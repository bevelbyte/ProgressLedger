/**
 * Pure display/derivation helpers for Career Planning. No Svelte/IO.
 * Every value is derived from real persisted data — no fabricated scores.
 */

const GOAL_STATUS_LABEL = { active: "Active", achieved: "Achieved", paused: "Paused" };
export function goalStatusLabel(status) {
  return GOAL_STATUS_LABEL[status] ?? "Active";
}

/** The primary goal (or first) from a goals list, or null. */
export function primaryGoal(goals) {
  if (!goals || goals.length === 0) return null;
  return goals.find((g) => g.isPrimary) ?? goals[0];
}

/** A milestone is complete iff it has a completedAt timestamp. */
export function isComplete(m) {
  return !!m?.completedAt;
}

/**
 * Milestone progress for a goal: completed vs total. Honest counts only —
 * returns null total when there are no milestones (caller shows "none yet").
 */
export function milestoneProgress(milestones) {
  const total = milestones?.length ?? 0;
  const done = (milestones ?? []).filter(isComplete).length;
  return { done, total };
}

/** "2 of 5 milestones complete" | "No milestones yet". */
export function progressText(milestones) {
  const { done, total } = milestoneProgress(milestones);
  if (total === 0) return "No milestones yet";
  return `${done} of ${total} milestone${total === 1 ? "" : "s"} complete`;
}

/**
 * The next actionable milestone = first (by existing sort order) that is not
 * complete. Milestones arrive already ordered by the backend. null when all
 * done or none exist.
 */
export function nextMilestone(milestones) {
  if (!milestones) return null;
  return milestones.find((m) => !isComplete(m)) ?? null;
}

/** Short local date label for an ISO YYYY-MM-DD, or "" when unset. */
export function formatTargetDate(iso) {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.valueOf())
    ? iso
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(d);
}

/** Move item at `from` to `to` in a copy of the array (for reordering UI). */
export function moveItem(arr, from, to) {
  const copy = [...arr];
  if (from < 0 || from >= copy.length || to < 0 || to >= copy.length) return copy;
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

/**
 * Linked-subject state for a roadmap row, derived ONLY from what the backend
 * returned. "missing" = the id is set but the subject no longer resolves
 * (deleted): the read path's LEFT JOIN then yields no name. No guessing.
 */
export function linkedSubjectState(milestone) {
  const id = milestone?.linkedSubjectId;
  if (id === null || id === undefined) return { state: "none", id: null, name: "" };
  return {
    state: milestone.linkedSubjectName ? "linked" : "missing",
    id,
    name: milestone.linkedSubjectName ?? "",
  };
}

/** Local YYYY-MM-DD for today (local calendar, matching deadlines/Today). */
function localToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Classify a milestone's target date, mirroring the deadline/Today local-date
 * semantics. A COMPLETED milestone is never overdue/due — completion overrides
 * date. No target date -> "none". Returns: "none" | "overdue" | "today" |
 * "soon" (<=7 days) | "upcoming".
 */
export function milestoneDateState(milestone, todayStr = localToday(), soonDays = 7) {
  if (!milestone || isComplete(milestone)) return "none";
  const date = milestone.targetDate;
  if (!date) return "none";
  const [ty, tm, td] = date.split("-").map(Number);
  const [ny, nm, nd] = todayStr.split("-").map(Number);
  if ([ty, tm, td, ny, nm, nd].some(Number.isNaN)) return "none";
  const delta = Math.round((new Date(ty, tm - 1, td) - new Date(ny, nm - 1, nd)) / 86400000);
  if (delta < 0) return "overdue";
  if (delta === 0) return "today";
  if (delta <= soonDays) return "soon";
  return "upcoming";
}
