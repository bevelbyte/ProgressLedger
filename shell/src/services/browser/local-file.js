// Local-file viewer — PURE helpers plus the nonce store (no Electron
// import, so the shell tests can prove every rule without launching).
//
// A file the user opens from the browser pane is NEVER loaded as a
// `file:` URL: typed `file:` addresses stay refused by the address bar,
// and the navigation policy admits no `file:` URL at all. Instead the
// file is rendered through a tiny app-owned viewer page, mirroring the
// PDF viewer wrapper (pdf-viewer.js):
//
//   - The user picks the file in the native open dialog (main process).
//     The renderer never supplies a path and never receives one back —
//     it gets only the viewer URL below.
//   - Main mints a random UUID nonce and remembers
//     nonce -> { path, mime, kind, title } in main memory only (10-minute
//     TTL, same as the PDF viewer). The viewer page is served at
//     `progressledger-v2://local/<nonce>` and the file bytes at
//     `progressledger-v2://local/<nonce>/file`, so the real path never
//     appears in the address bar, the tab list, or the database.
//   - Only an allowlist of safe, render-only types is admitted: PDF, plain
//     text, and raster images. Executables, scripts, and markup (HTML
//     included) are refused by the allowlist, not by a blocklist, so a
//     type nobody thought of is refused by default. Served bytes are
//     always labelled with the FIXED mime for their extension, never
//     sniffed, and are only ever interpreted by the renderer as a
//     document, text, or image — never executed, never saved.
//   - Opening a file writes nothing to the ledger: capture and save stay
//     user-initiated actions, and the browser surface already disables
//     them for non-http(s) page URLs, which viewer URLs are.
//
// Protocol handlers are PER SESSION in Electron: main.js registers
// `progressledger-v2` only on the default session (the main window), so
// a page in a partition session would fail the viewer load with an
// unknown scheme. The host therefore registers the local branch on each
// partition session when its first page is created (host.js), exactly
// like the PDF viewer branch.
import { randomUUID } from "node:crypto";
import { LOCAL_URL_PATTERN } from "./policy.js";

export { LOCAL_URL_PATTERN };

export const LOCAL_FILE_TTL_MS = 10 * 60 * 1000;

/**
 * The allowlist. Extension (lowercased, with dot) -> { mime, kind }.
 * `kind` selects the viewer element; `mime` is the ONLY content type the
 * bytes are ever served with.
 */
export const LOCAL_FILE_TYPES = Object.freeze({
  ".pdf": Object.freeze({ mime: "application/pdf", kind: "pdf" }),
  ".txt": Object.freeze({ mime: "text/plain", kind: "text" }),
  ".png": Object.freeze({ mime: "image/png", kind: "image" }),
  ".jpg": Object.freeze({ mime: "image/jpeg", kind: "image" }),
  ".jpeg": Object.freeze({ mime: "image/jpeg", kind: "image" }),
  ".gif": Object.freeze({ mime: "image/gif", kind: "image" }),
  ".webp": Object.freeze({ mime: "image/webp", kind: "image" }),
});

/** Dialog filter (a UI hint only — main re-validates after selection). */
export const LOCAL_FILE_DIALOG_EXTENSIONS = Object.freeze([
  "pdf",
  "txt",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
]);

export const LOCAL_FILE_REASONS = Object.freeze({
  NOT_A_FILE: "not-a-file",
  BLOCKED_TYPE: "blocked-type",
});

/** Last path segment, splitting on both separators: dialog paths are
 * Windows paths, and this module must read them correctly on any
 * platform its tests run on (node:path's basename is platform-bound). */
