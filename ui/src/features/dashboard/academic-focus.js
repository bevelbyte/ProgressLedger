/**
 * Academic Focus — pure, deterministic subject-level attention list.
 *
 * Sits alongside today.js / weekly-plan.js. The Dashboard owns when to call
 * this; this module owns ONLY the prioritization. No Svelte, no IPC, no
 * persistence, no Date objects beyond local-calendar strings.
 *
 * ----- Contract -----
 * buildAcademicFocus({
 *   subjects,    [{id, name, code?, status}]                // pending | in_progress only are scored
 *   deadlines,   [{id, subjectId, subjectName, deadlineDate, completedAt, title, category}]
 *   sessions,    [{subjectId, startedAt}]                    // local YYYY-MM-DD[ T]HH:MM:SS
 *   cards,       [{subjectId, dueDate}]                      // local YYYY-MM-DD
 *   mistakes,    [{subjectId, createdAt}]                    // local YYYY-MM-DD[ T]HH:MM:SS
 *   today,       "YYYY-MM-DD"                               // injectable for tests
 *   now?         "YYYY-MM-DDTHH:MM:SS" local                // for "recent mistakes" window
 *   options?     { maxResults, inactivityDays, soonWindows, recentMistakeWindowDays }
 * })
 *  -> {
 *       items: [
 *         {
 *           subjectId, subjectName, code,
 *           score, reason, signals: [...], actions: [...]
 *         }
 *       ],
 *       empty: bool,    // true when no recommendation is needed
 *       message: string // human-readable summary, e.g. "Nothing urgent."
 *     }
 *
 * ----- Design rules (do not change without re-running the full gate) -----
 * 1. The score is the SUM of a small set of positive point contributions.
 *    There is NO negative scoring, NO weighting changes per category, NO
 *    machine-derived thresholds. Every contribution is a named signal that
 *    the tests assert on.
 * 2. Subjects whose status is "done" are NEVER recommended. A done subject
 *    is by definition not something the student should pay attention to.
 * 3. Completed deadlines are excluded. The completed_at check matches
 *    deadlines.js / today.js / weekly-plan.js.
 * 4. Tie-break order is deterministic: score desc -> earliest-overdue-date
 *    asc (overdue > today > sooner; missing deadline uses the date of the
 *    earliest unfinished deadline the subject owns) -> subjectId asc.
 * 5. The "reason" string is composed from the actual signals (no synthetic
 *    language like "high priority" or "important"). The tests pin the exact
 *    strings so the UI never drifts from the data.
 * 6. Actions are enumerated, not invented: ["openSubject", "openRecall"].
 *    The UI may hide an action that it cannot route, but the algorithm
 *    never offers an action it cannot name.
 * 7. There is NO random, NO hash, NO priority-override input. Two callers
 *    with identical inputs get a byte-identical result.
 */

import { localDayString, dayDelta } from "./today.js";

// --- Local helpers (no Date objects beyond day strings) -------------------

/**
 * Convert a session/mistake timestamp to a local YYYY-MM-DD. Accepts both
 * the SQLite "YYYY-MM-DD HH:MM:SS" form and the ISO "YYYY-MM-DDTHH:MM:SS"
 * form. The shell writes localtime timestamps without TZ, so we DO NOT
 * coerce through Date (Date would reinterpret as local and shift the day).
 */
function datePartOf(timestamp) {
  if (!timestamp) return null;
  const s = String(timestamp);
  // Take the first 10 chars of the prefix before any T or space.
  const spaceOrT = s.search(/[ T]/);
  return spaceOrT === -1 ? s.slice(0, 10) : s.slice(0, spaceOrT);
}

/**
 * Add N whole days to a YYYY-MM-DD string, returning YYYY-MM-DD.
 * Uses noon-local Date arithmetic to avoid DST off-by-one at the boundary.
 */
