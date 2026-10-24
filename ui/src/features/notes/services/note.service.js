/**
 * Note Service - Note and resource operations
 */

export const noteService = {
  /**
   * Get a note/resource by ID
   * @param {number} resourceId - The resource ID
   * @returns {Promise<object>} The resource details
   */
  async get(profileId, resourceId) {
    return await window.careerflow.resources.get({ profileId, id: resourceId });
  },

  /**
   * Update an existing note
   * @param {number} profileId - The profile ID (caller's profile)
   * @param {number} resourceId - The resource ID
   * @param {string} title - The title
   * @param {string} content - The content
   * @returns {Promise<void>}
   */
  async updateNote(profileId, resourceId, title, content) {
    return await window.careerflow.resources.updateNote(profileId, resourceId, title, content);
  },

  /**
   * Add a new note for a subject
   * @param {number} profileId - The profile ID (caller's profile)
   * @param {number} subjectId - The subject ID
   * @param {string} title - The title
   * @param {string} content - The content
   * @returns {Promise<void>}
   */
  async addNote(profileId, subjectId, title, content) {
    return await window.careerflow.resources.addNote(profileId, subjectId, title, content);
  }
};
