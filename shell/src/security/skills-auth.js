import { Skills } from "../services/skills/index.js";

/** Validate the complete scope before changing persisted skill state. */
export async function validateSkillEnableScope(ctx, profileId, projectId, skillId) {
  if (!Number.isInteger(profileId) || profileId < 1) {
    return { ok: false, error: { code: "invalid-input", message: "profileId required" } };
  }
  if (typeof skillId !== "string" || !skillId) {
    return { ok: false, error: { code: "invalid-input", message: "skillId required" } };
  }
  if (!Skills.list().some((s) => s.id === skillId)) {
    return { ok: false, error: { code: "unknown-skill", message: "skill does not exist" } };
  }
  const getProfiles = ctx?.core && typeof ctx.core.getProfiles === "function" ? ctx.core.getProfiles.bind(ctx.core) : null;
  if (!getProfiles) return { ok: false, error: { code: "core-not-wired", message: "profile ownership cannot be verified" } };
  let profiles;
  try { profiles = await Promise.resolve(getProfiles()); } catch { profiles = null; }
  if (!Array.isArray(profiles) || !profiles.some((p) => Number(p?.id ?? p?.profile_id) === profileId)) {
    return { ok: false, error: { code: "profile-not-found", message: "profile does not exist" } };
  }
  if (projectId != null) {
    if (!Number.isInteger(projectId) || projectId < 1) {
      return { ok: false, error: { code: "invalid-input", message: "projectId must be a positive integer" } };
    }
    const getProject = ctx?.core && typeof ctx.core.pmGetProject === "function" ? ctx.core.pmGetProject.bind(ctx.core) : null;
    if (!getProject) return { ok: false, error: { code: "core-not-wired", message: "project ownership cannot be verified" } };
    let project;
    try { project = await Promise.resolve(getProject(profileId, projectId)); } catch { project = null; }
    const owner = project && (project.profileId ?? project.profile_id);
    if (!project || project.ok === false || Number(project.id) !== projectId || Number(owner) !== profileId) {
      return { ok: false, error: { code: "project-not-owned", message: "project does not belong to profile" } };
    }
  }
  return { ok: true };
}
