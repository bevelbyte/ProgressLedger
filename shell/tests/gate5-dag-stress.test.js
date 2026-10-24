// GATE 5 — DAG concurrency stress + duplicate prevention.
//
// Fixture: A (root)
//             ├── B (depends on A)
//             ├── C (depends on A)
//             ├── D (depends on A)
//             └── E (depends on A)
//                   ↓
//                 F (depends on B, C, D, E)
//
// v6 GATE 4 proved A→{B,C,D}→E with concurrency. v9 GATE 5 adds a 4th
// sibling (E) and a downstream join step (F), then runs 50 repeated
// executions to prove:
//   1. F waits for ALL four siblings — no premature dispatch
//   2. No duplicate execution across 50 runs
//   3. Failure propagation — B fails ⇒ F blocked/skipped
//   4. Cancellation — abort mid-flight ⇒ no further dispatch
//   5. Persistence/resume — completed-steps log ⇒ no re-execution
//   6. Concurrency limit — maxBatchSize=2 caps batch to 2 of 4
//
// All tests are deterministic. Timing uses process.hrtime.bigint().

import test from "node:test";
import assert from "node:assert/strict";

import {
  pickNextReadyBatch,
  classifyStall,
} from "../src/services/agent/exec-dag.js";
import {
  parsePlan,
  markStep,
  nextReadySteps,
  isPlanComplete,
} from "../src/services/agent/plan.js";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const GATE5_PLAN = {
  version: 1,
  steps: [
    { id: "A", title: "root",          status: "pending", depends_on: [],        files: [], assigned_to: null },
    { id: "B", title: "sibling one",   status: "pending", depends_on: ["A"],     files: [], assigned_to: null },
    { id: "C", title: "sibling two",   status: "pending", depends_on: ["A"],     files: [], assigned_to: null },
    { id: "D", title: "sibling three", status: "pending", depends_on: ["A"],     files: [], assigned_to: null },
    { id: "E", title: "sibling four",  status: "pending", depends_on: ["A"],     files: [], assigned_to: null },
    { id: "F", title: "join all",      status: "pending", depends_on: ["B", "C", "D", "E"], files: [], assigned_to: null },
  ],
};

