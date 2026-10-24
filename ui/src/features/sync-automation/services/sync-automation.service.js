/**
 * Sync Automation Service - IPC API wrapper for synchronization scheduling
 */

export const syncAutomationService = {
  async getAutomation() {
    return await window.careerflow.sync.getAutomation();
  },

  async updateAutomation(patch) {
    return await window.careerflow.sync.updateAutomation(patch);
  },

  async runNow() {
    return await window.careerflow.sync.runNow();
  },

  onAutomationResult(callback) {
    return window.careerflow.sync.onAutomationResult?.(callback);
  }
};
