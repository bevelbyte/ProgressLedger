/**
 * Profile Service - IPC API wrapper for student profile management
 */

export const profileService = {
  async list() {
    return await window.careerflow.profiles.list();
  },

  async add(name, slug) {
    return await window.careerflow.profiles.add(name, slug);
  },

  async remove(id) {
    return await window.careerflow.profiles.remove(id);
  },

  async export(id, slug) {
    return await window.careerflow.profiles.export(id, slug);
  },

  async import() {
    return await window.careerflow.profiles.import();
  }
};
