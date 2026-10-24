/**
 * Cloud Sync Service - IPC API wrapper for cloud storage vault interactions
 */

export const cloudSyncService = {
  async get() {
    return await window.progressLedger.cloud.get();
  },

  async configure(config) {
    return await window.progressLedger.cloud.configure(config);
  },

  async disconnect() {
    return await window.progressLedger.cloud.disconnect();
  },

  async upload(profileId, slug) {
    return await window.progressLedger.cloud.upload(profileId, slug);
  },

  async uploadAll(profiles) {
    return await window.progressLedger.cloud.uploadAll(profiles);
  },

  async inspect(name) {
    return await window.progressLedger.cloud.inspect(name);
  },

  async restore(name) {
    return await window.progressLedger.cloud.restore(name);
  }
};
