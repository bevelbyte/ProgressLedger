/**
 * Projects Service - IPC API wrapper for project and task tracking
 */

export const projectsService = {
  async listProjects(profileId) {
    return await window.careerflow.projects.list(profileId);
  },

  async addProject(profileId, name, projectType, deadline, description) {
    return await window.careerflow.projects.add(profileId, name, projectType, deadline, description);
  },

  async updateProject(profileId, id, name, status, deadline, description) {
    return await window.careerflow.projects.update(profileId, id, name, status, deadline, description);
  },

  async removeProject(profileId, id) {
    return await window.careerflow.projects.remove(profileId, id);
  },

  async listTasks(profileId, projectId) {
    return await window.careerflow.projectTasks.list(profileId, projectId);
  },

  async addTask(profileId, projectId, title, priority, dueDate) {
    return await window.careerflow.projectTasks.add(profileId, projectId, title, priority, dueDate);
  },

  async updateTask(profileId, id, title, status, priority, dueDate, notes) {
    return await window.careerflow.projectTasks.update(profileId, id, title, status, priority, dueDate, notes);
  },

  async removeTask(profileId, id) {
    return await window.careerflow.projectTasks.remove(profileId, id);
  }
};
