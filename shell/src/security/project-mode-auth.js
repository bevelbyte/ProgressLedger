// Pure authorization primitives for Project Mode IPC.

export function authorizeAgentRecord(profileId, agentId, agent) {
  if (typeof profileId !== "number" || typeof agentId !== "number") {
    return { ok: false, error: "invalid-ids" };
  }
  if (!agent || agent.ok === false || typeof agent.id !== "number") {
    return { ok: false, error: "agent-not-owned" };
  }
  // The record must be the agent the caller actually asked for.
  //
  // This check was missing while its sibling `authorizeProjectRecord` has always
  // had the equivalent (`project.id !== projectId`). Without it the primitive
  // only proved "this agent belongs to this profile", not "this agent is the one
  // you named" — so any caller that uses the agentId for something beyond a
  // lookup key (for example `project:diff`, which selects the project ROOT from
  // a registry keyed by agentId) could be handed a record for a different agent
  // and still pass. Callers normally fetch the row with
  // `pmGetAgent(profileId, agentId)`, which makes the mismatch unreachable in
  // practice; this is defence in depth for the ones where the id is load-bearing.
  if (agent.id !== agentId) {
    return { ok: false, error: "agent-not-owned" };
  }
  const ownerProfile = agent.profile_id ?? agent.profileId;
  if (ownerProfile !== undefined && ownerProfile !== profileId) {
    return { ok: false, error: "agent-not-owned" };
  }
  return { ok: true, agent };
}

export function authorizeProjectRecord(profileId, projectId, project) {
  if (typeof profileId !== "number" || typeof projectId !== "number") {
    return { ok: false, error: "invalid-ids" };
  }
  if (!project || project.ok === false || project.id !== projectId) {
    return { ok: false, error: "project-not-owned" };
  }
  const ownerProfile = project.profile_id ?? project.profileId;
  if (ownerProfile !== undefined && ownerProfile !== profileId) {
    return { ok: false, error: "project-not-owned" };
  }
  return { ok: true, project };
}

/** Authorize command IPC scopes before any command or cancellation dispatch. */
export async function authorizeCommandScope(core, profileId, projectId, agentId) {
  if (!Number.isInteger(profileId) || profileId < 1) return { ok: false, error: "invalid-profile" };
  if (agentId == null) return { ok: true, scoped: false };
  if (!Number.isInteger(projectId) || projectId < 1 || !Number.isInteger(agentId) || agentId < 1) {
    return { ok: false, error: "invalid-ids" };
  }
  return authorizeProjectToolScope(core, profileId, projectId, agentId);
}
export function isApprovalOwned(entry, profileId, agentId) {
  return Boolean(
    entry &&
    typeof profileId === "number" &&
    typeof agentId === "number" &&
    entry.profileId === profileId &&
    entry.agentId === agentId,
  );
}

export function sanitizeApprovalEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const { resolve: _resolve, input: _input, ...safe } = entry;
  return safe;
}

/**
 * Validate the complete profile → project → agent authorization tuple used
 * by internal project-tool invocations. The renderer normally omits these
 * identifiers entirely; when supplied, all three relationships must agree
 * with the authoritative core rows before any tool executes.
 */
export async function authorizeProjectToolScope(core, profileId, projectId, agentId) {
  const supplied = [profileId, projectId, agentId].filter((v) => v !== undefined);
  if (supplied.length === 0) return { ok: true, scoped: false };
  if (supplied.length !== 3 || supplied.some((v) => !Number.isInteger(v))) {
    return { ok: false, error: { code: "invalid-ids", message: "profileId, projectId and agentId must be supplied together" } };
  }
  const getAgent = core && typeof core.pmGetAgent === "function" ? core.pmGetAgent.bind(core) : null;
  const getProject = core && typeof core.pmGetProject === "function" ? core.pmGetProject.bind(core) : null;
  if (!getAgent || !getProject) {
    return { ok: false, error: { code: "core-not-wired", message: "project ownership cannot be verified" } };
  }
  let agent;
  let project;
  try {
    [agent, project] = await Promise.all([
      getAgent(profileId, agentId),
      getProject(profileId, projectId),
    ]);
  } catch {
    return { ok: false, error: { code: "ownership-check-failed", message: "project ownership could not be verified" } };
  }
  const agentProfile = agent && (agent.profileId ?? agent.profile_id);
  const agentProject = agent && (agent.projectId ?? agent.project_id);
  const projectProfile = project && (project.profileId ?? project.profile_id);
  const projectIdentity = project && project.id;
  if (
    !agent || agent.ok === false ||
    !project || project.ok === false ||
    Number(agentProfile) !== profileId ||
    Number(agentProject) !== projectId ||
    Number(projectProfile) !== profileId ||
    Number(projectIdentity) !== projectId
  ) {
    return { ok: false, error: { code: "not-owned", message: "agent and project do not belong to the requested profile" } };
  }
  return { ok: true, scoped: true };
}
