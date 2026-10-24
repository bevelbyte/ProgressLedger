/**
 * Labs Service - IPC API wrapper for laboratory experiment tracking
 */

export const labsService = {
  async getTree(profileId) {
    return await window.progressLedger.academic.tree(profileId);
  },

  async summary(profileId) {
    return await window.progressLedger.labs.summary(profileId);
  },

  async list(profileId, subjectId) {
    return await window.progressLedger.labs.list(profileId, subjectId);
  },

  async add(profileId, subjectId, experimentNo, title) {
    return await window.progressLedger.labs.add(profileId, subjectId, experimentNo, title);
  },

  async update(profileId, id, title, recordSubmitted, vivaDone, vivaScore, notes) {
    return await window.progressLedger.labs.update(profileId, id, title, recordSubmitted, vivaDone, vivaScore, notes);
  },

  async remove(profileId, id) {
    return await window.progressLedger.labs.remove(profileId, id);
  }
};
