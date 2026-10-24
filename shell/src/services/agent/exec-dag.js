// Project Mode — execution DAG helpers.
//
// The agent loop drives the plan one step at a time, but `nextReadySteps`
// can return MULTIPLE eligible steps (e.g. a fan-out A -> {B, C}). The
// engine must drain them in dependency order. This module owns the
// pure-function picker so it is unit-testable independently of the
// model / IO.
//
// Design notes
// ------------
//  - Dependency-aware, NOT parallel. The model still drives planning;
//    the engine only enforces that every currently-ready step gets a
//    turn before re-asking the model. Concurrency is bounded by the
//    provider and the per-parent sub-agent cap
//    (`MAX_CONCURRENT_SUBAGENTS` in `_roles.js`), not by this helper.
//  - Stall detection. If the same ready step is at the head of the
//    ready list twice in a row, the model has finished without
//    unlocking new work. `pickNextStep` returns `null` in that case
//    so the loop can transition to verifying / failed / completed
//    rather than spinning.
//  - Pure. No IO. No dependency on the loop, the provider, or the
//    NAPI surface.

import { nextReadySteps } from "./plan.js";

/**
 * Pick the next step to execute, given the current plan and the set of
 * step ids the model has already acted on during this iteration of the
 * outer planning loop.
 *
 * Returns the next step (a NEW object reference if the plan is mutated
 * elsewhere; otherwise a reference into the supplied plan) or `null`
 * when:
 *
 *   - the plan has no currently-ready steps (empty ready list), OR
 *   - the first ready step is one the model has already seen this
 *     iteration (stall detection — the model "gave up" without
 *     unlocking new work; the caller treats this as terminal for
 *     the iteration).
 *
 * The returned step is the FIRST element of `nextReadySteps(plan)`,
 * which preserves declaration order in the persisted plan. That is
 * the canonical "dependency order" — steps with no unmet deps first,
 * and within a fan-out, the order the model emitted them.
 *
 * @param {object} plan  the persisted plan object
 * @param {Set<string>} seenInThisModelStep  ids the model has acted on
 *   during the current outer-loop iteration. Used for stall detection.
 * @returns {object|null} the next step to execute, or null
 */
export function pickNextStep(plan, seenInThisModelStep) {
  const ready = nextReadySteps(plan);
  if (ready.length === 0) return null;
  const first = ready[0];
  const seen = seenInThisModelStep instanceof Set
    ? seenInThisModelStep
    : new Set(Array.isArray(seenInThisModelStep) ? seenInThisModelStep : []);
  if (seen.has(first.id)) return null; // stall
  return first;
}

/**
 * Convenience wrapper: re-fetch the next ready step after the caller has
 * marked the supplied step as `done` / `failed` / `skipped` in the plan.
 *
 * Equivalent to:
 *
 *   plan = markStep(plan, justFinishedId, newStatus);
 *   return pickNextStep(plan, seenInThisModelStep);
 *
 * Implemented as a thin helper so call sites read clearly and so the
 * "did we unlock a new step?" check is colocated.
 *
 * @param {object} plan  the current plan (already updated by caller)
 * @param {Set<string>} seenInThisModelStep  step ids seen this iteration
 * @returns {object|null} the next step to execute, or null
 */
export function nextAfterMark(plan, seenInThisModelStep) {
  return pickNextStep(plan, seenInThisModelStep);
}

/**
 * Classify the outcome of an iteration that did not produce a new step.
 *
 * The outer loop calls this when `pickNextStep` returns `null`. The
 * classifier tells the caller whether the plan is fully terminal
 * (`done`) or whether a non-done step remains (`stalled` — caller
 *     typically transitions to FAILED if the most recent step failed,
 *     or to VERIFYING if the plan is now complete).
 *
 * @param {object} plan  the current plan
 * @returns {{ terminal: boolean, reason: "complete"|"stalled"|"stalled-with-failed"|"stalled-with-running"|"stalled-with-pending", lastFailedId?: string }}
 */
export function classifyStall(plan) {
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  const terminalSet = new Set(["done", "failed", "skipped"]);
  let hasNonTerminal = false;
  let lastFailed = null;
  for (const s of steps) {
    if (!terminalSet.has(s.status)) {
      hasNonTerminal = true;
      if (s.status === "running") {
        return { terminal: false, reason: "stalled-with-running" };
      }
    }
    if (s.status === "failed") lastFailed = s.id;
  }
  if (!hasNonTerminal) return { terminal: true, reason: "complete" };
  if (lastFailed) return { terminal: false, reason: "stalled-with-failed", lastFailedId: lastFailed };
  return { terminal: false, reason: "stalled" };
}
/**
 * Pick a batch of up to `maxBatchSize` ready steps whose execution can
 * proceed in parallel (no deps between them). This is the "true
 * parallel DAG execution" — when a fan-out has multiple ready leaves
 * (e.g. inspect_project + fs_write + test_run, all independent), the
 * loop sends the model ONE prompt with all of them and the model can
 * call them all in one iteration.
 *
 * Independence rule: two steps A, B can run in the same batch if and
 * only if neither depends on the other AND the model is expected to
 * emit tool calls for both. Steps that require text-only reasoning
 * (e.g. "produce a final report") do not get batched with file-mutating
 * steps.
 *
 * The model will see the batch as multiple tool-call entries in the
 * next response. The loop executes them sequentially within the
 * current iteration (the model can't actually run two tool calls in
 * parallel; this just gives the model a chance to produce more output
 * per iteration).
 *
 * @param {object} plan
 * @param {number} maxBatchSize  default 3
 * @returns {object[]}  an array of up to maxBatchSize steps
 */
export function pickNextReadyBatch(plan, maxBatchSize = 3) {
  if (!plan || maxBatchSize <= 0) return [];
  const ready = nextReadySteps(plan);
  if (ready.length === 0) return [];
  return ready.slice(0, maxBatchSize);
}
