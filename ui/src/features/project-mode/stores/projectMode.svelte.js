// Project Mode — renderer-side store (Svelte 5 runes module).
//
// Holds the active project, the active agent, the live transcript, the
// plan, and any pending tool-approval requests. Mutations go through
// the IPC namespace; the store only mirrors the main-process state.

import { projectModeService } from "../services/projectMode.service.js";

export const projectModeStore = $state({
  // List of projects for the active profile
  projects: [],
  // Currently selected project (or null)
  activeProjectId: null,
  // Currently selected agent (or null)
  activeAgentId: null,
  // Run identity for the live event stream. Prevents late events from an
  // older run from mutating the newly-started run's UI state.
  activeRunId: null,
  // Active agent's metadata
  agent: null,
  // Live transcript
  messages: [],
  // Live plan (parsed from agent.plan_json)
  plan: [],
  // Tool activity (running + recently completed). Each item: { id, name, status, startedAt, elapsedMs? }
  toolActivity: [],
  // Pending approval requests. Each item: { toolName, input, permission, requestedAt }
  pendingApprovals: [],
  // Loading flags
  loadingProjects: false,
  loadingMessages: false,
  // Profile whose project list/context is currently loaded. This prevents
  // switching profiles from retaining the previous profile's project and
  // agent selection while the new list is loading.
  loadedProfileId: null,

  get activeProject() {
    return this.projects.find((p) => p.id === this.activeProjectId) || null;
  },
});

/** Load all projects for the given profile. */
export async function loadProjects(profileId) {
  if (profileId == null) {
    projectModeStore.projects = [];
    projectModeStore.loadedProfileId = null;
    clearActiveContext();
    return;
  }
  const requestProfileId = profileId;
  if (projectModeStore.loadedProfileId !== requestProfileId) {
    clearActiveContext();
    projectModeStore.projects = [];
    projectModeStore.loadedProfileId = requestProfileId;
  }
  projectModeStore.loadingProjects = true;
  try {
    const res = await projectModeService.listProjects(requestProfileId);
    // A profile switch can race an older list request. Never let the older
    // response repopulate the renderer with another profile's projects.
    if (projectModeStore.loadedProfileId !== requestProfileId) return;
    projectModeStore.projects = Array.isArray(res) ? res : [];
  } catch (e) {
    if (projectModeStore.loadedProfileId !== requestProfileId) return;
    projectModeStore.projects = [];
    throw e;
  } finally {
    if (projectModeStore.loadedProfileId === requestProfileId) {
      projectModeStore.loadingProjects = false;
    }
  }
}

function clearActiveContext() {
  projectModeStore.activeProjectId = null;
  projectModeStore.activeAgentId = null;
  projectModeStore.activeRunId = null;
  projectModeStore.agent = null;
  projectModeStore.messages = [];
  projectModeStore.plan = [];
  projectModeStore.toolActivity = [];
  projectModeStore.pendingApprovals = [];
}

/** Create a project and refresh the list. Returns the new project id. */
export async function createProject(profileId, { name, description, rootPath, configJson }) {
  const id = await projectModeService.createProject({
    profileId,
    name,
    description: description || "",
    rootPath,
    configJson: configJson || "{}",
  });
  await loadProjects(profileId);
  return id;
}

/** Delete a project and clear selection if it was active. */
export async function deleteProject(profileId, projectId) {
  await projectModeService.deleteProject(profileId, projectId);
  if (projectModeStore.activeProjectId === projectId) {
    projectModeStore.activeProjectId = null;
    projectModeStore.activeAgentId = null;
    projectModeStore.activeRunId = null;
    projectModeStore.agent = null;
    projectModeStore.messages = [];
    projectModeStore.plan = [];
  }
  await loadProjects(profileId);
}

/** Select a project (does NOT load messages — call loadAgent next). */
export function selectProject(projectId) {
  projectModeStore.activeProjectId = projectId;
  projectModeStore.activeAgentId = null;
  projectModeStore.activeRunId = null;
  projectModeStore.agent = null;
  projectModeStore.messages = [];
  projectModeStore.plan = [];
  projectModeStore.toolActivity = [];
}

