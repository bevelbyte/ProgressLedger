// SF-1 — Project Mode root trust anchor.
//
// THE PROBLEM
// -----------
// `project:create-project` accepts a renderer-supplied `rootPath`. That stored
// root then becomes the trusted filesystem scope for:
//
//   * Project Intelligence — `indexProject` walks the whole tree; getFileList /
//     getNeighbors / relevantFiles / getStats read the cached index.
//   * Project tools — the agent's `projectRoot` for fs_read / fs_write /
//     exec_run / test_run / build_run.
//
// Containment checks correctly enforce "stay inside <root>". But if the root
// ITSELF is `C:\`, then "inside C:\" is the whole disk. That is not a path
// traversal bug — it is a trust-anchor problem: the boundary is too broad to
// mean anything. A compromised renderer could request a maximally broad anchor
// and every downstream containment check would happily enforce it.
//
// DESIGN DECISION
// ---------------
// Progress Ledger already owns the right idiom for this exact class of problem: the
// first-run migration wizard opens `dialog.showOpenDialog` in the MAIN process
// and refuses any path the user did not actually pick there (see
// `migration:start` -> `workspace-path-not-selected`). So the trust anchor must
// be established by a main-process decision, not by renderer text.
//
// Two layers, in increasing strictness:
//
//   1. CANONICAL VALIDATION (always, for every root)
//      The path must be absolute, must exist, must be a directory, and is
//      canonicalized with realpathSync. The CANONICAL path is what gets
//      stored. This closes the reparse-point/junction TOCTOU the migration
//      wizard already guards against, and it means breadth is classified on
//      the real target rather than on a textual spelling.
//
//   2. BREADTH CONFIRMATION (only for a broad root)
//      A canonical root that is a filesystem/volume root, the OS user-profile
//      root, or a well-known system directory is BROAD. A broad root is NOT
//      forbidden — a user may genuinely want to scope an agent to a whole
//      volume — but it may not be established SILENTLY. It requires an explicit
//      confirmation gesture in the trusted main process (`confirmBroad`).
//
// WHAT WE DELIBERATELY DO NOT DO
// ------------------------------
// We do NOT restrict users to Documents/Desktop/known folders. Project Mode
// legitimately targets arbitrary directories (`D:\repos\monorepo`, a network
// share, a bare `D:\`). An allow-list of "safe" directories would break real
// usage and would not even be the right boundary — the risk is the anchor
// being established without the user's knowledge, not the anchor's location.
//
// Net invariant: a compromised renderer can propose any root it likes, but it
// cannot establish an excessively broad one without a human gesture in the
// main process. A narrow project root behaves exactly as before.

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Well-known OS system directories. A Project Mode agent rooted here would
 * have the whole OS as its blast radius, so it is treated as a broad anchor.
 * Compared case-insensitively on Windows.
 */
const WINDOWS_SYSTEM_ROOTS = [
  "C:\\Windows",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
  "C:\\ProgramData",
  "C:\\Users",
];

const POSIX_SYSTEM_ROOTS = [
  "/", "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/opt", "/private",
  "/proc", "/root", "/sbin", "/srv", "/sys", "/usr", "/var",
  "/Applications", "/Library", "/System", "/Users",
];

