// Project Mode — agent core (main-process only).
//
// The agent loop drives a multi-step model session:
//   1. Build the prompt (system + history + plan)
//   2. Stream a model response
//   3. If the response contains tool calls, validate + execute each one
//      (gated by the security layer), append results, and continue
//   4. When the model says "no more tool calls", mark the agent
//      `completed` and stop
//
// State machine: see `STATES` and the transitions in `transition`.
//
// Concurrency: at most ONE loop per agent. Concurrent calls to
// `startAgent(agentId)` for the same id return a structured refusal
// (`reason: 'already-running'`) and do NOT spawn a duplicate.
//
// Cancellation: every loop exposes a controller object with `abort()`.
// `abort()` flips a flag, cancels the active provider stream, and
// cooperatively interrupts the tool loop at the next tool boundary.
// The agent's state becomes `cancelled` and the runId is freed.
//
// Persistence: every state transition and every transcript message is
// persisted via the Rust NAPI surface (`pm_*`). The loop is therefore
// resumable across CareerFlow restarts — at minimum, the user can
// inspect the last completed run from the SQLite store.

import { createMockProvider, createOpenAiProvider } from "./provider.js";
import { createCredentialsStore } from "./credentials.js";
import { listTools } from "../project-tools/index.js";
import { Audit } from "../audit/index.js";
// ESM: this module is loaded under "type": "module". A bare
// `require("electron")` below would throw ReferenceError in the main
// process and be swallowed by its catch, silently degrading the agent
// to the mock provider (stored credentials would never be found).
// Mirror the createRequire pattern used by main.js / memory / project-intel.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { verifyCompletion, appendStatusMessage } from "./verify.js";
import { shouldRetryFix, buildFixStep } from "./fix-retry.js";
import { Memory } from "../memory/index.js";
import { persistRunState, clearRunState } from "./recovery.js";
import {
  parsePlan,
  buildInitialPlan,
  markStep,
  isPlanComplete,
  planToJson,
} from "./plan.js";
import { classifyStall, pickNextReadyBatch } from "./exec-dag.js";
import { DELEGATE_TOOL_NAMES, MAX_CONCURRENT_SUBAGENTS } from "../project-tools/_roles.js";
import {
  setActiveProjectRootFor,
  clearActiveProjectRootFor,
} from "../../ipc/agent-root-registry.js";
import { Skills } from "../skills/index.js";

// ----------------------------------------------------------------------------
// Sub-agent state cache + event bus (Phase 12 hardening)
// ----------------------------------------------------------------------------
//
// Parents that delegate_* poll pm_agents.state every 2000ms to detect
// child completion. That is IO-bound + slow. We add:
//   - a tiny in-memory cache for `core.pmGetAgent` results with a
//     200ms TTL (cheap, no NAPI change), AND
//   - an EventTarget that `finishAgent` notifies on terminal state so
//     the parent's poll loop can wake immediately instead of waiting
//     the next 2000ms tick.
//
// The 2000ms polling is retained as a fallback in case the event is
// missed (process restart, IPC layer drop, etc.).

const SUBAGENT_STATE_CACHE_TTL_MS = 200;
const subAgentStateCache = new Map(); // childAgentId -> { state, finishedAt, cachedAt }

export const SUBAGENT_EVENTS = Object.freeze({
  CHILD_TERMINAL: "subagent.child.terminal",
});

const subAgentEventTarget = new EventTarget();

function emitChildTerminal(childAgentId, state, finishedAt) {
  const event = Object.assign(new Event(SUBAGENT_EVENTS.CHILD_TERMINAL), {
    detail: { childAgentId, state, finishedAt: finishedAt || null },
  });
  subAgentEventTarget.dispatchEvent(event);
  // Invalidate the cache so the next getChildState call returns fresh
  // data (which matches the detail we just emitted).
  subAgentStateCache.delete(childAgentId);
}

export function onSubAgentTerminal(listener) {
  const wrapped = (e) => listener(e.detail);
  subAgentEventTarget.addEventListener(SUBAGENT_EVENTS.CHILD_TERMINAL, wrapped);
  return () => subAgentEventTarget.removeEventListener(SUBAGENT_EVENTS.CHILD_TERMINAL, wrapped);
}

/**
 * Test-only: dispatch a CHILD_TERMINAL event on the private target.
 * Production callers should never use this — `finishAgent` is the
 * authoritative emitter. Marked with an underscore so the intent is
 * obvious and linters can be told to ignore.
 */
export function _emitChildTerminalForTest(childAgentId, state, finishedAt) {
  emitChildTerminal(childAgentId, state, finishedAt);
}

/**
 * Read the child's persisted state via `core.pmGetAgent`, with a 200ms
 * cache. The cache is invalidated the moment `finishAgent` emits a
 * terminal event so the parent's first wake-up sees fresh data.
 *
 * Returns `{ state, finishedAt }` or `null` if the row is missing.
 */
export async function getChildState(core, profileId, childAgentId) {
  const cached = subAgentStateCache.get(childAgentId);
  if (cached && Date.now() - cached.cachedAt < SUBAGENT_STATE_CACHE_TTL_MS) {
    return { state: cached.state, finishedAt: cached.finishedAt };
  }
  const agent = await core.pmGetAgent(profileId, childAgentId);
  if (!agent || typeof agent !== "object") return null;
  const normalized = normalizeAgentRow(agent);
  const state = typeof normalized.state === "string" ? normalized.state : null;
  const finishedAt = normalized.finished_at || null;
  subAgentStateCache.set(childAgentId, {
    state,
    finishedAt,
    cachedAt: Date.now(),
  });
  return { state, finishedAt };
}

/**
 * Drop the cached row for a child (e.g. when the parent releases its
 * slot). Keeps memory bounded across long-running parents.
 */
export function invalidateChildStateCache(childAgentId) {
  subAgentStateCache.delete(childAgentId);
}
import { requiresToolApproval } from "../project-tools/security.js";
import {
  resolveTokenBudget,
  resolveMaxSteps,
  shouldInterrupt as budgetExceeded,
  buildBudgetStatusMessage,
  parseProjectConfig,
} from "./budget.js";
import { buildProjectIntelBlock } from "./context-builder.js";
import * as subagentTelemetry from "./subagent-telemetry.js";

// ----------------------------------------------------------------------------
// State machine
// ----------------------------------------------------------------------------

