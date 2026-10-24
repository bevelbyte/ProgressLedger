/**
 * Career Planning service — renderer path to career goals + roadmap milestones.
 * Thin wrapper over window.careerflow.career.* (IPC -> Rust -> SQLite). No logic.
 */
export const careerService = {
  listGoals(profileId) {
    return window.careerflow.career.goals(profileId);
  },
  /** input: {profileId, title, targetRole?, domain?, description?, targetDate?, isPrimary?} */
  addGoal(input) {
    return window.careerflow.career.addGoal(input);
  },
  /** input: {id, title, targetRole?, domain?, description?, targetDate?, status} */
  updateGoal(input) {
    return window.careerflow.career.updateGoal(input);
  },
  setPrimaryGoal(profileId, id) {
    return window.careerflow.career.setPrimaryGoal(profileId, id);
  },
  deleteGoal(profileId, id) {
    return window.careerflow.career.deleteGoal(profileId, id);
  },

  listMilestones(profileId, goalId) {
    return window.careerflow.career.milestones(profileId, goalId);
  },
  /** input: {profileId, goalId, title, description?, targetDate?} */
  addMilestone(input) {
    return window.careerflow.career.addMilestone(input);
  },
  /** input: {profileId, id, title, description?, targetDate?} */
  updateMilestone(input) {
    return window.careerflow.career.updateMilestone(input);
  },
  setMilestoneCompletion(profileId, id, completed) {
    return window.careerflow.career.setMilestoneCompletion(profileId, id, completed);
  },
  reorderMilestones(profileId, goalId, orderedIds) {
    return window.careerflow.career.reorderMilestones(profileId, goalId, orderedIds);
  },
  deleteMilestone(profileId, id) {
    return window.careerflow.career.deleteMilestone(profileId, id);
  },
  setMilestoneProject(profileId, milestoneId, projectId) {
    return window.careerflow.career.setMilestoneProject(profileId, milestoneId, projectId);
  },
  setMilestoneSubject(profileId, milestoneId, subjectId) {
    return window.careerflow.career.setMilestoneSubject(profileId, milestoneId, subjectId);
  },
};
