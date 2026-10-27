// Browser navigation policy — PURE, no electron import.
//
// Phase 1 of the approved D2-D6 plan. This module answers the questions that
// must never depend on a live WebContents: which URLs may be loaded, which
// partition a Progress Ledger profile owns, and what a rendered rectangle is allowed
// to be. Keeping it pure is deliberate and follows the repo's existing
// convention (`ui/src/shell/workspace/model.js` is pure and testable in plain
// Node): the security decisions below are the ones a reviewer must be able to
// test without launching a browser.
//
// SCOPE: the scheme allowlist, profile→partition mapping, display-URL
// sanitization, rectangle clamping, and (approved decision D) download filename
// sanitization and containment. Permissions, popups and the full navigation
// refusal matrix belong to later phases of the plan; nothing here pretends to
// cover them.

import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Schemes that may be loaded into a Progress Ledger browser view. */
export const ALLOWED_SCHEMES = Object.freeze(["https:", "http:"]);

/** Non-http destinations that are still legitimate to show. */
export const ALLOWED_EXACT = Object.freeze(["about:blank"]);

/**
 * The app-owned PDF viewer page (see services/browser/pdf-viewer.js).
 * ONLY main-generated nonce URLs pass: the scheme plus the exact
 * viewer path plus a UUID nonce. Every other progressledger-v2:// URL
 * -- including the app UI itself -- stays blocked, so a page can never
 * load the shell UI into a browser view.
 */
export const VIEWER_URL_PATTERN =
  /^progressledger-v2:\/\/viewer\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The app-owned local-file viewer page (see services/browser/local-file.js).
 * ONLY main-generated nonce URLs pass: the scheme plus the exact `local`
 * host plus a UUID nonce, with an optional `/file` suffix for the served
 * file bytes (the viewer page's embed/img/iframe target). Every other
 * progressledger-v2://local/... URL stays blocked, so a page can never
 * mint its own local-file URL or steer the viewer at an arbitrary path.
 */
export const LOCAL_URL_PATTERN =
  /^progressledger-v2:\/\/local\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/file)?$/;

/**
 * True for the app's own ephemeral viewer pages (PDF wrapper + local-file
 * viewer, including the local file-bytes URL). These pages carry a
 * main-memory nonce with a 10-minute TTL, so there is nothing meaningful
 * to restore after a restart — and the tab store only accepts absolute
 * http(s) URLs (its own deliberate guard, INVALID_URL otherwise). The
 * create-page channel therefore skips the tab-row write for viewer URLs
 * instead of failing the page, the same shape as temporary profiles,
 * which also carry no row. A viewer URL can never be a restore row, so
 * a restart can never replay an expired nonce into a 404.
 */
export function isEphemeralViewerUrl(url) {
  return (
    typeof url === "string" &&
    (VIEWER_URL_PATTERN.test(url) || LOCAL_URL_PATTERN.test(url))
  );
}

const REASON = Object.freeze({
  EMPTY: "empty-url",
  INVALID: "invalid-url",
  SCHEME: "blocked-scheme",
  NO_HOST: "missing-host",
  CREDENTIALS: "url-credentials",
});

export const URL_REASONS = REASON;

/**
 * Query parameters that never belong in a renderer-visible URL. Credentials,
 * known token parameters and the fragment are stripped before a URL is handed
 * to the UI layer.
 */
const SECRET_QUERY_KEYS = new Set([
  "token",
  "access_token",
  "api_key",
  "apikey",
  "secret",
  "secret_key",
  "password",
  "authorization",
]);

export const MAX_URL_LENGTH = 4096;

/**
 * Turn whatever the user typed (or a page handed us) into a loadable URL.
 *
 * Accepts an absolute http(s) URL, or a bare host and infers https for it, which
 * is what an address bar has always done. Refuses everything else with a stated
 * reason — the UI shows the reason, it never silently rewrites a request into a
 * different kind of navigation.
 *
 * @param {unknown} raw
 * @returns {{ok: true, url: string} | {ok: false, reason: string}}
 */