export const STATES = Object.freeze({
  IDLE: "idle",
  PLANNING: "planning",
  WAITING_FOR_TOOL: "waiting_for_tool",
  EXECUTING_TOOL: "executing_tool",
  WAITING_FOR_APPROVAL: "waiting_for_approval",
  OBSERVING: "observing",
  REPLANNING: "replanning",
  VERIFYING: "verifying",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

// The set of valid state transitions. A transition not in this set is
// a bug and is rejected loudly. Keep this table small and explicit.
//
// NOTE on the `X -> planning` edges from mid-execution states
// (waiting_for_tool, executing_tool, waiting_for_approval): the live
// loop NEVER uses these edges — its model-driven transitions go
// executing_tool -> observing -> planning (Phase 13 DAG batch flow).
// They exist for the RESTART path only: `startAgent(isResume)`\r
// re-enters the loop at `planning` from whatever non-terminal phase
// the agent persisted before a crash (pm_run_state/transition() writes
// "executing"/"awaiting_approval" phases durably). Without these
// edges, a mid-execution crash could never resume — startAgent threw
// `invalid agent state transition` — while the recovery sweep was
// simultaneously advertising the same row as `safe-resume`.
const VALID_TRANSITIONS = {
  idle: new Set(["planning", "failed", "cancelled"]),
  planning: new Set(["waiting_for_tool", "executing_tool", "verifying", "completed", "failed", "cancelled"]),
  waiting_for_tool: new Set(["executing_tool", "replanning", "completed", "failed", "cancelled", "planning"]),
  executing_tool: new Set(["observing", "waiting_for_approval", "replanning", "verifying", "completed", "failed", "cancelled", "planning"]),
  waiting_for_approval: new Set(["executing_tool", "replanning", "failed", "cancelled", "planning"]),
  observing: new Set(["replanning", "verifying", "completed", "failed", "cancelled", "planning"]),
  replanning: new Set(["waiting_for_tool", "executing_tool", "completed", "failed", "cancelled"]),
  verifying: new Set(["completed", "failed", "cancelled", "planning"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function canTransition(from, to) {
  const set = VALID_TRANSITIONS[from];
  return Boolean(set && set.has(to));
}

// ----------------------------------------------------------------------------
// Event stream (Phase 10)
// ----------------------------------------------------------------------------
//
// The agent emits a small set of structured events that the IPC layer
// (shell/src/ipc/project-mode.js) forwards to the renderer. We use
// Node's built-in EventTarget for in-process listeners and a simple
// per-run ring buffer so a late subscriber (e.g. the UI reattaching
// after a profile switch) can rehydrate the last N events.

export const AGENT_EVENTS = Object.freeze({
  AGENT_STARTED: "agent.started",
  AGENT_PLANNING: "agent.planning",
  AGENT_TEXT_DELTA: "agent.text.delta",
  AGENT_TOOL_STARTED: "agent.tool.started",
  AGENT_TOOL_COMPLETED: "agent.tool.completed",
  AGENT_TOOL_FAILED: "agent.tool.failed",
  AGENT_APPROVAL_REQUIRED: "agent.approval.required",
  AGENT_REPLANNING: "agent.replanning",
  AGENT_VERIFYING: "agent.verifying",
  AGENT_COMPLETED: "agent.completed",
  AGENT_FAILED: "agent.failed",
  AGENT_CANCELLED: "agent.cancelled",
  AGENT_RESUMED: "agent.resumed",
  MEMORY_RECALLED: "memory.recalled",
  PROJECT_INTEL_RECALLED: "agent.project_intel.recalled",
});

export class AgentEventBus {
  constructor({ ringSize = 256, onEvent = null, runId = null } = {}) {
    this.target = new EventTarget();
    this.ring = [];
    this.ringSize = ringSize;
    this.onEvent = typeof onEvent === "function" ? onEvent : null;
    this.runId = typeof runId === "string" ? runId : null;
  }
  emit(type, payload) {
    const event = { type, ts: Date.now(), runId: this.runId, payload };
    this.ring.push(event);
    if (this.ring.length > this.ringSize) this.ring.shift();
    this.target.dispatchEvent(Object.assign(new Event(type), { detail: event }));
    if (this.onEvent) {
      try { this.onEvent(event); } catch (_e) { /* observers are non-fatal */ }
    }
  }
  on(type, listener) {
    const wrapped = (e) => listener(e.detail);
    this.target.addEventListener(type, wrapped);
    return () => this.target.removeEventListener(type, wrapped);
  }
  recent(n = 64) {
    return this.ring.slice(-n);
  }
}

// ----------------------------------------------------------------------------
// Run registry
// ----------------------------------------------------------------------------
//
// At most one loop per agent. runId is a short-lived UUID; the registry
// is in-memory only. The persisted `state` column in pm_agents is the
// source of truth for resume / inspection.

const RUNS = new Map(); // agentId -> { runId, controller, bus, state, isSubAgent, role }

// ----------------------------------------------------------------------------
// NAPI row normalization (GATE 0 audit finding)
// ----------------------------------------------------------------------------
//
// The REAL NAPI core returns camelCase row fields (`PmAgent.planJson`,
// `PmAgent.parentAgentId`, `PmProject.rootPath`, `PmProject.configJson`,
// see core/index.d.ts). The agent loop and its test fakes historically
// read snake_case (`plan_json`, `parent_agent_id`, `root_path`,
// `config_json`). Reading the wrong spelling silently yields
// `undefined` in production: plan/resume loses progress, sub-agent
// telemetry + depth/limit checks never fire, tool projectRoot resolves
// to undefined, and the verification gate finds no test_command.
//
// Normalize ONCE at the boundary: every row consumed by the loop
// carries BOTH spellings, so downstream code (loop, verify.js,
// context-builder.js, delegate tools) can read either safely.

function aliasPair(obj, a, b) {
  const v = obj[a] !== undefined ? obj[a] : obj[b];
  if (v === undefined) return {};
  return { [a]: v, [b]: v };
}

export function normalizeAgentRow(agent) {
  if (!agent || typeof agent !== "object") return agent;
  return {
    ...agent,
    ...aliasPair(agent, "project_id", "projectId"),
    ...aliasPair(agent, "plan_json", "planJson"),
    ...aliasPair(agent, "parent_agent_id", "parentAgentId"),
    ...aliasPair(agent, "finished_at", "finishedAt"),
    ...aliasPair(agent, "tokens_in", "tokensIn"),
    ...aliasPair(agent, "tokens_out", "tokensOut"),
  };
}

export function normalizeProjectRow(project) {
  if (!project || typeof project !== "object") return project;
  return {
    ...project,
    ...aliasPair(project, "root_path", "rootPath"),
    ...aliasPair(project, "config_json", "configJson"),
  };
}

export function normalizeProfileRow(profile) {
  if (!profile || typeof profile !== "object") return profile;
  return {
    ...profile,
    ...aliasPair(profile, "profile_config", "profileConfig"),
  };
}

export function getRun(agentId) {
  return RUNS.get(agentId) || null;
}

export function listActiveRuns() {
  return [...RUNS.entries()].map(([agentId, run]) => ({
    agentId,
    runId: run.runId,
    state: run.state,
    isSubAgent: !!run.isSubAgent,
    role: run.role || null,
  }));
}

// ----------------------------------------------------------------------------
// Run controller
// ----------------------------------------------------------------------------

function shortUuid() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

/**
 * Build a controller. `signal` is the externally-supplied AbortSignal;
 * calling `abort()` cancels the provider stream and the tool loop.
 */
function makeController(signal) {
  const ctrl = new AbortController();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return ctrl;
}

/**
 * Persist a state transition. Validates the transition. The NAPI
 * `pm_update_agent` function is the only caller.
 *
 * PERF (GATE 20 v7): The loop issues several `transition()` calls per
 * round with identical (state, plan, tokens) — e.g. the OBSERVING <->
 * PLANNING loopback (loop.js:974/976) re-serializes and re-sends the
 * full plan_json for no observable change. We memoize the last write
 * per agent and skip the NAPI roundtrip when the state, plan, and
 * token counts are all identical.
 */
// Phase 15 — internal phase mirror. Maps agent states to the
// pm_run_state `phase` column. We never auto-resume a phase that
// does not match the agent's persisted state on recovery.
const AGENT_STATE_TO_PHASE = Object.freeze({
  idle: "preparing",
  planning: "planning",
  waiting_for_tool: "executing",
  executing_tool: "executing",
  waiting_for_approval: "awaiting_approval",
  observing: "executing",
  replanning: "planning",
  verifying: "verifying",
});

const transitionMemo = new Map();
async function transition(core, profileId, agentId, from, to, planJson, tokensIn, tokensOut) {
  if (!canTransition(from, to)) {
    throw new Error(`invalid agent state transition: ${from} -> ${to}`);
  }
  const key = `${to}|${planJson}|${tokensIn}|${tokensOut}`;
  const prev = transitionMemo.get(agentId);
  if (prev === key) {
    return to;
  }
  transitionMemo.set(agentId, key);
  await core.pmUpdateAgent(profileId, agentId, to, planJson, tokensIn, tokensOut);
  // Phase 15 — durable run-state mirror. We write here (not at every
  // tool call) so the recovery sweep has a low-noise history.
  const phase = AGENT_STATE_TO_PHASE[to] || "unknown";
  persistRunState(core, profileId, agentId, {
    runId: `transition-${Date.now()}`,
    role: null,
    isSubAgent: null,
    parentRunId: null,
    phase,
    state: "running",
    tokensIn: tokensIn | 0,
    tokensOut: tokensOut | 0,
    recovery: "safe-resume",
  });
  return to;
}

// ----------------------------------------------------------------------------
// Agent loop
// ----------------------------------------------------------------------------

/**
 * Start (or resume) an agent.
 *
 * @param {object} args
 * @param {object} args.core       the loaded Rust NAPI core
 * @param {number} args.profileId
 * @param {number} args.agentId
 * @param {object} [args.signal]   AbortSignal from the caller
 * @param {object} [args.provider] override the provider (tests pass a mock)
 * @param {function} [args.approvalResolver] async ({ tool, input }) => { approved: bool }
 *                                called when a tool needs approval. A missing
 *                                resolver denies privileged tools; it never
 *                                implies user approval.
 * @param {boolean} [args.isSubAgent=false]  when true, the 4 delegate_*
 *                                tools are filtered out of the model-visible
 *                                tool set (recursion guard). Set by the
 *                                delegate_* tools when they spawn a child.
 * @param {string} [args.role]     optional role hint ("researcher" / "coder"
 *                                / "tester" / "reviewer") used by the child
 *                                loop to build its specialised system prompt.
 * @returns {{ runId: string, bus: AgentEventBus, controller: AbortController }}
 */
export async function startAgent({ core, profileId, agentId, signal, provider, approvalResolver, isSubAgent = false, role = null, isResume = false, startSubAgent = null, onEvent = null }) {
  // Refuse if a run is already active for this agent.
  if (RUNS.has(agentId)) {
    const existing = RUNS.get(agentId);
    return { ok: false, reason: "already-running", runId: existing.runId };
  }
  // Refuse if the persisted state is already terminal. The user must
  // create a new agent to retry.
  const agent = normalizeAgentRow(await core.pmGetAgent(profileId, agentId));
  if (agent.state === STATES.COMPLETED || agent.state === STATES.FAILED || agent.state === STATES.CANCELLED) {
    return { ok: false, reason: `agent-already-${agent.state}` };
  }
  // TOCTOU guard (GATE 3): the entry check above ran before the
  // `pmGetAgent` await. Two concurrent starts for the same agentId can
  // both pass it. Re-check here — everything between this check and
  // RUNS.set below is synchronous, so the pair is atomic and at most
  // ONE loop per agent is ever registered.
  if (RUNS.has(agentId)) {
    const existing = RUNS.get(agentId);
    return { ok: false, reason: "already-running", runId: existing.runId };
  }

  const runId = shortUuid();
  const bus = new AgentEventBus({ onEvent, runId });
  const controller = makeController(signal);
  // Resume marker: the runId is fresh (so this run is independently
  // cancellable + observable on the bus), but the persisted plan_json
  // carries the previous progress. Emit an AGENT_RESUMED event so the
  // UI can distinguish "fresh start" from "picked up where it left off".
  if (isResume) {
    let planStepCount = 0;
    try {
      const resumePlan = parsePlan(agent && agent.plan_json);
      planStepCount = resumePlan && Array.isArray(resumePlan.steps) ? resumePlan.steps.length : 0;
    } catch (_e) {
      planStepCount = 0;
    }
    bus.emit(AGENT_EVENTS.AGENT_RESUMED, { runId, agentId, planStepCount });
  }
  // Production default: the real OpenAI-compatible provider. Credentials
  // are resolved from the credentials store FRESH on every call so a
  // rotated key is picked up without restart. If no key is configured
  // (e.g. first-run, test environment), we fall back to the mock
  // provider so the loop is still functional.
  const prov = provider || resolveDefaultProvider({ profileId, projectId: agent.projectId, bus });

  // In-flight sub-agent tracker. When a parent invokes a delegate_*
  // tool, the tool reserves a slot via ctx.subAgentSlotAvailable() and
  // releases it via ctx.subAgentSlotRelease(childId). The cap is
  // MAX_CONCURRENT_SUBAGENTS per parent. A 4th concurrent call is
  // refused with { ok: false, error: { code: 'too-many-concurrent-subagents' } }.
  // Children do NOT have a sub-agent tracker — they cannot delegate,
  // by design.
  const inFlightSubAgents = new Map();

  // Reserve the slot. We set state later, after the first transition.
  // `telemetryRunId` is filled in below for sub-agents (when the agent
  // row has a parent_agent_id) so `finishAgent` can close the row on
  // terminal transition. Top-level agents leave it null.
  // `inFlightSubAgents` is ALSO stored on the run entry so
  // `cancelAgent` can abort the whole descendant tree (GATE 1 P0).
  RUNS.set(agentId, { runId, controller, bus, state: STATES.IDLE, isSubAgent, role, telemetryRunId: null, inFlightSubAgents });

  // Phase 15 — persist the run-state row so a crash/restart can
  // classify this agent. We do this AFTER RUNS.set so the in-memory
  // state and the durable state are established in the same tick.
  // persistRunState is best-effort and never throws.
  persistRunState(core, profileId, agentId, {
    runId,
    role: role || null,
    isSubAgent: !!isSubAgent,
    parentRunId: null,
    phase: "preparing",
    state: "running",
    tokensIn: 0,
    tokensOut: 0,
    recovery: "requires-user",
  });

  // Sub-agent telemetry: open a subagent_runs row at dispatch so the
  // parent can see "this sub-agent was spawned, this is when it started"
  // in the activity panel. Top-level agents do NOT open a row — the
  // table is scoped to sub-agents only.
  if (isSubAgent && agent && typeof agent.parent_agent_id === "number") {
    try {
      const tid = await subagentTelemetry.start(core, {
        profileId,
        parentAgentId: agent.parent_agent_id,
        role: role || null,
        childAgentId: agentId,
        runId,
      });
      if (typeof tid === "number") {
        const r = RUNS.get(agentId);
        if (r) r.telemetryRunId = tid;
      }
    } catch (_e) {
      // best-effort: telemetry must never block the loop
    }

    // Sub-agent depth + count limits (PRIORITY 4). Check BEFORE starting
    // the loop. On breach, mark the child as cancelled and return early —
    // the delegate tool will see startRes.ok=false and surface the error.
    try {
      const projectId = agent.projectId;
      const project = normalizeProjectRow(await core.pmGetProject(profileId, projectId));
      const parentDepth = await subagentTelemetry.getDepth(core, { profileId, agentId: agent.parentAgentId || agent.parent_agent_id });
      const limRes = await subagentTelemetry.checkLimits(core, {
        profileId,
        parentAgentId: agent.parent_agent_id,
        currentDepth: parentDepth,
        configJson: project && project.config_json,
      });
      if (!limRes.ok) {
        const telemId = RUNS.get(agentId) && RUNS.get(agentId).telemetryRunId;
        await subagentTelemetry.cancelSubagentForLimit(core, {
          profileId,
          agentId,
          reason: limRes.reason,
          telemetryRunId: telemId,
        });
        RUNS.delete(agentId);
        return { ok: false, reason: `limit-${limRes.reason}` };
      }
    } catch (_e) {
      // best-effort: a limit-check failure must never block the loop
    }
  }

  // Run the loop in the background. The caller gets back the runId +
  // bus + controller immediately. Errors are emitted as AGENT_FAILED
  // events; the bus remains valid until the loop frees the slot.
  const loopStartedAt = Date.now();
  Audit.log({
    event: "agent.start",
    profileId,
    projectId: agent.projectId,
    agentId,
    tool: null,
    input_summary: isSubAgent ? `sub-agent role=${role || ""}`.trim() : "agent",
    result: null,
    durationMs: null,
    detail: null,
  });
  (async () => {
    try {
      bus.emit(AGENT_EVENTS.AGENT_STARTED, { runId, agentId });
      const projectId = agent.projectId;
      const project = normalizeProjectRow(await core.pmGetProject(profileId, projectId));

      // Register this agent's project root so the IPC layer (and the
      // tools it dispatches) can resolve the project root from the
      // (profileId, agentId) tuple. Cleared in the `finally` block.
      setActiveProjectRootFor(profileId, agentId, project.root_path);

      // Resolve the per-project token budget once at start. `config_json`
      // is a free-form JSON column on `pm_projects`; missing /
      // malformed values fall back to DEFAULT_TOKEN_BUDGET (200_000).
      // A configured value of 0 means "no limit".
      const tokenBudget = resolveTokenBudget(project && project.config_json);

      // Recursion guard: a sub-agent's tool set MUST NOT include the 4
      // delegate_* tools. This is the simplest way to prevent unbounded
      // nesting in this session — there is no path through which a child
      // can spawn a grandchild.
      let tools = listTools();
      if (isSubAgent) {
        tools = tools.filter((t) => !DELEGATE_TOOL_NAMES.includes(t.name));
      }
      const toolDefs = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));

      // Tool context. The 4 delegate_* tools require `core`, profileId,
      // agentId, projectId on the context so they can call pmCreateAgent
      // and pmListMessages against the persisted store. We also expose
      // the in-flight sub-agent slot helpers so the parent's loop can
      // enforce the 3-concurrent cap.
      const toolCtx = {
        core,
        profileId,
        agentId,
        projectId,
        projectRoot: project.root_path,
        isCancellable: () => controller.signal.aborted,
        cancelSignal: controller.signal,
        nowMs: () => Date.now(),
        isSubAgent,
        role,
        subAgentSlotAvailable: () => isSubAgent
          ? false // a sub-agent cannot delegate; refuse unconditionally
          : inFlightSubAgents.size < MAX_CONCURRENT_SUBAGENTS,
        subAgentSlotReserve: (childId, info) => {
          if (isSubAgent) return false;
          if (inFlightSubAgents.size >= MAX_CONCURRENT_SUBAGENTS) return false;
          inFlightSubAgents.set(childId, info || { runId, controller });
          return true;
        },
        subAgentSlotRelease: (childId) => {
          inFlightSubAgents.delete(childId);
        },
        subAgentInFlight: () => inFlightSubAgents.size,
        // Attach the child's live controller AFTER the child loop has
        // started (the delegate tool calls this once `startAgent`
        // resolves). This is what makes cancellation propagation
        // possible: the run registry can abort the child controller.
        subAgentSlotAttach: (childId, info) => {
          if (isSubAgent) return false;
          const cur = inFlightSubAgents.get(childId);
          if (!cur) return false;
          inFlightSubAgents.set(childId, { ...(cur || {}), ...(info || {}) });
          return true;
        },
        // Wake-up hook for long-polling tools (delegate_*): fires the
        // callback the moment this agent's run is cancelled so the tool
        // can react immediately instead of on its next poll tick.
        onCancelled: (cb) => {
          controller.signal.addEventListener("abort", cb, { once: true });
          return () => controller.signal.removeEventListener("abort", cb);
        },
      };
      // Child-start wiring. The delegate_* tools fall back to
      // ctx.startSubAgent when the core object has no startAgent method
      // (the REAL NAPI core never does). Production mounts it via the
      // project:start-agent IPC handler; tests mount core.startAgent.
      if (typeof startSubAgent === "function") {
        toolCtx.startSubAgent = startSubAgent;
      }

      // 1) PLANNING
      // Build the augmented first user message. We read the memory
      // packet + recent task history ONCE per agent run (not per step).
      // If `Memory.start()` was never called, the lookup returns an
      // empty packet / empty list, so the message falls back to the
      // bare objective and the loop runs unchanged.
      const projectCfg = parseProjectConfig(project && project.config_json);
      const maxTokens = Number.isFinite(projectCfg.context_packet_max_tokens) ? projectCfg.context_packet_max_tokens : 2000;
      const showRecentTasks = projectCfg.show_recent_tasks !== false; // default true
      let memoryPacket = "";
      let recentHistory = [];
      if (maxTokens > 0) {
        const pkt = await Memory.buildContextPacket(projectId, agent.objective, maxTokens);
        if (pkt && pkt.ok && pkt.result && typeof pkt.result.packet === "string") {
          memoryPacket = pkt.result.packet;
        }
      }
      if (showRecentTasks) {
        const list = await Memory.taskList(projectId, { limit: 5 });
        if (list && list.ok && Array.isArray(list.result)) {
          recentHistory = list.result;
        }
      }
      const memoryBlock = buildMemoryBlock({ objective: agent.objective, packet: memoryPacket, history: recentHistory });

      // Project Intelligence: append a small per-file header list for
      // the top-N ranked files relevant to the objective. Gated by
      // `project.config_json.context_packet_max_project_intel_tokens`
      // (default 1500; 0 disables). The block is appended AFTER the
      // memory block so the model's prior instructions stay at the top.
      const maxProjectIntelTokens = Number.isFinite(projectCfg.context_packet_max_project_intel_tokens)
        ? projectCfg.context_packet_max_project_intel_tokens
        : 1500;
      let projectIntelBlock = "";
      let projectIntelFileCount = 0;
      let projectIntelTokenCount = 0;
      if (maxProjectIntelTokens > 0 && project && project.root_path) {
        const pi = await buildProjectIntelBlock({
          projectId,
          objective: agent.objective,
          projectRoot: project.root_path,
          maxTokens: maxProjectIntelTokens,
        });
        if (pi && typeof pi.packet === "string" && pi.packet.length > 0) {
          projectIntelBlock = pi.packet;
          projectIntelFileCount = pi.fileCount | 0;
          projectIntelTokenCount = pi.tokenCount | 0;
        }
      }

      const firstUserContent = projectIntelBlock
        ? `${memoryBlock}

${projectIntelBlock}`
        : memoryBlock;
      const messages = [
        { role: "system", content: buildSystemPrompt(project, profileId, agent.projectId) },
        { role: "user", content: firstUserContent },
      ];
      await core.pmAppendMessage(profileId, agentId, "system", buildSystemPrompt(project, profileId, agent.projectId), null, null);
      await core.pmAppendMessage(profileId, agentId, "user", firstUserContent, null, null);
      // Emit a single recall event so the UI can show a banner with the
      // token estimate + history count. The UI listens for this event
      // on the AGENT_EVENTS bus and renders nothing when tokenCount
      // and historyCount are both 0.
      if (memoryPacket || recentHistory.length > 0) {
        bus.emit(AGENT_EVENTS.MEMORY_RECALLED, {
          projectId,
          tokenCount: tokenEstimate(memoryPacket),
          historyCount: recentHistory.length,
        });
      }
      // Observability for the project-intel block. Fires when at least
      // one file is represented in the block; the UI banner can read
      // fileCount + tokenCount to show a "Project files: N" hint.
      if (projectIntelFileCount > 0) {
        bus.emit(AGENT_EVENTS.PROJECT_INTEL_RECALLED, {
          projectId,
          fileCount: projectIntelFileCount,
          tokenCount: projectIntelTokenCount,
        });
      }

      // Parse the persisted plan. If it's empty (e.g. brand-new agent
      // or the column was just '[]'), build a 1-step starter plan and
      // persist it. The model will expand it on its first reply.
      let plan = parsePlan(agent.plan_json);
      if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
        plan = buildInitialPlan({ objective: agent.objective });
        await core.pmUpdateAgent(
          profileId,
          agentId,
          agent.state,
          planToJson(plan),
          0,
          0,
        );
      }
      // Resume safety: if the persisted state is already PLANNING (a
      // resume from a mid-run kill), do NOT re-issue the
      // planning -> planning transition (it is not in VALID_TRANSITIONS
      // and would throw). The loop continues from PLANNING as-is.
      if (agent.state !== STATES.PLANNING) {
        await transition(core, profileId, agentId, agent.state, STATES.PLANNING, planToJson(plan), 0, 0);
      }
      bus.emit(AGENT_EVENTS.AGENT_PLANNING, { agentId, objective: agent.objective });

      // 2) Loop: model -> tool calls -> tools -> model -> ...
      let state = STATES.PLANNING;
      let tokensIn = 0;
      let tokensOut = 0;
      let safetySteps = 0;
      let activeStep = null;
      // Step ids the engine has already attempted in the current
      // "outer iteration" of the planning loop. Used by the
      // dependency-aware picker to detect stalls: if `pickNextStep`
      // returns a step whose id is already in this set, the model
      // finished its round without unlocking new work and the loop
      // transitions to verifying/failed rather than re-running the
      // same step.
      let seenInThisModelStep = new Set();
      // Counter for the test/fix/retest loop. Bumped on every verify
      // failure. After MAX_FIX_ATTEMPTS (2) the loop terminates FAILED.
      let fixAttempts = 0;
      // Resolve the per-project step limit. `project.config_json.maxSteps`
      // overrides the default of 50; an admin-level `profile_config.max_steps`
      // (if the core exposes `pmGetProfile`) overrides the project value.
      // Invalid values (0, negative, non-numeric) fall back to 50.
      let profileCfg = null;
      if (core.pmGetProfile && typeof core.pmGetProfile === "function") {
        try {
          const profileRow = normalizeProfileRow(await core.pmGetProfile(profileId));
          profileCfg = profileRow && profileRow.profile_config
            ? parseProjectConfig(profileRow.profile_config)
            : null;
        } catch (_e) {
          // best-effort: profile config must never block the loop
        }
      }
      const maxSteps = resolveMaxSteps(project && project.config_json, profileCfg);

      while (true) {
        if (controller.signal.aborted) {
          await finishAgent(core, profileId, agentId, STATES.CANCELLED, plan, tokensIn, tokensOut, bus);
          return;
        }
        if (safetySteps++ >= maxSteps) {
          await finishAgent(core, profileId, agentId, STATES.FAILED, plan, tokensIn, tokensOut, bus, `max-steps-exceeded(limit=${maxSteps})`);
          return;
        }

        // If the plan is fully terminal, advance to the verification
        // gate. We do NOT mark `completed` here — that is the
        // verification gate's job (Phase 5/7). Until then the agent
        // sits in `verifying` and the renderer can show the plan as
        // a done DAG.
        if (isPlanComplete(plan)) {
          state = STATES.VERIFYING;
          await transition(
            core,
            profileId,
            agentId,
            STATES.PLANNING,
            STATES.VERIFYING,
            planToJson(plan),
            tokensIn,
            tokensOut,
          );
          bus.emit(AGENT_EVENTS.AGENT_VERIFYING, { agentId });
          const vr = await runVerificationGate({
            core, profileId, project, agentId, plan, tokensIn, tokensOut, bus,
            fixAttempts,
            onFixRetry: ({ plan: newPlan, fixAttempts: na }) => { plan = newPlan; fixAttempts = na; },
            prov, controller, messages,
          });
          if (vr.outcome === "retry") continue;
          return;
        }

        // Compute the steps that are eligible to run right now (no
        // unresolved deps + status pending) and pick a BATCH to
        // execute this iteration. Up to `projectCfg.max_parallel_steps`
        // (default 3) ready steps are marked `running` in a single
        // persist call. The loop drives the model on the FIRST step
        // (activeStep); after its tool calls execute, the next iteration
        // re-fetches the batch — the first step is now `running` so it
        // is filtered out, and the next ready step (if any) becomes the
        // new activeStep. `seenInThisModelStep` still detects stalls
        // when the batch is empty.
        const batchSize = Number.isFinite(projectCfg.max_parallel_steps) && projectCfg.max_parallel_steps > 0
          ? projectCfg.max_parallel_steps
          : 3;
        const batch = pickNextReadyBatch(plan, batchSize);
        activeStep = null;
        if (batch.length > 0) {
          // Track all picked step ids as seen in the current iteration.
          // If the model emits no tool calls and no new step was
          // unlocked, the next iteration's batch will be empty and we
          // fall through to the stall-handling block.
          for (const s of batch) seenInThisModelStep.add(s.id);
          // Mark every step in the batch as `running` so the renderer
          // shows the in-flight work, and persist once. The first step
          // in declaration order is the `activeStep` for backwards
          // compat with downstream code that reads it (the model
          // emits tool calls for the first step; the others stay
          // `running` until the next iteration drains them).
          activeStep = batch[0];
          for (const s of batch) {
            plan = markStep(plan, s.id, "running");
          }
          await core.pmUpdateAgent(
            profileId,
            agentId,
            STATES.PLANNING,
            planToJson(plan),
            tokensIn,
            tokensOut,
          );
        } else {
          // pickNextStep returned null. This happens when:
          //   - the plan has no currently-ready steps (a dep is
          //     `running` left over from a crash — common after a
          //     CareerFlow restart), OR
          //   - the model has already acted on every ready step this
          //     outer-loop iteration (the seen-set is non-empty).
          //
          // Either way, classify the stall and recover. The pre-existing
          // guard `seenInThisModelStep.size > 0` was too narrow: a
          // resume from a mid-run kill lands here with an empty
          // seen-set, so the recovery logic never fired and the loop
          // hit MAX_STEPS without making progress. Always classify.
          //
          const stall = classifyStall(plan);
          if (stall.terminal) {
            // Defensive: should have been caught by isPlanComplete.
            // Fall through to the model call which will reach the
            // verifying branch above.
            seenInThisModelStep = new Set();
          } else if (stall.reason === "stalled-with-running") {
            // A step is stuck `running`. Mark it failed so downstream
            // deps can unblock, then re-evaluate.
            const stuck = plan.steps.find((s) => s.status === "running");
            if (stuck) {
              plan = markStep(plan, stuck.id, "failed");
              await core.pmUpdateAgent(
                profileId,
                agentId,
                STATES.PLANNING,
                planToJson(plan),
                tokensIn,
                tokensOut,
              );
            }
            seenInThisModelStep = new Set();
          } else if (stall.reason === "stalled-with-failed") {
            // A step is failed and the model did not produce a fix
            // step. Bail to FAILED rather than spin. The fix-retry
            // flow lives at the verification gate, not here.
            await finishAgent(core, profileId, agentId, STATES.FAILED, plan, tokensIn, tokensOut, bus, "step-failed-no-replan:" + (stall.lastFailedId || ""));
            return;
          } else {
            // Generic stall. Reset and re-enter the model so the
            // model can choose the next step. The safetySteps counter
            // bounds the total iterations.
            seenInThisModelStep = new Set();
          }
        }

        // Plan step: when we have no plan yet, the model is expected to
        // emit a "plan" tool call before tool calls. (The system prompt
        // instructs the model to do so.) We do not assume a particular
        // tool name; we just feed the conversation to the provider and
        // process whatever it returns.
        const stream = prov.streamChat({ messages, tools: toolDefs, signal: controller.signal });

        let textAccum = "";
        const toolCalls = []; // { id, name, args }
        let finishReason = null;

        for await (const ev of stream) {
          if (controller.signal.aborted) break;
          if (ev.type === "text_delta") {
            textAccum += ev.delta;
            bus.emit(AGENT_EVENTS.AGENT_TEXT_DELTA, { delta: ev.delta });
          } else if (ev.type === "tool_call") {
            toolCalls.push(ev);
          } else if (ev.type === "usage") {
            tokensIn += ev.inputTokens;
            tokensOut += ev.outputTokens;
            // Hard budget interrupt: once cumulative tokens cross the
            // configured cap, the agent is FAILED with reason
            // `budget-exceeded`. This is a hard transition, not a
            // soft warning — the loop returns immediately.
            if (budgetExceeded(tokensIn, tokensOut, tokenBudget)) {
              const msg = buildBudgetStatusMessage(tokensIn, tokensOut, tokenBudget);
              await appendStatusMessage(core, profileId, agentId, msg.name, msg.payload);
              await finishAgent(core, profileId, agentId, STATES.FAILED, plan, tokensIn, tokensOut, bus, "budget-exceeded");
              return;
            }
            // Sub-agent token limit (PRIORITY 4): if a sub-agent's
            // cumulative tokens exceed the per-sub-agent cap, the
            // sub-agent is cancelled. This is separate from the project
            // budget (above) — it caps a single sub-agent's spend.
            if (isSubAgent) {
              const subagentLimits = subagentTelemetry.parseSubagentLimits(project && project.config_json);
              if (subagentTelemetry.shouldCancelForTokenLimit(tokensIn, tokensOut, subagentLimits.maxTokensPerSubagent)) {
                await finishAgent(core, profileId, agentId, STATES.CANCELLED, plan, tokensIn, tokensOut, bus, "limit-token-limit");
                return;
              }
            }
          } else if (ev.type === "finish") {
            finishReason = ev.reason;
          } else if (ev.type === "error") {
            await finishAgent(core, profileId, agentId, STATES.FAILED, plan, tokensIn, tokensOut, bus, ev.code + ": " + ev.message);
            return;
          }
        }

        if (textAccum) {
          await core.pmAppendMessage(profileId, agentId, "assistant", textAccum, null, null);
        }
        if (toolCalls.length === 0) {
          if (textAccum) messages.push({ role: "assistant", content: textAccum });
          // Model said "done". If we have an in-flight step, mark it
          // done. If the plan is now complete, advance to the
          // verification gate; otherwise loop back to planning so the
          // model can pick up the next ready step.
          if (activeStep) {
            plan = markStep(plan, activeStep.id, "done");
            await core.pmUpdateAgent(
              profileId,
              agentId,
              STATES.PLANNING,
              planToJson(plan),
              tokensIn,
              tokensOut,
            );
          }
          // The model finished a round. Reset the seen-set so the next
          // iteration can pick any newly-unlocked step.
          seenInThisModelStep = new Set();
          if (isPlanComplete(plan)) {
            state = STATES.VERIFYING;
            await transition(
              core,
              profileId,
              agentId,
              STATES.PLANNING,
              STATES.VERIFYING,
              planToJson(plan),
              tokensIn,
              tokensOut,
            );
            bus.emit(AGENT_EVENTS.AGENT_VERIFYING, { agentId });
            const vr2 = await runVerificationGate({
              core, profileId, project, agentId, plan, tokensIn, tokensOut, bus,
              fixAttempts,
              onFixRetry: ({ plan: newPlan, fixAttempts: na }) => { plan = newPlan; fixAttempts = na; },
              prov, controller, messages,
            });
            if (vr2.outcome === "retry") continue;
            return;
          }
          // No more work this round but the plan has more pending
          // steps. Loop back so the model can choose the next one.
          continue;
        }

        // EXECUTING_TOOL
        state = STATES.EXECUTING_TOOL;
        await transition(core, profileId, agentId, STATES.PLANNING, STATES.EXECUTING_TOOL, planToJson(plan), tokensIn, tokensOut);
        await core.pmAppendMessage(
          profileId,
          agentId,
          "tool_call",
          JSON.stringify(toolCalls),
          toolCalls.map((t) => t.name).join(","),
          JSON.stringify(toolCalls),
        );
        // Phase 13 (D5): the model context MUST carry the assistant's
        // tool_calls round BEFORE its tool results. OpenAI-compatible
        // providers that validate adjacency (b.ai) reject orphan
        // role:'tool' messages with HTTP 400 — "Messages with role
        // 'tool' must be a response to a preceding message with
        // 'tool_calls'". This retroactively explains the Phase 12
        // empty-body 400s: pure-tool-call rounds had no anchor.
        messages.push({
          role: "assistant",
          content: textAccum || null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {}),
            },
          })),
        });

        let anyToolFailed = false;
        for (const tc of toolCalls) {
          if (controller.signal.aborted) {
            await finishAgent(core, profileId, agentId, STATES.CANCELLED, plan, tokensIn, tokensOut, bus);
            return;
          }
          bus.emit(AGENT_EVENTS.AGENT_TOOL_STARTED, { tool: tc.name, callId: tc.id, input: tc.args });

          // For tools in APPROVAL_REQUIRED, the trusted resolver is asked.
          // If no resolver was wired, the default is denial: absence must
          // never imply user approval.
          const tool = tools.find((t) => t.name === tc.name);
          if (!tool) {
            const err = { ok: false, error: { code: "tool-not-found", message: `Tool not registered: ${tc.name}` } };
            await appendToolResult(core, profileId, agentId, tc.id, tc.name, err);
            bus.emit(AGENT_EVENTS.AGENT_TOOL_FAILED, { tool: tc.name, callId: tc.id, error: err.error });
            anyToolFailed = true;
            continue;
          }
          let input;
          try {
            input = JSON.parse(tc.args || "{}");
          } catch (e) {
            const err = { ok: false, error: { code: "invalid-tool-args", message: "Tool args are not valid JSON" } };
            await appendToolResult(core, profileId, agentId, tc.id, tc.name, err);
            bus.emit(AGENT_EVENTS.AGENT_TOOL_FAILED, { tool: tc.name, callId: tc.id, error: err.error });
            anyToolFailed = true;
            continue;
          }

          let approved = true;
          if (requiresToolApproval(tool.name, tool)) {
            state = STATES.WAITING_FOR_APPROVAL;
            await transition(core, profileId, agentId, STATES.EXECUTING_TOOL, STATES.WAITING_FOR_APPROVAL, planToJson(plan), tokensIn, tokensOut);
            const approvalId = `${agentId}:${tc.id}`;
            bus.emit(AGENT_EVENTS.AGENT_APPROVAL_REQUIRED, {
              approvalId,
              callId: tc.id,
              tool: tool.name,
              permission: tool.permission,
              input,
            });
            const decision = await (approvalResolver || defaultApprovalResolver)({
              approvalId,
              callId: tc.id,
              tool: tool.name,
              permission: tool.permission,
              input,
              signal: controller.signal,
            });
            approved = Boolean(decision && decision.approved);
            if (!approved) {
              const err = { ok: false, error: { code: "user-rejected", message: "User rejected this tool call" } };
              await appendToolResult(core, profileId, agentId, tc.id, tc.name, err);
              bus.emit(AGENT_EVENTS.AGENT_TOOL_COMPLETED, { tool: tool.name, callId: tc.id, result: null, rejected: true });
              state = STATES.EXECUTING_TOOL;
              await transition(core, profileId, agentId, STATES.WAITING_FOR_APPROVAL, STATES.EXECUTING_TOOL, planToJson(plan), tokensIn, tokensOut);
              anyToolFailed = true;
              continue;
            }
            state = STATES.EXECUTING_TOOL;
            await transition(core, profileId, agentId, STATES.WAITING_FOR_APPROVAL, STATES.EXECUTING_TOOL, planToJson(plan), tokensIn, tokensOut);
          }

          // Audit: the tool is about to run.
          //
          // The agent loop calls `tool.execute()` directly rather than going
          // through `runTool()` from ../project-tools/_runtime.js, because the
          // loop owns its own approval handshake (see the WAITING_FOR_APPROVAL
          // block above) and must not re-enter the IPC token gate. That also
          // meant it bypassed the ONLY place that records tool invocations, so
          // every tool the agent actually executed — including privileged,
          // approval-gated `fs_write` / `exec_run` — left no security-audit
          // record at all. The trail showed `agent.start` and `agent.end` and
          // nothing about what happened between them.
          //
          // These are the same events, with the same shape and the same
          // redaction, that `runTool()` writes. Nothing about authorization,
          // approval, or execution changes: this is the record, not the gate.
          // A throwing tool is recorded as `tool.failed` via `finally` and the
          // throw is then allowed to propagate exactly as it did before.
          const toolStartedAt = Date.now();
          Audit.log({
            event: "tool.invoked",
            profileId,
            projectId: agent.projectId,
            agentId,
            tool: tool.name,
            // A short label only. The full input is never persisted, and the
            // raw arguments are never projected to the renderer.
            input_summary: tool.name,
            result: null,
            durationMs: null,
            detail: null,
          });

          let result;
          try {
            result = await tool.execute(input, toolCtx);
          } finally {
            Audit.log({
              event: result && result.ok ? "tool.completed" : "tool.failed",
              profileId,
              projectId: agent.projectId,
              agentId,
              tool: tool.name,
              input_summary: tool.name,
              result: result && result.ok ? "ok" : "fail",
              durationMs: Date.now() - toolStartedAt,
              detail: result ? null : "threw",
            });
          }
          await appendToolResult(core, profileId, agentId, tc.id, tool.name, result);
          messages.push({ role: "tool", tool_call_id: tc.id, name: tool.name, content: JSON.stringify(result) });
          if (result && result.ok) {
            bus.emit(AGENT_EVENTS.AGENT_TOOL_COMPLETED, { tool: tool.name, callId: tc.id, elapsedMs: result.elapsedMs });
          } else {
            bus.emit(AGENT_EVENTS.AGENT_TOOL_FAILED, { tool: tc.name, callId: tc.id, error: result && result.error });
            anyToolFailed = true;
          }
        }

        // Resolve the active step: if every tool in this round
        // succeeded, mark the step done; otherwise mark it failed and
        // let the model decide whether to retry on the next round.
        if (activeStep) {
          plan = markStep(plan, activeStep.id, anyToolFailed ? "failed" : "done");
          await core.pmUpdateAgent(
            profileId,
            agentId,
            STATES.EXECUTING_TOOL,
            planToJson(plan),
            tokensIn,
            tokensOut,
          );
        }
        // Tools executed. Reset the seen-set so the next iteration's
        // pickNextStep can pick any step that just became ready.
        seenInThisModelStep = new Set();

        // If the plan is fully terminal now, advance to the
        // verification gate (NOT completed).
        if (isPlanComplete(plan)) {
          state = STATES.VERIFYING;
          await transition(
            core,
            profileId,
            agentId,
            STATES.EXECUTING_TOOL,
            STATES.VERIFYING,
            planToJson(plan),
            tokensIn,
            tokensOut,
          );
          bus.emit(AGENT_EVENTS.AGENT_VERIFYING, { agentId });
          const vr3 = await runVerificationGate({
            core, profileId, project, agentId, plan, tokensIn, tokensOut, bus,
            fixAttempts,
            onFixRetry: ({ plan: newPlan, fixAttempts: na }) => { plan = newPlan; fixAttempts = na; },
            prov, controller, messages, toolDefs,
          });
          if (vr3.outcome === "retry") continue;
          return;
        }

        // Loop back to OBSERVING -> replan via the model
        state = STATES.OBSERVING;
        await transition(core, profileId, agentId, STATES.EXECUTING_TOOL, STATES.OBSERVING, planToJson(plan), tokensIn, tokensOut);
        state = STATES.PLANNING;
        await transition(core, profileId, agentId, STATES.OBSERVING, STATES.PLANNING, planToJson(plan), tokensIn, tokensOut);
      }
    } catch (err) {
      bus.emit(AGENT_EVENTS.AGENT_FAILED, { error: { code: "loop-error", message: String(err && err.message || err) } });
      try {
        await core.pmFinishAgent(profileId, agentId, STATES.FAILED);
      } catch (_) {
        // best effort
      }
      // Phase 15 invariant (same as finishAgent): the durable
      // pm_run_state row must not outlive a terminal agent, or the
      // recovery sweep treats the agent as a zombie. This catch path
      // bypasses finishAgent (plan/tokens are out of scope here), so
      // drop the durable row explicitly. clearRunState is best-effort
      // and never throws.
      try {
        await clearRunState(core, profileId, agentId);
      } catch (_) {
        // best effort
      }
    } finally {
      RUNS.delete(agentId);
      // Drop the per-agent project root so a future run must set it
      // again. Pairs with the `setActiveProjectRootFor` call above.
      clearActiveProjectRootFor(profileId, agentId);
      Audit.log({
        event: "agent.end",
        profileId,
        projectId: agent.projectId,
        agentId,
        tool: null,
        input_summary: null,
        result: controller.signal.aborted ? "denied" : "ok",
        durationMs: Date.now() - loopStartedAt,
        detail: null,
      });
    }
  })();

  return { ok: true, runId, bus, controller };
}

