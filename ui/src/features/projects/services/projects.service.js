/**
 * Projects Service - IPC API wrapper for project and task tracking
 */

export const projectsService = {
  async listProjects(profileId) {
    return await window.progressLedger.projects.list(profileId);
  },

  async addProject(profileId, name, projectType, deadline, description) {
    return await window.progressLedger.projects.add(profileId, name, projectType, deadline, description);
  },

  async updateProject(profileId, id, name, status, deadline, description) {
    return await window.progressLedger.projects.update(profileId, id, name, status, deadline, description);
  },

  async removeProject(profileId, id) {
    return await window.progressLedger.projects.remove(profileId, id);
  },

  async listTasks(profileId, projectId) {
    return await window.progressLedger.projectTasks.list(profileId, projectId);
  },

  async addTask(profileId, projectId, title, priority, dueDate) {
    return await window.progressLedger.projectTasks.add(profileId, projectId, title, priority, dueDate);
  },

  async updateTask(profileId, id, title, status, priority, dueDate, notes) {
    return await window.progressLedger.projectTasks.update(profileId, id, title, status, priority, dueDate, notes);
  },

  async removeTask(profileId, id) {
    return await window.progressLedger.projectTasks.remove(profileId, id);
  }
};
