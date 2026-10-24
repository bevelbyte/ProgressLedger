// Atlas shell — operator state.
//
// One process-wide mirror of what the agent subsystem is doing, fed by the
// sanitized live event stream (`projectModeService.onEvent`) rather than by
// polling. This is what makes "the machine is visible" true everywhere in the
// app instead of only inside the Runs console.
//
// What the renderer is allowed to know is fixed by the main process:
// `shell/src/services/agent/event-sanitizer.js` deliberately projects only
// tool name / call id / permission / elapsed time / error code across the
// boundary — never tool arguments. The operator surfaces therefore describe
// *what kind of action* is being taken (permission), not its payload, and
// point at the durable transcript for detail.
//
// The store is inert until `startOperator()` is called (from the app shell)
// and is fully torn down by the returned disposer, so importing it never
// registers a listener.

import { projectModeService } from "../features/project-mode/services/projectMode.service.js";

const MAX_ACTIVITY = 60;
const MAX_RUNS = 40;

export const operator = $state({
  /** Live and recent runs, newest first. */
  runs: [],
  /** Approvals awaiting a decision, across every run. */
  approvals: [],
  /** The recent tool-call stream, newest first. */
  activity: [],
  /** True once an event has been observed this session. */
  live: false,
  /** Whether the operator console drawer is expanded. */
  consoleOpen: false,
  /** Which console tab the user last looked at. */
  consoleTab: "approvals",
});

let unsubscribe = null;

/** Terminal agent states — a run in one of these is done. */
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function upsertRun(agentId, patch) {
  const idx = operator.runs.findIndex((r) => r.agentId === agentId);
  if (idx === -1) {
    operator.runs.unshift({ agentId, startedAt: Date.now(), ...patch });
  } else {
    operator.runs[idx] = { ...operator.runs[idx], ...patch };
  }
  if (operator.runs.length > MAX_RUNS) operator.runs.length = MAX_RUNS;
}

function pushActivity(entry) {
  operator.activity.unshift({ at: Date.now(), ...entry });
  if (operator.activity.length > MAX_ACTIVITY) operator.activity.length = MAX_ACTIVITY;
}

/**
 * Apply one sanitized agent event. Exported so the behaviour is testable
 * without a live event bridge.
 */
export function applyOperatorEvent(event) {
  if (!event || typeof event.type !== "string") return false;
  if (!Number.isInteger(event.agentId)) return false;
  operator.live = true;

  switch (event.type) {
    case "agent.started":
    case "agent.resumed":
      upsertRun(event.agentId, {
        projectId: event.projectId,
        runId: event.runId,
        state: event.type === "agent.resumed" ? "resumed" : "running",
        objective: event.objective || null,
        endedAt: null,
      });
      return true;

    case "agent.planning":
    case "agent.replanning":
    case "agent.verifying":
      upsertRun(event.agentId, {
        projectId: event.projectId,
        runId: event.runId,
        state: event.type.slice("agent.".length),
      });
      return true;

    case "agent.tool.started":
      upsertRun(event.agentId, {
        projectId: event.projectId,
        state: "executing_tool",
        currentTool: event.tool || null,
      });
      pushActivity({
        kind: "started",
        agentId: event.agentId,
        projectId: event.projectId,
        tool: event.tool || "tool",
        callId: event.callId || null,
      });
      return true;

    case "agent.tool.completed":
      pushActivity({
        kind: "completed",
        agentId: event.agentId,
        projectId: event.projectId,
        tool: event.tool || "tool",
        callId: event.callId || null,
        elapsedMs: Number.isFinite(event.elapsedMs) ? event.elapsedMs : null,
      });
      return true;

    case "agent.tool.failed":
      pushActivity({
        kind: "failed",
        agentId: event.agentId,
        projectId: event.projectId,
        tool: event.tool || "tool",
        callId: event.callId || null,
        errorCode: event.errorCode || null,
      });
      return true;

    case "agent.approval.required": {
      const id = event.approvalId || event.callId || `${event.ts}-${event.tool || "tool"}`;
      if (!operator.approvals.some((a) => a.id === id)) {
        operator.approvals.unshift({
          id,
          agentId: event.agentId,
          profileId: event.profileId,
          projectId: event.projectId,
          tool: event.tool || "tool",
          permission: event.permission || null,
          requestedAt: Number(event.ts) || Date.now(),
        });
      }
      upsertRun(event.agentId, {
        projectId: event.projectId,
        state: "waiting_for_approval",
      });
      // An approval is the one thing the user must never miss.
      operator.consoleOpen = true;
      operator.consoleTab = "approvals";
      return true;
    }

    case "agent.completed":
    case "agent.failed":
    case "agent.cancelled": {
      const state = event.type.slice("agent.".length);
      upsertRun(event.agentId, {
        projectId: event.projectId,
        state,
        endedAt: Number(event.ts) || Date.now(),
        reason: event.reason || null,
        tokensIn: Number.isFinite(event.tokensIn) ? event.tokensIn : null,
        tokensOut: Number.isFinite(event.tokensOut) ? event.tokensOut : null,
        currentTool: null,
      });
      if (TERMINAL.has(state)) {
        operator.approvals = operator.approvals.filter((a) => a.agentId !== event.agentId);
      }
      return true;
    }

    default:
      return false;
  }
}

/**
 * Begin mirroring agent events. Safe to call when the IPC bridge is absent
 * (tests, non-Electron): it degrades to an inert store with a no-op disposer.
 */
export function startOperator() {
  if (unsubscribe) return unsubscribe;
  try {
    unsubscribe = projectModeService.onEvent(applyOperatorEvent) || null;
  } catch (_e) {
    unsubscribe = null;
  }
  return () => {
    if (typeof unsubscribe === "function") unsubscribe();
    unsubscribe = null;
  };
}

/** Drop an approval row once the main process has confirmed the decision. */
export function clearOperatorApproval(id) {
  operator.approvals = operator.approvals.filter((a) => a.id !== id);
}

/** Count of runs that are not in a terminal state. */
export function activeRunCount() {
  return operator.runs.filter((r) => !TERMINAL.has(r.state)).length;
}

/** True when the operator is blocked on the user. */
export function operatorNeedsUser() {
  return operator.approvals.length > 0;
}

/** A one-line, human readout of operator state for the status bar. */
export function operatorSummary() {
  if (operator.approvals.length > 0) {
    const n = operator.approvals.length;
    return { tone: "warn", text: `${n} waiting for you` };
  }
  const active = activeRunCount();
  if (active > 0) return { tone: "live", text: `running · ${active} agent${active === 1 ? "" : "s"}` };
  const last = operator.runs.find((r) => TERMINAL.has(r.state));
  if (last) return { tone: last.state === "completed" ? "ok" : "muted", text: `last run ${last.state}` };
  return { tone: "muted", text: "operator idle" };
}

/** Reset for tests. */
export function __resetOperator() {
  operator.runs = [];
  operator.approvals = [];
  operator.activity = [];
  operator.live = false;
  operator.consoleOpen = false;
  operator.consoleTab = "approvals";
}
