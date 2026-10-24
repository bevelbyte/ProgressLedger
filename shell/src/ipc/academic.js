import { safeHandle } from "../security/safe-handle.js";
import { ipcMain } from "electron";

export function register({ core }) {
  safeHandle("academic:tree", (_e, profileId) => core.getAcademicTree(profileId));
  safeHandle("academic:add-track", (_e, { profileId, name }) => core.addTrack(profileId, name));
  safeHandle("academic:add-semester", (_e, { profileId, trackId, name }) => core.addSemester(profileId, trackId, name));
  safeHandle("academic:add-milestone", (_e, { profileId, semesterId, title }) => core.addMilestone(profileId, semesterId, title));
  safeHandle("academic:add-subject", (_e, { profileId, milestoneId, name, code }) =>
    core.addSubject(profileId, milestoneId, name, code)
  );
  safeHandle("academic:update-subject", (_e, { profileId, id, name, code }) => core.updateSubject(profileId, id, name, code));
  safeHandle("academic:delete-track", (_e, { profileId, id }) => core.deleteTrack(profileId, id));
  safeHandle("academic:delete-semester", (_e, { profileId, id }) => core.deleteSemester(profileId, id));
  safeHandle("academic:delete-milestone", (_e, { profileId, id }) => core.deleteMilestone(profileId, id));
  safeHandle("academic:delete-subject", (_e, { profileId, id }) => core.deleteSubject(profileId, id));
  safeHandle("academic:set-subject-status", (_e, { profileId, id, status }) => core.setSubjectStatus(profileId, id, status));
  safeHandle("academic:set-semester-status", (_e, { profileId, id, status }) => core.setSemesterStatus(profileId, id, status));
}