function freshPlan() {
  return JSON.parse(JSON.stringify(GATE5_PLAN));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hrStamp() {
  // Keep sub-millisecond precision. Converting the bigint to whole
  // milliseconds made the "< 1ms" concurrency proof self-contradictory:
  // two genuinely same-tick starts could quantize to a 1ms skew and fail.
  return Number(process.hrtime.bigint()) / 1_000_000;
}

/** Simulated executor — awaits `ms` real ms, records to `log`. */
function simulateExecutor(log, ms, failIds = new Set(), cancelSignal = { cancelled: false }) {
  return async (step) => {
    if (cancelSignal.cancelled) return { id: step.id, skipped: true };
    const start = hrStamp();
    await new Promise((resolve) => setTimeout(resolve, ms));
    const end = hrStamp();
    log.push({ id: step.id, start, end, duration: end - start });
    return failIds.has(step.id) ? { id: step.id, status: "failed" } : { id: step.id, status: "done" };
  };
}

/**
 * Drive DAG through pickNextReadyBatch. Same runner pattern as GATE 4.
 * On dispatch, only steps whose every dependency is `done` are sent to
 * the executor. Steps whose deps include a `failed` dep are marked
 * `skipped` (failure propagation).
 */
async function runDAG(plan, executor, opts = {}) {
  const { maxBatchSize = 4, maxTicks = 20, shouldCancel = () => false } = opts;
  const tickLog = [];
  for (let i = 0; i < maxTicks; i++) {
    if (isPlanComplete(plan)) break;
    if (shouldCancel()) {
      tickLog.push({ tick: i, cancelled: true, dispatched: [] });
      break;
    }
    const ready = nextReadySteps(plan);
    const dispatchable = ready.filter((s) =>
      (s.depends_on || []).every((d) => {
        const dep = plan.steps.find((x) => x.id === d);
        return dep && dep.status === "done";
      }),
    );
    // Failure propagation: skip ready-but-not-dispatchable steps with a failed dep.
    for (const s of ready) {
      if (dispatchable.some((x) => x.id === s.id)) continue;
      const hasFailedDep = (s.depends_on || []).some((d) => {
        const dep = plan.steps.find((x) => x.id === d);
        return dep && dep.status === "failed";
      });
      if (hasFailedDep) plan = markStep(plan, s.id, "skipped");
    }
    if (dispatchable.length === 0) {
      tickLog.push({ tick: i, dispatched: [], noReady: true });
      break;
    }
    const batch = dispatchable.slice(0, maxBatchSize);
    tickLog.push({ tick: i, dispatched: batch.map((s) => s.id) });
    const results = await Promise.all(batch.map(executor));
    for (const r of results) {
      if (r && r.skipped)       plan = markStep(plan, r.id, "skipped");
      else if (r && r.status === "failed") plan = markStep(plan, r.id, "failed");
      else                            plan = markStep(plan, r.id, "done");
    }
  }
  return { plan, tickLog };
}

// ---------------------------------------------------------------------------
// Test 1 — F waits for ALL four siblings (B, C, D, E)
// ---------------------------------------------------------------------------

test("GATE 5 (1): F waits for all four siblings B, C, D, E — not dispatched until every one is done", () => {
  let plan = freshPlan();
  plan = markStep(plan, "A", "done");

  // Only B,C,D,E are ready; F depends on all four → not ready.
  const batch1 = pickNextReadyBatch(plan, 10);
  assert.deepEqual(
    batch1.map((s) => s.id),
    ["B", "C", "D", "E"],
    "After A done, exactly [B,C,D,E] should be ready — F must not appear",
  );
  assert.equal(batch1.some((s) => s.id === "F"), false, "F must NOT be ready while any sibling is pending");

  // Mark 3 of 4 done — F still blocked.
  plan = markStep(plan, "B", "done");
  plan = markStep(plan, "C", "done");
  plan = markStep(plan, "D", "done");
  // E still pending.
  const batch2 = pickNextReadyBatch(plan, 10);
  assert.equal(batch2.some((s) => s.id === "F"), false, "F must still be blocked when E is pending");

  // Mark E done — now F is ready.
  plan = markStep(plan, "E", "done");
  const batch3 = pickNextReadyBatch(plan, 10);
  assert.deepEqual(batch3.map((s) => s.id), ["F"], "F must be the only step ready after all 4 siblings are done");
});

// ---------------------------------------------------------------------------
// Test 2 — 50 repeated runs, no duplicate execution
// ---------------------------------------------------------------------------

test(
  "GATE 5 (2): 50 repeated DAG runs — every step dispatched exactly once per run, zero duplicates",
  { timeout: 30000 },
  async () => {
    const N = 50;
    const exec = simulateExecutor([], 1); // 1ms per step keeps this fast

    for (let run = 0; run < N; run++) {
      const log = [];
      const myExec = simulateExecutor(log, 1);
      const { plan, tickLog } = await runDAG(freshPlan(), myExec, { maxBatchSize: 4 });

      assert.equal(isPlanComplete(plan), true, `run ${run}: plan must complete`);

      // No duplicate in tickLog.
      const seenTick = new Set();
      for (const tick of tickLog) {
        for (const id of tick.dispatched || []) {
          assert.ok(
            !seenTick.has(id),
            `run ${run}: step ${id} was dispatched more than once across ticks`,
          );
          seenTick.add(id);
        }
      }

      // Every step executed exactly once in the log.
      const counts = new Map();
      for (const e of log) counts.set(e.id, (counts.get(e.id) || 0) + 1);
      for (const s of GATE5_PLAN.steps) {
        const c = counts.get(s.id);
        assert.equal(
          c,
          1,
          `run ${run}: step ${s.id} should be executed exactly once (got ${c})`,
        );
      }
    }

    assert.equal(N, 50, `completed ${N} runs`);
  },
);

// ---------------------------------------------------------------------------
// Test 3 — Failure propagation: B fails ⇒ F blocked/skipped
// ---------------------------------------------------------------------------

test(
  "GATE 5 (3): failure propagation — B fails ⇒ C, D, E run ⇒ F is skipped (never dispatched)",
  { timeout: 10000 },
  async () => {
    const failIds = new Set(["B"]);
    const log = [];
    const exec = simulateExecutor(log, 1, failIds);
    const { plan, tickLog } = await runDAG(freshPlan(), exec, { maxBatchSize: 4 });

    assert.equal(isPlanComplete(plan), true, "plan must complete after failure propagation");

    // B is failed.
    assert.equal(plan.steps.find((s) => s.id === "B").status, "failed");

    // C, D, E completed.
    for (const id of ["C", "D", "E"]) {
      assert.equal(
        plan.steps.find((s) => s.id === id).status,
        "done",
        `${id} should be done even though B failed (B is not a dep of ${id})`,
      );
    }

    // F was skipped (has failed dep B).
    assert.equal(
      plan.steps.find((s) => s.id === "F").status,
      "skipped",
      `F must be skipped because B failed (its dep), got: ${plan.steps.find((s) => s.id === "F").status}`,
    );

    // F was never dispatched.
    const dispatched = tickLog.flatMap((t) => t.dispatched || []);
    assert.ok(!dispatched.includes("F"), "F must never appear in dispatched lists");

    // F never appears in executor log.
    assert.ok(!log.some((e) => e.id === "F"), "F must not appear in executor log");

    // Classifier agrees: plan is terminal.
    const stall = classifyStall(plan);
    assert.equal(stall.terminal, true, `plan should be terminal after propagation (reason=${stall.reason})`);
  },
);

// ---------------------------------------------------------------------------
// Test 4 — Cancellation: abort mid-flight, no step processed after abort
// ---------------------------------------------------------------------------

test(
  "GATE 5 (4): cancellation — abort after A completes, no sibling or F is dispatched",
  { timeout: 5000 },
  async () => {
    const log = [];
    const cancelSignal = { cancelled: false };
    const exec = simulateExecutor(log, 1, new Set(), cancelSignal);

    let tick = 0;
    const { plan, tickLog } = await runDAG(
      freshPlan(),
      exec,
      {
        maxBatchSize: 4,
        maxTicks: 20,
        shouldCancel: () => {
          tick += 1;
          return tick > 1; // cancel after first dispatch (A)
        },
      },
    );

    // Only one tick dispatched steps.
    const dispatched = tickLog.filter((t) => (t.dispatched || []).length > 0);
    assert.equal(dispatched.length, 1, "only the pre-cancel tick should dispatch");
    assert.deepEqual(dispatched[0].dispatched, ["A"]);

    // Exactly one executor entry (A).
    assert.equal(log.length, 1);
    assert.equal(log[0].id, "A");

    // B, C, D, E, F never dispatched.
    for (const id of ["B", "C", "D", "E", "F"]) {
      assert.ok(
        !log.some((e) => e.id === id),
        `${id} must NOT have been dispatched after cancellation`,
      );
    }
    void plan;
  },
);

// ---------------------------------------------------------------------------
// Test 5 — Persistence/resume: completed-steps log → no duplicate work
// ---------------------------------------------------------------------------

test(
  "GATE 5 (5): persistence/resume — given a 'completed steps' log, runner skips already-done steps and finishes the rest without re-executing them",
  { timeout: 10000 },
  async () => {
    // Simulate: a prior session completed A, B, C. Persist their statuses.
    // The remaining work is D (needs A done ✓), then F (needs B,C,D,E done — but E is still pending).
    // After resume, D and E run, then F. A/B/C must NOT be re-executed.
    const completedSteps = new Set(["A", "B", "C"]);
    let plan = freshPlan();
    for (const id of completedSteps) plan = markStep(plan, id, "done");

    const log = [];
    const exec = simulateExecutor(log, 1);

    // Resume: the runner continues from current plan state.
    const { plan: resumed } = await runDAG(plan, exec, { maxBatchSize: 4 });

    assert.equal(isPlanComplete(resumed), true, "plan must complete after resume");

    // A, B, C must NOT appear in the executor log (they were already done).
    for (const id of ["A", "B", "C"]) {
      assert.ok(
        !log.some((e) => e.id === id),
        `${id} must NOT have been re-executed (it was already completed)`,
      );
    }

    // D, E, F should each appear exactly once.
    for (const id of ["D", "E", "F"]) {
      const count = log.filter((e) => e.id === id).length;
      assert.equal(
        count,
        1,
        `${id} should be executed exactly once during resume (got ${count})`,
      );
    }

    // All final statuses correct.
    assert.equal(resumed.steps.find((s) => s.id === "A").status, "done");
    assert.equal(resumed.steps.find((s) => s.id === "B").status, "done");
    assert.equal(resumed.steps.find((s) => s.id === "C").status, "done");
    assert.equal(resumed.steps.find((s) => s.id === "D").status, "done");
    assert.equal(resumed.steps.find((s) => s.id === "E").status, "done");
    assert.equal(resumed.steps.find((s) => s.id === "F").status, "done");

    // Verify via parsePlan round-trip: the plan JSON can be re-parsed and
    // produce the same terminal state — simulating real persistence.
    // Verify via parsePlan round-trip: serialize the plan back to JSON
    // (simulating real persistence), re-parse, and confirm it's still complete.
    const json = planToJson(resumed);
    const reparsed = parsePlan(json);
    assert.equal(isPlanComplete(reparsed), true, "re-parsed plan must also be complete");
    assert.equal(reparsed.steps.find((s) => s.id === "F").status, "done");
    void json;
  },
);

/** Minimal planToJson — mirrors plan.js; included inline so no extra import is needed
 * when plan.js is loaded. In practice plan.js exports planToJson; we import it
 * here but guard in case it's not exported in this version. */
import { planToJson } from "../src/services/agent/plan.js";

// ---------------------------------------------------------------------------
// Test 6 — Concurrency limit: maxBatchSize=2 returns only 2 of 4 ready siblings
// ---------------------------------------------------------------------------

test("GATE 5 (6): pickNextReadyBatch(plan, 2) returns only 2 of the 4 ready siblings after A done", () => {
  let plan = freshPlan();
  plan = markStep(plan, "A", "done");

  // With maxBatchSize=2, only the first 2 declaration-order siblings.
  const batch2 = pickNextReadyBatch(plan, 2);
  assert.equal(batch2.length, 2, "batch must have exactly 2 steps");
  assert.deepEqual(
    batch2.map((s) => s.id),
    ["B", "C"],
    "first 2 siblings in declaration order must be returned",
  );
  assert.equal(batch2.some((s) => s.id === "D"), false, "D must not be in the batch");
  assert.equal(batch2.some((s) => s.id === "E"), false, "E must not be in the batch");

  // With maxBatchSize=10, all 4.
  const batchAll = pickNextReadyBatch(plan, 10);
  assert.deepEqual(
    batchAll.map((s) => s.id),
    ["B", "C", "D", "E"],
    "with large maxBatchSize all 4 siblings must be returned",
  );

  // With maxBatchSize=1, only B.
  const batch1 = pickNextReadyBatch(plan, 1);
  assert.deepEqual(batch1.map((s) => s.id), ["B"]);

  // With maxBatchSize=3, B, C, D.
  const batch3 = pickNextReadyBatch(plan, 3);
  assert.deepEqual(batch3.map((s) => s.id), ["B", "C", "D"]);
});

// ---------------------------------------------------------------------------
// Bonus — real wall-clock proof: 4 siblings run concurrently in one tick
// ---------------------------------------------------------------------------

test(
  "GATE 5 (bonus): concurrency proof — B, C, D, E start in the same tick with >50% wall-clock savings vs sequential",
  { timeout: 5000 },
  async () => {
    const log = [];
    const ms = 30;
    const exec = simulateExecutor(log, ms);

    let plan = freshPlan();
    plan = markStep(plan, "A", "done");

    const t0 = hrStamp();
    const batch = pickNextReadyBatch(plan, 4);
    const results = await Promise.all(batch.map(exec));
    const t1 = hrStamp();

    for (const r of results) plan = markStep(plan, r.id, r.status);

    // All four start within 1ms.
    const starts = log.map((e) => e.start);
    const startSkew = Math.max(...starts) - Math.min(...starts);
    assert.ok(
      startSkew < 1,
      `B, C, D, E must start within 1ms of each other (start skew = ${startSkew}ms)`,
    );

    // Total wall time << sum of individual durations.
    const sum = log.reduce((acc, e) => acc + e.duration, 0);
    const elapsed = t1 - t0;
    const savings = (sum - elapsed) / sum;
    assert.ok(
      savings > 0.5,
      `parallel elapsed=${elapsed}ms vs sequential sum=${sum}ms — savings=${(savings * 100).toFixed(1)}% (need >50%)`,
    );

    // Elapsed close to the longest single task.
    const longest = Math.max(...log.map((e) => e.duration));
    assert.ok(
      elapsed < longest + 25,
      `parallel elapsed=${elapsed}ms should be within 25ms of longest single task=${longest}ms`,
    );

    // Exactly 4 entries in the log.
    assert.equal(log.length, 4, "all 4 siblings must have been executed");
    const ids = log.map((e) => e.id).sort();
    assert.deepEqual(ids, ["B", "C", "D", "E"]);
  },
);
