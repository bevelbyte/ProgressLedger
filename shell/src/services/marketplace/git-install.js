// Git-install path for the marketplace service.
//
// Clones a Git URL into a controlled, sandboxed location under
// `<userData>/marketplace/<id>/`, validates the manifest, and registers
// the resulting plugin. NEVER executes any of the cloned code at install
// time — the only thing we run is the `git` binary on PATH, via argv
// only (no shell), against the user-supplied URL.
//
// Security:
//   - URL is sanitized: http(s):// or git@host:path form only.
//   - Destination `<userData>/marketplace/<id>` is independently verified
//     to be a strict child of the configured marketplace root.
//   - Clone happens to a staging directory first. We only `mv` the
//     staged tree into the final location AFTER manifest validation
//     passes — a bad manifest leaves no half-installed plugin behind.
//   - The plugin runtime is not invoked. We register metadata only.
//
// All public functions never throw; failures surface as
// `{ ok: false, reason }`.

import {
  readFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { validateManifest as pluginsValidateManifest } from "../plugins/index.js";
import {
  cleanupMarketplacePath,
  resolveMarketplacePath,
  safeUnder as centralizedSafeUnder,
  verifyMarketplaceDestination,
} from "./path-security.js";

// ---- URL sanitization -----------------------------------------------------

// Allowed URL schemes: http(s) and the `git@host:path` SCP-like form used by
// GitHub / GitLab. Anything else (file://, ftp://, ssh://, custom schemes,
// shell-metachar-laden strings) is rejected before we touch `git`.
const HTTP_URL_RE = /^https?:\/\/[^\s]+$/i;
const SCP_URL_RE  = /^(?:[A-Za-z0-9._-]+@)[A-Za-z0-9._-]+:[^\s]+$/;

function isValidGitUrl(url) {
  if (typeof url !== "string" || !url) return false;
  // Reject any path-traversal hint anywhere in the URL — `git clone` will
  // happily accept these and the resulting path components are part of the
  // canonical repo URL, not the destination, but be strict anyway.
  if (url.includes("..")) return false;
  // Reject whitespace and shell metacharacters defensively. Even though
  // we always invoke git via argv (no shell), refuse these so we never
  // even *attempt* a clone with a suspicious string.
  if (/[\s'"`;|&$()<>]/.test(url)) return false;
  // Reject embedded credentials in the userinfo component
  // (e.g. https://user:pass@github.com/owner/repo). `git clone` accepts
  // these and would leak the credentials to the remote via the URL
  // userinfo — the auth header on the wire. Forbid outright so a user
  // with a configured credential helper isn't surprised.
  if (HTTP_URL_RE.test(url)) {
    try {
      const u = new URL(url);
      if (u.username || u.password) return false;
    } catch {
      return false;
    }
  }
  return HTTP_URL_RE.test(url) || SCP_URL_RE.test(url);
}

// ---- path-traversal guard -------------------------------------------------

// Compatibility export. Marketplace operations use resolveMarketplacePath and
// verifyMarketplaceDestination below; this helper delegates to the same strict
// child policy rather than maintaining a second boundary implementation.
const safeUnder = centralizedSafeUnder;

// ---- child_process binding (testable) -------------------------------------

// Default execFile binding. Injected as a dependency so tests can swap in
// a stub without monkey-patching `node:child_process`.
import { execFile as defaultExecFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(defaultExecFile);

// Run a single git argv command and resolve with `{ stdout, stderr }`.
// Throws on non-zero exit; the caller maps to a structured failure.
async function runGit(execFile, args, opts = {}) {
  return execFile("git", args, { ...opts, shell: false, windowsHide: true });
}

// ---- core install ---------------------------------------------------------

/**
 * Clone a Git URL into a sandboxed install path and validate the
 * manifest. Returns a normalized descriptor on success.
 *
 * Options:
 *   - url:         required, http(s):// or git@host:path form
 *   - ref:         optional, branch / tag / sha to check out (default "HEAD")
 *   - userDataDir: required, root of the user's data directory
 *   - execFile:    optional, injected for tests
 *   - id:          optional override for the install folder name (used by
 *                  tests); defaults to a sanitized form of the URL path.
 */
export async function installGit({
  url,
  ref = "HEAD",
  userDataDir,
  execFile = execFileP,
  id: idOverride,
} = {}) {
  if (typeof url !== "string" || !url) {
    return { ok: false, reason: "invalid-source" };
  }
  if (typeof userDataDir !== "string" || !userDataDir) {
    return { ok: false, reason: "no-root" };
  }
  if (!isValidGitUrl(url)) {
    return { ok: false, reason: "invalid-url" };
  }

  // Derive an install id from the URL path (last segment of the SCP path
  // or URL path, with the `.git` suffix stripped). Used as the on-disk
  // folder name and the in-memory registry key.
  const derivedId = idOverride || deriveIdFromUrl(url);
  if (!derivedId) return { ok: false, reason: "missing-id" };

  const marketplaceTarget = resolveMarketplacePath(userDataDir, derivedId);
  if (!marketplaceTarget.ok) return { ok: false, reason: "path-escape" };
  const marketplaceDir = marketplaceTarget.marketplaceRoot;

  let verifiedDest = verifyMarketplaceDestination(marketplaceTarget);
  if (!verifiedDest.ok) return verifiedDest;

  try {
    mkdirSync(marketplaceDir, { recursive: true });
  } catch { return { ok: false, reason: "mkdir-failed" }; }
  verifiedDest = verifyMarketplaceDestination(marketplaceTarget);
  if (!verifiedDest.ok) return verifiedDest;

  // Duplicate check: refuse to clobber an existing install.
  if (existsSync(verifiedDest.destination)) {
    return { ok: false, reason: "duplicate", existingVersion: null };
  }

  // Stage the clone into a unique tmp dir under marketplace/staging/.
  // If anything below fails (clone, rev-parse, manifest), we drop the
  // staging dir and report the error — nothing is left half-installed.
  const stagingRootTarget = resolveMarketplacePath(userDataDir, "staging");
  if (!stagingRootTarget.ok) return stagingRootTarget;
  const stagingRoot = stagingRootTarget.destination;
  try { mkdirSync(stagingRoot, { recursive: true }); }
  catch { return { ok: false, reason: "mkdir-failed" }; }
  const verifiedStagingRoot = verifyMarketplaceDestination(stagingRootTarget);
  if (!verifiedStagingRoot.ok) return verifiedStagingRoot;
  const stagingId = randomBytes(8).toString("hex");
  const stagingTarget = resolveMarketplacePath(userDataDir, "staging", stagingId);
  if (!stagingTarget.ok) return stagingTarget;
  const stagingPath = stagingTarget.destination;
  const verifiedStaging = verifyMarketplaceDestination(stagingTarget);
  if (!verifiedStaging.ok) return verifiedStaging;

  // Clone.
  let cloneRes;
  try {
    cloneRes = await runGit(execFile, [
      "clone",
      "--depth", "1",
      ...(ref && ref !== "HEAD" ? ["--branch", ref] : []),
      url,
      stagingPath,
    ]);
  } catch {
    cleanupMarketplacePath(userDataDir, "staging", stagingId);
    return { ok: false, reason: "clone-failed" };
  }

  // Resolve HEAD sha so the descriptor records exactly what we installed.
  let sha = null;
  try {
    const r = await runGit(execFile, ["-C", stagingPath, "rev-parse", "HEAD"]);
    sha = (r.stdout || "").trim() || null;
  } catch {
    // Non-fatal — we still have a working tree. Just no sha.
    sha = null;
  }

  // Read + validate manifest BEFORE moving into the install location.
  const manifestPath = join(stagingPath, "plugin.json");
  if (!existsSync(manifestPath)) {
    cleanupMarketplacePath(userDataDir, "staging", stagingId);
    return { ok: false, reason: "invalid-manifest" };
  }
  let raw;
  try { raw = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch {
    cleanupMarketplacePath(userDataDir, "staging", stagingId);
    return { ok: false, reason: "invalid-manifest" };
  }
  const v = pluginsValidateManifest(raw);
  if (!v.ok) {
    cleanupMarketplacePath(userDataDir, "staging", stagingId);
    return { ok: false, reason: "invalid-manifest" };
  }

  // Atomic-ish move into the install location. `renameSync` is atomic on
  // the same filesystem, which is the case here (both dirs live under
  // marketplace/). If the move fails we drop the staging dir.
  try {
    const finalVerified = verifyMarketplaceDestination({
      ok: true,
      marketplaceRoot: verifiedDest.marketplaceRoot,
      destination: verifiedDest.destination,
    });
    if (!finalVerified.ok) {
      cleanupMarketplacePath(userDataDir, "staging", stagingId);
      return finalVerified;
    }
    renameSync(stagingPath, finalVerified.destination);
  } catch {
    cleanupMarketplacePath(userDataDir, "staging", stagingId);
    return { ok: false, reason: "move-failed" };
  }

  return {
    ok: true,
    id: derivedId,
    name: v.manifest.name,
    version: v.manifest.version,
    skills: [...v.manifest.skills],
    tools: [...v.manifest.tools],
    mcpServers: [...v.manifest.mcpServers],
    sha,
    ref,
    source: { kind: "git", url, sha, ref },
    install_path: verifiedDest.destination,
    manifest: v.manifest,
  };
}

/**
 * Strip the trailing `.git` (if any) from a URL's path tail and return
 * the last non-empty path segment. Works for both http(s) and SCP forms.
 */
function deriveIdFromUrl(url) {
  let tail = "";
  if (HTTP_URL_RE.test(url)) {
    try {
      // Use a manual parse — we deliberately do NOT want a network lookup.
      const u = new URL(url);
      const parts = u.pathname.split("/").filter(Boolean);
      tail = parts[parts.length - 1] || "";
    } catch { return null; }
  } else if (SCP_URL_RE.test(url)) {
    const colon = url.indexOf(":");
    const path = colon >= 0 ? url.slice(colon + 1) : "";
    const parts = path.split("/").filter(Boolean);
    tail = parts[parts.length - 1] || "";
  }
  if (!tail) return null;
  if (tail.toLowerCase().endsWith(".git")) tail = tail.slice(0, -4);
  if (!tail) return null;
  // Only allow [A-Za-z0-9._-] in the derived id — keep it filesystem-safe.
  if (!/^[A-Za-z0-9._-]+$/.test(tail)) return null;
  return tail;
}

// Re-export the path-safety helper for direct testing.
export { isValidGitUrl, safeUnder, deriveIdFromUrl };