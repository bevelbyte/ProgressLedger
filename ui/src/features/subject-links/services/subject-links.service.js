/**
 * Subject Links Service - Subject link operations
 */

export const subjectLinksService = {
  /**
   * List links for a subject
   * @param {number} subjectId - The subject ID
   * @returns {Promise<Array>} List of links
   */
  async list(profileId, subjectId) {
    return await window.progressLedger.links.list(profileId, subjectId);
  },

  /**
   * Add a new link
   * @param {number} profileId - The caller's profile ID
   * @param {number} subjectId - The subject ID
   * @param {string} label - Link label
   * @param {string} url - Link URL
   * @returns {Promise<void>}
   */
  async add(profileId, subjectId, label, url) {
    return await window.progressLedger.links.add(profileId, subjectId, label, url);
  },

  /**
   * Update an existing link
   * @param {number} profileId - The caller's profile ID
   * @param {number} linkId - The link ID
   * @param {string} label - Link label
   * @param {string} url - Link URL
   * @returns {Promise<void>}
   */
  async update(profileId, linkId, label, url) {
    return await window.progressLedger.links.update(profileId, linkId, label, url);
  },

  /**
   * Remove a link
   * @param {number} profileId - The caller's profile ID
   * @param {number} linkId - The link ID
   * @returns {Promise<void>}
   */
  async remove(profileId, linkId) {
    return await window.progressLedger.links.remove(profileId, linkId);
  },

  async setPrimary(profileId, subjectId, linkId) {
    return await window.progressLedger.links.setPrimary(profileId, subjectId, linkId);
  }
};
