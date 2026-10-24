import { safeHandle } from "../security/safe-handle.js";
import { ipcMain } from "electron";

export function register({ core }) {
  safeHandle("labs:list", (_e, { profileId, subjectId }) => core.getExperiments(profileId, subjectId));
  safeHandle("labs:add", (_e, { profileId, subjectId, experimentNo, title }) =>
    core.addExperiment(profileId, subjectId, experimentNo, title)
  );
  safeHandle("labs:update", (_e, { profileId, id, title, recordSubmitted, vivaDone, vivaScore, notes }) =>
    core.updateExperiment(profileId, id, title, recordSubmitted, vivaDone, vivaScore ?? null, notes ?? null)
  );
  safeHandle("labs:delete", (_e, { profileId, id }) => core.deleteExperiment(profileId, id));
  safeHandle("labs:summary", (_e, profileId) => core.getLabSummary(profileId));
}
