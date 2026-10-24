// Test/fix/retest loop helpers.
//
// When the verification gate fails, the agent loop re-enters the
// planning state with the test failure as additional context, the model
// re-plans, the coder (or another sub-agent) tries again, and the
// verifier runs again. **Max 2 fix iterations.** After 2 failed
// iterations, the parent terminates as FAILED with reason
// `verify-exhausted:<n>`.
//
// This module is pure functions only. No IO. No loop dependency.

export const MAX_FIX_ATTEMPTS = 2;

/**
 * Should the loop attempt another fix iteration?
 *
 * - `attempts = 0` (just failed for the first time)  -> true
 * - `attempts = 1` (one previous failure already)    -> true
 * - `attempts = 2` (two previous failures, exhausted)-> false
 *
 * `attempts` is the number of fix attempts that have already been
 * started (i.e. the count of previously appended fix steps). The
 * canonical call site in the loop is `shouldRetryFix(fixAttempts + 1)`
 * where `fixAttempts` is the running counter inside the loop closure.
 */
export function shouldRetryFix(attempts) {
  let n = 0;
  if (typeof attempts === "number" && Number.isFinite(attempts)) {
    n = Math.trunc(attempts);
  } else if (typeof attempts === "string" && attempts.trim().length > 0) {
    const parsed = Number(attempts);
    if (Number.isFinite(parsed)) n = Math.trunc(parsed);
  }
  return n < MAX_FIX_ATTEMPTS;
}

/**
 * Build a new "fix" step that will be appended to the plan when the
 * verification gate fails. The new step has:
 *   - id: `fix-${attempt}-${failingStep.id}`
 *   - title: `Fix failing tests: ${failingStep.title}`
 *   - status: 'pending'
 *   - depends_on: []   (so it is immediately eligible to run)
 *   - files: inherited from the failing step
 *   - assigned_to: 'coder'
 *   - objective: a short, self-contained description that includes the
 *     verification failure (reason + tail of the output) so the coder
 *     sees the failure context in its context packet.
 *   - assigned_agent_id: null  (will be set when the delegation tool
 *     spawns a child for this step)
 *
 * Pure function. The failing step is not mutated; the verification
 * object is not mutated.
 */
export function buildFixStep({ failingStep, verification, attempt }) {
  if (!failingStep || typeof failingStep !== "object") {
    throw new TypeError("buildFixStep: failingStep is required");
  }
  const attemptNum = typeof attempt === "number" && Number.isFinite(attempt) ? Math.trunc(attempt) : 1;
  const failingId = typeof failingStep.id === "string" && failingStep.id.length > 0
    ? failingStep.id
    : "step";
  const failingTitle = typeof failingStep.title === "string" && failingStep.title.length > 0
    ? failingStep.title
    : failingId;
  const files = Array.isArray(failingStep.files) ? failingStep.files.slice() : [];
  const reason = (verification && typeof verification.reason === "string")
    ? verification.reason
    : "unknown";
  const output = (verification && typeof verification.output === "string" && verification.output.length > 0)
    ? verification.output
    : (verification && typeof verification.error === "string" ? verification.error : "");
  const exitCode = (verification && typeof verification.exitCode === "number")
    ? verification.exitCode
    : null;
  const id = `fix-${attemptNum}-${failingId}`;
  const title = `Fix failing tests: ${failingTitle}`;
  const objective = [
    `The following test run failed (attempt ${attemptNum} of ${MAX_FIX_ATTEMPTS}):`,
    `reason: ${reason}` + (exitCode !== null ? ` (exit=${exitCode})` : ""),
    output ? `output:\n${output}` : "",
    "Investigate the failure, make a focused fix in the files above, and re-run the tests so the verification gate can pass.",
  ].filter(Boolean).join("\n");
  return {
    id,
    title,
    status: "pending",
    depends_on: [],
    files,
    assigned_to: "coder",
    assigned_agent_id: null,
    objective,
  };
}
