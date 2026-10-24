import { safeHandle } from "../security/safe-handle.js";
import { ipcMain } from "electron";

export function register({ core }) {
  // Career goals
  safeHandle("career:goals", (_e, profileId) => core.getCareerGoals(profileId));
  safeHandle("career:add-goal", (_e, { profileId, title, targetRole, domain, description, targetDate, isPrimary }) =>
    core.addCareerGoal(profileId, title, targetRole ?? null, domain ?? null, description ?? null, targetDate ?? null, Boolean(isPrimary))
  );
  safeHandle("career:update-goal", (_e, { profileId, id, title, targetRole, domain, description, targetDate, status }) =>
    core.updateCareerGoal(profileId, id, title, targetRole ?? null, domain ?? null, description ?? null, targetDate ?? null, status)
  );
  safeHandle("career:set-primary-goal", (_e, { profileId, id }) => core.setPrimaryCareerGoal(profileId, id));
  safeHandle("career:delete-goal", (_e, { profileId, id }) => core.deleteCareerGoal(profileId, id));

  // Career milestones (roadmap)
  safeHandle("career:milestones", (_e, { profileId, goalId }) => core.getCareerMilestones(profileId, goalId));
  safeHandle("career:add-milestone", (_e, { profileId, goalId, title, description, targetDate }) =>
    core.addCareerMilestone(profileId, goalId, title, description ?? null, targetDate ?? null)
  );
  safeHandle("career:update-milestone", (_e, { profileId, id, title, description, targetDate }) =>
    core.updateCareerMilestone(profileId, id, title, description ?? null, targetDate ?? null)
  );
  safeHandle("career:set-milestone-completion", (_e, { profileId, id, completed }) =>
    core.setCareerMilestoneCompletion(profileId, id, completed)
  );
  safeHandle("career:reorder-milestones", (_e, { profileId, goalId, orderedIds }) =>
    core.reorderCareerMilestones(profileId, goalId, orderedIds)
  );
  safeHandle("career:delete-milestone", (_e, { profileId, id }) => core.deleteCareerMilestone(profileId, id));
  safeHandle("career:set-milestone-project", (_e, { profileId, milestoneId, projectId }) =>
    core.setCareerMilestoneProject(profileId, milestoneId, projectId ?? null)
  );
  safeHandle("career:set-milestone-subject", (_e, { profileId, milestoneId, subjectId }) =>
    core.setCareerMilestoneSubject(profileId, milestoneId, subjectId ?? null)
  );
}
