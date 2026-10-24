// Multi-step execution engine — dependency-aware picker + stall
// detection.
//
// These tests pin the behavior of `pickNextStep` and `classifyStall`
// in `shell/src/services/agent/exec-dag.js`. They are pure-function
// tests: no IO, no model, no plan-mutation side effects. The agent
// loop uses these helpers to drain ready steps in dependency order
// and to detect when the model has "given up" without unlocking new
// work.
//
// The engine contract is:
//   - Pick the FIRST ready step (status=pending + all deps terminal).
//   - Within an outer iteration, the same step must NOT be picked
//     twice — that is a stall and the loop terminates the iteration.
//   - Downstream steps DO NOT auto-execute when an upstream step
//     FAILS — the model gets a chance to replan. (This is a design
//     choice: dependency unblock on `done | failed | skipped` allows
//     propagation, but the engine here only surfaces the FIRST ready
//     step; the fix-retry flow is responsible for inserting fix steps.)
//   - The picker is pure: it never mutates the plan or the seen-set.

import test from "node:test";
import assert from "node:assert/strict";

import {
  parsePlan,
  buildInitialPlan,
  nextReadySteps,
  markStep,
  isPlanComplete,
} from "../src/services/agent/plan.js";
import { pickNextStep, nextAfterMark, classifyStall } from "../src/services/agent/exec-dag.js";

// Small helpers to keep the test bodies readable.

function plan(steps, version = 1) {
  return { steps, version };
}

function step(id, opts = {}) {
  return {
    id,
    title: opts.title || id,
    status: opts.status || "pending",
    depends_on: Array.isArray(opts.depends_on) ? opts.depends_on : [],
    files: Array.isArray(opts.files) ? opts.files : [],
    assigned_to: opts.assigned_to == null ? null : opts.assigned_to,
  };
}

// ----------------------------------------------------------------------------
// Linear DAG: A -> B -> C executes A, then B, then C
// ----------------------------------------------------------------------------

test("multi-step: linear 3-step DAG executes in order (A, B, C)", () => {
  let p = plan([
    step("A"),
    step("B", { depends_on: ["A"] }),
    step("C", { depends_on: ["B"] }),
  ]);
  const seen = new Set();
  // Iteration 1: A is ready.
  let next = pickNextStep(p, seen);
  assert.ok(next, "expected a step on iteration 1");
  assert.equal(next.id, "A");
  seen.add(next.id);
  p = markStep(p, "A", "done");

  // Iteration 2: A is seen but B is new at the head.
  next = pickNextStep(p, seen);
  assert.equal(next.id, "B");
  seen.add(next.id);
  p = markStep(p, "B", "done");

  // Iteration 3: C is now ready.
  next = pickNextStep(p, seen);
  assert.equal(next.id, "C");
  seen.add(next.id);
  p = markStep(p, "C", "done");

  // Iteration 4: nothing left -> plan complete.
  next = pickNextStep(p, seen);
  assert.equal(next, null);
  assert.equal(isPlanComplete(p), true);
});

// ----------------------------------------------------------------------------
// Diamond DAG: A -> {B, C} -> D executes B, then C, then D
// ----------------------------------------------------------------------------

test("multi-step: diamond A -> {B, C} -> D executes B, then C, then D", () => {
  let p = plan([
    step("A"),
    step("B", { depends_on: ["A"] }),
    step("C", { depends_on: ["A"] }),
    step("D", { depends_on: ["B", "C"] }),
  ]);
  const seen = new Set();

  let next = pickNextStep(p, seen);
  assert.equal(next.id, "A");
  seen.add(next.id);
  p = markStep(p, "A", "done");

  // After A: B and C are both ready. The picker returns the FIRST
  // one in plan order — that is B.
  next = pickNextStep(p, seen);
  assert.equal(next.id, "B");
  seen.add(next.id);
  p = markStep(p, "B", "done");

  // After B: C is still ready and D is still blocked on C.
  next = pickNextStep(p, seen);
  assert.equal(next.id, "C");
  seen.add(next.id);
  p = markStep(p, "C", "done");

  // After C: D is now ready.
  next = pickNextStep(p, seen);
  assert.equal(next.id, "D");
  seen.add(next.id);
  p = markStep(p, "D", "done");

  assert.equal(isPlanComplete(p), true);
});