export function normalizeTarget(raw) {
  if (typeof raw !== "string") return { ok: false, reason: REASON.INVALID };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: REASON.EMPTY };
  if (trimmed.length > MAX_URL_LENGTH) return { ok: false, reason: REASON.INVALID };
  if (ALLOWED_EXACT.includes(trimmed)) return { ok: true, url: trimmed };

  // A bare host (`example.com`, `localhost:3000`) is inferred as https, never
  // http: guessing the insecure scheme for the user is a downgrade, not a
  // convenience. An explicit `http://` is honoured and marked insecure by the UI.
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: REASON.INVALID };
  }
  if (!ALLOWED_SCHEMES.includes(url.protocol)) return { ok: false, reason: REASON.SCHEME };
  if (!url.hostname) return { ok: false, reason: REASON.NO_HOST };
  // `https://user:pass@host/` is a credential-leak shape and never something a
  // person types on purpose in this app.
  if (url.username || url.password) return { ok: false, reason: REASON.CREDENTIALS };
  return { ok: true, url: url.toString() };
}

/**
 * The navigation gate: may this URL be loaded? Used for an address-bar entry and
 * for the `will-navigate` / `will-redirect` refusals, so both paths agree by
 * construction.
 *
 * @param {unknown} raw
 * @returns {{ok: true, url: string} | {ok: false, reason: string}}
 */
export function isAllowedUrl(raw) {
  if (typeof raw === "string" && ALLOWED_EXACT.includes(raw.trim())) {
    return { ok: true, url: raw.trim() };
  }
  if (typeof raw === "string" && VIEWER_URL_PATTERN.test(raw.trim())) {
    return { ok: true, url: raw.trim() };
  }
  if (typeof raw === "string" && LOCAL_URL_PATTERN.test(raw.trim())) {
    return { ok: true, url: raw.trim() };
  }
  if (typeof raw !== "string") return { ok: false, reason: REASON.INVALID };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: REASON.INVALID };
  }
  if (!ALLOWED_SCHEMES.includes(url.protocol)) return { ok: false, reason: REASON.SCHEME };
  if (!url.hostname) return { ok: false, reason: REASON.NO_HOST };
  return { ok: true, url: url.toString() };
}

/** The scheme of a URL, for an honest refusal message. "" when unparseable. */
export function schemeOf(raw) {
  try {
    return new URL(String(raw)).protocol;
  } catch {
    return "";
  }
}

/**
 * A Progress Ledger profile id is a positive integer in the local database. It is
 * validated before it is ever concatenated into a partition name, because
 * `session.fromPartition` input is a security boundary, not a display string.
 */
export function validateProfileId(value) {
  // A number, or a canonical digit string. A padded/numeric-ish string is NOT
  // accepted: this gates a `session.fromPartition` name, and silently coercing
  // `" 3 "` (or `"3e2"`, or `"3.0"`) into a partition is exactly how a security
  // gate starts accepting input nobody meant to allow.
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 && value <= 2 ** 31 - 1;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 && id <= 2 ** 31 - 1;
}

/**
 * One persistent browser partition per Progress Ledger PROFILE (approved decision B).
 *
 * Workspace contexts map to no browser storage at all: contexts are ephemeral
 * layout bodies that can be created and dissolved, and tying cookies to them
 * would either discard logins on dissolve or leak them into a new context.
 * `session.defaultSession` is never used for web content — it carries the app's
 * own CSP injection and the privileged `progressledger-v2://` origin.
 *
 * @returns {string|null} null when the profile id is not valid
 */
export function partitionFor(profileId) {
  if (!validateProfileId(profileId)) return null;
  return `persist:cf-browser-${Number(profileId)}`;
}

/**
 * A browser profile local id is minted by main as "bp-<uuid>" and is the
 * ONLY browser-profile identifier that may reach a partition name. The
 * shape (bp- prefix, letters/digits/hyphens only) mirrors the Rust
 * validator, so a compromised renderer cannot steer a partition at a
 * path of its choosing. Temporary profiles carry "temp-<uuid>" instead
 * (shell-only, never a database row); they are validated separately.
 */