/**
 * Resume a previously-paused (or CareerFlow-restarted) agent.
 *
 * Refuses early if:
 *   - the agent row is missing (`not-found`)
 *   - the agent is in a terminal state (`terminal-state`)
 *   - a loop is already active for this agent (`already-running`)
 *
 * Otherwise it delegates to `startAgent` with `isResume: true` and a
 * fresh runId. The loop reads the persisted plan_json and continues
 * from the last known step (see `parsePlan` in `plan.js`).
 *
 * @param {{ core: object, profileId: number, agentId: number, provider?: object, approvalResolver?: function }} args
 * @returns {Promise<{ ok: true, runId: string, bus: AgentEventBus, controller: AbortController }
 *                | { ok: false, reason: string, runId?: string }>}
 */
export async function resumeAgent({ core, profileId, agentId, provider, approvalResolver }) {
  if (!core || typeof core.pmGetAgent !== "function") {
    return { ok: false, reason: "invalid-core" };
  }
  const agent = normalizeAgentRow(await core.pmGetAgent(profileId, agentId));
  if (!agent || typeof agent !== "object") {
    return { ok: false, reason: "not-found" };
  }
  // Refuse duplicate resume: the registry check is the authoritative
  // guard against double-execution. startAgent also re-checks, but
  // checking here lets us return a clearer error code.
  if (RUNS.has(agentId)) {
    const existing = RUNS.get(agentId);
    return { ok: false, reason: "already-running", runId: existing.runId };
  }
  if (agent.state === STATES.COMPLETED || agent.state === STATES.FAILED || agent.state === STATES.CANCELLED) {
    return { ok: false, reason: "terminal-state" };
  }
  return startAgent({ core, profileId, agentId, provider, approvalResolver, isResume: true });
}

