/**
 * Mistakes Service - IPC API wrapper for mistake logging and analytics
 */

export const mistakesService = {
  async getTree(profileId) {
    return await window.careerflow.academic.tree(profileId);
  },

  async list(profileId, filters) {
    return await window.careerflow.mistakes.list({ profileId, ...filters });
  },

  async stats(profileId) {
    return await window.careerflow.mistakes.stats(profileId);
  },

  async add(profileId, subjectId, questionText, mistakeType, correctApproach, tags) {
    return await window.careerflow.mistakes.add(profileId, subjectId, questionText, mistakeType, correctApproach, tags);
  },

  async update(profileId, id, questionText, mistakeType, correctApproach, tags) {
    return await window.careerflow.mistakes.update(profileId, id, questionText, mistakeType, correctApproach, tags);
  },

  async remove(profileId, id) {
    return await window.careerflow.mistakes.remove(profileId, id);
  }
};
