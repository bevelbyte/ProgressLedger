/**
 * Live page extraction for the Progress Ledger browser (ported from the
 * Progress Ledger TypeScript browser, Decision D-009 in that project).
 *
 * Pure module: no Electron import, so the caps and the extraction script
 * are unit-testable in plain Node and reviewable without launching a
 * browser. The host (shell/src/services/browser/host.js) owns the
 * webContents and calls `executeJavaScript` with EXTRACT_SCRIPT; this
 * module owns what that script returns and how it is capped.
 *
 * Provenance rule, kept from the PL design: the frame — URL and title —
 * is read by the host from its own registry record (main-process truth),
 * never from page-supplied data. The page contributes only the
 * quotation: its rendered text, the user's selection, and its HTML for
 * the snapshot.
 */

/** Page text cap (PL cap, kept): truncation is flagged, never silent. */
export const MAX_CAPTURE_TEXT_LENGTH = 200_000;

/** Snapshot cap (PL cap, kept): over this, the capture is text-only. */
export const MAX_SNAPSHOT_LENGTH = 10_000_000;

/** Selection cap (PL cap, kept): enforced by the capture IPC layer. */
export const MAX_SELECTION_LENGTH = 20_000;

/** What the host extracts from one live page. */
export interface ExtractedPage {
  url: string;
  title: string;
  html: string | null;
  text: string;
  textTruncated: boolean;
  selection: string;
}

/**
 * Runs in the page. Returns the page's own rendered text, the user's
 * current selection, and the document HTML. The HTML read is guarded:
 * a page that throws while serializing still yields its text.
 */
export const EXTRACT_SCRIPT = `(() => {
  const text = document.body ? document.body.innerText : ''
  const selection = window.getSelection ? String(window.getSelection()) : ''
  let html = ''
  try { html = document.documentElement ? document.documentElement.outerHTML : '' } catch { html = '' }
  return { text, selection, html }
})()`;

/** The untrusted shape `executeJavaScript` may hand back. */
export interface RawExtraction {
  text?: unknown;
  selection?: unknown;
  html?: unknown;
}

/**
 * Applies the caps to a raw extraction. Text over the cap is cut and
 * flagged; HTML that is empty or over the cap becomes null (text-only
 * capture); a non-string selection degrades to empty.
 */
export function applyExtractionCaps(raw: RawExtraction): {
  text: string;
  textTruncated: boolean;
  html: string | null;
  selection: string;
} {
  const fullText = typeof raw.text === "string" ? raw.text : "";
  const textTruncated = fullText.length > MAX_CAPTURE_TEXT_LENGTH;
  const rawHtml = typeof raw.html === "string" ? raw.html : "";
  return {
    text: textTruncated ? fullText.slice(0, MAX_CAPTURE_TEXT_LENGTH) : fullText,
    textTruncated,
    html: rawHtml.length > 0 && rawHtml.length <= MAX_SNAPSHOT_LENGTH ? rawHtml : null,
    selection: typeof raw.selection === "string" ? raw.selection : "",
  };
}
