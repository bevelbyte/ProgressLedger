// PDF viewer wrapper — PURE helpers plus the nonce store (no Electron
// import, so the shell tests can prove every rule without launching).
//
// Root cause (follow-up round, proven by the pdf-mechanism probe): in
// this Electron build a top-level navigation to a PDF never attaches
// the viewer — no <embed> appears, the document stays "loading" forever,
// and nothing downloads — even with webPreferences.plugins = true.
// But an explicit <embed type="application/pdf"> in an HTML page DOES
// instantiate the viewer. So a main-frame PDF navigation is rendered
// through a tiny app-owned wrapper page that contains exactly that
// embed. The routing lives inside the host's own onHeadersReceived
// handler (host.js): webRequest handlers replace, never accumulate, so
// a second listener would be silently replaced by the host's own
// third-party-cookie handler. The wrapper is served on the app's own
// privileged origin
// (progressledger-v2://viewer/<nonce>) with the PDF URL baked into the
// generated HTML — never in the wrapper URL — so no query string, token
// or credential from the PDF URL ever appears in the address bar, the
// tab list, or the database. The nonce is a random UUID, single-origin,
// kept in main memory only, and expires after ten minutes.
//
// Protocol handlers are PER SESSION in Electron: main.js registers
// progressledger-v2 only on the default session (the main window), so a
// page in a partition session would fail the wrapper load with an
// unknown scheme. The host therefore registers the viewer branch on
// each partition session when its first page is created (host.js,
// pdfProtocolSessions).
import { randomUUID } from "node:crypto";
import { VIEWER_URL_PATTERN } from "./policy.js";

export { VIEWER_URL_PATTERN };

export const PDF_VIEWER_TTL_MS = 10 * 60 * 1000;

/** Strict shape of a viewer URL: only main-generated nonces pass. */

function header(details, name) {
  const headers = details?.responseHeaders ?? {};
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) {
      const values = headers[key];
      return Array.isArray(values) ? values[0] ?? "" : String(values ?? "");
    }
  }
  return "";
}

/**
 * Is this response a main-frame PDF document that would otherwise hang
 * unrendered? Downloads (Content-Disposition: attachment) are excluded:
 * those already reach the managed download folder. Subframe and plugin
 * loads are excluded: embedded PDFs render natively.
 */
export function isPdfResponse(details) {
  if (!details || typeof details.url !== "string") return false;
  if (details.resourceType !== "mainFrame") return false;
  if (details.method !== "GET") return false;
  if (details.statusCode !== 200) return false;
  if (!/^https?:\/\//i.test(details.url)) return false;
  const contentType = header(details, "content-type").toLowerCase();
  if (!contentType.startsWith("application/pdf")) return false;
  const disposition = header(details, "content-disposition").toLowerCase();
  if (disposition.startsWith("attachment")) return false;
  return true;
}

/** File name for the tab title: last path segment, decoded, no query. */
export function pdfFilename(pdfUrl) {
  try {
    const url = new URL(pdfUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments.length > 0 ? decodeURIComponent(segments[segments.length - 1]) : "";
    const clean = last.replace(/[<>:"|?*]/g, "").trim();
    if (!clean) return "document.pdf";
    return clean.slice(0, 100);
  } catch {
    return "document.pdf";
  }
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
 * The wrapper page: a static document whose only content is the viewer
 * embed. No script: nothing here can be steered by page content, and
 * the embed's request carries the view's own partition cookies, so a
 * PDF behind a login still loads.
 */
export function viewerHtml(pdfUrl, title) {
  const safeTitle = escapeHtml(title);
  const safeSrc = escapeHtml(pdfUrl);
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${safeTitle}</title><style>html,body{margin:0;height:100%;background:#1e1e1e}embed{width:100%;height:100%;display:block}</style></head>\n<body><embed type="application/pdf" src="${safeSrc}"></body></html>\n`;
}

/**
 * Main-memory nonce store. register() mints a viewer URL for a PDF URL
 * and remembers the mapping; resolve() returns it until expiry. Entries
 * are purged lazily on every register and resolve, so the map cannot
 * grow without bound.
 */
export function createPdfViewerStore(now = () => Date.now()) {
  const entries = new Map();
  function purge() {
    const t = now();
    for (const [nonce, entry] of entries) {
      if (entry.expiresAt <= t) entries.delete(nonce);
    }
  }
  return {
    register(pdfUrl) {
      purge();
      const nonce = randomUUID();
      const title = pdfFilename(pdfUrl);
      entries.set(nonce, { pdfUrl, title, expiresAt: now() + PDF_VIEWER_TTL_MS });
      return { nonce, viewerUrl: `progressledger-v2://viewer/${nonce}`, title };
    },
    resolve(nonce) {
      purge();
      if (typeof nonce !== "string") return null;
      const entry = entries.get(nonce);
      if (!entry) return null;
      return { pdfUrl: entry.pdfUrl, title: entry.title };
    },
    size() {
      purge();
      return entries.size;
    },
  };
}
