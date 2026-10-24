import { safeHandle } from "../security/safe-handle.js";
import { ipcMain } from "electron";

export function register({ core }) {
  safeHandle("mistakes:list", (_e, { profileId, subjectId, mistakeType, limit }) =>
    core.getMistakes(profileId, subjectId, mistakeType, limit)
  );
  safeHandle("mistakes:add", (_e, { profileId, subjectId, questionText, mistakeType, correctApproach, tags }) =>
    core.addMistake(profileId, subjectId, questionText, mistakeType, correctApproach, tags)
  );
  safeHandle("mistakes:update", (_e, { profileId, id, questionText, mistakeType, correctApproach, tags }) =>
    core.updateMistake(profileId, id, questionText, mistakeType, correctApproach, tags)
  );
  safeHandle("mistakes:delete", (_e, { profileId, id }) => core.deleteMistake(profileId, id));
  safeHandle("mistakes:stats", (_e, profileId) => core.getMistakeStats(profileId));
}
