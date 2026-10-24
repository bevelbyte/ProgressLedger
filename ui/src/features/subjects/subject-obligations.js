/**
 * Subject obligations — pure, deterministic, no Svelte and no IO.
 *
 * SPACE BUNNY DIRECTION. The reference's Space surface leads with "OWED HERE"
 * — the things attached to this space that are not yet done, with the nearest
 * deadline given the loudest position. The subject index, by contrast, was a
 * pure inventory: it listed what exists and said nothing about what any of it
 * still owes you. Those are different questions, and a student opening Spaces
 * is usually asking the second one.
 *
 * EVERY NUMBER HERE IS COUNTED FROM A REAL ROW. Nothing is scored, weighted or
 * inferred. This is deliberate and matches the surrounding code's own rule --
 * `subject.svelte.js` explicitly refuses to render a fabricated progress
 * percentage or a hash-derived "priority", and an obligation strip invented the
 * same way would be a lie with a nicer font.
 *
 * Specifically NOT modelled, because no such data exists:
 *   - subject-to-subject relationships (there is none in the schema at all)
 *   - any notion of a subject's importance or risk
 *   - estimated effort or minutes (deadline rows carry no estimate)
 */

// The date helpers are the Desk's, and are reused rather than reimplemented:
// two copies of "what counts as today" would eventually disagree at midnight.
import { localDayString, dayDelta, classifyDeadline } from "../dashboard/today.js";

/**
 * Fold the profile-wide deadline / card / mistake lists into per-subject
 * obligation counts.
 *
 * All three inputs are optional so one failed fetch degrades to the others
 * rather than blanking the strip. Each row is attributed by `subjectId`, which
 * every one of these sources genuinely carries.
 *
 * @param {object} p
 * @param {Array}  p.deadlines [{id, subjectId, deadlineDate, completedAt}]
 * @param {Array}  p.cards     [{id, subjectId, dueDate}]      flashcards
 * @param {Array}  p.mistakes  [{id, subjectId, resolvedAt}]   the mistake ledger
 * @param {string} p.today     local YYYY-MM-DD, injectable for tests
 * @returns {Map<number, object>} keyed by subjectId
 */
export function buildObligations({ deadlines = [], cards = [], mistakes = [], today = localDayString() } = {}) {
  const by = new Map();

  const entry = (subjectId) => {
    if (subjectId == null) return null;
    let e = by.get(subjectId);
    if (!e) {
      e = { open: 0, late: 0, dueToday: 0, soon: 0, cardsDue: 0, mistakesOpen: 0, nearest: null };
      by.set(subjectId, e);
    }
    return e;
  };

  for (const d of deadlines) {
    if (!d || d.completedAt) continue; // finished work is not an obligation
    const e = entry(d.subjectId);
    if (!e) continue;
    e.open++;
    const bucket = classifyDeadline(d.deadlineDate, today, 7);
    if (bucket === "overdue") e.late++;
    else if (bucket === "today") e.dueToday++;
    else if (bucket === "soon") e.soon++;
    // The nearest dated item drives the "in Nd" / "Nd late" read-out. Only
    // overdue and today rows set it: a deadline eight days out is not what the
    // user needs surfaced on a subject row today.
    const delta = dayDelta(d.deadlineDate, today);
    if (bucket === "overdue" || bucket === "today") {
      if (e.nearest === null || Math.abs(delta) < Math.abs(e.nearest)) {
        e.nearest = delta;
      }
    }
  }

  for (const c of cards) {
    if (!c) continue;
    const e = entry(c.subjectId);
    // A card with no date is not counted: "due" is a claim about a date, and an
    // undated card cannot honestly be counted as due today.
    if (!e || !c.dueDate) continue;
    const bucket = classifyDeadline(c.dueDate, today, 7);
    if (bucket === "overdue" || bucket === "today" || bucket === "soon") e.cardsDue++;
  }

  for (const m of mistakes) {
    if (!m || m.resolvedAt) continue;
    const e = entry(m.subjectId);
    if (e) e.mistakesOpen++;
  }

  return by;
}

/**
 * The single most pressing thing owed, as short text -- or "" when nothing is.
 *
 * Precedence is late > due today > nearest upcoming, because that is the order
 * in which the user would say it out loud.
 */
export function obligationHeadline(e) {
  if (!e) return "";
  if (e.late > 0) return e.late === 1 ? "1 late" : `${e.late} late`;
  if (e.dueToday > 0) return e.dueToday === 1 ? "due today" : `${e.dueToday} due today`;
  if (e.nearest !== null) return e.nearest > 0 ? `in ${e.nearest}d` : "today";
  return "";
}

/** Tone for the obligation read-out: bad / warn / quiet. Never decorative. */
export function obligationTone(e) {
  if (!e) return "quiet";
  if (e.late > 0) return "bad";
  if (e.dueToday > 0) return "warn";
  if (e.open > 0) return "signal";
  return "quiet";
}

/**
 * Portfolio totals for the strip above the list: how much is owed across every
 * subject, not per row.
 */
export function obligationsTotals(by) {
  let open = 0, late = 0, dueToday = 0;
  for (const e of by.values()) {
    open += e.open;
    late += e.late;
    dueToday += e.dueToday;
  }
  return { open, late, dueToday };
}