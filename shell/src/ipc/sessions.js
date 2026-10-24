import { safeHandle } from "../security/safe-handle.js";
import { ipcMain } from "electron";

export function register({ core }) {
  safeHandle("sessions:list", (_e, { profileId, limit }) =>
    core.getStudySessions(profileId, limit ?? null)
  );
  safeHandle("sessions:add", (_e, { profileId, subjectId, durationMinutes, startedAt, endedAt, notes }) =>
    core.addStudySession(profileId, subjectId, durationMinutes, startedAt ?? null, endedAt ?? null, notes ?? null)
  );
  safeHandle("sessions:delete", (_e, { profileId, id }) => core.deleteStudySession(profileId, id));
  safeHandle("sessions:stats", (_e, profileId) => core.getStudySessionStats(profileId));
}