function lastSegment(filePath) {
  const parts = String(filePath).split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/** The allowlist entry for a path, or null when the type is not admitted. */
export function localFileTypeForPath(filePath) {
  if (typeof filePath !== "string" || !filePath) return null;
  const segment = lastSegment(filePath);
  const dot = segment.lastIndexOf(".");
  if (dot <= 0) return null;
  const entry = LOCAL_FILE_TYPES[segment.slice(dot).toLowerCase()];
  return entry ?? null;
}

/** File name for the tab title: basename, cleaned, no path separators. */
export function localFileTitle(filePath) {
  if (typeof filePath !== "string" || !filePath) return "local file";
  const clean = lastSegment(filePath).replace(/[<>:"|?*]/g, "").trim();
  if (!clean) return "local file";
  return clean.slice(0, 100);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The viewer page: a static document whose only content is the file
 * itself, rendered by kind. No script: nothing here can be steered by
 * file content. Text goes through a sandboxed iframe (a text/plain
 * document has no scripts to run, and the sandbox makes sure of it).
 */
export function localViewerHtml(kind, title, fileUrl) {
  const safeTitle = escapeHtml(title);
  const safeSrc = escapeHtml(fileUrl);
  const style =
    "html,body{margin:0;height:100%;background:#1e1e1e}embed,iframe{width:100%;height:100%;display:block;border:0}img{width:100%;height:100%;object-fit:contain;display:block}";
  let body = "";
  if (kind === "pdf") body = `<embed type="application/pdf" src="${safeSrc}">`;
  else if (kind === "image") body = `<img src="${safeSrc}">`;
  else body = `<iframe sandbox="" src="${safeSrc}"></iframe>`;
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${safeTitle}</title><style>${style}</style></head>\n<body>${body}</body></html>\n`;
}

/**
 * Validate a candidate local file (dialog result or test-mint path).
 * `statSync` is injected so tests can pass a fake; the app passes
 * node:fs's statSync. Returns the store entry on success, or a refusal
 * with a reason the UI can show. Never returns the path to a caller
 * that must not see it — the entry is main-only.
 */
export function validateLocalFilePath(filePath, statSync) {
  if (typeof filePath !== "string" || !filePath) {
    return { ok: false, reason: LOCAL_FILE_REASONS.NOT_A_FILE };
  }
  let stat = null;
  try {
    stat = typeof statSync === "function" ? statSync(filePath) : null;
  } catch {
    stat = null;
  }
  if (!stat || typeof stat.isFile !== "function" || !stat.isFile()) {
    return { ok: false, reason: LOCAL_FILE_REASONS.NOT_A_FILE };
  }
  const type = localFileTypeForPath(filePath);
  if (!type) {
    return {
      ok: false,
      reason: LOCAL_FILE_REASONS.BLOCKED_TYPE,
      detail: "Only PDF, text, and image files can be opened here.",
    };
  }
  return {
    ok: true,
    entry: {
      path: filePath,
      mime: type.mime,
      kind: type.kind,
      title: localFileTitle(filePath),
    },
  };
}

/**
 * Main-memory nonce store. register() mints viewer + file URLs for a
 * validated entry and remembers the mapping; resolve() returns it until
 * expiry. Entries are purged lazily on every register and resolve, so
 * the map cannot grow without bound.
 */
export function createLocalFileStore(now = () => Date.now()) {
  const entries = new Map();
  function purge() {
    const t = now();
    for (const [nonce, entry] of entries) {
      if (entry.expiresAt <= t) entries.delete(nonce);
    }
  }
  return {
    register(entry) {
      purge();
      const nonce = randomUUID();
      entries.set(nonce, { ...entry, expiresAt: now() + LOCAL_FILE_TTL_MS });
      return {
        nonce,
        viewerUrl: `progressledger-v2://local/${nonce}`,
        fileUrl: `progressledger-v2://local/${nonce}/file`,
        title: entry.title,
        kind: entry.kind,
      };
    },
    resolve(nonce) {
      purge();
      if (typeof nonce !== "string") return null;
      const entry = entries.get(nonce);
      if (!entry) return null;
      return { path: entry.path, mime: entry.mime, kind: entry.kind, title: entry.title };
    },
    size() {
      purge();
      return entries.size;
    },
  };
}

/**
 * Serve one nonce entry's bytes for a protocol handler. `statSync` and
 * `fetchFile` are injected (the app passes node:fs's statSync and a
 * net.fetch over the file URL); the response re-labels the bytes with
 * the store entry's FIXED mime and never sniffs. Anything wrong — a
 * vanished path, a directory, a failed fetch, a non-200 — is a 404,
 * never a partial file and never an error page that leaks the path.
 */
export async function localFileResponse(entry, { statSync, fetchFile }) {
  const notFound = () => new Response("Not Found", { status: 404 });
  if (!entry || typeof entry.path !== "string" || !entry.path) return notFound();
  let stat = null;
  try {
    stat = typeof statSync === "function" ? statSync(entry.path) : null;
  } catch {
    return notFound();
  }
  if (!stat || typeof stat.isFile !== "function" || !stat.isFile()) return notFound();
  let upstream = null;
  try {
    upstream = typeof fetchFile === "function" ? await fetchFile(entry.path) : null;
  } catch {
    return notFound();
  }
  if (!upstream || typeof upstream.status !== "number" || upstream.status !== 200) {
    return notFound();
  }
  if (typeof upstream.body === "undefined" || upstream.body === null) return notFound();
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": entry.mime,
      "cache-control": "no-store",
      "content-disposition": "inline",
    },
  });
}
