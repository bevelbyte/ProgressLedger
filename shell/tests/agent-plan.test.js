// Phase 13 — plan_json becomes operational.
//
// The plan is the DAG the agent loop reads / writes / respects. These
// tests pin the pure helpers in shell/src/services/agent/plan.js.

import test from "node:test";
import assert from "node:assert/strict";

import {
  parsePlan,
  validatePlan,
  buildInitialPlan,
  nextReadySteps,
  markStep,
  isPlanComplete,
  planToJson,
} from "../src/services/agent/plan.js";

// ----------------------------------------------------------------------------
// parsePlan
// ----------------------------------------------------------------------------

test("parsePlan: accepts a plain array (legacy shape)", () => {
  const plan = parsePlan(JSON.stringify([
    { id: "a", title: "A", status: "pending" },
    { id: "b", title: "B", status: "pending" },
  ]));
  assert.ok(Array.isArray(plan.steps));
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].id, "a");
  assert.equal(plan.steps[0].title, "A");
  assert.equal(plan.steps[0].status, "pending");
});

test("parsePlan: accepts the object-with-steps shape (canonical)", () => {
  const plan = parsePlan(JSON.stringify({
    steps: [
      { id: "x", title: "X", status: "done", depends_on: [], files: [], assigned_to: null },
    ],
    version: 1,
  }));
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].id, "x");
  assert.equal(plan.steps[0].status, "done");
});

test("parsePlan: returns { steps: [] } for empty / null input", () => {
  assert.deepEqual(parsePlan(""), { steps: [], version: 1 });
  assert.deepEqual(parsePlan(null), { steps: [], version: 1 });
  assert.deepEqual(parsePlan(undefined), { steps: [], version: 1 });
  assert.deepEqual(parsePlan("   "), { steps: [], version: 1 });
});

test("parsePlan: returns { steps: [] } for invalid JSON", () => {
  assert.deepEqual(parsePlan("not json"), { steps: [], version: 1 });
  assert.deepEqual(parsePlan("{"), { steps: [], version: 1 });
});

test("parsePlan: normalizes 'completed' to 'done' and lowercase statuses", () => {
  const plan = parsePlan(JSON.stringify([
    { id: "a", title: "A", status: "Completed" },
    { id: "b", title: "B", status: "FAILED" },
    { id: "c", title: "C", status: "Running" },
  ]));
  assert.equal(plan.steps[0].status, "done");
  assert.equal(plan.steps[1].status, "failed");
  assert.equal(plan.steps[2].status, "running");
});

test("parsePlan: preserves depends_on / files / assigned_to", () => {
  const plan = parsePlan(JSON.stringify({
    steps: [
      { id: "a", title: "A", status: "pending", depends_on: ["b"], files: ["src/x.js"], assigned_to: "coder" },
    ],
  }));
  assert.deepEqual(plan.steps[0].depends_on, ["b"]);
  assert.deepEqual(plan.steps[0].files, ["src/x.js"]);
  assert.equal(plan.steps[0].assigned_to, "coder");
});

// ----------------------------------------------------------------------------
// validatePlan
// ----------------------------------------------------------------------------

test("validatePlan: accepts a minimal valid plan", () => {
  const r = validatePlan({ steps: [{ id: "a", title: "A" }], version: 1 });
  assert.equal(r.ok, true);
});

