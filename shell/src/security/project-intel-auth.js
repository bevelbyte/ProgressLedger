// Pure Project Intelligence context resolver. The Project Mode project row is
// authoritative for both ownership and filesystem root.

import { authorizeProjectRecord } from "./project-mode-auth.js";

function projectRoot(project) {
  return project && (project.rootPath ?? project.root_path);
}

export async function resolveProjectIntelContext(core, payload) {
  const profileId = payload && payload.profileId;
  const projectId = payload && payload.projectId;
  if (!Number.isInteger(profileId) || profileId < 1 || !Number.isInteger(projectId) || projectId < 1) {
    return { ok: false, error: "invalid-project-context" };
  }
  if (!core || typeof core.pmGetProject !== "function") {
    return { ok: false, error: "core-not-wired" };
  }

  let project;
  try {
    project = await core.pmGetProject(profileId, projectId);
  } catch {
    return { ok: false, error: "project-not-owned" };
  }
  const authorized = authorizeProjectRecord(profileId, projectId, project);
  if (!authorized.ok) return { ok: false, error: authorized.error };

  const rootPath = projectRoot(authorized.project);
  if (typeof rootPath !== "string" || !rootPath.trim()) {
    return { ok: false, error: "project-root-unavailable" };
  }
  return { ok: true, profileId, projectId, rootPath };
}
