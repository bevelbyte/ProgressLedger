/**
 * Cloud Sync Service - IPC API wrapper for cloud storage vault interactions
 */

export const cloudSyncService = {
  async get() {
    return await window.careerflow.cloud.get();
  },

  async configure(config) {
    return await window.careerflow.cloud.configure(config);
  },

  async disconnect() {
    return await window.careerflow.cloud.disconnect();
  },

  async upload(profileId, slug) {
    return await window.careerflow.cloud.upload(profileId, slug);
  },

  async uploadAll(profiles) {
    return await window.careerflow.cloud.uploadAll(profiles);
  },

  async inspect(name) {
    return await window.careerflow.cloud.inspect(name);
  },

  async restore(name) {
    return await window.careerflow.cloud.restore(name);
  }
};
