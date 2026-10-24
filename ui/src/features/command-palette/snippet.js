/**
 * Pure FTS-snippet parsing for the command palette.
 *
 * SQLite's snippet() is called with '<mark>' / '</mark>' markers (see
 * resources.rs search_resources). This splits a snippet into
 * { t: text, hl: boolean } parts so the UI can highlight matches WITHOUT
 * injecting HTML ({@html} would be an XSS hole over user-authored notes).
 */

export function parseSnippet(snippet) {
  const parts = [];
  const re = /<mark>([\s\S]*?)<\/mark>/g;
  let last = 0;
  let m;
  while ((m = re.exec(snippet))) {
    if (m.index > last) parts.push({ t: snippet.slice(last, m.index), hl: false });
    parts.push({ t: m[1], hl: true });
    last = re.lastIndex;
  }
  if (last < snippet.length) parts.push({ t: snippet.slice(last), hl: false });
  return parts.length > 0 ? parts : [{ t: snippet, hl: false }];
}
