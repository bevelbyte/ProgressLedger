/**
 * Pure display helpers for the Semester Progress view. No Svelte/IO.
 * Every label maps to a real, defensible data source — no health scores.
 */

/** "14h 35m" | "45m" | "0m" from minutes. */
export function formatStudyTime(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h > 0 && rem > 0) return `${h}h ${rem}m`;
  if (h > 0) return `${h}h`;
  return `${rem}m`;
}

/** SGPA line, or an honest "No graded subjects yet" when nothing is graded. */
export function formatSgpa(academic) {
  if (!academic || academic.gradedCourseCount === 0) return null; // caller shows empty text
  return academic.sgpa.toFixed(2);
}

/** "6 of 8 subjects graded" style completion text. */
export function gradedText(completion) {
  const total = completion?.totalSubjects ?? 0;
  const graded = completion?.gradedSubjects ?? 0;
  if (total === 0) return "No subjects yet";
  return `${graded} of ${total} subject${total === 1 ? "" : "s"} graded`;
}

/** "5 of 8 subjects completed" from persisted subject status (done). */
export function completedText(completion) {
  const total = completion?.totalSubjects ?? 0;
  const done = completion?.doneSubjects ?? 0;
  if (total === 0) return "No subjects yet";
  return `${done} of ${total} completed`;
}

/** Deadline summary chip text; null when there are none. */
export function deadlineSummary(deadlines) {
  if (!deadlines) return null;
  const parts = [];
  if (deadlines.overdue > 0) parts.push(`${deadlines.overdue} overdue`);
  if (deadlines.dueSoon > 0) parts.push(`${deadlines.dueSoon} due this week`);
  if (deadlines.upcoming > 0) parts.push(`${deadlines.upcoming} upcoming`);
  return parts.length ? parts.join(" · ") : null;
}

/** Short local date label for a YYYY-MM-DD deadline date. */
export function formatDeadlineDate(iso) {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.valueOf())
    ? iso
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(d);
}

const STATUS_LABEL = { pending: "Pending", in_progress: "In Progress", done: "Done" };
export function subjectStatusLabel(status) {
  return STATUS_LABEL[status] ?? "Pending";
}
