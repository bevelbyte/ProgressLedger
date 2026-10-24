/**
 * Labs Service - IPC API wrapper for laboratory experiment tracking
 */

export const labsService = {
  async getTree(profileId) {
    return await window.careerflow.academic.tree(profileId);
  },

  async summary(profileId) {
    return await window.careerflow.labs.summary(profileId);
  },

  async list(profileId, subjectId) {
    return await window.careerflow.labs.list(profileId, subjectId);
  },

  async add(profileId, subjectId, experimentNo, title) {
    return await window.careerflow.labs.add(profileId, subjectId, experimentNo, title);
  },

  async update(profileId, id, title, recordSubmitted, vivaDone, vivaScore, notes) {
    return await window.careerflow.labs.update(profileId, id, title, recordSubmitted, vivaDone, vivaScore, notes);
  },

  async remove(profileId, id) {
    return await window.careerflow.labs.remove(profileId, id);
  }
};
