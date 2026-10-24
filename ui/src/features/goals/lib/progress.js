// Goals progress — derived from real persisted state.
//
// Phase 14 returned {done: 0, running: 0, pending: 0, total: 0, percent: 0}
// as a placeholder. Phase 15 derives truthful progress from the linked
// pm_agents row + its plan_json (parsed).
//
// Source of truth:
//   - goal.state (orchestration-level state from pm_goals)
//   - linked agent.state (pm_agents.state — the execution state)
//   - linked agent.plan_json (parsed; step statuses live here)
//
// The renderer is read-only. It NEVER invents progress — every field is
// computed from the IPC snapshot of the agent row + its plan.
//
// Returns: {
//     phase: 'preparing' | 'planning' | 'executing' | 'verifying'
//            | 'recovering' | 'completed' | 'failed' | 'cancelled'
//             | 'idle',
//     total, done, running, pending, failed,
//     percent,           // 0..100, derived only when phase is fully observable
//     percentReliable,  // true only when we have a parsed plan
//   }

// Pure helper — does NOT import the runes store so this module is
// testable in isolation (the runes store pulls in Svelte, which the
// vitest harness chokes on).
function isTerminalState(s) {
  return s === "completed" || s === "failed" || s === "cancelled";
}

const PHASE_ORDER = ["idle", "preparing", "planning", "executing", "verifying", "completed"];

export function deriveGoalPhase(goal, agent) {
  if (!goal) return "idle";
  const gState = goal.state;
  if (gState === "created") return "preparing";
  if (gState === "starting") return "preparing";
  if (gState === "running") {
    if (agent && agent.state === "verifying") return "verifying";
    return "executing";
  }
  if (gState === "verifying") return "verifying";
  if (isTerminalState(gState)) return gState; // 'completed' | 'failed' | 'cancelled'
  return "idle";
}

/**
 * Parse a plan_json string into the canonical { steps, version } shape
 * used by the agent loop. The renderer mirrors the agent loop's parser
 * so step statuses are observable here too.
 */
export function parseGoalPlan(planJson) {
  if (typeof planJson !== "string" || !planJson) {
    return { steps: [], version: 1 };
  }
  try {
    const parsed = JSON.parse(planJson);
    if (Array.isArray(parsed)) {
      return { steps: parsed, version: 1 };
    }
    if (parsed && Array.isArray(parsed.steps)) {
      return { steps: parsed.steps, version: parsed.version || 1 };
    }
  } catch (_e) {
    // fall through
  }
  return { steps: [], version: 1 };
}

export function summarizeGoalPlan(planJson) {
  const { steps } = parseGoalPlan(planJson);
  const summary = { total: steps.length, done: 0, running: 0, pending: 0, failed: 0, skipped: 0 };
  for (const step of steps) {
    const s = step && step.status;
    if (s === "done") summary.done += 1;
    else if (s === "running") summary.running += 1;
    else if (s === "failed") summary.failed += 1;
    else if (s === "skipped") summary.skipped += 1;
    else summary.pending += 1;
  }
  return summary;
}

/**
 * The single truthful progress function. Caller passes the goal row
 * (with linkedAgentId set when applicable) plus the agent row (or
 * null when not loaded yet). Returns a stable shape that the UI can
 * render without any further work.
 */
export function goalProgress(goal, agent) {
  const phase = deriveGoalPhase(goal, agent);
  let summary = { total: 0, done: 0, running: 0, pending: 0, failed: 0, skipped: 0 };
  let percentReliable = false;
  let percent = 0;

  if (agent && agent.planJson != null) {
    summary = summarizeGoalPlan(agent.planJson);
    // Plan-derived percent. We weight 'done' and 'skipped' as terminal
    // progress; 'failed' is a defect, not progress.
    const terminalCount = summary.done + summary.skipped;
    const denominator = summary.total - summary.skipped;
    if (denominator > 0) {
      percent = Math.round((terminalCount / denominator) * 100);
      percentReliable = true;
    }
  }

  // Override for terminal phases — the UI should always show 100%/0%
  // unambiguously on completion/failure, regardless of plan summary.
  if (phase === "completed") {
    percent = 100;
    percentReliable = true;
  } else if (phase === "failed" || phase === "cancelled") {
    // Don't fake 100% on failure — leave whatever the plan says, but
    // mark the phase so the UI shows the failure state.
  }

  return {
    phase,
    total: summary.total,
    done: summary.done,
    running: summary.running,
    pending: summary.pending,
    failed: summary.failed,
    skipped: summary.skipped,
    percent,
    percentReliable,
  };
}

export function phaseLabel(phase) {
  switch (phase) {
    case "preparing": return "Preparing";
    case "planning": return "Planning";
    case "executing": return "Executing";
    case "verifying": return "Verifying";
    case "recovering": return "Recovering";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
    case "idle": return "Idle";
    default: return String(phase);
  }
}

export const PHASES = Object.freeze(PHASE_ORDER);