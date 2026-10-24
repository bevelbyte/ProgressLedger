/**
 * Update Service - IPC API wrapper for software updates
 */

export const updateService = {
  async check() {
    return await window.careerflow.update.check();
  },

  async download() {
    return await window.careerflow.update.download();
  },

  async install() {
    return await window.careerflow.update.install();
  },

  onStatus(callback) {
    return window.careerflow.update.onStatus(callback);
  }
};
