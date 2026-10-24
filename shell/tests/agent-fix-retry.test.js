// Test/fix/retest loop helpers.
//
// These tests pin the pure helpers in shell/src/services/agent/fix-retry.js.
// They do NOT exercise the live agent loop — that is the job of
// agent-loop.test.js. The loop wires `buildFixStep` + `shouldRetryFix`
// together; the units here are the individual building blocks.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_FIX_ATTEMPTS,
  shouldRetryFix,
  buildFixStep,
} from "../src/services/agent/fix-retry.js";

const failingStepFixture = () => ({
  id: "step-1",
  title: "Implement the login flow",
  status: "done",
  depends_on: [],
  files: ["src/auth/login.js", "src/auth/login.test.js"],
  assigned_to: "coder",
});

const verificationFailureFixture = () => ({
  ok: false,
  reason: "test-failed",
  elapsedMs: 4321,
  exitCode: 1,
  output: "AssertionError: expected 'ok' to equal 'fine'\n  at login.test.js:42",
  error: "",
});

// ----------------------------------------------------------------------------
// shouldRetryFix
// ----------------------------------------------------------------------------

test("shouldRetryFix: 0 attempts -> true (first failure, retry allowed)", () => {
  assert.equal(shouldRetryFix(0), true);
});

test("shouldRetryFix: 1 attempt -> true (one prior failure, one slot left)", () => {
  assert.equal(shouldRetryFix(1), true);
});

test("shouldRetryFix: 2 attempts -> false (exhausted, no more retries)", () => {
  assert.equal(shouldRetryFix(2), false);
});

test("shouldRetryFix: defensive against non-numeric input", () => {
  // Non-numeric / non-finite input is coerced to 0 ("no attempts yet")
  // so the caller defaults to "retry allowed" rather than accidentally
  // exhausting the cap. Numeric strings are parsed (e.g. "3" -> 3 -> false).
  assert.equal(shouldRetryFix(undefined), true);
  assert.equal(shouldRetryFix(null), true);
  assert.equal(shouldRetryFix("3"), false);
});

test("MAX_FIX_ATTEMPTS: pins the cap to 2 (matches spec)", () => {
  // If you intentionally bump this, every loop site that depends on
  // 2 (the AGENT_FAILED reason, the planner, the docs) must move too.
  assert.equal(MAX_FIX_ATTEMPTS, 2);
});

// ----------------------------------------------------------------------------
// buildFixStep
// ----------------------------------------------------------------------------

test("buildFixStep: returns a step with status='pending' and assigned_to='coder'", () => {
  const step = buildFixStep({
    failingStep: failingStepFixture(),
    verification: verificationFailureFixture(),
    attempt: 1,
  });
  assert.equal(step.status, "pending");
  assert.equal(step.assigned_to, "coder");
});

test("buildFixStep: id is `fix-${attempt}-${failingStep.id}`", () => {
  const step = buildFixStep({
    failingStep: failingStepFixture(),
    verification: verificationFailureFixture(),
    attempt: 1,
  });
  assert.equal(step.id, "fix-1-step-1");

  const step2 = buildFixStep({
    failingStep: failingStepFixture(),
    verification: verificationFailureFixture(),
    attempt: 2,
  });
  assert.equal(step2.id, "fix-2-step-1");
});

test("buildFixStep: objective mentions the verification failure (reason + output)", () => {
  const v = verificationFailureFixture();
  const step = buildFixStep({
    failingStep: failingStepFixture(),
    verification: v,
    attempt: 1,
  });
  assert.ok(typeof step.objective === "string" && step.objective.length > 0);
  assert.match(step.objective, /test-failed/);
  assert.match(step.objective, new RegExp(v.output.split("\n")[0].slice(0, 20)));
  assert.match(step.objective, /attempt 1 of 2/);
});

test("buildFixStep: files are inherited from the failing step", () => {
  const failing = failingStepFixture();
  const step = buildFixStep({
    failingStep: failing,
    verification: verificationFailureFixture(),
    attempt: 1,
  });
  assert.deepEqual(step.files, failing.files);
});

test("buildFixStep: title is `Fix failing tests: ${failingStep.title}`", () => {
  const step = buildFixStep({
    failingStep: failingStepFixture(),
    verification: verificationFailureFixture(),
    attempt: 1,
  });
  assert.equal(step.title, "Fix failing tests: Implement the login flow");
});

test("buildFixStep: depends_on is [] so the fix step is immediately eligible", () => {
  const step = buildFixStep({
    failingStep: failingStepFixture(),
    verification: verificationFailureFixture(),
    attempt: 1,
  });
  assert.deepEqual(step.depends_on, []);
});

test("buildFixStep: assigned_agent_id is null (set by the delegation tool later)", () => {
  const step = buildFixStep({
    failingStep: failingStepFixture(),
    verification: verificationFailureFixture(),
    attempt: 1,
  });
  assert.equal(step.assigned_agent_id, null);
});

test("buildFixStep: tolerates a verification with no output (falls back to error)", () => {
  const step = buildFixStep({
    failingStep: failingStepFixture(),
    verification: { ok: false, reason: "test-errored", error: "spawn failed" },
    attempt: 1,
  });
  assert.match(step.objective, /test-errored/);
  assert.match(step.objective, /spawn failed/);
});

test("buildFixStep: does not mutate the failing step or the verification object", () => {
  const failing = failingStepFixture();
  const v = verificationFailureFixture();
  const failingSnapshot = JSON.stringify(failing);
  const vSnapshot = JSON.stringify(v);
  buildFixStep({ failingStep: failing, verification: v, attempt: 1 });
  assert.equal(JSON.stringify(failing), failingSnapshot, "failingStep must not be mutated");
  assert.equal(JSON.stringify(v), vSnapshot, "verification must not be mutated");
});
