// Goal Mode — integration tests against the real Rust/NAPI core.
//
// These tests exercise the full Goal Mode SQL boundary:
//   - create / list / get / delete goal
//   - state transitions are validated at the SQL boundary
//   - terminal states cannot be left
//   - linked agent linkage is gated by project ownership
//   - timeline events append correctly
//   - rejection of invalid kinds / states
//
// They do NOT exercise the goal engine's start/cancel orchestration
// (that needs the agent loop + provider). The engine orchestration is
// covered by goals-engine-integration.test.js (with a mocked agent
// loop).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// Locate the native core build. We use the .node binary that ships in
// the repo for the test harness.
const corePath = path.join(REPO_ROOT, "core", "progress_ledger_core.win32-x64-msvc.node");
assert.ok(fs.existsSync(corePath), `Native core not built: ${corePath}`);
// ESM dynamic import of a CommonJS module — Node treats require() of a
// .node file as CJS, but we can import the .node via createRequire.
import { createRequire } from "node:module";
const requireCJS = createRequire(import.meta.url);
const core = requireCJS(corePath);

// We share ONE DB across the suite (a per-suite temp file) instead of
// creating a new DB per test. Creating a fresh DB per test exercises the
// global pool's connection lifecycle in ways the production code path
// does not (the pool is global; reopening it for each test reveals
// flakiness in the test harness rather than in the goal engine).
const suiteTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "goals-suite-"));
const suiteDbPath = path.join(suiteTmpDir, "suite.db");
let suiteInited = false;
let counter = 0;

async function ensureSuite() {
  if (!suiteInited) {
    await core.initDb(suiteDbPath);
    suiteInited = true;
  }
}

async function withFreshDb(fn) {
  await ensureSuite();
  counter += 1;
  return await fn(suiteDbPath, counter);
}

