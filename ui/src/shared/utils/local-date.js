/**
 * Local-calendar date/time helpers.
 *
 * CareerFlow's storage convention is LOCAL calendar strings
 * ("YYYY-MM-DD" / "YYYY-MM-DD HH:MM:SS"). Never feed these `toISOString()` —
 * that is a UTC instant and silently shifts late-evening rows to another day
 * (the midnight bug class this guards against).
 */

/** "YYYY-MM-DD" for a Date in LOCAL time. */
export function todayLocalISO(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** "YYYY-MM-DD HH:MM:SS" for a Date in LOCAL time (SQLite-friendly). */
export function toLocalTimestamp(date = new Date()) {
  return `${todayLocalISO(date)} ${date.toTimeString().slice(0, 8)}`;
}

/**
 * Format a stored timestamp for display, tolerating anything.
 *
 * Vault metadata, backup manifests and settings files are plain JSON on the
 * user's own disk, so they are the one place in this app where a value can be
 * missing, truncated or hand-edited. `new Intl.DateTimeFormat().format(new
 * Date(value))` throws a RangeError on an unparseable value, and that throw
 * happens during render — which blanks the whole surface, not just the row.
 *
 * A timestamp we cannot read is a fact worth stating ("Unknown"), never a
 * reason to lose the screen. Non-date garbage is rendered verbatim, which
 * keeps a diagnosable value on screen instead of discarding it.
 *
 * @param {unknown} value  ISO string, epoch ms, Date, or junk
 * @param {{ fallback?: string, style?: object }} [options]
 */
export function formatTimestamp(value, options = {}) {
  const { fallback = "—", style } = options;
  if (value == null || value === "") return fallback;

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return typeof value === "string" && value.trim() !== "" ? value : "Unknown";
  }
  if (!Number.isFinite(date.getTime())) return fallback;

  return new Intl.DateTimeFormat(
    undefined,
    style ?? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
  ).format(date);
}

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;
const WEEK = 604800;

/**
 * Compact elapsed-time label: "12s ago" … "3d ago", then a date.
 *
 * Was copy-pasted into six surfaces with six slightly different rules (one
 * returned "" for junk, another printed "Invalid Date", a third used a
 * different week cutoff), so the same event read differently depending on
 * which panel you happened to be looking at.
 *
 * `null` for an unreadable value: callers render their own placeholder, and a
 * dash is a presentation choice this helper should not make for them.
 *
 * @param {unknown} value ISO string, epoch ms, or Date
 * @param {{ now?: number }} [options]  `now` is injectable for tests
 * @returns {string | null}
 */
export function timeAgo(value, options = {}) {
  if (value == null || value === "") return null;

  let ms;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === "number") ms = value;
  else {
    // Storage uses local "YYYY-MM-DD HH:MM:SS". `Date.parse` treats that as
    // UTC on some engines and local on others; a space-form string is parsed
    // as LOCAL deliberately, matching todayLocalISO().
    const text = String(value).trim();
    ms = /^\d{4}-\d{2}-\d{2} /.test(text)
      ? new Date(text.replace(" ", "T")).getTime()
      : Date.parse(text);
  }
  if (!Number.isFinite(ms)) return null;

  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const seconds = Math.max(0, (now - ms) / 1000);

  if (seconds < MINUTE) return "just now";
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m ago`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h ago`;
  if (seconds < WEEK) return `${Math.floor(seconds / DAY)}d ago`;
  return new Date(ms).toLocaleDateString();
}
