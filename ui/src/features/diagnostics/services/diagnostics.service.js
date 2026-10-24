/**
 * Diagnostics Service - IPC API wrapper
 */

export const diagnosticsService = {
  async getReport(options) {
    return await window.progressLedger.diagnostics.getReport(options);
  },

  async exportReport(options) {
    return await window.progressLedger.diagnostics.exportReport(options);
  },

  async openLogs() {
    return await window.progressLedger.diagnostics.openLogs();
  },

  async readLog() {
    return await window.progressLedger.diagnostics.readLog();
  }
};
