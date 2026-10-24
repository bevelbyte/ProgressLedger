/**
 * Profile Service - IPC API wrapper for student profile management
 */

export const profileService = {
  async list() {
    return await window.progressLedger.profiles.list();
  },

  async add(name, slug) {
    return await window.progressLedger.profiles.add(name, slug);
  },

  async remove(id) {
    return await window.progressLedger.profiles.remove(id);
  },

  async export(id, slug) {
    return await window.progressLedger.profiles.export(id, slug);
  },

  async import() {
    return await window.progressLedger.profiles.import();
  }
};
