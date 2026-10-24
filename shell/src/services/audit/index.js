// Project Mode — security audit log.
//
// SOLE place where tool invocations and provider calls are recorded. Lives
// in the main process; the renderer can read it via `audit:list` but never
// writes to it.
//
// Storage: append-only JSONL at `<userData>/audit-log.jsonl`. A 50k-line
// ring cap rotates the live file to `<userData>/audit-log.jsonl.1` once
// the threshold is crossed. Old rotated files are pruned by the in-memory
// ring (no rotation chain — only the live + one backup).
//
// Failure model: NOTHING here throws. A disk failure, a JSON.stringify
// error on a giant `detail`, or a permission error all fall through to
// `log_debug()` (a console.trace) and the calling operation succeeds.

import { appendFile, mkdir, rename, readFile, writeFile, stat, unlink, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

// ---- configuration -------------------------------------------------------

const MAX_LINES = 50_000;
const ROTATED_NAME = "audit-log.jsonl.1";
const LIVE_NAME = "audit-log.jsonl";
// Configurable retention policy. The defaults match the prior hard-coded
// behaviour so existing tests stay green; profile_config can override
// via the `audit:set-retention` IPC channel at runtime.
const DEFAULT_RETENTION = { days: 30, count: MAX_LINES };
const MAX_FIELD_CHARS = 4096;
// Hourly prune cadence. The job runs in the background; it never
// blocks the synchronous Audit.log() writer.
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

// ---- retention policy (module-scoped) ------------------------------------

let retention = { ...DEFAULT_RETENTION };
let pruneTimer = null;

/** Read the current retention policy. Returns a copy so callers can't mutate it. */
export function _getRetention() {
  return { days: retention.days, count: retention.count };
}

/**
 * Replace the retention policy. Clamps the values to safe ranges so a
 * misconfigured renderer can't disable audit retention entirely.
 *
 * @param {{ days?: number, count?: number }} next
 */
export function _setRetention(next = {}) {
  const days = Number(next.days);
  const count = Number(next.count);
  const out = {
    days: Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 3650) : retention.days,
    count: Number.isFinite(count) && count > 0 ? Math.min(Math.floor(count), 1_000_000) : retention.count,
  };
  retention = out;
  // Shrink the live ring immediately if the new cap is lower than the
  // current ring length. Growing the cap takes effect on the next push.
  if (state && state.started && state.ring.length > retention.count) {
    state.ring = state.ring.slice(-retention.count);
  }
  return { ...retention };
}

/** Reset retention to defaults (default 30 days / 50_000 count). */
export function _resetRetention() {
  retention = { ...DEFAULT_RETENTION };
}

// ---- state (module-scoped, swappable via _setStateForTests) --------------

let state = null;

function makeFreshState(filePath) {
  return {
    filePath,
    ring: [],      // last `retention.count` events, in-memory; the JSONL is the source of truth
    lineCount: 0,  // monotonically increasing total lines written (capped at MAX_LINES)
    started: false,
    inflight: [],  // array of pending persist() promises (awaited by flush())
  };
}

// ---- public API -----------------------------------------------------------

