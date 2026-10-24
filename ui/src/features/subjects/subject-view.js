/**
 * Pure display helpers for the Subject Workspace. No Svelte/IO.
 */

/** "1h 45m" | "45m" | "0m" from minutes. */
export function formatStudyTime(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h > 0 && rem > 0) return `${h}h ${rem}m`;
  if (h > 0) return `${h}h`;
  return `${rem}m`;
}

/** Grade summary line from an overview, e.g. "85 / 100 · 85.0% · 9.0 (A+)" or "Not graded". */
export function formatGrade(overview) {
  if (!overview || overview.gradePoint == null || overview.percentage == null) {
    return "Not graded";
  }
  const marks =
    overview.marksObtained != null && overview.maxMarks != null
      ? `${overview.marksObtained} / ${overview.maxMarks} · `
      : "";
  const label = overview.gradeLabel ? ` (${overview.gradeLabel})` : "";
  return `${marks}${overview.percentage.toFixed(1)}% · ${overview.gradePoint.toFixed(1)}${label}`;
}

/** Credits label, or an em dash when unset. */
export function formatCredits(credits) {
  return credits == null ? "—" : String(credits);
}

const STATUS_LABELS = { pending: "Pending", in_progress: "In Progress", done: "Done" };
export function statusLabel(status) {
  return STATUS_LABELS[status] ?? "Pending";
}

/** "B.Tech (CSE)" -> "B.Tech"; plain names pass through. */
export function cleanTrackName(trackName) {
  return (trackName || "").replace(/\s*\(.*?\)\s*/g, "").trim();
}

/**
 * "Last studied" label from a persisted session start timestamp
 * ("YYYY-MM-DD HH:MM:SS" or ISO). Callers pass null when the subject has no
 * session in recent history — this formats, it never invents.
 */
export function formatLastStudied(startedAt) {
  if (!startedAt) return "—";
  const iso = startedAt.includes("T") ? startedAt : startedAt.replace(" ", "T");
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(d);
}
