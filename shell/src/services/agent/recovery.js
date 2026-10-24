// Phase 15 — Crash/Restart recovery layer.
//
// The Phase 14 agent loop kept the live run registry (`RUNS`) in
// memory only. That means an Electron crash/restart lost every running
// agent's controller / bus / signal even though `pm_agents.state`
// was still persisted in SQLite. The goal engine could reconcile
// terminal-vs-non-terminal goals, but it could not safely resume a
// non-terminal agent without re-running every tool call (which is
// dangerous — file writes and shell commands would repeat).
//
// Phase 15 adds a small `pm_run_state` table (migration 022) and a
// durable-write step in the agent loop. On startup the recovery
// sweep reads the durable registry and:
//
//   1. For each non-terminal pm_run_state row, classifies the row:
//      - safe-resume:  phase is verifiable AND the agent's last
//                       persisted state matches the row's phase.
//                       The agent can be re-attached to a fresh
//                       loop without re-running tool calls.
//      - requires-user: anything else. The sweep surfaces the row
//                        to the renderer as "needs your attention".
//                        We never auto-resume.
//      - stale:        the row's last_event_at is older than the
//                      stale threshold. The sweep refuses to touch
//                      the agent until the user takes action.
//
//   2. For each non-terminal pm_goals row whose linked agent is
//      terminal, mirrors the terminal state to the goal (the same
//      path Phase 14 used; this layer just calls the existing
//      reconcileGoalsForProfile entry point).
//
// The agent loop also deletes the pm_run_state row on terminal
// completion so the sweep sees a clean slate.
//
// The recovery layer NEVER auto-resumes a requires-user or stale
// row. The renderer offers an explicit "Resume" button per row;
// the user must click it to actually re-attach the loop.

import { reconcileGoalsForProfile } from "../goals/engine.js";

const STALE_AFTER_MINUTES = 30;

const PHASE_TO_AGENT_STATE = {
  preparing: "idle",
  planning: "planning",
  executing: "executing_tool",
  verifying: "verifying",
  awaiting_approval: "waiting_for_approval",
  idle: "idle",
};

/**
 * Persist the agent loop's current run-state to disk. Called by
 * the loop on every transition. We deliberately debounce to avoid
 * hot writes; the loop only calls this on transition boundaries
 * (`transition()` in loop.js), not on every streamed chunk.
 */
export async function persistRunState(core, profileId, agentId, info) {
  if (!core || typeof core.pmUpsertRunState !== "function") return;
  try {
    await core.pmUpsertRunState(
      profileId,
      agentId,
      info.runId,
      info.role || null,
      info.isSubAgent == null ? null : String(info.isSubAgent),
      info.parentRunId || null,
      info.phase || "unknown",
      info.state || "running",
      Number(info.tokensIn) || 0,
      Number(info.tokensOut) || 0,
      info.recovery || "requires-user"
    );
  } catch (e) {
    // Never let a persistence failure kill the loop. Log and move on.
    try {
      const { Audit } = await import("../audit/index.js");
      Audit.log({
        event: "run_state.persist.error",
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
}

/**
 * Drop a run-state row. Called by the loop on terminal completion.
 */
export async function clearRunState(core, profileId, agentId) {
  if (!core || typeof core.pmDeleteRunState !== "function") return;
  try {
    await core.pmDeleteRunState(profileId, agentId);
  } catch (_e) {
    // ignore — sweep can also clean up.
  }
}

/**
 * The Phase 15 startup sweep. Called from `agent-loop-recovery-init`
 * once per active profile. It:
 *   - reads non-terminal rows from pm_run_state
 *   - classifies each (safe-resume / requires-user / stale)
 *   - reconciles goals whose linked agent is terminal
 *   - returns a summary the renderer can render as "needs your
 *     attention" rows.
 *
 * NEVER auto-resumes a row.
 */
export async function runRecoverySweep({ core, profileId }) {
  if (!core || typeof core.pmListResumableRuns !== "function") {
    return { ok: false, reason: "core-not-wired", resumable: [], stale: [] };
  }
  const resumable = [];
  let stale = [];
  try {
    const rows = await core.pmListResumableRuns(profileId, STALE_AFTER_MINUTES);
    for (const row of rows || []) {
      // NAPI returns camelCase but tests + older code paths sometimes
      // use snake_case. Normalize once.
      const agentId = row.agentId ?? row.agent_id;
      // Cross-check the agent's persisted state vs the row's phase.
      let classification = "requires-user";
      let reason = "phase-mismatch";
      try {
        const agent = await core.pmGetAgent(profileId, agentId);
        if (agent && agent.ok !== false) {
          const expected = PHASE_TO_AGENT_STATE[row.phase] || row.phase;
          if (agent.state === expected) {
            // phase matches — the agent's persisted state is consistent
            // with what the loop last wrote. The controller is gone
            // (in-memory), but the loop can re-attach via isResume=true.
            classification = "safe-resume";
            reason = "ok";
          } else if (
            agent.state === "completed" ||
            agent.state === "failed" ||
            agent.state === "cancelled"
          ) {
            // Agent reached terminal — the row should have been deleted
            // by the loop, but the loop crashed first. Clean it up.
            classification = "terminal-cleanup";
            reason = `agent-${agent.state}`;
          }
        }
      } catch (_e) {
        // Keep requires-user — the safest default.
      }
      resumable.push({
        ...row,
        classification,
        reason,
      });
    }
    stale = await core.pmListStaleRuns(profileId, STALE_AFTER_MINUTES);
  } catch (e) {
    return { ok: false, reason: "sweep-threw", message: String(e && e.message || e), resumable, stale };
  }
  // Reconcile goals whose linked agent already reached a terminal state.
  // This piggybacks on the Phase 14 engine function (already proven).
  let goalReconciled = 0;
  try {
    const r = await reconcileGoalsForProfile({ core, profileId });
    goalReconciled = (r && r.reconciled) || 0;
  } catch (_e) {}
  return {
    ok: true,
    resumable,
    stale,
    goalReconciled,
    staleAfterMinutes: STALE_AFTER_MINUTES,
  };
}

/**
 * Test-only: reset module-level state. Production never calls this.
 */
export function _resetForTests() {
  /* no module state */
}