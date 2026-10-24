/**
 * Pure helpers for the Focus feature — no Svelte, no IO, no persistence.
 *
 * Focus is a *surface*, not an engine. It never writes a study record itself:
 * every session it produces goes through `sessionsService.add()` into the
 * existing `session_states` table, so Study Sessions stays the single source of
 * truth for study records. There is no second session engine, no new table, no
 * duplicated statistics, and no persisted "active session" — abandoning a
 * running focus (closing the app, switching profile, navigating away) logs
 * nothing, which is the explicit, documented behaviour.
 */

import { localDayString, dayDelta } from "../dashboard/today.js";

/** "HH:MM:SS" clock for the elapsed timer (tabular-friendly, zero-padded). */
export function formatClock(startMs, endMs) {
  const total = Number.isFinite(Number(endMs)) && Number.isFinite(Number(startMs))
    ? Math.max(0, Math.floor((Number(endMs) - Number(startMs)) / 1000))
    : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** Whole elapsed minutes between two epoch-ms timestamps (>= 0). */
export function elapsedWholeMinutes(startMs, endMs) {
  const diff = Number(endMs) - Number(startMs);
  if (!Number.isFinite(diff)) return 0;
  return Math.max(0, Math.floor(diff / 60000));
}

/**
 * Flatten an academic tree into the subject list a focus session can run
 * against. Each entry carries the placement labels the context strip shows.
 * Tolerates a malformed tree: a null row at any level is skipped rather than
 * thrown on, because a focus session must never die in its subject chooser.
 */
export function focusSubjects(tree) {
  const out = [];
  for (const track of tree || []) {
    if (!track) continue;
    for (const sem of track.semesters || []) {
      if (!sem) continue;
      for (const ms of sem.milestones || []) {
        if (!ms) continue;
        for (const subj of ms.subjects || []) {
          if (!subj || subj.id == null) continue;
          out.push({
            id: subj.id,
            name: subj.name,
            trackName: track.name,
            semesterName: sem.name,
            path: `${track.name} › ${sem.name} › ${ms.title}`,
            label: `${subj.name} — ${track.name} / ${sem.name}`,
          });
        }
      }
    }
  }
  return out;
}

/**
 * The nearest active deadline for a subject, with a local-calendar day delta.
 * Returns null when there is no deadline to show. Nulls and completed rows are
 * ignored so a failed or empty fetch degrades to "no context" instead of
 * inventing one.
 */
export function nearestDeadline(deadlines, todayStr = localDayString()) {
  let best = null;
  for (const d of deadlines || []) {
    if (!d || !d.deadlineDate || d.completedAt) continue;
    if (!best || d.deadlineDate.localeCompare(best.deadlineDate) < 0) best = d;
  }
  if (!best) return null;
  return {
    title: best.title || best.deadlineDate,
    date: best.deadlineDate,
    delta: dayDelta(best.deadlineDate, todayStr),
  };
}

/** Short human label for a day delta, e.g. "today", "in 2 days", "3 days overdue". */
export function deadlinePhrase(deadline) {
  if (!deadline) return "";
  const d = deadline.delta;
  if (d < 0) return `${Math.abs(d)} day${Math.abs(d) === 1 ? "" : "s"} overdue`;
  if (d === 0) return "due today";
  if (d === 1) return "due tomorrow";
  return `due in ${d} days`;
}

/**
 * Assemble the read-only context strip. Every value is data the rest of the
 * app already fetches; nothing here computes a score, a rank, or a
 * recommendation. Unknown fields stay null so the UI can hide them.
 *
 * @param {object} p
 * @param {string|null} p.subjectName
 * @param {string|null} p.path          placement label, e.g. "Track › Semester › Milestone"
 * @param {object|null} p.overview      SubjectOverview from `resources.overview`
 * @param {Array}     p.deadlines       active deadlines for the subject
 * @param {number|null} p.minutesToday  today's study minutes (any scope)
 */
export function buildFocusContext({ subjectName = null, path = null, overview = null, deadlines = [], minutesToday = null } = {}) {
  return {
    subjectName: subjectName || null,
    path: path || null,
    minutesToday: minutesToday ?? overview?.studyMinutesToday ?? null,
    flashcardsDue: typeof overview?.flashcardDue === "number" ? overview.flashcardDue : null,
    nearestDeadline: nearestDeadline(deadlines),
  };
}

/**
 * Whether the context strip has anything worth showing.
 *
 * A valid subject's overview always returns numbers, so `flashcardsDue` and
 * `minutesToday` are 0 — never null — for a quiet subject. Comparing against
 * null made the "nothing pending" state unreachable, so a subject with no
 * deadline, no due cards and no time logged rendered an empty greyed box
 * instead of saying so.
 */
function isPositiveNumber(n) {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

export function contextIsEmpty(ctx) {
  if (!ctx) return true;
  return !ctx.nearestDeadline && !isPositiveNumber(ctx.flashcardsDue) && !isPositiveNumber(ctx.minutesToday);
}

/**
 * What finishing a running focus session should do. Pure and total so the
 * lifecycle is unit-testable and the duplicate/zero-minute rules cannot drift
 * between the UI and the tests.
 *
 * Rules:
 *   - no start recorded            -> "not-running"  (never logs anything)
 *   - elapsed < 1 minute           -> "too-short"    (no row; the Rust layer
 *                                                    rejects <= 0 anyway, but
 *                                                    we do not spam IPC)
 *   - otherwise                    -> log exactly one session
 *
 * The objective is optional: a focus session is valid with none.
 */
export function resolveFinish({ startedMs, finishedAtMs, minutes, objective } = {}) {
  if (startedMs == null || finishedAtMs == null) {
    return { ok: false, reason: "not-running" };
  }
  const whole = elapsedWholeMinutes(startedMs, finishedAtMs);
  const used = Number.isFinite(Number(minutes)) ? Math.max(0, Math.round(Number(minutes))) : whole;
  if (used < 1) {
    return { ok: false, reason: "too-short" };
  }
  return {
    ok: true,
    reason: null,
    minutes: used,
    objective: (objective || "").trim() || null,
  };
}