async function finishAgent(core, profileId, agentId, state, plan, tokensIn, tokensOut, bus, reason) {
  await core.pmFinishAgent(profileId, agentId, state);
  // Phase 15 — drop the durable run-state row. The agent has reached
  // a terminal state and the in-memory RUNS row will be deleted below;
  // the durable row must mirror that or the recovery sweep will treat
  // the agent as a zombie. clearRunState is best-effort.
  clearRunState(core, profileId, agentId);
  // Close the sub-agent telemetry row, if one was opened at dispatch.
  // Telemetry is observational; a missing / failed close is logged and
  // ignored — the parent's pm_agents row is the source of truth.
  const run = RUNS.get(agentId);
  if (run && typeof run.telemetryRunId === "number") {
    try {
      await subagentTelemetry.end(core, {
        profileId,
        id: run.telemetryRunId,
        outcome: state,
        tokensIn: tokensIn | 0,
        tokensOut: tokensOut | 0,
        error: state === STATES.COMPLETED ? "" : (reason || state),
      });
    } catch (_e) {
      // best-effort
    }
  }
  if (state === STATES.COMPLETED) bus.emit(AGENT_EVENTS.AGENT_COMPLETED, { tokensIn, tokensOut, reason: reason || "stop" });
  else if (state === STATES.FAILED) bus.emit(AGENT_EVENTS.AGENT_FAILED, { reason: reason || "failed" });
  else if (state === STATES.CANCELLED) bus.emit(AGENT_EVENTS.AGENT_CANCELLED, {});
  // Notify any waiting parent that this child reached a terminal state.
  // Parents using `onSubAgentTerminal` wake immediately instead of
  // waiting for their next 2000ms poll tick.
  if (state === STATES.COMPLETED || state === STATES.FAILED || state === STATES.CANCELLED) {
    emitChildTerminal(agentId, state, Date.now());
  }
}

