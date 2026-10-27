/**
 * Page network log (Bug 3 diagnostic): the per-page record of failed
 * requests the user reads in Settings > Diagnostics. The rules are the
 * user's, and they are strict:
 *
 * - ONLY failed requests. A success is never recorded.
 * - Each entry is host + path (no query string, no fragment), the HTTP
 *   status OR the Chromium error code, and the time. Nothing else.
 * - No headers, no cookies, no bodies are ever captured: this module
 *   never receives them, so it cannot leak them. An entry's keys are
 *   exactly { at, host, path } plus `status` or `error`.
 * - Memory only: the host holds these maps in main-process memory, the
 *   panel reads them over IPC, and they are dropped when the page
 *   closes or when the user turns the log off. Nothing is written to
 *   disk and nothing leaves the laptop.
 * - The log is OFF until the user turns it on: the host gates recording
 *   on its enabled flag, so an entry made while off never exists.
 *
 * This module is pure (no Electron, no I/O) so the rules above are
 * unit-testable: what is recorded, what is stripped, and what is never
 * recorded at all.
 */

/** Entries kept per page. Enough for one send attempt and its retries. */
export const PAGE_NETWORK_LOG_CAP = 200;

/**
 * Build one log entry from a request URL and its failure, or null when
 * the URL cannot be parsed (an unparseable URL records nothing, never a
 * guessed host). `outcome` is either { status: <number> } for an HTTP
 * failure or { error: <string> } for a Chromium network error. The query
 * string and fragment are dropped by construction: only hostname and
 * pathname are kept.
 */
export function networkLogEntryFor(url, outcome, now = () => Date.now()) {
  if (typeof url !== "string" || !url) return null;
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname ?? "";
  if (!host) return null;
  const entry = { at: now(), host, path: parsed.pathname || "/" };
  if (outcome && typeof outcome.status === "number") {
    entry.status = outcome.status;
  } else if (outcome && typeof outcome.error === "string" && outcome.error) {
    entry.error = outcome.error;
  } else {
    return null;
  }
  return entry;
}

/** A fresh per-page log: just its entries, oldest first. */
export function createPageNetworkLog() {
  return { entries: [] };
}

/** Append an entry, dropping the oldest past the cap. Nulls are ignored. */
export function recordPageNetworkEntry(log, entry) {
  if (!log || !entry) return log;
  log.entries.push(entry);
  while (log.entries.length > PAGE_NETWORK_LOG_CAP) log.entries.shift();
  return log;
}

/** Empty a page's log (toggle-off and page-close both use this). */
export function clearPageNetworkLog(log) {
  if (!log) return log;
  log.entries.length = 0;
  return log;
}
