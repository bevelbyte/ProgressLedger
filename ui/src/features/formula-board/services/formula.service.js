/**
 * Formula Service - Formula board operations
 */

export const formulaService = {
  /**
   * Get academic tree for subject selection
   * @param {number} profileId - The profile ID
   * @returns {Promise<Array>} Academic tree structure
   */
  async getAcademicTree(profileId) {
    if (profileId == null) {
      return [];
    }
    return await window.progressLedger.academic.tree(profileId);
  },

  /**
   * List formulas for a subject
   * @param {number} subjectId - The subject ID
   * @param {string|null} category - Optional category filter
   * @returns {Promise<Array>} List of formulas
   */
  async list(profileId, subjectId, category) {
    return await window.progressLedger.formulas.list(profileId, subjectId, category);
  },

  /**
   * Add a new formula
   * @param {number} profileId - The profile ID (caller's profile)
   * @param {number} subjectId - The subject ID
   * @param {string} title - Formula title
   * @param {string} latexContent - LaTeX content
   * @param {string|null} category - Optional category
   * @returns {Promise<void>}
   */
  async add(profileId, subjectId, title, latexContent, category) {
    return await window.progressLedger.formulas.add(profileId, subjectId, title, latexContent, category);
  },

  /**
   * Update an existing formula
   * @param {number} profileId - The profile ID (caller's profile)
   * @param {number} formulaId - The formula ID
   * @param {string} title - Formula title
   * @param {string} latexContent - LaTeX content
   * @param {string|null} category - Optional category
   * @returns {Promise<void>}
   */
  async update(profileId, formulaId, title, latexContent, category) {
    return await window.progressLedger.formulas.update(profileId, formulaId, title, latexContent, category);
  },

  /**
   * Remove a formula
   * @param {number} profileId - The profile ID (caller's profile)
   * @param {number} formulaId - The formula ID
   * @returns {Promise<void>}
   */
  async remove(profileId, formulaId) {
    return await window.progressLedger.formulas.remove(profileId, formulaId);
  }
};
