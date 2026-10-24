// Pure helpers for the ProviderHealth panel.
//
// Kept out of the .svelte file so the colour thresholds and formatters are
// unit-testable without jsdom. Everything here is a pure function over the
// shape returned by the `provider:health` IPC channel:
//
//   { name, requests, success, errors, errorRate, avgLatencyMs, last429 }

/** Error rate at or above this -> yellow (warn). */
export const HEALTH_WARN_RATE = 0.05;
/** Error rate at or above this -> red (danger). */
export const HEALTH_DANGER_RATE = 0.25;
/** A 429 inside this window -> at least yellow, even with a 0% error rate. */
export const HEALTH_429_WARN_MS = 10 * 60 * 1000;

/**
 * Clamp a provider row's error rate to [0, 1]. Returns 0 for rows with no
 * requests or malformed numbers so the UI never renders NaN/Infinity.
 */
export function providerErrorRate(p) {
  const requests = Number(p && p.requests);
  const errors = Number(p && p.errors);
  if (!Number.isFinite(requests) || !Number.isFinite(errors) || requests <= 0) return 0;
  return Math.max(0, Math.min(1, errors / requests));
}

/**
 * Colour bucket for a provider row.
 *
 *   idle   — no requests recorded yet (grey)
 *   danger — errorRate >= 25%
 *   warn   — any error, or a 429 within the last 10 minutes
 *   ok     — otherwise (green)
 *
 * `nowMs` is injectable so tests can drive the "recent 429" window with
 * fake timers instead of the wall clock.
 *
 * @param {{requests?: number, errors?: number, last429?: (number|null)}|null} p
 * @param {number} [nowMs]
 * @returns {"idle"|"ok"|"warn"|"danger"}
 */
export function classifyProviderHealth(p, nowMs = Date.now()) {
  if (!p) return "idle";
  const requests = Number(p.requests) || 0;
  if (requests <= 0) return "idle";
  const rate = providerErrorRate(p);
  if (rate >= HEALTH_DANGER_RATE) return "danger";
  if (rate > 0) return "warn";
  const since429 = p.last429 == null ? null : nowMs - Number(p.last429);
  if (since429 != null && since429 >= 0 && since429 <= HEALTH_429_WARN_MS) return "warn";
  return "ok";
}

/**
 * Human-friendly label for a status bucket. Unknown buckets collapse to
 * "idle" rather than echoing a raw string into the UI.
 *
 * @param {string} status
 * @returns {string}
 */
export function statusLabel(status) {
  switch (status) {
    case "ok": return "ok";
    case "warn": return "warn";
    case "danger": return "danger";
    case "error": return "error";
    default: return "idle";
  }
}

/**
 * Format a latency in ms. Sub-second reads as "123 ms", larger reads as
 * "1.24 s". Null / non-finite -> em dash.
 */
export function formatLatencyMs(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Format a provider row's error rate as a percentage. Rows with no
 * requests render as an em dash so the caller can distinguish "no data"
 * from a genuine "0.0%".
 */
export function formatErrorRate(p) {
  if ((Number(p && p.requests) || 0) <= 0) return "—";
  return `${(providerErrorRate(p) * 100).toFixed(1)}%`;
}

/**
 * Relative time for the "last 429" cell. `null`/never-recorded renders as
 * "never" rather than an empty string.
 */
export function formatAgo(ts, nowMs = Date.now()) {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "never";
  const diff = Math.max(0, nowMs - ts);
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/** Thousands-separated integer ("50,000") or an em dash for non-numbers. */
export function formatNumber(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US");
}
