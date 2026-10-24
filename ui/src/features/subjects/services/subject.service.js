/**
 * Subject Service - IPC API wrapper for Subject Hub
 */

export const subjectService = {
  async getTree(profileId) {
    return await window.progressLedger.academic.tree(profileId);
  },

  /** Courses (marks/credits) for a profile — replaces reading CGPA's localStorage. */
  async listCourses(profileId) {
    return await window.progressLedger.courses.list(profileId, null);
  },

  async setSubjectStatus(profileId, subjectId, status) {
    return await window.progressLedger.academic.setSubjectStatus(profileId, subjectId, status);
  },

  async listResources(profileId, subjectId) {
    return await window.progressLedger.resources.list({ profileId, subjectId });
  },

  async attachFile(profileId, subjectId) {
    return await window.progressLedger.resources.attachFile({ profileId, subjectId });
  },

  async getResource(profileId, resourceId) {
    return await window.progressLedger.resources.get({ profileId, id: resourceId });
  },

  /**
   * Open a previously-attached resource. The renderer passes the resource
   * id; the main process resolves the file path from the database. The
   * renderer never holds a raw filesystem path.
   */
  async openFile(profileId, resourceId) {
    return await window.progressLedger.resources.openFile({ profileId, resourceId });
  },

  async deleteResource(profileId, resourceId) {
    return await window.progressLedger.resources.delete({ profileId, id: resourceId });
  },

  /** Aggregated single-subject workspace overview (academic/grade/study/counts). */
  async getOverview(profileId, subjectId) {
    return await window.progressLedger.resources.overview({ profileId, subjectId });
  },

  /** Active (not completed) deadlines for a subject (filters the profile-wide list). */
  async listSubjectDeadlines(profileId, subjectId) {
    const all = await window.progressLedger.deadlines.list(profileId);
    return all
      .filter((d) => d.subjectId === subjectId && !d.completedAt)
      .sort((a, b) => a.deadlineDate.localeCompare(b.deadlineDate));
  },

  /** Flashcards for a subject (filters the profile-wide list). */
  async listSubjectCards(profileId, subjectId) {
    const all = await window.progressLedger.cards.all(profileId);
    return all.filter((c) => c.subjectId === subjectId);
  },

  /** Mistakes logged against a subject. */
  async listSubjectMistakes(profileId, subjectId) {
    return await window.progressLedger.mistakes.list({ profileId, subjectId });
  },
};
