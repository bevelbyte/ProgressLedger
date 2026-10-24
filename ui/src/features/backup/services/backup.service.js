/**
 * Backup Service - IPC API wrapper for local vault backups
 */

export const backupService = {
  async get() {
    return await window.careerflow.backups.get();
  },

  async chooseFolder() {
    return await window.careerflow.backups.chooseFolder();
  },

  async clearFolder() {
    return await window.careerflow.backups.clearFolder();
  },

  async run(profileId, slug) {
    return await window.careerflow.backups.run(profileId, slug);
  },

  async inspect(path) {
    return await window.careerflow.backups.inspect(path);
  },

  async restore(path) {
    return await window.careerflow.backups.restore(path);
  },

  async openFolder() {
    return await window.careerflow.backups.openFolder();
  }
};
