/**
 * Sync Automation Service - IPC API wrapper for synchronization scheduling
 */

export const syncAutomationService = {
  async getAutomation() {
    return await window.progressLedger.sync.getAutomation();
  },

  async updateAutomation(patch) {
    return await window.progressLedger.sync.updateAutomation(patch);
  },

  async runNow() {
    return await window.progressLedger.sync.runNow();
  },

  onAutomationResult(callback) {
    return window.progressLedger.sync.onAutomationResult?.(callback);
  }
};