// ----------------------------------------------------------------------------
// Fan-out DAG: A -> {B, C, D} executes B first, then C, then D
// ----------------------------------------------------------------------------

test("multi-step: fan-out A -> {B, C, D} executes B, then C, then D in plan order", () => {
  let p = plan([
    step("A"),
    step("B", { depends_on: ["A"] }),
    step("C", { depends_on: ["A"] }),
    step("D", { depends_on: ["A"] }),
  ]);
  const seen = new Set();

  let next = pickNextStep(p, seen);
  assert.equal(next.id, "A");
  seen.add(next.id);
  p = markStep(p, "A", "done");

  // After A: B, C, D all ready. First-in-plan-order is B.
  next = pickNextStep(p, seen);
  assert.equal(next.id, "B");
  seen.add(next.id);
  p = markStep(p, "B", "done");

  next = pickNextStep(p, seen);
  assert.equal(next.id, "C");
  seen.add(next.id);
  p = markStep(p, "C", "done");

  next = pickNextStep(p, seen);
  assert.equal(next.id, "D");
  seen.add(next.id);
  p = markStep(p, "D", "done");

  assert.equal(isPlanComplete(p), true);
});

// ----------------------------------------------------------------------------
// Failure of a step: failed step is propagated, downstream is NOT
// auto-executed (the engine only surfaces one step; fix-retry inserts
// new fix steps at the verification gate, not here).
// ----------------------------------------------------------------------------

test("multi-step: failed step stays failed; downstream unblocks but the picker surfaces the first ready one", () => {
  // A (fail) -> B -> C
  let p = plan([
    step("A"),
    step("B", { depends_on: ["A"] }),
    step("C", { depends_on: ["B"] }),
  ]);
  const seen = new Set();

  // Iteration 1: A is ready. Model picks it, then fails.
  let next = pickNextStep(p, seen);
  assert.equal(next.id, "A");
  seen.add(next.id);
  p = markStep(p, "A", "failed");
  // A failed (terminal) -> B becomes ready.
  assert.equal(nextReadySteps(p).length, 1);
  assert.equal(nextReadySteps(p)[0].id, "B");

  // Iteration 2: B is the new ready step. The engine surfaces it
  // (downstream auto-propagation IS allowed because the dep is in a
  // terminal status). The model gets a chance to decide whether to
  // run B or insert a fix step. We pin the engine's behavior: the
  // engine does NOT block B because A failed.
  next = pickNextStep(p, seen);
  assert.equal(next.id, "B");
  seen.add(next.id);
  p = markStep(p, "B", "done");

  // Iteration 3: C becomes ready.
  next = pickNextStep(p, seen);
  assert.equal(next.id, "C");
});

// ----------------------------------------------------------------------------
// Cancellation: the picker is cancellation-agnostic — the agent
// loop checks controller.signal.aborted. Pin the picker contract so
// a refactor doesn't introduce cancellation side-effects.
// ----------------------------------------------------------------------------

test("multi-step: cancellation does not affect the picker (engine stays pure)", () => {
  const p = plan([step("A"), step("B", { depends_on: ["A"] })]);
  const seen = new Set();
  // Even after a hypothetical "abort", the picker still returns the
  // first ready step. The outer loop is responsible for bailing.
  const first = pickNextStep(p, seen);
  assert.equal(first.id, "A");
  // The picker does NOT mutate the plan.
  const before = JSON.stringify(p);
  pickNextStep(p, seen);
  assert.equal(JSON.stringify(p), before, "picker must not mutate plan");
});

// ----------------------------------------------------------------------------
// Completed-then-new: after A completes, B becomes ready and is picked
// ----------------------------------------------------------------------------