export function validateBrowserProfileId(value) {
  return (
    typeof value === "string" &&
    value.length >= 4 &&
    value.length <= 64 &&
    value.startsWith("bp-") &&
    /^[A-Za-z0-9-]+$/.test(value.slice(3))
  );
}

export function validateTempProfileId(value) {
  return (
    typeof value === "string" &&
    value.length >= 6 &&
    value.length <= 64 &&
    value.startsWith("temp-") &&
    /^[A-Za-z0-9-]+$/.test(value.slice(5))
  );
}

/**
 * The partition for one browser profile (Phase 3B, V2-33).
 *
 * - A temporary profile gets an IN-MEMORY partition (`pl-temp-<uuid>`,
 *   no `persist:` prefix): nothing survives the app closing.
 * - The workspace's DEFAULT profile adopts the Phase 3 partition
 *   (`persist:cf-browser-<workspace>`), so cookies from before 3B
 *   survive. The cf-browser name is a Phase 3 artifact kept
 *   deliberately, not a rename miss.
 * - Any other profile gets `persist:pl-browser-<workspace>-<localId>`.
 *
 * Returns null for any invalid input (workspace id, profile shape, or
 * a default flag that contradicts the id shape). Partition names come
 * only from validated internal ids, never user text.
 *
 * @param {number|string} workspaceId
 * @param {{localId?: string, isDefault?: boolean, temporary?: boolean}|null} browserProfile
 *   null = the legacy implicit profile (Phase 3 behaviour)
 */
export function partitionForBrowser(workspaceId, browserProfile) {
  if (!validateProfileId(workspaceId)) return null;
  const ws = Number(workspaceId);
  if (!browserProfile) return `persist:cf-browser-${ws}`;
  if (browserProfile.temporary === true) {
    if (!validateTempProfileId(browserProfile.localId)) return null;
    return `pl-temp-${browserProfile.localId.slice(5)}`;
  }
  if (!validateBrowserProfileId(browserProfile.localId)) return null;
  if (browserProfile.isDefault === true) return `persist:cf-browser-${ws}`;
  return `persist:pl-browser-${ws}-${browserProfile.localId}`;
}

/**
 * A URL with credentials, token-ish query parameters and the fragment removed,
 * bounded in length. This is the ONLY form of a URL the renderer ever sees.
 */
export function sanitizeDisplayUrl(raw) {
  if (typeof raw !== "string" || !raw) return "";
  const hadExplicitRootPath = /^https?:\/\/[^/?#]+\/(?:[?#]|$)/i.test(raw);
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.hash = "";
    const serialized = url.toString();
    const text =
      url.pathname === "/" && !url.search && !hadExplicitRootPath
        ? serialized.slice(0, -1)
        : serialized;
    return text.slice(0, MAX_URL_LENGTH);
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------
 * Downloads (approved decision D): sanitization and containment
 * ------------------------------------------------------------------
 *
 * A webpage chooses the NAME of a download. It must never choose the DIRECTORY,
 * and it must never be able to name a file outside the managed directory. Two
 * independent mechanisms enforce that here, deliberately overlapping:
 *
 *   1. `sanitizeDownloadFilename` turns an arbitrary string into a single safe
 *      path SEGMENT - separators, traversal shapes, control characters, the
 *      Windows-illegal set (including the alternate-data-stream colon), reserved
 *      device names and trailing dots/spaces are all removed or neutralised.
 *   2. `resolveDownloadTarget` re-checks containment on the RESOLVED path, so a
 *      bug in (1) cannot become a write outside the directory. This is the
 *      "re-check after resolution" rule; the two are not redundant, because (1)
 *      reasons about a name and (2) reasons about the filesystem.
 *
 * Both are pure (nothing here touches the disk or Electron), so the security
 * decisions are testable in plain Node - the same doctrine as the rest of this
 * module.
 */

/** How many downloads may be in flight at once. A page cannot flood the disk. */
export const MAX_CONCURRENT_DOWNLOADS = 3;

/** Bounded so a hostile name cannot exceed a filesystem's component limit. */
export const MAX_DOWNLOAD_FILENAME_LENGTH = 180;

/**
 * Windows device names that are unusable as file names, with or without an
 * extension: `CON.txt` is still the console device. Case-insensitive, and the
 * comparison must be made against the STEM (basename without extension).
 */
const WINDOWS_RESERVED_STEMS = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CLOCK$",
  ...Array.from({ length: 9 }, (_v, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_v, i) => `LPT${i + 1}`),
]);