/**
 * Create a new agent in the active project and start a run. Returns
 * { ok, agentId, runId? }.
 */
export async function createAndStartAgent(profileId, projectId, objective) {
  const created = await projectModeService.createAgent(profileId, projectId, objective);
  const agentId = typeof created === "number" ? created : created && typeof created.id === "number" ? created.id : null;
  if (agentId == null) return { ok: false, error: created && created.error ? created.error : "agent-create-failed" };
  projectModeStore.activeAgentId = agentId;
  projectModeStore.activeRunId = null;
  let runId = null;
  let startError = null;
  try {
    const start = await projectModeService.startAgent({ profileId, agentId });
    if (start && start.ok) {
      runId = start.runId;
      projectModeStore.activeRunId = runId || null;
    } else {
      // Surface the rejection reason — a silently dropped start left the
      // agent row idle forever with no user-visible error.
      startError = (start && start.error) || "start-rejected";
      console.warn("startAgent rejected:", startError);
    }
  } catch (e) {
    // Non-fatal — the agent row still exists and the user can start it later.
    startError = String(e && e.message ? e.message : e).slice(0, 200);
    console.warn("startAgent failed:", e);
  }
  return { ok: true, agentId, runId, startError };
}

/** Load the active agent + transcript from the main process. */
export async function loadAgent(profileId, agentId) {
  if (profileId == null || agentId == null) {
    projectModeStore.agent = null;
    projectModeStore.messages = [];
    return;
  }
  projectModeStore.loadingMessages = true;
  try {
    const agent = await projectModeService.getAgent(profileId, agentId);
    projectModeStore.agent = agent;
    projectModeStore.plan = parsePlanJson(agent && agent.plan_json);
    const messages = await projectModeService.listMessages(profileId, agentId);
    projectModeStore.messages = Array.isArray(messages) ? messages : [];
    rebuildToolActivity(projectModeStore.messages);
    // Approval continuity: pending approvals live in the main-process
    // queue (durable across renderer reloads), but until now they only
    // reached the UI via the LIVE event stream — so after a mid-approval
    // page reload the agent stayed blocked while the UI showed nothing
    // to approve. Rehydrate from the authoritative queue on every agent
    // load; rows the user already resolved locally are simply re-added
    // only if still pending in the main process (listPendingApprovals is
    // authoritative and resolved ids are gone there).
    try {
      const pend = await projectModeService.listPendingApprovals(profileId, agentId);
      const rows = pend && pend.ok !== false && Array.isArray(pend.approvals) ? pend.approvals : [];
      projectModeStore.pendingApprovals = rows.map((r) => ({
        id: r.id,
        toolName: r.toolName || r.tool || "tool",
        permission: r.permission || null,
        requestedAt: r.requestedAt || Date.now(),
        // NOTE: intentionally NO raw args here — the main process
        // sanitizes approval entries for the renderer boundary.
      }));
    } catch (_e) {
      // Non-fatal: live events still feed the queue in-session.
    }
  } finally {
    projectModeStore.loadingMessages = false;
  }
}

/**
 * Refresh the active agent's parsed plan from the main process via the
 * `project:get-plan` IPC channel. The main process parses plan_json
 * through the canonical `parsePlan` helper, so the renderer always sees
 * the operational { steps, version } shape. Falls back to the locally-
 * cached `agent.plan_json` if the IPC call fails (e.g. during a quick
 * re-render before the agent row is loaded).
 */
export async function refreshPlan(profileId, agentId) {
  if (profileId == null || agentId == null) {
    projectModeStore.plan = [];
    return { ok: false, reason: "missing-ids" };
  }
  try {
    const res = await projectModeService.getPlan(profileId, agentId);
    if (res && res.ok && res.plan && Array.isArray(res.plan.steps)) {
      projectModeStore.plan = res.plan.steps;
      return { ok: true, plan: res.plan };
    }
    // Fallback: try the legacy parse path on agent.plan_json
    if (projectModeStore.agent && typeof projectModeStore.agent.plan_json === "string") {
      projectModeStore.plan = parsePlanJson(projectModeStore.agent.plan_json);
    }
    return res || { ok: false, reason: "no-response" };
  } catch (e) {
    if (projectModeStore.agent && typeof projectModeStore.agent.plan_json === "string") {
      projectModeStore.plan = parsePlanJson(projectModeStore.agent.plan_json);
    }
    return { ok: false, reason: String(e && e.message || e) };
  }
}