function addDays(dayStr, n) {
  const [y, m, d] = dayStr.split("-").map(Number);
  const t = new Date(y, m - 1, d, 12, 0, 0, 0);
  t.setDate(t.getDate() + n);
  return localDayString(t);
}

// --- Signal extractors ----------------------------------------------------

/**
 * Per-subject deadline stats. Only ACTIVE (not completed) deadlines count.
 * Returns:
 *   {
 *     [subjectId]: {
 *       overdue: [{date, title, daysOverdue}],
 *       today:   [{date, title}],
 *       soon:    [{date, title}],            // 1..=soonDays
 *       later:   [{date, title}],            // 8..=14
 *       earliest: "YYYY-MM-DD" or null       // earliest unfinished deadline date
 *     }
 *   }
 */
function bucketDeadlinesBySubject(deadlines, today, soonDays, laterDays) {
  const by = new Map();
  for (const d of deadlines || []) {
    if (!d || d.completedAt) continue; // completed deadlines never contribute
    if (!d.subjectId) continue;
    if (!d.deadlineDate) continue;
    const delta = dayDelta(d.deadlineDate, today);
    // Far-future deadlines (> laterDays) do not contribute; they would
    // create noise and a "task list" feel. The user can still see them
    // in the regular This Week / Semester views.
    if (delta > laterDays) continue;
    let bucket;
    if (delta < 0) bucket = "overdue";
    else if (delta === 0) bucket = "today";
    else if (delta <= soonDays) bucket = "soon";
    else bucket = "later";
    let s = by.get(d.subjectId);
    if (!s) {
      s = { overdue: [], today: [], soon: [], later: [], earliest: null };
      by.set(d.subjectId, s);
    }
    s[bucket].push({
      date: d.deadlineDate,
      title: d.title,
      daysOverdue: delta,
    });
    if (
      s.earliest === null ||
      d.deadlineDate < s.earliest
    ) {
      s.earliest = d.deadlineDate;
    }
  }
  // Sort each bucket deterministically by date asc, then title asc.
  const byDate = (a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title);
  for (const s of by.values()) {
    s.overdue.sort(byDate);
    s.today.sort(byDate);
    s.soon.sort(byDate);
    s.later.sort(byDate);
  }
  return by;
}

/**
 * Latest session date per subject, computed from raw session rows. Sessions
 * with startedAt on or after today count as recent (a session started today
 * reduces the inactivity signal).
 */
function lastSessionBySubject(sessions) {
  const by = new Map(); // subjectId -> { lastDate, recent }
  for (const s of sessions || []) {
    if (!s || !s.subjectId) continue;
    const date = datePartOf(s.startedAt);
    if (!date) continue;
    const cur = by.get(s.subjectId);
    if (!cur || date > cur.lastDate) by.set(s.subjectId, { lastDate: date });
  }
  return by;
}

/**
 * Per-subject card-due count. We deliberately do NOT surface individual
 * cards — the UI just needs a number to decide whether to show the
 * "Review" action.
 */
function cardsDueBySubject(cards, today) {
  const by = new Map();
  for (const c of cards || []) {
    if (!c || !c.subjectId || !c.dueDate) continue;
    if (c.dueDate > today) continue;
    by.set(c.subjectId, (by.get(c.subjectId) || 0) + 1);
  }
  return by;
}

/**
 * Recent mistake count per subject. The "recent" window is small (default
 * 14 days) so an old mistake made during exam season last year does not
 * haunt today's list.
 */
function recentMistakesBySubject(mistakes, today, windowDays) {
  const cutoff = addDays(today, -windowDays);
  const by = new Map();
  for (const m of mistakes || []) {
    if (!m || !m.subjectId) continue;
    const date = datePartOf(m.createdAt);
    if (!date) continue;
    if (date < cutoff || date > today) continue;
    by.set(m.subjectId, (by.get(m.subjectId) || 0) + 1);
  }
  return by;
}

// --- Score & reason composition -------------------------------------------