/**
 * Verification-before-completion gate. Called when the plan is
 * complete and the loop would otherwise `return`. Runs the project's
 * configured test command (if any) and either:
 *   - transitions VERIFYING -> COMPLETED on pass / no-test-command, or
 *   - transitions VERIFYING -> FAILED on test-failed (after the fix
 *     retry budget is exhausted), appending a `status` message so the
 *     renderer can show why, OR
 *   - re-enters PLANNING (a new `fix-N-<step>` step is appended to the
 *     plan) so the coder can try again. The outer loop continues.
 *
 * Returns one of:
 *   { outcome: "completed" }    — verification passed; loop should exit
 *   { outcome: "failed", ... } — verification failed and the retry
 *                                budget is exhausted; loop should exit
 *   { outcome: "retry", ... }  — verification failed but a retry is
 *                                allowed; loop should `continue` with
 *                                the (mutated) plan
 *
 * Idempotent: a status message `verified` / `verify-failed` /
 * `fix-retrying` is appended so a resumption can see whether
 * verification already ran.
 */
async function runVerificationGate({ core, profileId, project, agentId, plan, tokensIn, tokensOut, bus, fixAttempts, onFixRetry, prov, controller, messages, toolDefs }) {
  // Cancellation race (GATE 1): a cancel observed before the gate even
  // starts must not kick off a pointless (possibly long) test run.
  if (controller && controller.signal && controller.signal.aborted) {
    await finishAgent(core, profileId, agentId, STATES.CANCELLED, plan, tokensIn, tokensOut, bus, "cancelled-during-verification");
    return { outcome: "cancelled" };
  }
  const v = await verifyCompletion({ core, profileId, project, agentId });
  // GATE 1 (cont.): the verify command can run for a long time; if the
  // cancel lands MID-VERIFICATION and verification PASSED, committing
  // COMPLETED here would contradict the user's cancel. The failure
  // path below deliberately keeps the v7 semantics (gate16 stage test):
  // a failed verification still records its fix-retrying status + fix
  // step; the loop's top guard then ends the run CANCELLED.
  if (v.ok && controller && controller.signal && controller.signal.aborted) {
    await finishAgent(core, profileId, agentId, STATES.CANCELLED, plan, tokensIn, tokensOut, bus, "cancelled-during-verification");
    return { outcome: "cancelled" };
  }
  if (v.ok) {
    // One final model round after verify-gate success. The agent's
    // last user-visible assistant message must reflect this round's
    // summary text (the loop otherwise exits without a final model
    // reply). The fixture (and any real provider) returns its
    // current round's text on this call. We drain `text_delta` events,
    // persist the text as a new assistant row, and only then call
    // `finishAgent` so the AGENT_COMPLETED event fires AFTER the
    // message has been recorded.
    let finalText = "";
    if (prov && typeof prov.streamChat === "function") {
      try {
        // Phase 12 live finding: this request carries tool-role messages
        // (the transcript above them), and OpenAI-compatible providers
        // like b.ai REJECT tool messages unless the `tools` declaration
        // is present (HTTP 400, empty body). The summary round must look
        // like a normal round: same tools, and the model is instructed
        // not to call any. Any tool_call events it emits are ignored.
        const finalStream = prov.streamChat({
          messages: Array.isArray(messages) ? messages : [],
          tools: Array.isArray(toolDefs) ? toolDefs : undefined,
          signal: controller && controller.signal ? controller.signal : undefined,
        });
        for await (const ev of finalStream) {
          if (ev && ev.type === "text_delta" && typeof ev.delta === "string") {
            finalText += ev.delta;
          } else if (ev && ev.type === "error") {
            break;
          }
        }
      } catch (_e) {
        // Provider error during the final summary is non-fatal; the
        // agent is still verified and we exit normally.
      }
    }
    if (finalText && typeof core.pmAppendMessage === "function") {
      await core.pmAppendMessage(profileId, agentId, "assistant", finalText, null, null);
      if (Array.isArray(messages)) {
        messages.push({ role: "assistant", content: finalText });
      }
    }
    await appendStatusMessage(core, profileId, agentId, "verified", {
      reason: v.reason,
      elapsedMs: v.elapsedMs,
      output: v.output || "",
    });
    await transition(core, profileId, agentId, STATES.VERIFYING, STATES.COMPLETED, planToJson(plan), tokensIn, tokensOut);
    bus.emit(AGENT_EVENTS.AGENT_VERIFYING, { agentId, verified: true });
    await finishAgent(core, profileId, agentId, STATES.COMPLETED, plan, tokensIn, tokensOut, bus, "verified");
    return { outcome: "completed" };
  }

  // Verification failed. Decide: retry or terminal FAILED.
  const nextAttempt = fixAttempts + 1;
  const canRetry = shouldRetryFix(nextAttempt);

  if (!canRetry) {
    await appendStatusMessage(core, profileId, agentId, "verify-failed", {
      reason: v.reason,
      elapsedMs: v.elapsedMs,
      exitCode: v.exitCode,
      output: v.output || "",
      error: v.error || "",
      fixAttempts: nextAttempt,
      exhausted: true,
    });
    await transition(core, profileId, agentId, STATES.VERIFYING, STATES.FAILED, planToJson(plan), tokensIn, tokensOut);
    bus.emit(AGENT_EVENTS.AGENT_VERIFYING, { agentId, verified: false, fixAttempts: nextAttempt, exhausted: true });
    await finishAgent(core, profileId, agentId, STATES.FAILED, plan, tokensIn, tokensOut, bus, "verify-exhausted:" + nextAttempt + ":" + v.reason);
    return { outcome: "failed", reason: v.reason, attempt: nextAttempt };
  }

  // Retry path: append a fix step, persist, transition back to PLANNING,
  // emit a status + event, and let the outer loop continue.
  const lastStep = Array.isArray(plan.steps) && plan.steps.length > 0
    ? plan.steps[plan.steps.length - 1]
    : { id: "step-1", title: "Plan the work", status: "done", depends_on: [], files: [], assigned_to: null };
  const fixStep = buildFixStep({ failingStep: lastStep, verification: v, attempt: nextAttempt });
  plan = {
    steps: [...plan.steps, fixStep],
    version: plan && typeof plan.version === "number" ? plan.version : 1,
  };

  await appendStatusMessage(core, profileId, agentId, "fix-retrying", {
    reason: v.reason,
    elapsedMs: v.elapsedMs,
    exitCode: v.exitCode,
    output: v.output || "",
    error: v.error || "",
    fixAttempts: nextAttempt,
    fixStepId: fixStep.id,
  });
  // The model must SEE the verification failure on the next round —
  // without this signal it replans blind (Phase 12 live finding: the
  // post-fix-retry round repeated the pre-fix behavior). Persisted so
  // the DB transcript matches the model's view and resume stays honest.
  const fixSignal = [
    `Verification failed (attempt ${nextAttempt}): ${v.reason}.`,
    v.output ? `Test output:\n${v.output}` : "",
    `Fix the issue (step ${fixStep.id}: ${fixStep.title}) and make the project's test command pass, then stop.`,
  ].filter(Boolean).join("\n");
  await core.pmAppendMessage(profileId, agentId, "user", fixSignal, null, null);
  if (Array.isArray(messages)) {
    messages.push({ role: "user", content: fixSignal });
  }
  await transition(core, profileId, agentId, STATES.VERIFYING, STATES.PLANNING, planToJson(plan), tokensIn, tokensOut);
  bus.emit(AGENT_EVENTS.AGENT_VERIFYING, { agentId, verified: false, fixAttempts: nextAttempt, fixStepId: fixStep.id });

  if (typeof onFixRetry === "function") {
    onFixRetry({ plan, fixAttempts: nextAttempt, fixStep, verification: v });
  }
  return { outcome: "retry", plan, fixAttempts: nextAttempt, fixStep, verification: v };
}