test("validatePlan: rejects steps with duplicate ids", () => {
  const r = validatePlan({
    steps: [
      { id: "a", title: "A" },
      { id: "a", title: "A-dup" },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /duplicate step id/);
});

test("validatePlan: rejects cycles in depends_on", () => {
  const r = validatePlan({
    steps: [
      { id: "a", title: "A", depends_on: ["b"] },
      { id: "b", title: "B", depends_on: ["a"] },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /cycle/);
});

test("validatePlan: rejects three-step cycles in depends_on", () => {
  const r = validatePlan({
    steps: [
      { id: "a", title: "A", depends_on: ["c"] },
      { id: "b", title: "B", depends_on: ["a"] },
      { id: "c", title: "C", depends_on: ["b"] },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /cycle/);
});

test("validatePlan: rejects depends_on references to unknown step ids", () => {
  const r = validatePlan({
    steps: [
      { id: "a", title: "A", depends_on: ["ghost"] },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown step/);
});

test("validatePlan: rejects plans that are not objects", () => {
  assert.equal(validatePlan(null).ok, false);
  assert.equal(validatePlan("string").ok, false);
  assert.equal(validatePlan(undefined).ok, false);
});

test("validatePlan: rejects steps that are not objects", () => {
  const r = validatePlan({ steps: [null] });
  assert.equal(r.ok, false);
});

// ----------------------------------------------------------------------------
// nextReadySteps
// ----------------------------------------------------------------------------

test("nextReadySteps: returns the root steps first (no dependencies)", () => {
  const plan = {
    steps: [
      { id: "a", title: "A", status: "pending", depends_on: [] },
      { id: "b", title: "B", status: "pending", depends_on: [] },
      { id: "c", title: "C", status: "pending", depends_on: ["a"] },
    ],
  };
  const ready = nextReadySteps(plan);
  const ids = ready.map((s) => s.id);
  assert.deepEqual(ids.sort(), ["a", "b"]);
});

test("nextReadySteps: returns nothing once all done", () => {
  const plan = {
    steps: [
      { id: "a", title: "A", status: "done", depends_on: [] },
      { id: "b", title: "B", status: "failed", depends_on: ["a"] },
    ],
  };
  const ready = nextReadySteps(plan);
  assert.equal(ready.length, 0);
});

test("nextReadySteps: unblocks when deps are skipped/failed (no hard block)", () => {
  const plan = {
    steps: [
      { id: "a", title: "A", status: "skipped", depends_on: [] },
      { id: "b", title: "B", status: "pending", depends_on: ["a"] },
    ],
  };
  const ready = nextReadySteps(plan);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].id, "b");
});

test("nextReadySteps: ignores steps that are already running or done", () => {
  const plan = {
    steps: [
      { id: "a", title: "A", status: "running", depends_on: [] },
      { id: "b", title: "B", status: "done", depends_on: [] },
      { id: "c", title: "C", status: "pending", depends_on: [] },
    ],
  };
  const ready = nextReadySteps(plan);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].id, "c");
});

// ----------------------------------------------------------------------------
// markStep
// ----------------------------------------------------------------------------

test("markStep: returns a new plan (immutability)", () => {
  const plan = {
    steps: [
      { id: "a", title: "A", status: "pending", depends_on: [], files: [], assigned_to: null },
    ],
    version: 1,
  };
  const before = JSON.stringify(plan);
  const next = markStep(plan, "a", "running");
  assert.equal(JSON.stringify(plan), before, "input plan must not be mutated");
  assert.notEqual(next, plan, "must be a new object reference");
  assert.equal(next.steps[0].status, "running");
  assert.equal(plan.steps[0].status, "pending");
});

test("markStep: only changes the targeted step", () => {
  const plan = {
    steps: [
      { id: "a", title: "A", status: "pending", depends_on: [], files: [], assigned_to: null },
      { id: "b", title: "B", status: "pending", depends_on: [], files: [], assigned_to: null },
    ],
    version: 1,
  };
  const next = markStep(plan, "b", "done");
  assert.equal(next.steps[0].status, "pending");
  assert.equal(next.steps[1].status, "done");
});

test("markStep: no-op when stepId is unknown (returns a copy)", () => {
  const plan = { steps: [{ id: "a", title: "A", status: "pending" }], version: 1 };
  const next = markStep(plan, "ghost", "done");
  assert.equal(next.steps[0].status, "pending");
  assert.notEqual(next, plan);
});

// ----------------------------------------------------------------------------
// isPlanComplete
// ----------------------------------------------------------------------------

test("isPlanComplete: true when every step has a terminal status", () => {
  const plan = {
    steps: [
      { id: "a", title: "A", status: "done" },
      { id: "b", title: "B", status: "failed" },
      { id: "c", title: "C", status: "skipped" },
    ],
  };
  assert.equal(isPlanComplete(plan), true);
});

test("isPlanComplete: false when any step is pending or running", () => {
  const plan1 = {
    steps: [
      { id: "a", title: "A", status: "done" },
      { id: "b", title: "B", status: "pending" },
    ],
  };
  assert.equal(isPlanComplete(plan1), false);
  const plan2 = {
    steps: [
      { id: "a", title: "A", status: "running" },
    ],
  };
  assert.equal(isPlanComplete(plan2), false);
});

test("isPlanComplete: false for an empty plan (no work, but not done)", () => {
  assert.equal(isPlanComplete({ steps: [] }), false);
  assert.equal(isPlanComplete(null), false);
});

// ----------------------------------------------------------------------------
// buildInitialPlan
// ----------------------------------------------------------------------------

test("buildInitialPlan({ objective }) returns a single pending step", () => {
  const plan = buildInitialPlan({ objective: "Build a thing" });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].status, "pending");
  assert.ok(plan.steps[0].id && plan.steps[0].id.length > 0);
  assert.ok(plan.steps[0].title && plan.steps[0].title.length > 0);
});

test("buildInitialPlan: tolerates a missing objective", () => {
  const plan = buildInitialPlan({});
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].status, "pending");
});

// ----------------------------------------------------------------------------
// planToJson (round-trip)
// ----------------------------------------------------------------------------

test("planToJson: round-trips through parsePlan", () => {
  const plan = {
    steps: [
      { id: "a", title: "A", status: "pending", depends_on: [], files: ["src/x.js"], assigned_to: "coder" },
      { id: "b", title: "B", status: "running", depends_on: ["a"], files: [], assigned_to: null },
    ],
    version: 1,
  };
  const json = planToJson(plan);
  const back = parsePlan(json);
  assert.deepEqual(back, plan);
});

test("planToJson: produces parseable JSON", () => {
  const json = planToJson({ steps: [{ id: "a", title: "A" }], version: 1 });
  assert.doesNotThrow(() => JSON.parse(json));
});