const POINTS = Object.freeze({
  // Hard urgency. Overdue is the single strongest signal in the system.
  overdueDeadline: 100,
  // A deadline today is critical but not overdue.
  deadlineToday: 60,
  // Within 1..=3 days: significant.
  deadlineSoon3: 30,
  // 4..=7 days: present, but softer.
  deadlineSoon7: 12,
  // 8..=14 days: only a baseline pull, not a steer.
  deadlineLater: 4,
  // Spaced repetition pressure.
  cardsDue: 20,
  // Recent mistake density. The mistakes table is the one place where the
  // student admits they got it wrong — treating that as a signal respects
  // their own input rather than fabricating a difficulty score.
  recentMistakesLow: 8,   // >=1 in the window
  recentMistakesHigh: 15, // >=3 in the window (strict superset of low)
  // Study inactivity. Only counted if there is at least some session history
  // for the profile, so a brand-new subject does not get recommended for
  // "no study" before the student has even opened it.
  studyInactive: 10,
});

function scoreSubject(
  subjectId,
  dl,
  lastSession,
  cardsDue,
  mistakesRecent,
  today,
  inactivityDays,
  hasAnySession
) {
  const signals = [];
  let score = 0;

  if (dl && dl.overdue.length > 0) {
    score += POINTS.overdueDeadline;
    signals.push({
      kind: "overdue_deadline",
      count: dl.overdue.length,
    });
  }
  if (dl && dl.today.length > 0) {
    score += POINTS.deadlineToday;
    signals.push({
      kind: "deadline_today",
      count: dl.today.length,
    });
  }
  if (dl && dl.soon.length > 0) {
    // Two tiers inside the 1..=7 window so a deadline tomorrow outranks one
    // in a week. The test suite pins both tiers.
    const within3 = dl.soon.filter((d) => dayDelta(d.date, today) <= 3);
    if (within3.length > 0) {
      score += POINTS.deadlineSoon3;
      signals.push({ kind: "deadline_within_3_days", count: within3.length });
    }
    if (dl.soon.length > within3.length) {
      score += POINTS.deadlineSoon7;
      signals.push({
        kind: "deadline_within_7_days",
        count: dl.soon.length - within3.length,
      });
    }
  }
  if (dl && dl.later.length > 0) {
    // Only count a single "later" bucket pull so a backlog of far-future
    // items does not flood the list. The cap is per-subject.
    score += POINTS.deadlineLater;
    signals.push({ kind: "deadline_within_14_days", count: dl.later.length });
  }

  if (cardsDue && cardsDue > 0) {
    score += POINTS.cardsDue;
    signals.push({ kind: "cards_due", count: cardsDue });
  }

  if (mistakesRecent && mistakesRecent > 0) {
    // High is a strict superset of low. We emit the high signal only — the
    // test asserts on the high text — and bump the score by the delta.
    if (mistakesRecent >= 3) {
      score += POINTS.recentMistakesHigh;
      signals.push({ kind: "recent_mistakes_high", count: mistakesRecent });
    } else {
      score += POINTS.recentMistakesLow;
      signals.push({ kind: "recent_mistakes", count: mistakesRecent });
    }
  }

  if (hasAnySession && lastSession) {
    const delta = dayDelta(today, lastSession);
    // dayDelta(today, lastSession) = today - lastSession (positive if last
    // session is in the past). >= inactivityDays means "inactive".
    if (delta >= inactivityDays) {
      score += POINTS.studyInactive;
      signals.push({ kind: "study_inactive", days: delta });
    }
  }

  return { score, signals };
}

// --- Reason text generation (deterministic, from the actual signals) ------

