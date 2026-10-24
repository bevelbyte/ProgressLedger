/**
 * Study-sessions service — renderer path to logged study time. Thin wrapper
 * over window.careerflow.sessions.* (IPC -> Rust -> SQLite). No logic here.
 */
export const sessionsService = {
  list(profileId, limit = 50) {
    return window.careerflow.sessions.list(profileId, limit);
  },
  /** Local "YYYY-MM-DD HH:MM:SS" timestamps (not ISO — ISO is UTC and would
   *  file a late-evening session on the wrong calendar day); durationMinutes > 0. */
  add(profileId, subjectId, durationMinutes, startedAt = null, endedAt = null, notes = null) {
    return window.careerflow.sessions.add(profileId, subjectId, durationMinutes, startedAt, endedAt, notes);
  },
  remove(profileId, id) {
    return window.careerflow.sessions.remove(profileId, id);
  },
  stats(profileId) {
    return window.careerflow.sessions.stats(profileId);
  },
  /** Academic tree for the subject picker (reuses the academic API). */
  getTree(profileId) {
    return window.careerflow.academic.tree(profileId);
  },
};
