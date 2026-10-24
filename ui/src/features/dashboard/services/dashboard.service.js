/**
 * Dashboard Service - IPC API wrapper for dashboard metrics & activity
 */

export const dashboardService = {
  async getStats(profileId) {
    return await window.progressLedger.dashboard.stats(profileId);
  },

  async getMistakeStats(profileId) {
    return await window.progressLedger.mistakes.stats(profileId);
  },

  async getDeadlines(profileId) {
    return await window.progressLedger.deadlines.list(profileId);
  },

  // Today/Daily Focus reuses the existing flashcard + study-session APIs;
  // the Dashboard composes them, it does not own scheduling or logging.
  async getReviewStats(profileId) {
    return await window.progressLedger.cards.stats(profileId);
  },

  async getSessionStats(profileId) {
    return await window.progressLedger.sessions.stats(profileId);
  },

  // Academic Focus: single bounded batch read of subjects, active deadlines,
  // recent sessions, due flashcards, and recent mistakes. The pure
  // prioritization algorithm (academic-focus.js) runs in the component.
  async getFocusSignals(profileId) {
    return await window.progressLedger.focusSignals.get(profileId);
  },
};
