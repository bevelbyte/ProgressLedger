/**
 * Diagnostics Service - IPC API wrapper
 */

export const diagnosticsService = {
  async getReport(options) {
    return await window.careerflow.diagnostics.getReport(options);
  },

  async exportReport(options) {
    return await window.careerflow.diagnostics.exportReport(options);
  },

  async openLogs() {
    return await window.careerflow.diagnostics.openLogs();
  },

  async readLog() {
    return await window.careerflow.diagnostics.readLog();
  }
};
