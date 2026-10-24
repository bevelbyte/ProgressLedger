/**
 * Cards Service - IPC API wrapper for Recall Deck / Flashcards
 *
 * Every write takes a profileId first so the main process can refuse to
 * touch cards owned by another profile.
 */

export const cardsService = {
  async due(profileId) {
    return await window.careerflow.cards.due(profileId);
  },

  async all(profileId) {
    return await window.careerflow.cards.all(profileId);
  },

  async stats(profileId) {
    return await window.careerflow.cards.stats(profileId);
  },

  async review(profileId, cardId, quality) {
    return await window.careerflow.cards.review(profileId, cardId, quality);
  },

  async create(profileId, subjectId, front, back) {
    return await window.careerflow.cards.create(profileId, subjectId, front, back);
  },

  async update(profileId, cardId, subjectId, front, back) {
    return await window.careerflow.cards.update(profileId, cardId, subjectId, front, back);
  },

  async remove(profileId, cardId) {
    return await window.careerflow.cards.remove(profileId, cardId);
  },

  async getAcademicTree(profileId) {
    return await window.careerflow.academic.tree(profileId);
  }
};