export const Audit = {
  /**
   * Initialize the sidecar store. Idempotent — calling start() a second
   * time reloads from disk so tests can persist-then-restart cleanly.
   *
   * @param {string} filePath absolute path to audit-log.jsonl
   */
  async start(filePath) {
    try {
      if (typeof filePath !== "string" || !filePath) {
        state = makeFreshState(null);
        state.started = true;
        schedulePrune();
        return;
      }
      state = makeFreshState(filePath);
      await mkdir(dirname(filePath), { recursive: true });
      // Reload existing lines so the in-memory ring is consistent with
      // the on-disk file across restarts. Cap is enforced on read so
      // we keep the last `retention.count` entries even if the file
      // was rotated.
      if (existsSync(filePath)) {
        const text = await readFile(filePath, "utf8").catch(() => "");
        const raw = text ? text.split("\n").filter((l) => l.length > 0) : [];
        const readCap = Math.max(retention.count, MAX_LINES);
        const tail = raw.length > readCap ? raw.slice(raw.length - readCap) : raw;
        const ring = [];
        for (const line of tail) {
          try {
            const ev = JSON.parse(line);
            ring.push(ev);
          } catch (_e) {
            // skip malformed line — never let a bad row crash the audit
          }
        }
        state.ring = ring;
        state.lineCount = ring.length;
      }
      state.started = true;
      schedulePrune();
    } catch (e) {
      log_debug("audit.start failed:", e);
      // Stay operational; subsequent log() calls just won't persist.
      state = state || makeFreshState(null);
      state.started = true;
      schedulePrune();
    }
  },

  /** Tear down (used in tests). */
  async stop() {
    // Wait for any in-flight persist() writes to complete so the file
    // is durable on disk before we tear the in-memory ring down.
    if (state && state.inflight && state.inflight.length > 0) {
      try {
        await Promise.allSettled(state.inflight.slice());
      } catch (_e) { /* never throw from stop() */ }
    }
    if (pruneTimer) {
      try { clearInterval(pruneTimer); } catch (_e) { /* best effort */ }
      pruneTimer = null;
    }
    state = null;
  },

  /**
   * Await any in-flight writes. The next log() call adds new ones.
   * Useful for tests + for graceful-shutdown handlers.
   */
  async flush() {
    if (!state) return;
    if (state.inflight && state.inflight.length > 0) {
      try { await Promise.allSettled(state.inflight.slice()); }
      catch (_e) { /* never throw */ }
    }
  },

  /** Append an event. MUST NOT throw. */
  log(event) {
    try {
      if (!state || !state.started) return;
      const ev = normalize(event);
      if (!ev) return; // normalization rejected it (malformed)
      // In-memory ring first (synchronous, so recent()/list() reflect
      // the call instantly even before the disk write completes).
      // The cap honours the live retention policy; shrinking it via
      // `audit:set-retention` takes effect on the very next push.
      const ringCap = retention.count;
      state.ring.push(ev);
      state.lineCount += 1;
      if (state.ring.length > ringCap) state.ring.splice(0, state.ring.length - ringCap);
      // Track the in-flight persist so flush() / stop() can await it.
      const p = persist(ev).catch(() => {});
      state.inflight.push(p);
      // Best-effort cleanup; we don't grow the array unboundedly.
      if (state.inflight.length > 256) state.inflight = state.inflight.slice(-64);
    } catch (e) {
      log_debug("audit.log failed:", e);
    }
  },

  /** Last N events (most recent first). Default 100. */
  recent(n = 100) {
    if (!state) return [];
    const size = Math.max(0, Math.min(Number(n) || 0, state.ring.length));
    if (size === 0) return [];
    return state.ring.slice(-size).reverse();
  },

  /**
   * Filtered + paged query. Returns events in reverse chronological
   * order (newest first). Caller may scope by event name, profileId,
   * and a time window. `limit` is clamped to 200.
   */
  list({ event, profileId, since, until, limit = 100 } = {}) {
    if (!state) return [];
    const cap = Math.max(0, Math.min(Number(limit) || 0, 200));
    const out = [];
    for (let i = state.ring.length - 1; i >= 0 && out.length < cap; i--) {
      const ev = state.ring[i];
      if (event && ev.event !== event) continue;
      if (typeof profileId === "number" && ev.profileId !== profileId) continue;
      if (typeof since === "number" && ev.ts < since) continue;
      if (typeof until === "number" && ev.ts > until) continue;
      out.push(ev);
    }
    return out;
  },

  /** Absolute path to the JSONL file (or null if start() not yet called). */
  filePath() {
    return state ? state.filePath : null;
  },
};

// ---- helpers --------------------------------------------------------------

/**
 * Normalize + redact an event into the canonical shape. Returns null on
 * inputs we refuse (e.g. event is not a string). The redaction step runs
 * BEFORE the event reaches the disk so an API key can't sneak in through
 * a tool's `input_summary` or `detail`.
 */
function normalize(event) {
  if (!event || typeof event !== "object") return null;
  const ev = String(event.event || "");
  if (!ev) return null;
  const out = {
    ts: typeof event.ts === "number" && Number.isFinite(event.ts) ? event.ts : Date.now(),
    event: ev.slice(0, 128),
    profileId: typeof event.profileId === "number" ? event.profileId : null,
    projectId: typeof event.projectId === "number" ? event.projectId : null,
    agentId: typeof event.agentId === "number" ? event.agentId : null,
    tool: typeof event.tool === "string" ? event.tool.slice(0, 256) : null,
    input_summary: typeof event.input_summary === "string" ? redact(event.input_summary).slice(0, MAX_FIELD_CHARS) : null,
    result: typeof event.result === "string" ? event.result.slice(0, MAX_FIELD_CHARS) : null,
    durationMs: typeof event.durationMs === "number" && Number.isFinite(event.durationMs)
      ? event.durationMs : null,
    detail: typeof event.detail === "string" ? redact(event.detail).slice(0, MAX_FIELD_CHARS) : null,
  };
  return out;
}

