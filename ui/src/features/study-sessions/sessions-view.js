/**
 * Pure display helpers for the study-sessions feature. No Svelte/IO.
 */

/** "1h 45m" | "45m" | "0m" from a minute count. */
export function formatDuration(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h > 0 && rem > 0) return `${h}h ${rem}m`;
  if (h > 0) return `${h}h`;
  return `${rem}m`;
}

/** Short local date+time label for a session's start, e.g. "Aug 23, 08:40". */
export function formatSessionStart(iso) {
  if (!iso) return "";
  // SQLite stores "YYYY-MM-DD HH:MM:SS" (local); make it Date-parseable.
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T"));
  if (Number.isNaN(d.valueOf())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** Flatten the academic tree into a [{id,label}] subject list for a picker. */
export function flattenSubjects(tree) {
  const out = [];
  for (const track of tree || []) {
    for (const sem of track.semesters || []) {
      for (const ms of sem.milestones || []) {
        for (const subj of ms.subjects || []) {
          out.push({ id: subj.id, label: `${subj.name} — ${track.name} / ${sem.name}` });
        }
      }
    }
  }
  return out;
}

/** Elapsed whole minutes between two epoch-ms timestamps (>= 0). */
export function elapsedMinutes(startMs, endMs) {
  return Math.max(0, Math.floor((endMs - startMs) / 60000));
}
