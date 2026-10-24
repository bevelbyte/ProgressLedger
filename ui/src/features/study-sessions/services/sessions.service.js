/**
 * Study-sessions service — renderer path to logged study time. Thin wrapper
 * over window.progressLedger.sessions.* (IPC -> Rust -> SQLite). No logic here.
 */
export const sessionsService = {
  list(profileId, limit = 50) {
    return window.progressLedger.sessions.list(profileId, limit);
  },
  /** Local "YYYY-MM-DD HH:MM:SS" timestamps (not ISO — ISO is UTC and would
   *  file a late-evening session on the wrong calendar day); durationMinutes > 0. */
  add(profileId, subjectId, durationMinutes, startedAt = null, endedAt = null, notes = null) {
    return window.progressLedger.sessions.add(profileId, subjectId, durationMinutes, startedAt, endedAt, notes);
  },
  remove(profileId, id) {
    return window.progressLedger.sessions.remove(profileId, id);
  },
  stats(profileId) {
    return window.progressLedger.sessions.stats(profileId);
  },
  /** Academic tree for the subject picker (reuses the academic API). */
  getTree(profileId) {
    return window.progressLedger.academic.tree(profileId);
  },
};
