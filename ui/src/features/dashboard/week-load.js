/**
 * "The week" load instrument — pure, deterministic, no Svelte and no IO.
 *
 * SPACE BUNNY DIRECTION. In the reference the Desk pairs its ranked "Decide"
 * queue with a seven-column load readout beside it: one column per day, a bar
 * whose height is that day's committed load, the day label, the load figure,
 * and either "N items" or "clean". Two panels side by side answer two different
 * questions -- "what should I do first" and "is this week survivable" -- and
 * neither can answer the other. Progress Ledger had only the first.
 *
 * WHY THE LOAD IS A COUNT AND NOT MINUTES. The reference measures minutes
 * because it schedules real sessions. Progress Ledger's deadline rows carry no
 * estimate field, so inventing one would be fabrication on the front door. A
 * day's load is therefore its number of open items, and the figure under the
 * bar is that count. Honest, and still the thing the user is asking about.
 *
 * Date semantics are LOCAL calendar, matching today.js and the rest of
 * Progress Ledger (SQLite date('now','localtime')). Days are compared as
 * YYYY-MM-DD strings, never as UTC instants, so "today" respects the user's
 * midnight boundary.
 */

/** Local YYYY-MM-DD for a Date. Local, not UTC. */
export function localDay(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * The seven days starting at `todayStr`, in order, with their short labels.
 *
 * The first column is always "today" regardless of weekday, because the column
 * is a position in the user's near future rather than a name for a weekday --
 * the reference does the same. The remaining six are labelled by weekday
 * initial, which is what keeps seven columns legible at a narrow width.
 */
export function weekDays(todayStr = localDay()) {
  const [y, m, d] = todayStr.split("-").map(Number);
  const base = new Date(y, m - 1, d);
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(base);
    date.setDate(base.getDate() + i);
    return {
      date: localDay(date),
      label: i === 0 ? "TODAY" : String(date.getDay()).slice(0, 3).toUpperCase(),
      offset: i,
    };
  });
}

/**
 * Bucket a day's open-item count into the three tones the reference uses.
 *
 *   clean — nothing open
 *   light — 1 item
 *   full  — 2..3 items
 *   heavy — 4 or more
 *
 * The thresholds are deliberately coarse. This is a glanceable pressure
 * indicator, not a chart, and a seven-bin scale would invite reading precision
 * into it that it does not have.
 */
export function loadTone(count) {
  if (count <= 0) return "clean";
  if (count === 1) return "light";
  if (count <= 3) return "full";
  return "heavy";
}

/**
 * Build the seven-day load model from the deadlines the Desk already fetched.
 *
 * Only OPEN work counts: a completed deadline is work the user finished, and
 * showing it as load would make a finished week look like a heavy one. Items
 * dated outside the window are ignored entirely rather than clamped into the
 * first or last column, because a clamped bar would claim work belongs to a day
 * it does not belong to.
 *
 * @param {object} p
 * @param {Array}  p.deadlines [{id, deadlineDate, completedAt}]
 * @param {string} p.todayStr  local YYYY-MM-DD, injectable for tests
 */
export function buildWeekLoad({ deadlines = [], todayStr = localDay() } = {}) {
  const days = weekDays(todayStr);
  const byDate = new Map(days.map((d) => [d.date, 0]));

  for (const d of deadlines) {
    if (!d || d.completedAt) continue;
    if (!d.deadlineDate) continue;
    if (byDate.has(d.deadlineDate)) {
      byDate.set(d.deadlineDate, byDate.get(d.deadlineDate) + 1);
    }
  }

  const columns = days.map((d) => {
    const count = byDate.get(d.date) ?? 0;
    return { ...d, count, tone: loadTone(count) };
  });

  // The bar height is relative to the busiest day in THIS window, so a light
  // week still reads as a shape rather than collapsing to seven identical
  // stubs. Guard the divide: an entirely clear week would otherwise be NaN.
  const peak = columns.reduce((m, c) => Math.max(m, c.count), 0);
  return {
    columns: columns.map((c) => ({
      ...c,
      // A lone item on an otherwise empty week still needs to be visible, so
      // the floor is 8% rather than 0.
      pct: peak > 0 ? Math.max(8, Math.round((c.count / peak) * 100)) : 0,
    })),
    peak,
    total: columns.reduce((n, c) => n + c.count, 0),
    // "Clean" is a fact worth stating once, in the panel's own words.
    isClear: columns.every((c) => c.count === 0),
  };
}