// Pure authorization for sub-agent diff reads. Kept Electron-free for focused security tests.
async function loadAgent(core, profileId, agentId) {
  if (!core || typeof core.pmGetAgent !== "function") return null;
  try {
    const out = await core.pmGetAgent(profileId, agentId);
    if (!out || typeof out !== "object" || out.ok === false) return null;
    return out;
  } catch {
    return null;
  }
}

export async function authorizeDiffCaller(core, profileId, callerAgentId, targetAgentId) {
  if (!Number.isInteger(profileId) || profileId < 1 || !Number.isInteger(callerAgentId) || callerAgentId < 1 || !Number.isInteger(targetAgentId) || targetAgentId < 1) {
    return { ok: false, error: { code: "invalid-input", message: "profileId + callerAgentId + agentId required" } };
  }
  const caller = await loadAgent(core, profileId, callerAgentId);
  if (!caller || Number(caller.id) !== callerAgentId || Number(caller.profile_id ?? caller.profileId) !== profileId) {
    return { ok: false, error: { code: "caller-agent-not-found", message: "caller agent not found" } };
  }
  let currentId = targetAgentId;
  const seen = new Set();
  for (let depth = 0; depth < 128; depth++) {
    if (currentId === callerAgentId) return { ok: true, caller };
    if (seen.has(currentId)) break;
    seen.add(currentId);
    const current = await loadAgent(core, profileId, currentId);
    if (!current || Number(current.id) !== currentId || Number(current.profile_id ?? current.profileId) !== profileId) break;
    const parentId = current.parent_agent_id == null ? null : Number(current.parent_agent_id);
    if (!Number.isInteger(parentId) || parentId < 1) break;
    currentId = parentId;
  }
  return { ok: false, error: { code: "not-authorised", message: "agent is outside caller subtree" } };
}
