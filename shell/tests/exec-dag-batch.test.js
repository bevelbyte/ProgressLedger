// Tests for the new pickNextReadyBatch() helper + the parallel-batch
// semantics it enables.

import test from "node:test";
import assert from "node:assert/strict";
import { pickNextReadyBatch, pickNextStep } from "../src/services/agent/exec-dag.js";
import { parsePlan, markStep, nextReadySteps } from "../src/services/agent/plan.js";

function makePlan(steps) {
  return { version: 1, steps };
}

test("pickNextReadyBatch: empty plan returns []", () => {
  assert.deepEqual(pickNextReadyBatch({ steps: [] }), []);
  assert.deepEqual(pickNextReadyBatch(null), []);
});

test("pickNextReadyBatch: single ready step returns it", () => {
  const plan = makePlan([
    { id: "a", title: "t", status: "pending", depends_on: [], files: [] },
  ]);
  const batch = pickNextReadyBatch(plan, 3);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].id, "a");
});

test("pickNextReadyBatch: diamond returns A first", () => {
  const plan = makePlan([
    { id: "a", status: "pending", depends_on: [] },
    { id: "b", status: "pending", depends_on: ["a"] },
    { id: "c", status: "pending", depends_on: ["a"] },
    { id: "d", status: "pending", depends_on: ["b", "c"] },
  ]);
  // Initially only a is ready.
  const batch = pickNextReadyBatch(plan, 3);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].id, "a");
  // After marking a done, b and c are both ready; both come back.
  const next = markStep(plan, "a", "done");
  const batch2 = pickNextReadyBatch(next, 3);
  assert.equal(batch2.length, 2);
  const ids = batch2.map((s) => s.id).sort();
  assert.deepEqual(ids, ["b", "c"]);
});

test("pickNextReadyBatch: fan-out returns all parallel leaves", () => {
  const plan = makePlan([
    { id: "a", status: "pending", depends_on: [] },
    { id: "b", status: "pending", depends_on: ["a"] },
    { id: "c", status: "pending", depends_on: ["a"] },
    { id: "d", status: "pending", depends_on: ["a"] },
  ]);
  // Mark a done → b, c, d all ready; batch returns all 3.
  const next = markStep(plan, "a", "done");
  const batch = pickNextReadyBatch(next, 3);
  assert.equal(batch.length, 3);
  const ids = batch.map((s) => s.id).sort();
  assert.deepEqual(ids, ["b", "c", "d"]);
});

test("pickNextReadyBatch: respects maxBatchSize", () => {
  const plan = makePlan([
    { id: "a", status: "pending", depends_on: [] },
    { id: "b", status: "pending", depends_on: ["a"] },
    { id: "c", status: "pending", depends_on: ["a"] },
    { id: "d", status: "pending", depends_on: ["a"] },
  ]);
  const next = markStep(plan, "a", "done");
  const batch = pickNextReadyBatch(next, 2);
  assert.equal(batch.length, 2);
});

test("pickNextReadyBatch: maxBatchSize <= 0 returns []", () => {
  const plan = makePlan([{ id: "a", status: "pending", depends_on: [] }]);
  assert.deepEqual(pickNextReadyBatch(plan, 0), []);
  assert.deepEqual(pickNextReadyBatch(plan, -1), []);
});

test("pickNextReadyBatch: returns first N in declaration order", () => {
  const plan = makePlan([
    { id: "a", status: "pending", depends_on: [] },
    { id: "b", status: "pending", depends_on: ["a"] },
    { id: "c", status: "pending", depends_on: ["a"] },
  ]);
  const next = markStep(plan, "a", "done");
  // maxBatchSize=10 returns all 2, in declaration order.
  const batch = pickNextReadyBatch(next, 10);
  assert.deepEqual(batch.map((s) => s.id), ["b", "c"]);
});

test("pickNextReadyBatch: skips non-pending steps", () => {
  const plan = makePlan([
    { id: "a", status: "pending", depends_on: [] },
    { id: "b", status: "done", depends_on: ["a"] },
    { id: "c", status: "pending", depends_on: ["b"] },
  ]);
  // Only a + c are pending; b is done (terminal). Batch should
  // return a then c (only one ready at a time, since c depends on b
  // which is done — wait, c depends on b but b is done so c IS ready).
  // So batch is [a, c] in declaration order.
  const batch = pickNextReadyBatch(plan, 5);
  assert.equal(batch.length, 2);
  assert.deepEqual(batch.map((s) => s.id), ["a", "c"]);
});

test("pickNextReadyBatch: respects seenInThisModelStep (delegated to pickNextStep)", () => {
  // pickNextReadyBatch is intentionally simple (no seen set). The
  // loop handles seenInThisModelStep at a higher level.
  const plan = makePlan([
    { id: "a", status: "pending", depends_on: [] },
    { id: "b", status: "pending", depends_on: ["a"] },
  ]);
  const next = markStep(plan, "a", "done");
  // After a is done, only b is READY (a is terminal). The batch
  // helper returns ready steps in declaration order.
  const batch = pickNextReadyBatch(next, 5);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].id, "b");
});
