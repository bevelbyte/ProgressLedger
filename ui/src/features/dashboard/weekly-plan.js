/**
 * Weekly Planning — pure, deterministic helper for the "This Week" dashboard section.
 * No IPC, no Svelte, no Date objects beyond local date strings.
 * Reuses the local‑date conventions from today.js.
 */

export function localDay(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Monday and Sunday of the current week (local calendar, week starts Monday).
 */
export function currentWeek(todayStr = localDay()) {
  const [y, m, d] = todayStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const day = date.getDay(); // 0 = Sunday
  const diff = (day === 0 ? 6 : day - 1); // days to Monday
  const monday = new Date(date);
  monday.setDate(date.getDate() - diff);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    start: localDay(monday),
    end: localDay(sunday),
  };
}

function dayDelta(targetStr, todayStr) {
  const [ty, tm, td] = targetStr.split("-").map(Number);
  const [ny, nm, nd] = todayStr.split("-").map(Number);
  const target = new Date(ty, tm - 1, td);
  const today = new Date(ny, nm - 1, nd);
  return Math.round((target - today) / 86400000);
}

/**
 * Classify a deadline relative to today and the current week.
 * Returns:
 *   "overdue"   – before today (and incomplete)
 *   "this-week" – today through Sunday
 *   "later"     – after Sunday
 *   "completed" – if completedAt is set
 */
export function classifyDeadline(deadline, todayStr = localDay()) {
  if (deadline.completedAt) return "completed";
  if (!deadline.deadlineDate) return "later";
  const week = currentWeek(todayStr);
  const delta = dayDelta(deadline.deadlineDate, todayStr);
  if (delta < 0) return "overdue";
  if (deadline.deadlineDate <= week.end) return "this-week";
  return "later";
}

/**
 * Build the weekly plan model from deadlines, sessions, and subject data.
 * Sessions are optional; if not provided or expensive, the plan still works.
 */
export function buildWeeklyPlan({
  deadlines = [],
  sessions = null, // { bySubjectId: { totalMinutes, thisWeekMinutes } } (or null)
  subjects = [], // array of { id, name, status, trackName, semesterName }
  todayStr = localDay(),
} = {}) {
  const week = currentWeek(todayStr);
  const overdue = [];
  const thisWeek = [];
  const later = [];

  for (const d of deadlines) {
    const cls = classifyDeadline(d, todayStr);
    const item = {
      id: d.id,
      title: d.title,
      deadlineDate: d.deadlineDate,
      subjectId: d.subjectId,
      subjectName: d.subjectName,
      category: d.category,
    };
    if (cls === "overdue") overdue.push(item);
    else if (cls === "this-week") thisWeek.push(item);
    else if (cls === "later") later.push(item);
    // completed items are excluded entirely
  }

  // Sort by date
  const byDate = (a, b) => a.deadlineDate.localeCompare(b.deadlineDate);
  overdue.sort(byDate);
  thisWeek.sort(byDate);

  // Study focus: subjects with incomplete deadlines this week or overdue.
  // Only include subjects that have at least one such deadline.
  const focusSet = new Map();
  for (const d of overdue) {
    const key = d.subjectId;
    if (!focusSet.has(key)) {
      focusSet.set(key, { subjectId: key, subjectName: d.subjectName, reason: "Overdue" });
    }
  }
  for (const d of thisWeek) {
    const key = d.subjectId;
    if (!focusSet.has(key)) {
      focusSet.set(key, { subjectId: key, subjectName: d.subjectName, reason: "Deadline this week" });
    }
  }

  const focus = Array.from(focusSet.values());

  // If we have session data, augment focus with minutes and maybe adjust reason.
  if (sessions) {
    for (const f of focus) {
      const info = sessions.bySubjectId[f.subjectId];
      if (info) {
        f.totalMinutes = info.totalMinutes || 0;
        f.thisWeekMinutes = info.thisWeekMinutes || 0;
      } else {
        f.totalMinutes = 0;
        f.thisWeekMinutes = 0;
      }
    }
  }

  return {
    week,
    overdue,
    thisWeek,
    later,
    focus,
    // A human‑readable summary for the empty state
    hasWork: overdue.length > 0 || thisWeek.length > 0,
    count: overdue.length + thisWeek.length,
  };
}

/**
 * Aggregate session minutes per subject from a list of sessions.
 * This is a pure transformation; it does not fetch data.
 *
 * `todayStr` is injectable so the week boundary is deterministic in tests.
 */
export function aggregateSessions(sessions, todayStr = localDay()) {
  const bySubjectId = {};
  if (!sessions) return { bySubjectId };
  // We need the current week boundaries to filter "this week".
  const week = currentWeek(todayStr);
  for (const s of sessions) {
    if (!s.subjectId) continue;
    const id = s.subjectId;
    if (!bySubjectId[id]) bySubjectId[id] = { totalMinutes: 0, thisWeekMinutes: 0 };
    bySubjectId[id].totalMinutes += s.durationMinutes || 0;
    // Check if started_at is within the current week.
    //
    // CareerFlow stores session timestamps as "YYYY-MM-DD HH:MM:SS" (local,
    // space-separated) via datetime('now','localtime') / toLocalTimestamp(), and
    // may also receive "YYYY-MM-DDTHH:MM:SS" from ISO callers. Splitting on "T"
    // alone left the whole "2026-01-14 10:00:00" string as the date, which made
    // the range test pass for every past session and fail for the week's own
    // Sunday. Take only the date part under either separator.
    if (s.startedAt) {
      const datePart = s.startedAt.split(/[ T]/)[0];
      if (datePart >= week.start && datePart <= week.end) {
        bySubjectId[id].thisWeekMinutes += s.durationMinutes || 0;
      }
    }
  }
  return { bySubjectId };
}