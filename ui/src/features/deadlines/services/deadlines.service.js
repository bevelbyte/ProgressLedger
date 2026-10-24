/**
 * Deadlines Service - IPC API wrapper for deadline tracking
 */

export const deadlinesService = {
  async list(profileId) {
    return await window.careerflow.deadlines.list(profileId);
  },

  /** Pace for every ACTIVE deadline of the profile in one round-trip. */
  async paces(profileId) {
    return await window.careerflow.deadlines.paces(profileId);
  },

  async add(profileId, subjectId, deadlineDate, category, title, notes) {
    return await window.careerflow.deadlines.add(profileId, subjectId, deadlineDate, category, title, notes);
  },

  async update(profileId, id, deadlineDate, category, title, notes) {
    return await window.careerflow.deadlines.update(profileId, id, deadlineDate, category, title, notes);
  },

  async remove(profileId, id) {
    return await window.careerflow.deadlines.remove(profileId, id);
  },

  /** Mark a deadline complete (true) or reopen it (false). */
  async setCompletion(profileId, id, completed) {
    return await window.careerflow.deadlines.setCompletion(profileId, id, completed);
  },

  async getTree(profileId) {
    return await window.careerflow.academic.tree(profileId);
  }
};
