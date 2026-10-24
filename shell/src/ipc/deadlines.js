import { safeHandle } from "../security/safe-handle.js";
import { ipcMain } from "electron";

export function register({ core }) {
  safeHandle("deadlines:list", (_e, profileId) => core.getDeadlines(profileId ?? 0));
  safeHandle("deadlines:add", (_e, { profileId, subjectId, deadlineDate, category, title, notes }) =>
    core.addDeadline(profileId, subjectId, deadlineDate, category, title, notes)
  );
  safeHandle("deadlines:update", (_e, { profileId, id, deadlineDate, category, title, notes }) =>
    core.updateDeadline(profileId, id, deadlineDate, category, title, notes)
  );
  safeHandle("deadlines:delete", (_e, { profileId, id }) => core.deleteDeadline(profileId, id));
  safeHandle("deadlines:set-completion", (_e, { profileId, id, completed }) =>
    core.setDeadlineCompletion(profileId, id, completed)
  );
  safeHandle("deadlines:paces", (_e, profileId) => core.getDeadlinePaces(profileId));
}
