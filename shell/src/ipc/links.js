import { safeHandle } from "../security/safe-handle.js";
import { ipcMain } from "electron";

export function register({ core }) {
  safeHandle("links:list", (_e, { profileId, subjectId }) => core.getSubjectLinks(profileId, subjectId));
  safeHandle("links:add", (_e, { profileId, subjectId, label, url }) =>
    core.addSubjectLink(profileId, subjectId, label, url)
  );
  safeHandle("links:update", (_e, { profileId, linkId, label, url }) =>
    core.updateSubjectLink(profileId, linkId, label, url)
  );
  safeHandle("links:delete", (_e, { profileId, linkId }) => core.deleteSubjectLink(profileId, linkId));
  safeHandle("links:set-primary", (_e, { profileId, subjectId, linkId }) =>
    core.setPrimaryLink(profileId, subjectId, linkId)
  );
}
