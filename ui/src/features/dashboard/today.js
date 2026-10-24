/**
 * Pure "Today / Daily Focus" prioritization — no Svelte, no IO, no persistence.
 *
 * Composes data the Dashboard already fetches (deadlines, due flashcards,
 * today's study stats) into a transparent, deterministic priority model. There
 * is NO scoring system and NO new data: every classification is derived from a
 * local-calendar date comparison the user can understand.
 *
 * Date semantics are LOCAL-calendar (matching the rest of CareerFlow, which uses
 * SQLite date('now','localtime')). We compare YYYY-MM-DD day strings, not UTC
 * instants, so "overdue"/"today"/"soon" respect the user's midnight boundary.
 */

/** Local YYYY-MM-DD for a Date (defaults to now). Local, not UTC. */
export function localDayString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Whole-day difference (targetDay - todayDay) using local-calendar dates. */
export function dayDelta(targetDayStr, todayStr = localDayString()) {
  // Parse as local midnights so DST/tz never shifts the day count.
  const [ty, tm, td] = targetDayStr.split("-").map(Number);
  const [ny, nm, nd] = todayStr.split("-").map(Number);
  const target = new Date(ty, tm - 1, td);
  const today = new Date(ny, nm - 1, nd);
  return Math.round((target - today) / 86400000);
}

/**
 * Classify a deadline date relative to today:
 *   "overdue" (before today), "today", "soon" (1..=soonDays), or "later".
 */
export function classifyDeadline(deadlineDate, todayStr = localDayString(), soonDays = 7) {
  const delta = dayDelta(deadlineDate, todayStr);
  if (delta < 0) return "overdue";
  if (delta === 0) return "today";
  if (delta <= soonDays) return "soon";
  return "later";
}

/**
 * Build the Today model from already-fetched data. Inputs are plain arrays/
 * objects; each source is optional so a failed fetch degrades gracefully.
 *
 * @param {object} p
 * @param {Array}  p.deadlines  [{id, title, deadlineDate, category, subjectId, subjectName}]
 * @param {object} p.reviewStats {dueToday, ...} from cards.stats
 * @param {object} p.sessionStats {minutesToday, ...} from sessions.stats
 * @param {string} p.today  local YYYY-MM-DD (injectable for tests)
 * @param {number} p.soonDays
 */
export function buildToday({ deadlines = [], reviewStats = null, sessionStats = null, today = localDayString(), soonDays = 7 } = {}) {
  const overdue = [];
  const dueToday = [];
  const soon = [];

  for (const d of deadlines) {
    if (!d?.deadlineDate) continue;
    // Completed deadlines are historical — they never contribute to attention.
    if (d.completedAt) continue;
    const cls = classifyDeadline(d.deadlineDate, today, soonDays);
    const item = {
      id: d.id,
      title: d.title,
      category: d.category,
      deadlineDate: d.deadlineDate,
      subjectId: d.subjectId,
      subjectName: d.subjectName,
      dayDelta: dayDelta(d.deadlineDate, today),
    };
    if (cls === "overdue") overdue.push(item);
    else if (cls === "today") dueToday.push(item);
    else if (cls === "soon") soon.push(item);
  }

  const byDate = (a, b) => a.deadlineDate.localeCompare(b.deadlineDate);
  overdue.sort(byDate);
  dueToday.sort(byDate);
  soon.sort(byDate);

  const flashcardsDue = Math.max(0, Number(reviewStats?.dueToday) || 0);
  const studyMinutesToday = Math.max(0, Number(sessionStats?.minutesToday) || 0);

  // "Needs attention" = things that are late or due now, or cards to review.
  const attentionCount = overdue.length + dueToday.length + flashcardsDue;

  return {
    overdue,
    dueToday,
    soon,
    flashcardsDue,
    studyMinutesToday,
    attentionCount,
    // True when nothing is overdue/due-today and no cards are due — "caught up".
    caughtUp: attentionCount === 0,
  };
}

/**
 * Flatten the Today model into ONE chronological instrument.
 *
 * The Desk previously rendered overdue and upcoming work as two separate
 * columns, so "what is due" was answered by reading two places and comparing
 * them, and the days between them had no ordering at all. A student's actual
 * question is "what is next, in order". This returns the three buckets of
 * `buildToday` as a single ordered run — overdue oldest-first, then today, then
 * the next seven days — each row carrying the bucket it came from.
 *
 * No new data and no scoring: the order is the order `buildToday` already
 * established, which is the order of the dates themselves.
 *
 * @param {object} model  the object returned by buildToday
 * @param {{ soonLimit?: number }} [options]  cap on the upcoming tail
 */
export function buildAgenda(model = {}, { soonLimit = 6 } = {}) {
  const rows = [];
  const append = (list, state) => {
    for (const item of list ?? []) rows.push({ ...item, state });
  };

  append(model.overdue, "overdue");
  append(model.dueToday, "today");
  append((model.soon ?? []).slice(0, soonLimit), "soon");

  return rows;
}

/**
 * The date gutter for an agenda row — the shortest honest statement of *when*.
 *
 * Relative for the near term (the only term where relative is genuinely easier
 * to read than a date), absolute once "in 6d" stops meaning anything.
 */
export function agendaGutter(row) {
  // `null` must not coerce to 0: `Number(null)` is 0, which would claim "today"
  // for a deadline whose date we do not actually know. Absence stays absent.
  if (row?.dayDelta == null || row.dayDelta === "") return "";
  const delta = Number(row.dayDelta);
  if (!Number.isFinite(delta)) return "";
  if (delta < 0) return `${Math.abs(delta)}d late`;
  if (delta === 0) return "today";
  if (delta === 1) return "tomorrow";
  if (delta <= 7) return `in ${delta}d`;
  return row?.deadlineDate ?? "";
}

/**
 * Human bucket label for an agenda row's state.
 *
 * "today" is deliberately not labelled "Due today" in the gutter AND here —
 * the gutter already says `today`, and repeating it inside the same row is the
 * kind of duplication the agenda replaced.
 */
export function agendaStateLabel(state) {
  if (state === "overdue") return "Overdue";
  if (state === "today") return "Due today";
  if (state === "soon") return "Next 7 days";
  return "";
}

/**
 * A one-line, honest summary of the day. States a fact about the user's own
 * data; never encouragement, never a score.
 */
export function agendaSummary(model = {}) {
  const overdue = model.overdue?.length ?? 0;
  const dueToday = model.dueToday?.length ?? 0;
  const cards = model.flashcardsDue ?? 0;

  const parts = [];
  if (overdue > 0) parts.push(`${overdue} overdue`);
  if (dueToday > 0) parts.push(`${dueToday} due today`);
  if (cards > 0) parts.push(`${cards} card${cards === 1 ? "" : "s"} to review`);

  if (parts.length === 0) return "Nothing is due. Nothing is late.";
  return `${parts.join(" · ")}.`;
}
