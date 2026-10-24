/**
 * Update Service - IPC API wrapper for software updates
 */

export const updateService = {
  async check() {
    return await window.progressLedger.update.check();
  },

  async download() {
    return await window.progressLedger.update.download();
  },

  async install() {
    return await window.progressLedger.update.install();
  },

  onStatus(callback) {
    return window.progressLedger.update.onStatus(callback);
  }
};
