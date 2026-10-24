/**
 * Backup Service - IPC API wrapper for local vault backups
 */

export const backupService = {
  async get() {
    return await window.progressLedger.backups.get();
  },

  async chooseFolder() {
    return await window.progressLedger.backups.chooseFolder();
  },

  async clearFolder() {
    return await window.progressLedger.backups.clearFolder();
  },

  async run(profileId, slug) {
    return await window.progressLedger.backups.run(profileId, slug);
  },

  async inspect(path) {
    return await window.progressLedger.backups.inspect(path);
  },

  async restore(path) {
    return await window.progressLedger.backups.restore(path);
  },

  async openFolder() {
    return await window.progressLedger.backups.openFolder();
  }
};
