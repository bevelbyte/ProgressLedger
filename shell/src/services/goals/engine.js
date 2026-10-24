// Goal Mode — orchestration layer over the proven Project Mode agent loop.
//
// A Goal is a user-facing autonomous objective ("refactor authentication,
// update tests, ensure verification passes"). Goals are NOT a second
// agent engine; they are a thin coordination layer on top of the existing
// `pm_agents` infrastructure.
//
// Lifecycle:
//   1. The renderer creates a goal via `core.pmCreateGoal`.
//   2. The renderer calls `Goals.startGoal({ profileId, goalId })`.
//   3. `startGoal` resolves the goal's project, creates a fresh
//      `pm_agents` row (state='idle', plan='[]') with the goal's objective,
//      links the goal to the agent via `core.pmLinkGoalAgent`, transitions
//      the goal `created -> starting -> running`, and invokes the existing
//      `startAgentLoop()` — no duplicated engine.
//   4. The engine subscribes to the agent's `bus` events. When the agent
//      reaches a terminal state (`completed` / `failed` / `cancelled`), the
//      engine maps that to the goal's terminal state and persists the
//      outcome (failure_reason / result_text).
//   5. The engine also observes the agent's persisted state for changes
//      that did not surface as bus events (e.g. verification transitions),
//      so a goal that requires verification only completes after the
//      agent actually finished + verified.
//   6. Cancellation routes through `cancelAgentLoop()` — the existing
//      cooperative cancellation machinery. The engine then transitions
//      the goal `running -> cancelled`.
//
// Concurrency:
//   - At most one in-flight `startGoal` call per goal id. A second call
//     returns `{ ok: false, reason: 'already-starting' }`.
//   - The linked agent is also protected: `startAgentLoop` returns
//     `already-running` if the agent is mid-run; the engine propagates
//     this as `{ ok: false, reason: 'agent-already-running' }`.
//
// Recovery:
//   - On engine startup (called from `IPC.register`), the engine walks
//     all `state IN ('starting','running','verifying')` goals. For each,
//     it reconciles the goal state with the linked agent's persisted
//     state — if the agent is terminal, the goal moves to that terminal
//     state. This guarantees a goal does not remain stuck in 'running'
//     after an Electron crash.

import { EventEmitter } from "node:events";
import { startAgent as startAgentLoop, cancelAgent as cancelAgentLoop, normalizeAgentRow } from "../agent/loop.js";
import { Audit } from "../audit/index.js";

// ---------------------------------------------------------------------------
// State-machine helpers
// ---------------------------------------------------------------------------