function humanizeDeadlineBucket(items, today) {
  // Build a phrase like "1 deadline tomorrow", "2 deadlines this week", or
  // "1 deadline overdue". The tests assert on the canonical forms, which
  // always include the count and use the plural noun for >1.
  if (!items || items.length === 0) return null;
  const first = items[0];
  const delta = dayDelta(first.date, today);
  const count = items.length;
  const plural = count > 1;
  const noun = plural ? "deadlines" : "deadline";
  if (delta < 0) {
    // "1 deadline 5d overdue" or "2 deadlines overdue" (when multiple
    // distinct days, the most-overdue day is the anchor).
    if (plural) return `${count} ${noun} overdue`;
    return `${count} ${noun} ${Math.abs(delta)}d overdue`;
  }
  if (delta === 0) return `${count} ${noun} today`;
  if (delta === 1) return `${count} ${noun} tomorrow`;
  if (delta <= 3) return `${count} ${noun} in ${delta}d`;
  if (delta <= 7) return `${count} ${noun} this week`;
  return `${count} ${noun} in ${delta}d`;
}

function composeReason(subjectName, dl, cardsDue, mistakesRecent, lastSession, today, inactivityDays) {
  // Phrase priority:
  //   1. Overdue / today / soon (the data the student must see first).
  //   2. Cards due (review).
  //   3. Recent mistakes (targeted practice).
  //   4. Inactivity (catch-up).
  // We emit up to two phrases, joined by " · " — never three, so the chip
  // stays scannable. The single-source phrases below are pinned by tests.
  const parts = [];

  if (dl) {
    if (dl.overdue.length > 0) {
      parts.push(humanizeDeadlineBucket(dl.overdue, today));
    } else if (dl.today.length > 0) {
      parts.push(humanizeDeadlineBucket(dl.today, today));
    } else if (dl.soon.length > 0) {
      parts.push(humanizeDeadlineBucket(dl.soon, today));
    } else if (dl.later.length > 0) {
      parts.push(humanizeDeadlineBucket(dl.later, today));
    }
  }

  if (cardsDue && cardsDue > 0 && parts.length < 2) {
    parts.push(`${cardsDue} flashcard${cardsDue === 1 ? "" : "s"} due`);
  }
  if (mistakesRecent && mistakesRecent > 0 && parts.length < 2) {
    parts.push(
      mistakesRecent >= 3
        ? `${mistakesRecent} recent mistakes`
        : `${mistakesRecent} recent mistake${mistakesRecent === 1 ? "" : "s"}`
    );
  }
  if (lastSession && parts.length < 2) {
    const delta = dayDelta(today, lastSession);
    if (delta >= inactivityDays) {
      parts.push(`no study in ${delta}d`);
    }
  }

  const reason = parts.length === 0 ? "" : parts.join(" · ");
  return { reason, parts };
}

function actionsFor(signals) {
  const out = [];
  // openSubject is always available — every recommendation has a subject.
  out.push("openSubject");
  if (signals.some((s) => s.kind === "cards_due")) out.push("openRecall");
  if (signals.some((s) => s.kind === "study_inactive")) out.push("openSubject");
  // De-duplicate while preserving order.
  return Array.from(new Set(out));
}

// --- Public entry point ---------------------------------------------------

/**
 * Build the Academic Focus list. Pure: no Date.now, no random, no IO.
 *
 * @param {object} input
 * @param {Array}  input.subjects
 * @param {Array}  input.deadlines
 * @param {Array}  input.sessions
 * @param {Array}  input.cards
 * @param {Array}  input.mistakes
 * @param {string} input.today
 * @param {object} [input.options]
 * @param {number} [input.options.maxResults=4]
 * @param {number} [input.options.inactivityDays=7]
 * @param {number} [input.options.soonDays=7]
 * @param {number} [input.options.laterDays=14]
 * @param {number} [input.options.recentMistakeWindowDays=14]
 * @returns {object}
 */
