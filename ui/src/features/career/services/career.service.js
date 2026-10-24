/**
 * Career Planning service — renderer path to career goals + roadmap milestones.
 * Thin wrapper over window.progressLedger.career.* (IPC -> Rust -> SQLite). No logic.
 */
export const careerService = {
  listGoals(profileId) {
    return window.progressLedger.career.goals(profileId);
  },
  /** input: {profileId, title, targetRole?, domain?, description?, targetDate?, isPrimary?} */
  addGoal(input) {
    return window.progressLedger.career.addGoal(input);
  },
  /** input: {id, title, targetRole?, domain?, description?, targetDate?, status} */
  updateGoal(input) {
    return window.progressLedger.career.updateGoal(input);
  },
  setPrimaryGoal(profileId, id) {
    return window.progressLedger.career.setPrimaryGoal(profileId, id);
  },
  deleteGoal(profileId, id) {
    return window.progressLedger.career.deleteGoal(profileId, id);
  },

  listMilestones(profileId, goalId) {
    return window.progressLedger.career.milestones(profileId, goalId);
  },
  /** input: {profileId, goalId, title, description?, targetDate?} */
  addMilestone(input) {
    return window.progressLedger.career.addMilestone(input);
  },
  /** input: {profileId, id, title, description?, targetDate?} */
  updateMilestone(input) {
    return window.progressLedger.career.updateMilestone(input);
  },
  setMilestoneCompletion(profileId, id, completed) {
    return window.progressLedger.career.setMilestoneCompletion(profileId, id, completed);
  },
  reorderMilestones(profileId, goalId, orderedIds) {
    return window.progressLedger.career.reorderMilestones(profileId, goalId, orderedIds);
  },
  deleteMilestone(profileId, id) {
    return window.progressLedger.career.deleteMilestone(profileId, id);
  },
  setMilestoneProject(profileId, milestoneId, projectId) {
    return window.progressLedger.career.setMilestoneProject(profileId, milestoneId, projectId);
  },
  setMilestoneSubject(profileId, milestoneId, subjectId) {
    return window.progressLedger.career.setMilestoneSubject(profileId, milestoneId, subjectId);
  },
};