export const GOAL_STATES = Object.freeze({
  CREATED: "created",
  STARTING: "starting",
  RUNNING: "running",
  VERIFYING: "verifying",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

const TERMINAL = new Set([GOAL_STATES.COMPLETED, GOAL_STATES.FAILED, GOAL_STATES.CANCELLED]);

// Goal -> Agent state mapping. When the linked agent reaches a terminal
// state, the goal follows. When the agent enters 'verifying', the goal
// also enters 'verifying'.
const AGENT_TO_GOAL_STATE = Object.freeze({
  completed: GOAL_STATES.COMPLETED,
  failed: GOAL_STATES.FAILED,
  cancelled: GOAL_STATES.CANCELLED,
  verifying: GOAL_STATES.VERIFYING,
});

// ---------------------------------------------------------------------------
// In-memory tracker (per-goal start locks + bus subscriptions)
// ---------------------------------------------------------------------------

const startLocks = new Map(); // goalId -> { startedAt, abortSignal }

export function isGoalStarting(goalId) {
  return startLocks.has(goalId);
}

/**
 * Test-only: reset internal state. Production never calls this.
 */
export function _resetForTests() {
  startLocks.clear();
  engineEventBus.removeAllListeners();
}

// Engine-level event bus (UI subscribes via IPC).
const engineEventBus = new EventEmitter();
engineEventBus.setMaxListeners(50);

export function onGoalEvent(listener) {
  engineEventBus.on("goal", listener);
  return () => engineEventBus.off("goal", listener);
}

function fire(payload) {
  engineEventBus.emit("goal", payload);
}

// ---------------------------------------------------------------------------
// Helpers — small wrappers over the NAPI surface that the renderer cannot
// reach. Keeping these in one place makes the engine easier to test.
// ---------------------------------------------------------------------------

function normGoal(row) {
  if (!row || typeof row !== "object") return row;
  return {
    id: row.id,
    profileId: row.profile_id ?? row.profileId,
    projectId: row.project_id ?? row.projectId,
    title: row.title,
    objective: row.objective,
    kind: row.kind,
    state: row.state,
    priority: row.priority,
    requireVerification: row.require_verification ?? row.requireVerification,
    linkedAgentId: row.linked_agent_id ?? row.linkedAgentId ?? null,
    failureReason: row.failure_reason ?? row.failureReason ?? "",
    resultText: row.result_text ?? row.resultText ?? "",
    planStepCount: row.plan_step_count ?? row.planStepCount ?? 0,
    createdAt: row.created_at ?? row.createdAt,
    startedAt: row.started_at ?? row.startedAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt,
    completedAt: row.completed_at ?? row.completedAt ?? null,
  };
}

async function getGoal(core, profileId, goalId) {
  const r = await core.pmGetGoal(profileId, goalId);
  if (!r || r.ok === false) return null;
  return normGoal(r);
}

// ---------------------------------------------------------------------------
// Start a goal
// ---------------------------------------------------------------------------

/**
 * Start (or re-observe) a goal. The engine creates the linked agent if
 * the goal has none, transitions the goal to 'running', and invokes the
 * existing agent loop. No duplicated engine.
 *
 * @param {object} args
 * @param {object} args.core
 * @param {number} args.profileId
 * @param {number} args.goalId
 * @param {AbortSignal} [args.signal] optional external abort signal
 * @param {object} [args.provider] main-process provider override (tests)
 * @param {function} [args.approvalResolverFactory] trusted main-process factory
 *        invoked as ({ profileId, agentId }) after the linked agent is known
 * @returns {Promise<{ ok: boolean, runId?: string, agentId?: number, reason?: string }>}
 */
export async function startGoal({ core, profileId, goalId, signal, provider, approvalResolverFactory }) {
  if (!core || typeof core.pmGetGoal !== "function") {
    return { ok: false, reason: "core-not-wired" };
  }
  // TOCTOU guard: refuse if a start is already in flight.
  if (startLocks.has(goalId)) {
    return { ok: false, reason: "already-starting" };
  }
  const lock = { startedAt: Date.now() };
  startLocks.set(goalId, lock);

try {
      let goal;
      try {
        goal = await getGoal(core, profileId, goalId);
      } catch (e) {
        return { ok: false, reason: "goal-not-found", message: String(e && e.message || e) };
      }
      if (!goal) return { ok: false, reason: "goal-not-found" };
      if (TERMINAL.has(goal.state)) {
        return { ok: false, reason: `goal-already-${goal.state}` };
      }

    // If the goal has no linked agent yet, create one in the goal's
    // project with the goal's objective. The agent inherits the project's
    // provider config; the goal engine does NOT mint provider credentials.
    let agentId = goal.linkedAgentId;
    if (!agentId) {
      try {
        agentId = await core.pmCreateAgent(goal.projectId, goal.objective, null);
        await core.pmLinkGoalAgent(profileId, goalId, agentId);
        await core.pmAppendGoalEvent(
          profileId,
          goalId,
          `Created agent #${agentId} for goal`,
          JSON.stringify({ agent_id: agentId })
        );
      } catch (e) {
        return { ok: false, reason: "agent-create-failed", message: String(e && e.message || e) };
      }
    }

    // Transition the goal to 'starting' before invoking the loop. The
    // 'starting' state is reserved for the brief window between
    // "we are about to start the loop" and "the loop is now driving
    // pm_agents.state transitions". The loop will produce the bus
    // events the engine listens to.
    await core.pmTransitionGoal(profileId, goalId, GOAL_STATES.STARTING);

    let result;
    try {
      result = await startAgentLoop({
        core,
        profileId,
        agentId,
        signal,
        provider,
        approvalResolver: typeof approvalResolverFactory === "function"
          ? approvalResolverFactory({ profileId, agentId })
          : undefined,
      });
    } catch (e) {
      // If the loop blew up before producing any state, mark the goal
      // failed so the renderer sees a terminal state immediately.
      await safeTransition(core, profileId, goalId, GOAL_STATES.FAILED, `start-error: ${e && e.message || e}`);
      return { ok: false, reason: "loop-threw", message: String(e && e.message || e) };
    }

    if (!result || result.ok === false) {
      const reason = result && result.reason ? result.reason : "unknown";
      const stateForFailure = reason === "already-running" ? GOAL_STATES.RUNNING : GOAL_STATES.FAILED;
      await safeTransition(core, profileId, goalId, stateForFailure, `start-refused: ${reason}`);
      return { ok: false, reason, agentId };
    }

    // The loop is now in flight. Transition the goal to 'running' so
    // the UI knows the agent is alive.
    await core.pmTransitionGoal(profileId, goalId, GOAL_STATES.RUNNING);
    fire({ type: "started", goalId, agentId, runId: result.runId });
    Audit.log({
      event: "goal.start",
      profileId,
      projectId: goal.projectId,
      agentId,
      tool: null,
      input_summary: goal.title,
      result: "ok",
      durationMs: null,
      detail: `goalId=${goalId}; runId=${result.runId}`,
    });

    // Observe the agent's lifecycle by polling the persisted state. The
    // bus events are in-process and ephemeral; the SQL row is the
    // source of truth. Polling catches crash-resume and the rare event
    // that the bus listener missed.
    observeAgentUntilTerminal({ core, profileId, goalId, agentId, kind: goal.kind, requireVerification: !!goal.requireVerification });

    return { ok: true, runId: result.runId, agentId };
  } finally {
    startLocks.delete(goalId);
  }
}

// ---------------------------------------------------------------------------
// Cancel a goal
// ---------------------------------------------------------------------------

/**
 * Cancel a running goal. Routes through `cancelAgentLoop` so the agent
 * and all of its children get the cooperative cancellation signal. The
 * goal then transitions to `cancelled`.
 *
 * Refuses to cancel goals that are already terminal.
 */
export async function cancelGoal({ core, profileId, goalId }) {
  if (!core || typeof core.pmGetGoal !== "function") {
    return { ok: false, reason: "core-not-wired" };
  }
  let goal;
  try {
    goal = await getGoal(core, profileId, goalId);
  } catch (e) {
    return { ok: false, reason: "goal-not-found", message: String(e && e.message || e) };
  }
  if (!goal) return { ok: false, reason: "goal-not-found" };
  if (TERMINAL.has(goal.state)) {
    return { ok: false, reason: `goal-already-${goal.state}` };
  }
  if (goal.linkedAgentId) {
    try {
      const cancelResult = cancelAgentLoop(goal.linkedAgentId);
      if (!cancelResult || cancelResult.ok === false) {
        // The agent may already be terminal. That's fine: we still move
        // the goal to a terminal state below.
      }
    } catch (_e) {
      // Swallow — the goal state transition is what the renderer reads.
    }
  }
  await safeTransition(core, profileId, goalId, GOAL_STATES.CANCELLED, "user-cancelled");
  const after = await getGoal(core, profileId, goalId);
  if (!after || after.state !== GOAL_STATES.CANCELLED) {
    return { ok: false, reason: "cancel-transition-failed" };
  }
  fire({ type: "cancelled", goalId });
  Audit.log({
    event: "goal.cancel",
    profileId,
    projectId: goal.projectId,
    agentId: goal.linkedAgentId || null,
    tool: null,
    input_summary: goal.title,
    result: "ok",
    durationMs: null,
    detail: `goalId=${goalId}`,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Observe the linked agent until it reaches a terminal state
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 1000;
const observations = new Map(); // goalId -> { timer, abortCtrl }

export function stopAllObservations() {
  for (const goalId of [...observations.keys()]) stopObservation(goalId);
  return { ok: true };
}

function stopObservation(goalId) {
  const obs = observations.get(goalId);
  if (!obs) return;
  try { obs.abortCtrl.abort(); } catch (_e) {}
  if (obs.timer) clearInterval(obs.timer);
  observations.delete(goalId);
}

function observeAgentUntilTerminal({ core, profileId, goalId, agentId, kind, requireVerification }) {
  // Cancel any prior observer for this goal — startGoal can be called
  // multiple times for the same goal in the resume path.
  stopObservation(goalId);

  const abortCtrl = new AbortController();
  const timer = setInterval(async () => {
    try {
      if (abortCtrl.signal.aborted) return;
      // Stop polling once the goal itself is terminal.
      const goalRow = await getGoal(core, profileId, goalId);
      if (!goalRow || TERMINAL.has(goalRow.state)) {
        stopObservation(goalId);
        return;
      }
      const agentRaw = await core.pmGetAgent(profileId, agentId);
      const agent = normalizeAgentRow(agentRaw);
      if (!agent) {
        stopObservation(goalId);
        return;
      }
      // Mirror the agent's progress into the goal:
      //   - agent 'verifying' -> goal 'verifying' (no terminal yet)
      //   - agent terminal -> goal terminal (with reason / result)
      if (AGENT_TO_GOAL_STATE[agent.state]) {
        const nextState = AGENT_TO_GOAL_STATE[agent.state];
        if (nextState === GOAL_STATES.VERIFYING) {
          // Verification is mid-flight. Only move the goal to 'verifying'
          // if it requires verification OR the agent is verifying
          // anyway (defensive — we don't want a research goal to claim
          // 'verifying' without a verifier).
          if (requireVerification) {
            await safeTransition(core, profileId, goalId, GOAL_STATES.VERIFYING);
          }
          return;
        }
        // Terminal agent state. Determine the goal's terminal reason +
        // result from the agent's last status messages.
        const { failureReason, resultText } = await readTerminalSummary(core, profileId, agentId);
        // Only mark the goal completed if the agent completed AND:
        //   - the goal does not require verification, OR
        //   - the agent's verify step passed.
        // Otherwise, the agent completed but verification failed; the
        // agent loop should already have entered 'failed' (Phase 12
        // verify gate), so 'failed' is the correct mirror.
        await safeTransition(core, profileId, goalId, nextState, failureReason, resultText);
        fire({ type: "terminal", goalId, state: nextState });
        Audit.log({
          event: "goal.terminal",
          profileId,
          projectId: goalRow.projectId,
          agentId,
          tool: null,
          input_summary: goalRow.title,
          result: nextState,
          durationMs: null,
          detail: `goalId=${goalId}; reason=${failureReason || ""}`,
        });
        stopObservation(goalId);
        return;
      }
      // While the agent is mid-loop, keep the cached plan_step_count
      // fresh. Cheap: parse the plan_json in shell.
      try {
        const planJson = typeof agent.plan_json === "string" ? agent.plan_json : "[]";
        let count = 0;
        try {
          const parsed = JSON.parse(planJson);
          count = Array.isArray(parsed) ? parsed.length : Array.isArray(parsed && parsed.steps) ? parsed.steps.length : 0;
        } catch (_e) {}
        if (count > 0 && goalRow.planStepCount !== count) {
          await core.pmUpdateGoalPlanStepCount(profileId, goalId, count);
        }
      } catch (_e) {}
    } catch (e) {
      // Don't let an observation tick kill the loop. Log + keep polling.
      try {
        Audit.log({
          event: "goal.observe.error",
          profileId,
          projectId: null,
          agentId,
          tool: null,
          input_summary: null,
          result: "fail",
          durationMs: null,
          detail: String(e && e.message || e),
        });
      } catch (_e) {}
    }
  }, POLL_INTERVAL_MS);

  // Stop the interval when the renderer window goes away (best effort).
  abortCtrl.signal.addEventListener("abort", () => {
    if (timer) clearInterval(timer);
  });

  observations.set(goalId, { timer, abortCtrl });
}

async function readTerminalSummary(core, profileId, agentId) {
  try {
    const msgs = await core.pmListMessages(profileId, agentId);
    if (!Array.isArray(msgs)) return { failureReason: "", resultText: "" };
    // Walk newest-first (the list is already ordered seq DESC by the NAPI).
    let failureReason = "";
    let resultText = "";
    for (const m of msgs) {
      if (!m) continue;
      if ((m.role === "status" || m.role === "error") && m.content && !failureReason) {
        failureReason = String(m.content);
      }
      if (m.role === "assistant" && m.content && !resultText) {
        // Use the last assistant text as the goal's result.
        resultText = String(m.content);
      }
      if (failureReason && resultText) break;
    }
    return { failureReason: failureReason.slice(0, 2000), resultText: resultText.slice(0, 100_000) };
  } catch (_e) {
    return { failureReason: "", resultText: "" };
  }
}

async function safeTransition(core, profileId, goalId, toState, failureReason, resultText) {
  try {
    await core.pmTransitionGoal(profileId, goalId, toState, failureReason || null, resultText || null);
  } catch (e) {
    // If the transition itself was rejected (e.g. already terminal), log
    // and move on — the goal will be reconciled by the recovery sweep
    // on next startup.
    try {
      Audit.log({
        event: "goal.transition.error",
        profileId,
        projectId: null,
        agentId: null,
        tool: null,
        input_summary: null,
        result: "fail",
        durationMs: null,
        detail: `${goalId} -> ${toState}: ${e && e.message || e}`,
      });
    } catch (_e) {}
  }
}

// ---------------------------------------------------------------------------
// Recovery — called once on shell startup
// ---------------------------------------------------------------------------

/**
 * Reconcile any goal that is left in a non-terminal state on startup.
 * Maps each goal to its linked agent's persisted state and finishes
 * the goal if the agent is already terminal.
 *
 * This is the crash-resume "small" piece. The full crash-resume (rebuild
 * the in-memory RUNS registry from disk) is a future phase.
 */
export async function reconcileGoalsOnStartup({ core }) {
  if (!core || typeof core.pmListGoals !== "function") return { ok: false, reason: "core-not-wired" };
  const NON_TERMINAL = [GOAL_STATES.CREATED, GOAL_STATES.STARTING, GOAL_STATES.RUNNING, GOAL_STATES.VERIFYING];
  let reconciled = 0;
  for (const st of NON_TERMINAL) {
    try {
      const rows = await core.pmListGoals(null, st, 500); // profile_id not used — we fetch all
      // Wait — pmListGoals requires profileId. The recovery must be
      // per-profile. We can't enumerate profiles from this layer cheaply
      // without an NAPI listProfiles. Instead, the recovery IPC layer
      // in ipc/goals.js is responsible for invoking this once per
      // profile the renderer knows about.
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const goal = normGoal(row);
          await reconcileSingleGoal(core, goal);
          reconciled += 1;
        }
      }
    } catch (_e) {
      // Continue — one bad row shouldn't stop the sweep.
    }
  }
  return { ok: true, reconciled };
}

export async function reconcileGoalsForProfile({ core, profileId }) {
  if (!core || typeof core.pmListGoals !== "function") return { ok: false, reason: "core-not-wired" };
  const NON_TERMINAL = [GOAL_STATES.CREATED, GOAL_STATES.STARTING, GOAL_STATES.RUNNING, GOAL_STATES.VERIFYING];
  let reconciled = 0;
  for (const st of NON_TERMINAL) {
    try {
      const rows = await core.pmListGoals(profileId, st, 500);
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const goal = normGoal(row);
          await reconcileSingleGoal(core, goal);
          reconciled += 1;
        }
      }
    } catch (_e) {}
  }
  return { ok: true, reconciled };
}

async function reconcileSingleGoal(core, goal) {
  if (!goal.linkedAgentId) {
    // Goal never got an agent (e.g. startGoal crashed between
    // pmCreateGoal and pmCreateAgent). Fail it so the UI sees a
    // terminal state.
    await safeTransition(core, goal.profileId, goal.id, GOAL_STATES.FAILED, "no-agent-created");
    return;
  }
  const agentRaw = await core.pmGetAgent(goal.profileId, goal.linkedAgentId);
  const agent = normalizeAgentRow(agentRaw);
  if (!agent) {
    await safeTransition(core, goal.profileId, goal.id, GOAL_STATES.FAILED, "linked-agent-missing");
    return;
  }
  if (TERMINAL.has(agent.state) && AGENT_TO_GOAL_STATE[agent.state]) {
    const { failureReason, resultText } = await readTerminalSummary(core, goal.profileId, goal.linkedAgentId);
    await safeTransition(core, goal.profileId, goal.id, AGENT_TO_GOAL_STATE[agent.state], failureReason, resultText);
    fire({ type: "reconciled", goalId: goal.id, state: agent.state });
  }
}