export function parsePlanJson(planJson) {
  if (!planJson) return [];
  try {
    const parsed = JSON.parse(planJson);
    // Canonical shape from plan.js: { steps: [...], version }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.steps)) {
      return parsed.steps.map(normalizeStepShape);
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeStepShape);
  } catch (_e) {
    return [];
  }
}

function normalizeStepShape(step) {
  if (!step || typeof step !== "object") {
    return { id: Math.random().toString(36).slice(2, 8), title: "(untitled)", status: "pending" };
  }
  const status = typeof step.status === "string" ? step.status.toLowerCase() : "pending";
  const normStatus = status === "completed" ? "done" : status;
  return {
    id: step.id || step.title || Math.random().toString(36).slice(2, 8),
    title: step.title || step.name || "(untitled)",
    status: normStatus,
    depends_on: Array.isArray(step.depends_on) ? step.depends_on.filter((d) => typeof d === "string") : [],
    files: Array.isArray(step.files) ? step.files.filter((f) => typeof f === "string") : [],
    assigned_to: typeof step.assigned_to === "string" ? step.assigned_to : null,
  };
}

/**
 * Rebuild the tool trace from the durable transcript.
 *
 * TWO rules learned the hard way (D12/D13), both encoded here:
 *
 * 1. READ THE JS NAME, NOT THE RUST NAME. Native `pm_messages` rows are napi
 *    objects, so the Rust field `payload_json` reaches the renderer as
 *    `payloadJson`; fixtures and older surfaces use the snake name. Reading only
 *    `payload_json` made `JSON.parse` see `"{}"`, so this function silently
 *    produced an empty list for every real run. Both are read, camelCase first.
 *
 * 2. A REBUILD MUST NOT ERASE WHAT IT CANNOT RECONSTRUCT. `loadAgent` calls
 *    this immediately after `startAgent` resolves - while the run's own live
 *    events (and their tool rows) are still arriving. Because the rebuild was
 *    silently empty, the assignment below wiped a live row and a healthy run's
 *    tool trace read "No tool activity yet." for the rest of the run. So the
 *    store is replaced only when the rebuild is trustworthy: either the
 *    transcript has no tool rows at all (an honest empty trace), or at least
 *    one of them was actually readable. Otherwise the existing live activity is
 *    preserved and the caller is told the rebuild was refused.
 *
 * @returns {boolean} true when the store was replaced, false when refused.
 */
function rebuildToolActivity(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const items = [];
  let toolRows = 0;
  let readableToolRows = 0;

  // `??` (not `||`) so an empty-string payload falls through to the other name
  // instead of being treated as the payload.
  const payloadOf = (m) => m.payloadJson ?? m.payload_json;

  for (const m of list) {
    if (m.role === "tool_call") {
      toolRows += 1;
      let parsed = null;
      try { parsed = JSON.parse(payloadOf(m) || "{}"); } catch (_e) {}
      const calls = parsed && Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.calls) ? parsed.calls : []);
      if (calls.length > 0) readableToolRows += 1;
      for (const c of calls) {
        items.push({
          id: c.id || `${m.id}-${c.name}`,
          name: c.name,
          status: "running",
          startedAt: m.createdAt ?? m.created_at,
        });
      }
    } else if (m.role === "tool_result") {
      toolRows += 1;
      let parsed = null;
      try { parsed = JSON.parse(payloadOf(m) || "{}"); } catch (_e) {}
      const callId = parsed && parsed.callId;
      const result = parsed && parsed.result;
      if (callId || result) readableToolRows += 1;
      const target = items.find((it) => it.id === callId || (!callId && false));
      if (target) {
        target.status = result && result.ok ? "completed" : "failed";
        if (result && result.elapsedMs != null) target.elapsedMs = result.elapsedMs;
      } else if (callId) {
        items.push({
          id: callId,
          name: parsed && parsed.name,
          status: result && result.ok ? "completed" : "failed",
          startedAt: m.createdAt ?? m.created_at,
          elapsedMs: result && result.elapsedMs,
        });
      }
    }
  }

  // Rule 2. Tool rows exist but none of them could be read: the row shape is not
  // one this build understands, so the result is not a reconstruction - it is a
  // blind empty list. Keep the live trace rather than hiding a running tool.
  if (toolRows > 0 && readableToolRows === 0) return false;

  projectModeStore.toolActivity = items.slice(-20);
  return true;
}

