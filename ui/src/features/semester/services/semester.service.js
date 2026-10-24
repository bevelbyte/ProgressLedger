/**
 * Semester Progress service — the renderer path to the aggregated semester
 * overview. Thin wrapper over the single bounded IPC read; no logic here.
 */
export const semesterService = {
  getOverview(profileId, semesterId) {
    return window.progressLedger.resources.semesterOverview({ profileId, semesterId });
  },
};
