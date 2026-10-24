/**
 * Mistakes Service - IPC API wrapper for mistake logging and analytics
 */

export const mistakesService = {
  async getTree(profileId) {
    return await window.progressLedger.academic.tree(profileId);
  },

  async list(profileId, filters) {
    return await window.progressLedger.mistakes.list({ profileId, ...filters });
  },

  async stats(profileId) {
    return await window.progressLedger.mistakes.stats(profileId);
  },

  async add(profileId, subjectId, questionText, mistakeType, correctApproach, tags) {
    return await window.progressLedger.mistakes.add(profileId, subjectId, questionText, mistakeType, correctApproach, tags);
  },

  async update(profileId, id, questionText, mistakeType, correctApproach, tags) {
    return await window.progressLedger.mistakes.update(profileId, id, questionText, mistakeType, correctApproach, tags);
  },

  async remove(profileId, id) {
    return await window.progressLedger.mistakes.remove(profileId, id);
  }
};