/** Characters Windows refuses in a file name, plus the ADS colon. */
const ILLEGAL_NAME_CHARS = /[<>:"|?*]/g;

/** C0/C1 control characters and DEL: never legitimate in a display name. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Used when a name sanitizes away to nothing at all. */
const FALLBACK_FILENAME = "download";

export const DOWNLOAD_REASONS = Object.freeze({
  NO_DIR: "no-downloads-dir",
  UNSAFE_NAME: "unsafe-filename",
  NOT_CONTAINED: "not-contained",
  NO_ROOM: "too-many-collisions",
});

/** Split `name` into its stem and extension, honouring a leading dot. */
function splitExtension(name) {
  const dot = name.lastIndexOf(".");
  // A leading dot is part of the STEM (`.bashrc` has no extension), and a
  // trailing dot was already stripped by the caller.
  if (dot <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * Turn whatever a page (or a Content-Disposition header) handed us into ONE safe
 * file-name segment.
 *
 * NEVER returns a path: the result contains no `/` and no `\`, so joining it to
 * the managed directory cannot escape that directory. Always returns a usable
 * name, so the caller never has to invent one.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeDownloadFilename(raw) {
  let name = typeof raw === "string" ? raw : "";

  // 1. A name is a NAME. Take the last segment of either separator, so
  //    `../../etc/passwd`, `C:\\Temp\\x.exe` and `/tmp/x` all collapse to their
  //    final component before anything else looks at them.
  name = name.split(/[\\/]/).pop() ?? "";

  // 2. Control characters first (they can hide a separator from a human), then
  //    the Windows-illegal set. The colon removal is what kills an ADS write
  //    (`report.pdf:payload.exe`).
  name = name.replace(CONTROL_CHARS, "").replace(ILLEGAL_NAME_CHARS, "");

  // 3. Trailing dots and spaces: Windows SILENTLY strips them, which is how
  //    `malware.exe.` becomes `malware.exe` after a check said otherwise. Strip
  //    them here so what we validate is what the filesystem gets.
  name = name.replace(/[. ]+$/, "").trim();

  // 4. A name that was only dots (`..`) or only separators is not a name.
  if (!name || /^\.+$/.test(name)) return FALLBACK_FILENAME;

  let { stem, ext } = splitExtension(name);

  // 5. Reserved device names are neutralised by prefixing, which keeps the name
  //    recognisable instead of renaming it beyond recognition.
  if (WINDOWS_RESERVED_STEMS.has(stem.toUpperCase())) stem = `_${stem}`;
  if (!stem) stem = FALLBACK_FILENAME;

  // 6. Bound the length while keeping the extension - the extension is what
  //    decides how the file is treated, so it is the last thing to lose.
  ext = ext.replace(/[. ]+$/, "");
  const budget = Math.max(1, MAX_DOWNLOAD_FILENAME_LENGTH - ext.length);
  if (stem.length > budget) stem = stem.slice(0, budget);
  stem = stem.replace(/[. ]+$/, "") || FALLBACK_FILENAME;

  const safe = `${stem}${ext}`;
  // Belt and braces: the documented invariant of this function.
  return safe.includes("/") || safe.includes("\\") ? FALLBACK_FILENAME : safe;
}

/**
 * Is `candidate` strictly inside `dir`?
 *
 * The check is on resolved paths and compares path SEGMENTS, not string
 * prefixes: `/ws/downloads-evil/x` is NOT inside `/ws/downloads`, although a
 * naive `startsWith` would say it is.
 */
export function isContainedIn(dir, candidate) {
  if (typeof dir !== "string" || !dir) return false;
  if (typeof candidate !== "string" || !candidate) return false;
  let root;
  let target;
  try {
    root = resolve(dir);
    target = resolve(candidate);
  } catch {
    return false;
  }
  if (target === root) return false;
  const rel = relative(root, target);
  if (!rel) return false;
  if (isAbsolute(rel)) return false;
  if (rel === ".." || rel.startsWith(`..${sep}`)) return false;
  return true;
}

/**
 * The final destination for a download: sanitize the name, join it, re-check
 * containment, then de-duplicate a collision instead of overwriting whatever is
 * already there.
 *
 * `exists` is injected so this stays pure and so the caller owns the (racy, by
 * nature) filesystem question. It is called with an absolute path.
 *
 * @returns {{ok: true, path: string, filename: string}
 *          | {ok: false, reason: string}}
 */
export function resolveDownloadTarget({
  dir,
  filename,
  exists = () => false,
  maxAttempts = 1000,
} = {}) {
  if (typeof dir !== "string" || !dir) {
    return { ok: false, reason: DOWNLOAD_REASONS.NO_DIR };
  }
  const safe = sanitizeDownloadFilename(filename);
  if (!safe) return { ok: false, reason: DOWNLOAD_REASONS.UNSAFE_NAME };

  let candidate = join(dir, safe);
  if (!isContainedIn(dir, candidate)) {
    return { ok: false, reason: DOWNLOAD_REASONS.NOT_CONTAINED };
  }

  if (typeof exists === "function" && exists(candidate)) {
    const { stem, ext } = splitExtension(safe);
    let found = null;
    for (let n = 1; n <= maxAttempts; n += 1) {
      const next = join(dir, `${stem} (${n})${ext}`);
      if (!isContainedIn(dir, next)) {
        return { ok: false, reason: DOWNLOAD_REASONS.NOT_CONTAINED };
      }
      if (!exists(next)) {
        found = next;
        break;
      }
    }
    if (found === null) return { ok: false, reason: DOWNLOAD_REASONS.NO_ROOM };
    candidate = found;
  }

  // Containment is asserted once more on the FINAL path, including the
  // de-duplicated one: this is the value handed to `setSavePath`.
  if (!isContainedIn(dir, candidate)) {
    return { ok: false, reason: DOWNLOAD_REASONS.NOT_CONTAINED };
  }
  return { ok: true, path: candidate, filename: basename(candidate) };
}

export const MIN_VIEW_SIZE = 1;

/**
 * The renderer declares where the browser should sit; MAIN decides what that is
 * allowed to be. A rectangle is clamped to the window's content area, rounded to
 * whole pixels and refused when it would be degenerate — so a buggy or hostile
 * renderer cannot draw a native view over UI main did not intend, nor park it
 * outside the window.
 *
 * @param {unknown} rect     {x, y, width, height} in CSS pixels
 * @param {{width: number, height: number}} content  window content size
 * @param {number} [scale]   devicePixelRatio (unused for bounds, kept for the
 *                           caller's own rounding decisions)
 * @returns {{ok: true, x: number, y: number, width: number, height: number}
 *          | {ok: false, reason: string}}
 */
export function clampRect(rect, content, scale = 1) {
  if (!rect || typeof rect !== "object") return { ok: false, reason: "invalid-rect" };
  const width = Math.round(Number(rect.width));
  const height = Math.round(Number(rect.height));
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return { ok: false, reason: "invalid-rect" };
  }
  if (width < MIN_VIEW_SIZE || height < MIN_VIEW_SIZE) {
    return { ok: false, reason: "empty-rect" };
  }
  const maxW = Math.max(MIN_VIEW_SIZE, Math.round(Number(content?.width) || 0));
  const maxH = Math.max(MIN_VIEW_SIZE, Math.round(Number(content?.height) || 0));
  const x = Math.min(Math.max(0, Math.round(Number(rect.x) || 0)), Math.max(0, maxW - MIN_VIEW_SIZE));
  const y = Math.min(Math.max(0, Math.round(Number(rect.y) || 0)), Math.max(0, maxH - MIN_VIEW_SIZE));
  return {
    ok: true,
    x,
    y,
    width: Math.min(width, maxW - x),
    height: Math.min(height, maxH - y),
  };
}