export function buildAcademicFocus(input = {}) {
  const today = input.today || localDayString();
  const opts = input.options || {};
  const maxResults = clampInt(opts.maxResults, 1, 10, 4);
  const inactivityDays = clampInt(opts.inactivityDays, 1, 60, 7);
  const soonDays = clampInt(opts.soonDays, 1, 30, 7);
  const laterDays = clampInt(opts.laterDays, soonDays + 1, 60, 14);
  const recentMistakeWindowDays = clampInt(opts.recentMistakeWindowDays, 1, 90, 14);

  // ---- Pre-compute per-subject signal maps (bounded by subject count) ---
  const subjects = Array.isArray(input.subjects) ? input.subjects : [];
  const subjectsById = new Map();
  for (const s of subjects) {
    if (!s || s.id == null) continue;
    if (s.status === "done") continue; // rule 2: done subjects never recommended
    subjectsById.set(s.id, s);
  }

  const dlBySubject = bucketDeadlinesBySubject(
    input.deadlines,
    today,
    soonDays,
    laterDays
  );
  const lastSessionBySubj = lastSessionBySubject(input.sessions);
  const cardsBySubject = cardsDueBySubject(input.cards, today);
  const mistakesBySubject = recentMistakesBySubject(
    input.mistakes,
    today,
    recentMistakeWindowDays
  );

  // The "study inactivity" signal only fires when the profile has at least
  // one recorded session ever. Otherwise the recommendation would surface
  // every fresh subject as "no study" — useless.
  const hasAnySession = lastSessionBySubj.size > 0;

  // ---- Score each eligible subject ---------------------------------------
  const scored = [];
  for (const s of subjects) {
    if (!s || s.id == null) continue;
    if (!subjectsById.has(s.id)) continue; // skip "done"
    const sid = s.id;
    const dl = dlBySubject.get(sid) || null;
    const last = lastSessionBySubj.get(sid)?.lastDate || null;
    const cardsDue = cardsBySubject.get(sid) || 0;
    const mistakes = mistakesBySubject.get(sid) || 0;

    const { score, signals } = scoreSubject(
      sid,
      dl,
      last,
      cardsDue,
      mistakes,
      today,
      inactivityDays,
      hasAnySession
    );
    if (score <= 0) continue; // no signal -> not a recommendation

    const { reason } = composeReason(
      s.name,
      dl,
      cardsDue,
      mistakes,
      last,
      today,
      inactivityDays
    );
    if (!reason) continue; // safety: never emit a recommendation without a why

    scored.push({
      subjectId: sid,
      subjectName: s.name,
      code: s.code || null,
      score,
      reason,
      signals,
      actions: actionsFor(signals),
      // Tie-break field exposed for tests: earliest unfinished deadline date
      // (null if no deadline), so two subjects with the same score are
      // ordered by date asc, then subjectId asc.
      _earliest: dl ? dl.earliest : null,
    });
  }

  if (scored.length === 0) {
    return {
      items: [],
      empty: true,
      message: "Nothing urgent. Your current workload is under control.",
    };
  }

  // ---- Deterministic ordering -------------------------------------------
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Earlier deadline first (overdue > today > sooner). nulls last.
    const aD = a._earliest || "\uffff";
    const bD = b._earliest || "\uffff";
    if (aD !== bD) return aD.localeCompare(bD);
    return a.subjectId - b.subjectId;
  });

  // Cap before serialising: top N. Internal fields stripped for the public
  // shape — the UI must not depend on _earliest.
  const items = scored.slice(0, maxResults).map((it) => ({
    subjectId: it.subjectId,
    subjectName: it.subjectName,
    code: it.code,
    score: it.score,
    reason: it.reason,
    signals: it.signals,
    actions: it.actions,
  }));

  return {
    items,
    empty: false,
    message: `${items.length} subject${items.length === 1 ? "" : "s"} need attention.`,
  };
}

function clampInt(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

// Public re-exports (useful for tests and UI; stable).
export const __internals = {
  POINTS,
  bucketDeadlinesBySubject,
  lastSessionBySubject,
  cardsDueBySubject,
  recentMistakesBySubject,
  composeReason,
  scoreSubject,
  actionsFor,
};
