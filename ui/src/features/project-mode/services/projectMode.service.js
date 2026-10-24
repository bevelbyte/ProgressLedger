// Project Mode service: thin wrapper around the IPC namespace.
//
// All calls funnel through window.careerflow.projectMode. The renderer
// never sees the API key — `getProviderConfig` only returns
// `{ endpoint, model, hasKey }`.

const ns = () => window.careerflow && window.careerflow.projectMode;

function call(method, ...args) {
  const n = ns();
  if (!n || typeof n[method] !== "function") {
    return Promise.reject(new Error(`projectMode.${method} is not available`));
  }
  return n[method](...args);
}

export const projectModeService = {
  onEvent: (callback) => {
    const n = ns();
    if (!n || typeof n.onEvent !== "function") return () => {};
    return n.onEvent(callback);
  },
  // Projects
  listProjects: (profileId) => call("listProjects", profileId),
  createProject: (input) => call("createProject", input),
  getProject: (profileId, projectId) => call("getProject", profileId, projectId),
  deleteProject: (profileId, projectId) => call("deleteProject", profileId, projectId),

  // Agents
  listAgents: (profileId, projectId) => call("listAgents", profileId, projectId),
  createAgent: (profileId, projectId, objective) => call("createAgent", profileId, projectId, objective),
  getAgent: (profileId, agentId) => call("getAgent", profileId, agentId),
  getPlan: (profileId, agentId) => call("getPlan", profileId, agentId),
  listMessages: (profileId, agentId) => call("listMessages", profileId, agentId),
  // Paginated message list for the session timeline panel.
  // Pass `before` (last message id seen) for cursor-based pagination.
  // `limit` defaults to 50 and is clamped to [1, 200] server-side.
  listMessagesPaginated: (profileId, agentId, limit, before) =>
    call("listMessagesPaginated", profileId, agentId, limit, before),
  // Sub-agent tree
  getChildren: (profileId, parentAgentId) =>
    call("getChildren", profileId, parentAgentId),
  setParent: (profileId, agentId, parentAgentId) =>
    call("setParent", profileId, agentId, parentAgentId),

  // Run control. The preload binding is POSITIONAL
  // (profileId, agentId) — see shell/src/preload.cjs startAgent — so the
  // object form is destructured here. Passing the object straight
  // through sent { profileId: {…}, agentId: undefined } over IPC and
  // the ownership check rejected every UI-driven start.
  startAgent: ({ profileId, agentId }) => call("startAgent", profileId, agentId),
  cancelAgent: (profileId, agentId) => call("cancelAgent", profileId, agentId),
  getAgentRun: (profileId, agentId) => call("getAgentRun", profileId, agentId),

  // Sub-agent run telemetry (read-only). Reads the `subagent_runs`
  // table via `agent:list-subagent-runs` (shell/src/ipc/project-mode.js).
  // Rows are camelCase SubagentRun objects: { id, parentAgentId, role,
  // childAgentId, runId, startedAt, endedAt, outcome, tokensIn,
  // tokensOut, error }. `parentAgentId` scopes to one parent; omit or
  // pass null for all parents in the profile. `limit` defaults to 200
  // and is clamped server-side to [1, 1000]. A missing core returns
  // `{ ok: false, reason }` instead of an array — callers must
  // `Array.isArray` before iterating.
  listSubagentRuns: (profileId, parentAgentId, limit) =>
    call("listSubagentRuns", profileId, parentAgentId, limit),

  // Token budget (read-only): { current, cap, usedPct, lastUpdated }.
  // A cap of 0 means "no limit"; usedPct is 0 in that case.
  getBudget: (profileId, agentId) => call("getBudget", profileId, agentId),

  // Agent run history (parent-agent runs, pm_agents) — one row per run.
  listRecentAgentRuns: (profileId, limit) =>
    call("listRecentAgentRuns", profileId, limit),
  // Resumable previous run: most-recent non-terminal agent (running or
  // paused when CareerFlow was last closed). Returns
  // `{ ok, agent | null }` — agent is null when nothing is resumable.
  listResumableAgent: (profileId, limit) =>
    call("listResumableAgent", profileId, limit),

  // Recent failed agent runs (pm_agents where state='failed') with the
  // last role='status' message attached (verification / budget-exceeded
  // / fix-retry trace). `since` is an optional ISO-8601 timestamp.
  // `limit` defaults to 50 and is clamped server-side to [1, 500].
  listAgentErrors: (profileId, since, limit) =>
    call("listAgentErrors", profileId, since, limit),

  // Tool approval queue — list pending approvals and resolve them.
  listPendingApprovals: (profileId, agentId) =>
    call("listPendingApprovals", profileId, agentId),
  approveCall: (profileId, agentId, approvalId) =>
    call("approveCall", profileId, agentId, approvalId),
  denyCall: (profileId, agentId, approvalId) =>
    call("denyCall", profileId, agentId, approvalId),

  // Provider credentials
  getProviderConfig: (profileId, projectId) => call("getProviderConfig", profileId, projectId),
  // The preload binding is POSITIONAL
  // (profileId, projectId, config) — see shell/src/preload.cjs setProviderConfig.
  // Spreading `{ profileId, projectId, ...config }` into the FIRST argument
  // sent { profileId: {…}, projectId: undefined, config: undefined } over IPC,
  // so the main-process project-ownership check rejected every save and the
  // supported credential-store write path was dead (the agent then silently
  // fell back to the mock provider). Forward positionally instead.
  setProviderConfig: (profileId, projectId, config) =>
    call("setProviderConfig", profileId, projectId, config),
  clearProviderConfig: (profileId, projectId) => call("clearProviderConfig", profileId, projectId),

  // Default provider per project (stored in pm_projects.config_json)
  getDefaultProvider: (profileId, projectId) => call("getDefaultProvider", profileId, projectId),
  setDefaultProvider: (profileId, projectId, providerId) =>
    call("setDefaultProvider", profileId, projectId, providerId),

  // Tool system (delegates through projectTools)
  listTools: () =>
    window.careerflow.projectTools ? window.careerflow.projectTools.list() : Promise.resolve({ ok: false, tools: [] }),
  approveTool: (toolName, input) =>
    window.careerflow.projectTools ? window.careerflow.projectTools.approve(toolName, input) : Promise.resolve({ ok: false }),
  invokeTool: (toolName, input, options) =>
    window.careerflow.projectTools ? window.careerflow.projectTools.invoke(toolName, input, options) : Promise.resolve({ ok: false }),

  // Plan template library. savePlanTemplate upserts on (profile_id, name);
  // listPlanTemplates returns newest-first; loadPlanTemplate accepts either
  // a row id or a name. Profile-scoped at the SQL boundary.
  savePlanTemplate: (profileId, name, description, planJson) =>
    call("savePlanTemplate", profileId, name, description, planJson),
  listPlanTemplates: (profileId) => call("listPlanTemplates", profileId),
  loadPlanTemplate: (profileId, templateId, name) =>
    call("loadPlanTemplate", profileId, templateId, name),
  deletePlanTemplate: (profileId, templateId) =>
    call("deletePlanTemplate", profileId, templateId),
};
