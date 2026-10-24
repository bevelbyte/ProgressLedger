import { safeHandle } from "../security/safe-handle.js";
import { ipcMain } from "electron";

export function register({ core }) {
  safeHandle("projects:list", (_e, profileId) => core.getProjects(profileId));
  safeHandle("projects:add", (_e, { profileId, name, projectType, deadline, description }) =>
    core.addProject(profileId, name, projectType, deadline ?? null, description ?? null)
  );
  safeHandle("projects:update", (_e, { profileId, id, name, status, deadline, description }) =>
    core.updateProject(profileId, id, name, status, deadline ?? null, description ?? null)
  );
  safeHandle("projects:delete", (_e, { profileId, id }) => core.deleteProject(profileId, id));

  safeHandle("projectTasks:list", (_e, { profileId, projectId }) =>
    core.getProjectTasks(profileId, projectId)
  );
  safeHandle("projectTasks:add", (_e, { profileId, projectId, title, priority, dueDate }) =>
    core.addProjectTask(profileId, projectId, title, priority ?? null, dueDate ?? null)
  );
  safeHandle("projectTasks:update", (_e, { profileId, id, title, status, priority, dueDate, notes }) =>
    core.updateProjectTask(profileId, id, title, status, priority, dueDate ?? null, notes ?? null)
  );
  safeHandle("projectTasks:delete", (_e, { profileId, id }) => core.deleteProjectTask(profileId, id));
}