test("multi-step: after A completes, B becomes ready and is picked next", () => {
  let p = plan([
    step("A"),
    step("B", { depends_on: ["A"] }),
    step("C", { depends_on: ["B"] }),
  ]);
  const seen = new Set();

  let next = pickNextStep(p, seen);
  assert.equal(next.id, "A");
  seen.add(next.id);
  p = markStep(p, "A", "done");

  // Now B is the head of the ready list. seen has only "A".
  next = pickNextStep(p, seen);
  assert.equal(next.id, "B");
  assert.equal(seen.has("B"), false, "B must not be in seen yet");
  seen.add(next.id);
});

// ----------------------------------------------------------------------------
// No-ready: a finished plan returns null
// ----------------------------------------------------------------------------

test("multi-step: a finished plan returns null from pickNextStep", () => {
  const p = plan([
    { id: "A", title: "A", status: "done", depends_on: [], files: [], assigned_to: null },
    { id: "B", title: "B", status: "failed", depends_on: ["A"], files: [], assigned_to: null },
  ]);
  assert.equal(isPlanComplete(p), true);
  assert.equal(pickNextStep(p, new Set()), null);
});

test("multi-step: an empty plan returns null from pickNextStep", () => {
  assert.equal(pickNextStep({ steps: [], version: 1 }, new Set()), null);
  assert.equal(pickNextStep(null, new Set()), null);
  assert.equal(pickNextStep(undefined, new Set()), null);
});

// ----------------------------------------------------------------------------
// Stall detection: same step ready twice in a row returns null on the
// second call (caller treats as completed or stalled).
// ----------------------------------------------------------------------------

test("multi-step: stall detection returns null when the same ready step is at the head twice", () => {
  const p = plan([
    step("A"),
    step("B", { depends_on: ["A"] }),
  ]);
  const seen = new Set();
  // First call: A is ready, not seen.
  const first = pickNextStep(p, seen);
  assert.equal(first.id, "A");
  seen.add(first.id);
  // No markStep between calls — the same plan is in front of the
  // picker. A is still at the head, and is now in `seen`. Stall.
  const second = pickNextStep(p, seen);
  assert.equal(second, null, "second pick without progress must stall");
});

test("multi-step: stall detection ignores non-head steps in seen", () => {
  const p = plan([
    step("A"),
    step("B", { depends_on: ["A"] }),
  ]);
  const seen = new Set(["Z"]); // Z is not in the plan, but A is at the head.
  const next = pickNextStep(p, seen);
  assert.equal(next.id, "A", "unrelated seen ids must not block the head");
});

// ----------------------------------------------------------------------------
// nextAfterMark: thin wrapper that re-picks after markStep.
// ----------------------------------------------------------------------------

test("multi-step: nextAfterMark re-picks after the caller has marked the step", () => {
  let p = plan([
    step("A"),
    step("B", { depends_on: ["A"] }),
  ]);
  const seen = new Set();
  let n = pickNextStep(p, seen);
  assert.equal(n.id, "A");
  seen.add(n.id);
  p = markStep(p, "A", "done");
  // nextAfterMark should now return B.
  n = nextAfterMark(p, seen);
  assert.equal(n.id, "B");
});

// ----------------------------------------------------------------------------
// Fan-out + picked-twice: drain semantics
// ----------------------------------------------------------------------------

test("multi-step: fan-out drains B, C, D across iterations without an extra model call per step", () => {
  // Simulates the engine behavior: after the model acts on A and
  // returns text (no tool calls), the engine continues to B, then C,
  // then D automatically — because each mark + re-pick is a local
  // state change, not a model round-trip.
  let p = plan([
    step("A"),
    step("B", { depends_on: ["A"] }),
    step("C", { depends_on: ["A"] }),
    step("D", { depends_on: ["A"] }),
  ]);
  const order = [];
  const seen = new Set();
  // Outer loop boundary simulates the model's per-step chat round.
  for (let i = 0; i < 10; i++) {
    const n = pickNextStep(p, seen);
    if (!n) break;
    order.push(n.id);
    seen.add(n.id);
    p = markStep(p, n.id, "done");
    // Reset seen between "rounds" so the engine can pick the new
    // head. This mirrors what `loop.js` does after each tool batch.
    if (i % 1 === 0) {
      // no-op; we just continue accumulating seen. The drain still
      // works because B/C/D are all NEW at the head.
    }
  }
  assert.deepEqual(order, ["A", "B", "C", "D"]);
  assert.equal(isPlanComplete(p), true);
});