// Patterns we strip before persisting. The keys we redact:
//   * labelled fields: apiKey / API_KEY / api_key / apikey,
//     password / passwd / pwd, authorization
//   * Authorization: Bearer ... header values
//   * provider token shapes: OpenAI sk-..., GitHub ghp_..., AWS AKIA...,
//     Stripe sk_live_...
//   * URL query params: token=, api_key=, secret=
//   * a stray "sk-..." or "Bearer <token>" appearing in free text
// Key/value pattern. Case-insensitive flag covers API_KEY / apiKey / apikey.
// Bare-token path excludes `<` and `>` so an existing `<redacted>` marker
// becomes a natural stop point (otherwise a previously-redacted value
// would be re-consumed by this pattern).
const SECRET_KEY_RE = /\b(api_?key|apikey|authorization|password|passwd|pwd)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,}\]<]+)/gi;
// Authorization header values:
//   * "Authorization: Bearer <token>" / "authorization: Bearer <token>"
//     (the entire value, including "Bearer", is consumed in one shot)
//     Case-insensitive for "Bearer"; allows spaces so multi-word tokens
//     (e.g. "Bearer secret_token_here") are fully redacted.
//   * "authorization=<token>" / "Authorization: <token>" without Bearer
//     OR "Authorization: Basic <base64>" (value may contain a single space).
// Group 1 = the key name, group 2 = the value (or "Bearer <token>").
// For the generic (no-Bearer) path, the value is either quoted OR a
// non-quoted run that may contain one space (Basic auth, Digest) but
// stops at end-of-line / comma / brace / bracket.
const AUTH_HEADER_BEARER_RE = /\b(authorization)\b\s*[:=]\s*Bearer\s+[^\s,}\]"']*/gi;
// Skip when the value already starts with `<` (i.e. it was redacted by
// the Bearer pattern above) so we don't append a duplicate `<redacted>`.
// Match: quoted, or a non-quoted run that may include one space (Basic).
const AUTH_HEADER_RE = /\b(authorization)\b\s*[:=]\s*("[^"]*"|'[^']*'|(?!<)(?:[^\s,}\]<]+(?:\s+[^\s,}\]<]+)?))/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-]+/g;
// OpenAI-style secret key: "sk-" prefix followed by at least 16 alnum/_/-.
const SK_RE = /\bsk-[A-Za-z0-9_-]{16,}\b/g;
// GitHub personal access token: "ghp_" + 36 alnum.
const GHP_RE = /\bghp_[A-Za-z0-9]{36}\b/g;
// AWS access key id: "AKIA" + 16 uppercase alnum.
const AWS_RE = /\bAKIA[0-9A-Z]{16}\b/g;
// Stripe live secret key: "sk_live_" + 24+ alnum.
const STRIPE_RE = /\bsk_live_[A-Za-z0-9]{24,}\b/g;
// URL query params carrying secrets.
const URL_PARAM_RE = /([?&])(token|api_key|apikey|secret|secret_key|access_token|password)=([^&\s"]+)/gi;

function redact(s) {
  if (s == null) return null;
  if (typeof s !== "string") s = String(s);
  let out = s;
  // URL query params first — covers api_key=sk-... and similar, so the
  // provider-shaped regexes below don't have to chase into the URL body.
  out = out.replace(URL_PARAM_RE, (_m, sep, name) => `${sep}${name}=<redacted>`);
  // Order matters: more specific provider shapes first so we don't
  // shadow them with the generic sk- matcher.
  out = out.replace(STRIPE_RE, "sk_live_<redacted>");
  out = out.replace(GHP_RE, "ghp_<redacted>");
  out = out.replace(AWS_RE, "AKIA<redacted>");
  out = out.replace(SK_RE, "sk-<redacted>");
  // Bare Authorization header value (without "Bearer" prefix).
  out = out.replace(AUTH_HEADER_BEARER_RE, (_m, key) => `${key}: <redacted>`);
  // Generic Authorization: <value> (no Bearer prefix).
  out = out.replace(AUTH_HEADER_RE, (_m, key) => `${key}: <redacted>`);
  // Keyed fields (apiKey / password / etc.) — replaces both quoted and bare.
  out = out.replace(SECRET_KEY_RE, (_m, key) => `${key}: <redacted>`);
  // Bare "Bearer <token>" anywhere in the text.
  out = out.replace(BEARER_RE, "Bearer <redacted>");
  return out;
}

/** Best-effort disk write. Swallows every error. */
async function persist(ev) {
  if (!state || !state.filePath) return;
  try {
    const line = JSON.stringify(ev);
    await appendFile(state.filePath, line + "\n", "utf8");
    // Rotate once the on-disk line count crosses the cap.
    if (state.lineCount > MAX_LINES) {
      const rotated = join(dirname(state.filePath), ROTATED_NAME);
      try { await unlink(rotated); } catch (_e) { /* best effort */ }
      try { await rename(state.filePath, rotated); } catch (_e) {
        // If rename fails (e.g. file open elsewhere), we keep the live
        // file growing; rotation is best-effort, never blocking.
        log_debug("audit rotate failed:", _e);
      }
      state.lineCount = 0;
    }
  } catch (e) {
    log_debug("audit.persist failed:", e);
  }
}

function log_debug(...args) {
  // The audit log never throws. Diagnostic breadcrumbs go to the
  // console only — the existing logger.js is append-only and we don't
  // want a failed audit to cascade into the main diagnostics stream.
  try {
    // eslint-disable-next-line no-console
    if (typeof console !== "undefined" && console.debug) console.debug(...args);
  } catch (_e) {
    /* truly unreachable */
  }
}

// ---- prune job (best-effort, never blocks the writer) ---------------------

/**
 * Start the hourly prune interval if it isn't already running. Safe to
 * call repeatedly — a single timer covers all start() cycles for the
 * life of the process. clearInterval() happens in stop().
 */
function schedulePrune() {
  if (pruneTimer) return;
  try {
    pruneTimer = setInterval(() => {
      prune().catch(() => { /* never throw out of the interval */ });
    }, PRUNE_INTERVAL_MS);
    // Node will keep the process alive only because of this timer; mark
    // it as "don't keep alive" so it doesn't block a clean shutdown.
    if (pruneTimer && typeof pruneTimer.unref === "function") pruneTimer.unref();
  } catch (_e) {
    pruneTimer = null;
  }
}

/**
 * Drop events older than `retention.days`, but only after the ring has
 * exceeded `retention.count` (so we don't churn the disk when traffic
 * is low). The prune runs against the in-memory ring synchronously and
 * the on-disk JSONL asynchronously so the audit writer is never
 * blocked.
 *
 * Returns the number of events pruned (0 if nothing to prune).
 */
export async function prune() {
  if (!state || !state.started) return 0;
  const before = state.ring.length;
  if (before === 0) return 0;
  const cutoff = Date.now() - retention.days * 24 * 60 * 60 * 1000;
  // Only prune if we're past the count cap OR the oldest event is
  // older than the retention window. Avoids churning the file when
  // the ring is well within its cap and time window.
  const oldest = state.ring[0];
  const oldestTs = oldest && typeof oldest.ts === "number" ? oldest.ts : 0;
  if (before < retention.count && oldestTs >= cutoff) return 0;
  const kept = state.ring.filter((ev) => ev && typeof ev.ts === "number" && ev.ts >= cutoff);
  state.ring = kept;
  const removed = before - kept.length;
  // Rebuild the on-disk JSONL so the rotated file matches the live ring.
  // Best-effort: failures stay diagnostic, never throw.
  if (state.filePath && removed > 0) {
    try {
      const lines = kept.map((ev) => JSON.stringify(ev)).join("\n");
      await writeFile(state.filePath, lines ? lines + "\n" : "", "utf8");
      state.lineCount = kept.length;
    } catch (e) {
      log_debug("audit.prune rewrite failed:", e);
    }
  }
  return removed;
}

// ---- test helpers ---------------------------------------------------------

/**
 * Replace the module's state. Used by tests that want a clean ring
 * without touching the disk. Always call with `{ filePath: null }` in
 * tests that don't need persistence so the rotate / file-write paths
 * stay no-ops.
 */
export function _setStateForTests(partial = {}) {
  state = Object.assign(makeFreshState(partial.filePath ?? null), partial);
  state.started = true;
}

/** Reset to a clean, uninitialised state. */
export function _resetForTests() {
  state = null;
  if (pruneTimer) {
    try { clearInterval(pruneTimer); } catch (_e) { /* best effort */ }
    pruneTimer = null;
  }
}

/** Used by the IPC export handler to count disk-resident lines. */
export async function _sizeOnDisk(filePath) {
  try {
    if (!filePath || !existsSync(filePath)) return { exists: false, bytes: 0 };
    const info = await stat(filePath);
    const dir = dirname(filePath);
    const files = await readdir(dir).catch(() => []);
    const hasBackup = files.includes(ROTATED_NAME);
    return { exists: true, bytes: info.size, hasBackup };
  } catch (e) {
    log_debug("audit._sizeOnDisk failed:", e);
    return { exists: false, bytes: 0 };
  }
}

export const _INTERNAL = { MAX_LINES, ROTATED_NAME, LIVE_NAME, redact, DEFAULT_RETENTION, PRUNE_INTERVAL_MS };