function normalizeForCompare(p, platform) {
  const trimmed = String(p || "").replace(/[\\/]+$/, "");
  if (!trimmed) return String(p || "");
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/**
 * True when `canonicalPath` is the filesystem/volume root itself
 * (`C:\`, `/`, `\\server\share\`).
 */
export function isVolumeRoot(canonicalPath, platform = process.platform) {
  if (typeof canonicalPath !== "string" || !canonicalPath) return false;
  const parsed = path.parse(canonicalPath);
  if (!parsed.root) return false;
  const trimmedRoot = parsed.root.replace(/[\\/]+$/, "");
  const trimmedPath = canonicalPath.replace(/[\\/]+$/, "");
  // `C:\` parses to root `C:\`; the whole path equals the root.
  return normalizeForCompare(trimmedPath, platform) === normalizeForCompare(trimmedRoot, platform);
}

/**
 * Classify how much of the filesystem a canonical root would hand to an agent.
 *
 * @returns {"broad" | "narrow"}
 */
export function classifyProjectRootBreadth(canonicalPath, options = {}) {
  const platform = options.platform || process.platform;
  if (typeof canonicalPath !== "string" || !canonicalPath) return "broad";

  // Fail safe: an unclassifiable root is treated as broad, never narrow.
  if (isVolumeRoot(canonicalPath, platform)) return "broad";

  const target = normalizeForCompare(canonicalPath, platform);

  const home = options.homedir !== undefined ? options.homedir : safeHomedir();
  if (home) {
    const normalizedHome = normalizeForCompare(
      // Canonicalize the home dir too: a profile root reached through a
      // junction must classify the same as the direct spelling.
      safeRealpath(home) || home,
      platform,
    );
    if (target === normalizedHome) return "broad";
  }

  const systemRoots = platform === "win32" ? WINDOWS_SYSTEM_ROOTS : POSIX_SYSTEM_ROOTS;
  for (const root of systemRoots) {
    const canonicalRoot = safeRealpath(root);
    if (target === normalizeForCompare(canonicalRoot || root, platform)) return "broad";
  }

  return "narrow";
}

function safeHomedir() {
  try { return homedir(); } catch { return null; }
}

function safeRealpath(p) {
  try { return realpathSync(p); } catch { return null; }
}

/**
 * Validate + canonicalize a renderer-supplied project root.
 *
 * @returns {{ok: true, canonicalPath: string, breadth: "broad"|"narrow"}
 *          | {ok: false, reason: string}}
 */
export function canonicalizeProjectRoot(rawPath, options = {}) {
  const platform = options.platform || process.platform;
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return { ok: false, reason: "invalid-root" };
  }
  const candidate = rawPath.trim();
  if (!path.isAbsolute(candidate)) {
    return { ok: false, reason: "root-not-absolute" };
  }

  let stats;
  try { stats = statSync(candidate); }
  catch { return { ok: false, reason: "root-not-found" }; }
  if (!stats.isDirectory()) {
    return { ok: false, reason: "root-not-a-directory" };
  }

  // Store the canonical identity, not the textual spelling. This is what
  // closes the junction/reparse-point TOCTOU: a renderer cannot store one
  // spelling and have the filesystem later resolve it somewhere else.
  const canonicalPath = safeRealpath(candidate);
  if (!canonicalPath) return { ok: false, reason: "root-not-found" };

  return {
    ok: true,
    canonicalPath,
    breadth: classifyProjectRootBreadth(canonicalPath, { ...options, platform }),
  };
}

/**
 * Full SF-1 authorization for establishing a project root.
 *
 * @param {string} rawPath           renderer-supplied root
 * @param {object} options
 * @param {(canonicalPath: string) => Promise<boolean>} [options.confirmBroad]
 *        Main-process confirmation gesture. Required for a broad root; when it
 *        is absent a broad root is REFUSED.
 * @returns {Promise<{ok: true, canonicalPath: string, breadth: string}
 *                 | {ok: false, reason: string}>}
 */
export async function authorizeProjectRoot(rawPath, options = {}) {
  const resolved = canonicalizeProjectRoot(rawPath, options);
  if (!resolved.ok) return resolved;
  if (resolved.breadth !== "broad") return resolved;

  const confirmBroad = options.confirmBroad;
  if (typeof confirmBroad !== "function") {
    return { ok: false, reason: "root-too-broad" };
  }
  let confirmed = false;
  try { confirmed = (await confirmBroad(resolved.canonicalPath)) === true; }
  catch { confirmed = false; }
  if (!confirmed) return { ok: false, reason: "root-too-broad" };
  return resolved;
}

export const _INTERNAL = {
  WINDOWS_SYSTEM_ROOTS,
  POSIX_SYSTEM_ROOTS,
  normalizeForCompare,
};