// ----------------------------------------------------------------------------
// classifyStall: terminal / pending / running / failed classification
// ----------------------------------------------------------------------------

test("classifyStall: terminal plan returns terminal=true", () => {
  const p = plan([
    { id: "A", title: "A", status: "done", depends_on: [], files: [], assigned_to: null },
    { id: "B", title: "B", status: "failed", depends_on: ["A"], files: [], assigned_to: null },
  ]);
  const r = classifyStall(p);
  assert.equal(r.terminal, true);
  assert.equal(r.reason, "complete");
});

test("classifyStall: pending step surfaces reason=stalled", () => {
  const p = plan([
    { id: "A", title: "A", status: "done", depends_on: [], files: [], assigned_to: null },
    { id: "B", title: "B", status: "pending", depends_on: ["A"], files: [], assigned_to: null },
  ]);
  const r = classifyStall(p);
  assert.equal(r.terminal, false);
  assert.equal(r.reason, "stalled");
});

test("classifyStall: stuck-running surfaces reason=stalled-with-running", () => {
  const p = plan([
    { id: "A", title: "A", status: "running", depends_on: [], files: [], assigned_to: null },
  ]);
  const r = classifyStall(p);
  assert.equal(r.terminal, false);
  assert.equal(r.reason, "stalled-with-running");
});

test("classifyStall: failed with pending surfaces reason=stalled-with-failed", () => {
  const p = plan([
    { id: "A", title: "A", status: "done", depends_on: [], files: [], assigned_to: null },
    { id: "B", title: "B", status: "failed", depends_on: ["A"], files: [], assigned_to: null },
    { id: "C", title: "C", status: "pending", depends_on: ["B"], files: [], assigned_to: null },
  ]);
  const r = classifyStall(p);
  assert.equal(r.terminal, false);
  assert.equal(r.reason, "stalled-with-failed");
  assert.equal(r.lastFailedId, "B");
});

// ----------------------------------------------------------------------------
// Immutability + safety
// ----------------------------------------------------------------------------

test("multi-step: pickNextStep tolerates a missing seen-set (defaults to empty)", () => {
  const p = plan([step("A")]);
  const n = pickNextStep(p, undefined);
  assert.equal(n.id, "A");
  // Second call without a seen-set returns A again — the helper does
  // NOT memoize; the loop owns the seen-set.
  const n2 = pickNextStep(p, undefined);
  assert.equal(n2.id, "A");
});

test("multi-step: pickNextStep accepts an array as the seen argument", () => {
  // Plan: A -> B. First ready is A. After marking A done, B is ready
  // and A is in the seen set. Array form must behave like a Set.
  const p1 = plan([step("A"), step("B", { depends_on: ["A"] })]);
  // seen = ["X"] (unrelated). A is still at the head, not in seen.
  assert.equal(pickNextStep(p1, ["X"]).id, "A");
  // seen = ["A"]. A is at the head and is in seen -> stall.
  assert.equal(pickNextStep(p1, ["A"]), null);
  // After A is done, B is at the head. seen contains "A", not "B" -> B.
  const p2 = markStep(p1, "A", "done");
  assert.equal(pickNextStep(p2, ["A"]).id, "B");
});

// ----------------------------------------------------------------------------
// Integration with buildInitialPlan + parsePlan round-trip
// ----------------------------------------------------------------------------

test("multi-step: buildInitialPlan + parsePlan produces a single ready step", () => {
  const initial = buildInitialPlan({ objective: "Investigate the failing build" });
  const json = JSON.stringify(initial);
  const parsed = parsePlan(json);
  const n = pickNextStep(parsed, new Set());
  assert.ok(n);
  assert.equal(n.status, "pending");
  assert.deepEqual(n.depends_on, []);
});