async function appendToolResult(core, profileId, agentId, callId, name, result) {
  await core.pmAppendMessage(
    profileId,
    agentId,
    "tool_result",
    JSON.stringify(result),
    name,
    JSON.stringify({ callId, name, result }),
  );
}

function buildSystemPrompt(project, profileId, projectId) {
  const lines = [
    "You are a Project Mode agent in CareerFlow.",
    `Project: ${project.name}`,
    project.description ? `Description: ${project.description}` : "",
    `Project root: ${project.root_path}`,
    "",
    "Plan before you act. Use the inspect_project tool first to learn the project shape, then make focused edits. After each tool call, observe the result and decide whether to continue, replan, or stop.",
    "Actions require tool calls: if you intend to inspect, modify, or test files, you MUST emit the tool calls in your CURRENT response. Replying with text that only describes what you are about to do does not perform the work and ends the round.",
    "Tool-call protocol: use the function-calling mechanism of this API (the tools parameter). Never write tool calls as text, JSON, or pseudo-XML in your reply — text-form tool calls cannot be executed.",
    "When the requested objective is complete, respond with a short final summary and DO NOT call any more tools.",
    "If a tool errors, do not retry the same call blindly — read the error and adjust.",
  ];
  // Inject enabled skills into the system prompt (GATE 11: skills affect execution).
  if (typeof profileId === "number" && typeof projectId === "number") {
    const skillsBlock = Skills.buildSystemPrompt(profileId, projectId);
    if (skillsBlock) lines.push("", skillsBlock);
  }
  return lines.filter(Boolean).join("\n");
}