async function createProfileAndProject(dbPath, n) {
  const addResult = await core.addProfile(`Test ${n}`, `t-${n}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const profileId = typeof addResult === "number" ? addResult : (addResult && addResult.id);
  const projectId = await core.pmCreateProject(
    profileId,
    `Goals Project ${n}`,
    "Test",
    path.dirname(dbPath),
    "{}"
  );
  return { profileId, projectId };
}

test("goal: create + list + get + delete (full round-trip)", async () => {
  await withFreshDb(async (dbPath) => {
    await core.initDb(dbPath);
    const { profileId, projectId } = await createProfileAndProject(dbPath);
    const goalId = await core.pmCreateGoal(profileId, projectId, "T", "O", "code_change", "normal", true);
    assert.equal(typeof goalId, "number");
    assert.ok(goalId > 0);

    const g = await core.pmGetGoal(profileId, goalId);
    assert.equal(g.id, goalId);
    assert.equal(g.title, "T");
    assert.equal(g.objective, "O");
    assert.equal(g.kind, "code_change");
    assert.equal(g.state, "created");
    assert.equal(g.priority, "normal");
    assert.equal(g.requireVerification, true);
    assert.ok(g.linkedAgentId == null); // NAPI serializes Option<i32> as undefined

    const list = await core.pmListGoals(profileId, null, 50);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, goalId);

    // Filter by state.
    const created = await core.pmListGoals(profileId, "created", 50);
    assert.equal(created.length, 1);

    const completed = await core.pmListGoals(profileId, "completed", 50);
    assert.equal(completed.length, 0);

    // Delete.
    await core.pmDeleteGoal(profileId, goalId);
    const after = await core.pmListGoals(profileId, null, 50);
    assert.equal(after.length, 0);
  });
});

test("goal: invalid kind is rejected at the SQL boundary", async () => {
  await withFreshDb(async (dbPath) => {
    await core.initDb(dbPath);
    const { profileId, projectId } = await createProfileAndProject(dbPath);
    let threw = false;
    try {
      await core.pmCreateGoal(profileId, projectId, "T", "O", "garbage", null, null);
    } catch (e) {
      threw = true;
      assert.ok(/kind must be one of/.test(String(e && e.message || e)), `unexpected error: ${e && e.message}`);
    }
    assert.ok(threw, "should have thrown");
  });
});

test("goal: invalid priority is rejected at the SQL boundary", async () => {
  await withFreshDb(async (dbPath) => {
    await core.initDb(dbPath);
    const { profileId, projectId } = await createProfileAndProject(dbPath);
    let threw = false;
    try {
      await core.pmCreateGoal(profileId, projectId, "T", "O", null, "urgent", null);
    } catch (e) {
      threw = true;
      assert.ok(/priority must be one of/.test(String(e && e.message || e)));
    }
    assert.ok(threw, "should have thrown");
  });
});

async function expectThrows(fn, pattern, message) {
  let threw = false;
  try { await fn(); } catch (e) {
    threw = true;
    const text = String(e && e.message || e);
    if (pattern) {
      assert.ok(pattern.test(text), `${message || "error"}: ${text}`);
    }
  }
  assert.ok(threw, message || "expected throw");
}

test("goal: cross-profile access is refused", async () => {
  await withFreshDb(async (dbPath) => {
    await core.initDb(dbPath);
    const { profileId, projectId } = await createProfileAndProject(dbPath);
    // Add a second profile (extract id from the object).
    const added = await core.addProfile("Second", "second");
    const profileBId = typeof added === "number" ? added : added.id;
    // Profile A creates a goal.
    const goalId = await core.pmCreateGoal(
      profileId, projectId, "X", "Y",
      "code_change", "normal", true
    );
    assert.ok(typeof goalId === "number");
    // Profile B cannot read it.
    let threwError = null;
    try { await core.pmGetGoal(profileBId, goalId); }
    catch (e) { threwError = e; }
    assert.ok(threwError, "cross-profile read should throw");
    assert.ok(/Goal not found/i.test(String(threwError && threwError.message || threwError)),
      `unexpected: ${threwError && threwError.message}`);
  });
});

test("goal: cross-project ownership — cannot use another profile's project", async () => {
  await withFreshDb(async (dbPath, n) => {
    await core.initDb(dbPath);
    const { profileId, projectId } = await createProfileAndProject(dbPath, n);
    const addResult = await core.addProfile("Second", `second-${n}-${Date.now()}`);
    const profileBId = typeof addResult === "number" ? addResult : addResult.id;
    await expectThrows(
      () => core.pmCreateGoal(profileBId, projectId, "T", "O"),
      /Project not found/,
      "cross-project goal create should fail"
    );
  });
});

test("goal: valid transitions accepted; invalid refused", async () => {
  await withFreshDb(async (dbPath) => {
    await core.initDb(dbPath);
    const { profileId, projectId } = await createProfileAndProject(dbPath);
    const goalId = await core.pmCreateGoal(profileId, projectId, "T", "O");

    // created -> starting (valid)
    await core.pmTransitionGoal(profileId, goalId, "starting", null, null);
    let g = await core.pmGetGoal(profileId, goalId);
    assert.equal(g.state, "starting");

    // starting -> running (valid)
    await core.pmTransitionGoal(profileId, goalId, "running", null, null);
    g = await core.pmGetGoal(profileId, goalId);
    assert.equal(g.state, "running");

    // running -> verifying (valid)
    await core.pmTransitionGoal(profileId, goalId, "verifying", null, null);
    g = await core.pmGetGoal(profileId, goalId);
    assert.equal(g.state, "verifying");

    // verifying -> completed (valid)
    await core.pmTransitionGoal(profileId, goalId, "completed", null, "All good");
    g = await core.pmGetGoal(profileId, goalId);
    assert.equal(g.state, "completed");
    assert.equal(g.resultText, "All good");

    // completed -> starting (invalid — terminal cannot be left)
    await expectThrows(
      () => core.pmTransitionGoal(profileId, goalId, "starting", null, null),
      /already terminal/,
      "completed goal cannot be transitioned"
    );
  });
});

test("goal: invalid transition rejected with a clear error", async () => {
  await withFreshDb(async (dbPath) => {
    await core.initDb(dbPath);
    const { profileId, projectId } = await createProfileAndProject(dbPath);
    const goalId = await core.pmCreateGoal(profileId, projectId, "T", "O");
    // created -> completed is not allowed (must go through starting/running).
    await expectThrows(
      () => core.pmTransitionGoal(profileId, goalId, "completed", null, null),
      /Invalid goal transition/,
      "invalid transition should fail"
    );
  });
});

test("goal: link agent — valid project + ownership", async () => {
  await withFreshDb(async (dbPath) => {
    await core.initDb(dbPath);
    const { profileId, projectId } = await createProfileAndProject(dbPath);
    const goalId = await core.pmCreateGoal(profileId, projectId, "T", "O");
    const agentId = await core.pmCreateAgent(projectId, "Do the thing");
    await core.pmLinkGoalAgent(profileId, goalId, agentId);
    const g = await core.pmGetGoal(profileId, goalId);
    assert.equal(g.linkedAgentId, agentId);
    const resolved = await core.pmGetGoalAgentId(profileId, goalId);
    assert.equal(resolved, agentId);
  });
});

test("goal: link agent — cross-project link refused", async () => {
  await withFreshDb(async (dbPath) => {
    await core.initDb(dbPath);
    const { profileId } = await createProfileAndProject(dbPath);
    const projectA = await core.pmCreateProject(profileId, "A", "", path.dirname(dbPath), "{}");
    const projectB = await core.pmCreateProject(profileId, "B", "", path.dirname(dbPath), "{}");
    const goalId = await core.pmCreateGoal(profileId, projectA, "T", "O");
    const agentId = await core.pmCreateAgent(projectB, "X");
    await expectThrows(
      () => core.pmLinkGoalAgent(profileId, goalId, agentId),
      /not found in this goal's project/,
      "cross-project link should fail"
    );
  });
});

test("goal: timeline events append correctly", async () => {
  await withFreshDb(async (dbPath) => {
    await core.initDb(dbPath);
    const { profileId, projectId } = await createProfileAndProject(dbPath);
    const goalId = await core.pmCreateGoal(profileId, projectId, "T", "O");
    await core.pmAppendGoalEvent(profileId, goalId, "Note 1", JSON.stringify({ k: 1 }));
    await core.pmAppendGoalEvent(profileId, goalId, "Note 2", null);
    await core.pmTransitionGoal(profileId, goalId, "starting", null, null);
    const events = await core.pmListGoalEvents(profileId, goalId, 50);
    // Should have at least: created, Note 1, Note 2, state_changed (starting).
    assert.ok(events.length >= 4, `expected >=4 events, got ${events.length}`);
    // Newest-first: state_changed is at the top.
    const top = events[0];
    assert.equal(top.event, "state_changed");
    // Find the created event.
    const created = events.find((e) => e.event === "created");
    assert.ok(created);
    assert.ok(/Goal created/.test(created.message));
  });
});

test("goal: idempotent transitions allowed (running -> running)", async () => {
  await withFreshDb(async (dbPath) => {
    await core.initDb(dbPath);
    const { profileId, projectId } = await createProfileAndProject(dbPath);
    const goalId = await core.pmCreateGoal(profileId, projectId, "T", "O");
    await core.pmTransitionGoal(profileId, goalId, "starting", null, null);
    await core.pmTransitionGoal(profileId, goalId, "running", null, null);
    // Idempotent (same state -> same state) is allowed.
    await core.pmTransitionGoal(profileId, goalId, "running", null, null);
    const g = await core.pmGetGoal(profileId, goalId);
    assert.equal(g.state, "running");
  });
});

test("goal: completed_at is set on terminal transition", async () => {
  await withFreshDb(async (dbPath) => {
    await core.initDb(dbPath);
    const { profileId, projectId } = await createProfileAndProject(dbPath);
    const goalId = await core.pmCreateGoal(profileId, projectId, "T", "O");
    await core.pmTransitionGoal(profileId, goalId, "starting", null, null);
    await core.pmTransitionGoal(profileId, goalId, "running", null, null);
    let g = await core.pmGetGoal(profileId, goalId);
    assert.ok(g.completedAt == null);
    await core.pmTransitionGoal(profileId, goalId, "cancelled", "user-cancelled", null);
    g = await core.pmGetGoal(profileId, goalId);
    assert.ok(g.completedAt, "completed_at should be set");
    assert.equal(g.failureReason, "user-cancelled");
  });
});

test("goal: list filter by state", async () => {
  await withFreshDb(async (dbPath) => {
    await core.initDb(dbPath);
    const { profileId, projectId } = await createProfileAndProject(dbPath);
    const a = await core.pmCreateGoal(profileId, projectId, "A", "A");
    const b = await core.pmCreateGoal(profileId, projectId, "B", "B");
    await core.pmTransitionGoal(profileId, a, "starting", null, null);
    await core.pmTransitionGoal(profileId, a, "running", null, null);
    await core.pmTransitionGoal(profileId, a, "verifying", null, null);
    await core.pmTransitionGoal(profileId, a, "completed", null, null);

    const created = await core.pmListGoals(profileId, "created", 50);
    assert.equal(created.length, 1);
    assert.equal(created[0].id, b);

    const completed = await core.pmListGoals(profileId, "completed", 50);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].id, a);
  });
});

test("goal: unknown state filter rejected", async () => {
  await withFreshDb(async (dbPath) => {
    await core.initDb(dbPath);
    const { profileId } = await createProfileAndProject(dbPath);
    await expectThrows(
      () => core.pmListGoals(profileId, "weird", 50),
      /state must be one of/,
      "unknown state should be rejected"
    );
  });
});

test("goal: plan step count update", async () => {
  await withFreshDb(async (dbPath) => {
    await core.initDb(dbPath);
    const { profileId, projectId } = await createProfileAndProject(dbPath);
    const goalId = await core.pmCreateGoal(profileId, projectId, "T", "O");
    await core.pmUpdateGoalPlanStepCount(profileId, goalId, 5);
    const g = await core.pmGetGoal(profileId, goalId);
    assert.equal(g.planStepCount, 5);
  });
});

test("goal: events are deleted on goal delete", async () => {
  await withFreshDb(async (dbPath) => {
    await core.initDb(dbPath);
    const { profileId, projectId } = await createProfileAndProject(dbPath);
    const goalId = await core.pmCreateGoal(profileId, projectId, "T", "O");
    await core.pmAppendGoalEvent(profileId, goalId, "Note", null);
    let events = await core.pmListGoalEvents(profileId, goalId, 50);
    assert.ok(events.length >= 2);
    await core.pmDeleteGoal(profileId, goalId);
    // pm_list_goal_events refuses after delete because ownership is gone.
    await expectThrows(() => core.pmListGoalEvents(profileId, goalId, 50), /Goal not found/, "events should be inaccessible after delete");
  });
});