/** Add a transient tool entry — used while the agent loop is running. */
export function pushToolActivity(item) {
  projectModeStore.toolActivity.push({
    startedAt: Date.now(),
    ...item,
  });
  if (projectModeStore.toolActivity.length > 20) {
    projectModeStore.toolActivity.splice(0, projectModeStore.toolActivity.length - 20);
  }
}

export function setToolActivityStatus(id, status, extra) {
  const target = projectModeStore.toolActivity.find((t) => t.id === id);
  if (target) {
    target.status = status;
    if (extra) Object.assign(target, extra);
  }
}

/** Push a fresh tool-call entry to the transcript (for the live view). */
export function appendLocalMessage(message) {
  projectModeStore.messages.push(message);
}

/** Append a transient approval request. */
export function pushApprovalRequest(req) {
  projectModeStore.pendingApprovals.push({
    requestedAt: Date.now(),
    ...req,
  });
}

export function resolveApprovalRequest(id, decision) {
  const idx = projectModeStore.pendingApprovals.findIndex((a) => a.id === id);
  if (idx !== -1) {
    projectModeStore.pendingApprovals.splice(idx, 1);
  }
  return decision;
}

/**
 * Apply one sanitized live main-process agent event. The durable DB remains
 * authoritative; these mutations only make the current workspace responsive
 * between persistence reads.
 */
export function applyAgentEvent(event) {
  if (!event || typeof event !== "object") return false;
  if (typeof event.projectId === "number" && event.projectId !== projectModeStore.activeProjectId) return false;
  if (typeof event.agentId === "number" && event.agentId !== projectModeStore.activeAgentId) return false;
  if (event.runId && projectModeStore.activeRunId && event.runId !== projectModeStore.activeRunId) return false;
  if ((event.type === "agent.started" || event.type === "agent.resumed") && event.runId) {
    projectModeStore.activeRunId = event.runId;
  }

  switch (event.type) {
    case "agent.tool.started":
      if (typeof event.tool === "string") {
        pushToolActivity({ id: event.callId || `${event.ts}-${event.tool}`, name: event.tool, status: "running" });
      }
      return true;
    case "agent.tool.completed":
      if (typeof event.tool === "string") {
        const target = event.callId
          ? projectModeStore.toolActivity.find((t) => t.id === event.callId)
          : [...projectModeStore.toolActivity].reverse().find((t) => t.name === event.tool && t.status === "running");
        if (target) setToolActivityStatus(target.id, "completed", { elapsedMs: event.elapsedMs });
      }
      return true;
    case "agent.tool.failed":
      if (typeof event.tool === "string") {
        const target = event.callId
          ? projectModeStore.toolActivity.find((t) => t.id === event.callId)
          : [...projectModeStore.toolActivity].reverse().find((t) => t.name === event.tool && t.status === "running");
        if (target) setToolActivityStatus(target.id, "failed", { errorCode: event.errorCode });
      }
      return true;
    case "agent.approval.required":
      pushApprovalRequest({
        id: event.approvalId || `${event.ts}-${event.tool || "tool"}`,
        toolName: event.tool || "tool",
        permission: event.permission || null,
      });
      return true;
    case "agent.completed":
    case "agent.failed":
    case "agent.cancelled":
      if (projectModeStore.agent) projectModeStore.agent = { ...projectModeStore.agent, state: event.type.slice("agent.".length) };
      return true;
    default:
      return false;
  }
}