/**
 * Assemble the augmented first user message. The original objective is
 * preserved verbatim so the model's instructions are unchanged; memory
 * + history sections are appended below it. When both sources are
 * empty we return the bare objective so the loop behaves identically to
 * the no-memory era.
 */
function buildMemoryBlock({ objective, packet, history }) {
  const hasPacket = typeof packet === "string" && packet.length > 0;
  const hasHistory = Array.isArray(history) && history.length > 0;
  if (!hasPacket && !hasHistory) return objective;
  const sections = [objective];
  if (hasPacket) {
    sections.push("", "## Project memory", packet);
  }
  if (hasHistory) {
    sections.push("", "## Recent task history", formatHistory(history));
  }
  return sections.join("\n");
}

function formatHistory(history) {
  const lines = [];
  for (const h of history) {
    const status = h && h.success ? "ok" : "failed";
    const summary = h && typeof h.summary === "string" ? h.summary : "";
    lines.push(`- [${status}] ${summary}`);
  }
  return lines.join("\n");
}

/**
 * Cheap whitespace-split token approximation. Mirrors the ranker's
 * heuristic so the token count shown in the UI is consistent with the
 * cap used to build the packet.
 */
function tokenEstimate(text) {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

async function defaultApprovalResolver(_request) {
  return { approved: false, reason: "approval-resolver-unavailable" };
}

/**
 * Resolve the production-default provider for this (profileId, projectId).
 *
 *   1. If a stored credential exists, build a real OpenAI-compatible
 *      provider bound to that credential + bus. The credential is read
 *      per-call (see createOpenAiProvider), so the resolved `fetchImpl`
 *      pulls the latest key from disk.
 *   2. Otherwise fall back to the network-free mock so the loop can
 *      still execute (offline / first-run). The mock is the offline
 *      fallback, NOT the production default.
 *
 * Tests pass an explicit `provider` to `startAgent` and skip this path.
 */
function resolveDefaultProvider({ profileId, projectId, bus }) {
  try {
    const userDataDir = resolveUserDataDir();
    if (!userDataDir) return createMockProvider();
    const store = createCredentialsStore({ userDataDir });
    const cfg = store.readProviderConfig(profileId, projectId);
    if (!cfg || !cfg.apiKey) return createMockProvider();
    return createOpenAiProvider({
      endpoint: cfg.endpoint,
      apiKey: cfg.apiKey,
      model: cfg.model,
      bus,
    });
  } catch (_e) {
    // best-effort: never block the loop on a credential lookup failure
    return createMockProvider();
  }
}

/**
 * Locate the userData directory the same way the rest of the shell
 * does (memory + project-intel services). Falls back to process.cwd()
 * outside Electron so unit tests work without a fake app object.
 */
function resolveUserDataDir() {
  try {
    // Lazy-require so this module stays importable from non-Electron
    // tests without pulling `electron` into the resolution path.
    const electron = require("electron");
    const a = electron && electron.app;
    if (a && typeof a.getPath === "function") return a.getPath("userData");
  } catch (_e) {
    // not running under Electron (unit tests)
  }
  return process.cwd();
}

// ----------------------------------------------------------------------------
// Public helpers for the IPC layer
// ----------------------------------------------------------------------------

/**
 * Cancel a running agent. Cooperative — the active provider stream is
 * aborted and the tool loop is interrupted at the next tool boundary.
 *
 * GATE 1 (P0): cancellation propagates to the whole descendant tree.
 * Every in-flight sub-agent registered on a run in the subtree (via
 * `subAgentSlotAttach` in the delegate tools) has its controller
 * aborted too, transitively — so a 3-generation hierarchy
 * (PARENT → CHILD → GRANDCHILD) is fully cancelled by one call, even
 * if an intermediate level is not inside a cooperative poll.
 *
 * Idempotent: calling cancelAgent again after the run cleared returns
 * `{ ok: false, reason: 'not-running' }`; aborting an already-aborted
 * controller is a no-op.
 */
export function cancelAllAgents() {
  const agentIds = [...RUNS.keys()];
  for (const agentId of agentIds) cancelAgent(agentId);
  return { ok: true, cancelled: agentIds.length };
}

export function cancelAgent(agentId) {
  const root = RUNS.get(agentId);
  if (!root) return { ok: false, reason: "not-running" };
  const cancelledChildren = [];
  const seen = new Set([agentId]);
  const stack = [agentId];
  while (stack.length > 0) {
    const id = stack.pop();
    const run = RUNS.get(id);
    if (!run) continue;
    run.controller.abort();
    if (id !== agentId) cancelledChildren.push(id);
    const kids = run.inFlightSubAgents;
    if (kids && typeof kids.keys === "function") {
      for (const childId of kids.keys()) {
        if (!seen.has(childId)) {
          seen.add(childId);
          stack.push(childId);
        }
      }
    }
  }
  return { ok: true, cancelledChildren };
}

/**
 * Test-only: register an in-flight child controller on a run's
 * in-flight map, mirroring what the delegate tool's
 * `ctx.subAgentSlotAttach` does in production. Lets tests build
 * multi-generation hierarchies that the recursion guard otherwise
 * prevents, and proves cancelAgent's transitive propagation.
 */
export function _attachInFlightForTest(parentAgentId, childAgentId, info) {
  const run = RUNS.get(parentAgentId);
  if (!run || !run.inFlightSubAgents) return false;
  run.inFlightSubAgents.set(childAgentId, info || {});
  return true;
}
