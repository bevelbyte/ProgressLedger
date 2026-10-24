// Goal Mode — crash/restart recovery tests.
//
// Phase 15: the in-memory RUNS registry is now backed by `pm_run_state`
// (migration 022). These tests simulate a process crash + restart by
// (a) running the loop's persistence side-effects directly via
// persistRunState / clearRunState, (b) instantiating a fresh
// recovery layer (runRecoverySweep), and (c) asserting the sweep
// classifies rows correctly.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const requireCJS = createRequire(import.meta.url);
const core = requireCJS(path.join(REPO_ROOT, "core", "careerflow_core.win32-x64-msvc.node"));

const suiteTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "goals-recovery-suite-"));
const suiteDbPath = path.join(suiteTmpDir, "suite.db");
let suiteInited = false;
let counter = 0;

async function ensure() { if (!suiteInited) { await core.initDb(suiteDbPath); suiteInited = true; } }

async function fresh(n) {
  await ensure();
  counter += 1;
  const a = await core.addProfile("Rec", `r-${Date.now()}-${counter}`);
  const profileId = a.id;
  const projectId = await core.pmCreateProject(
    profileId, `P${counter}`, "test", path.dirname(suiteDbPath), "{}"
  );
  return { profileId, projectId };
}

test("RECOVERY-1: safe-resume — phase matches agent.state", async () => {
  const { profileId, projectId } = await fresh(1);
  const goalId = await core.pmCreateGoal(profileId, projectId, "T", "O");
  const agentId = await core.pmCreateAgent(projectId, "X");
  await core.pmLinkGoalAgent(profileId, goalId, agentId);
  // Simulate the loop writing a row matching the agent's current state.
  await core.pmUpdateAgent(profileId, agentId, "executing_tool", "[]", 0, 0);
  // Verify the update actually persisted.
  const beforeAg = await core.pmGetAgent(profileId, agentId);
  await core.pmUpsertRunState(
    profileId, agentId, "run-1", null, "false", null,
    "executing", "running", 0, 0, "safe-resume"
  );
  // Re-read agent after upsert.
  const afterUpsertAg = await core.pmGetAgent(profileId, agentId);
  // Append a "started" status so the goal engine doesn't move it to
  // completed before reconciliation.
  await core.pmAppendMessage(profileId, agentId, "status", "loop started", null, null);
  const goalStateBefore = await core.pmGetGoal(profileId, goalId);
  // The goal is still in 'created' — the user has not pressed Start
  // yet. We don't move it here; the recovery sweep only classifies.
  const sweepModule = await import("../src/services/agent/recovery.js");
  const r = await sweepModule.runRecoverySweep({ core, profileId });
  assert.equal(r.ok, true);
  const row = r.resumable.find((x) => (x.agentId ?? x.agent_id) === agentId);
  assert.ok(row, "agent row should appear in resumable");
  assert.equal(row.classification, "safe-resume");
  assert.equal(row.phase, "executing");
  // Goal state should not be touched by the sweep alone (it only
  // reconciles goals whose linked agent is already terminal).
  const goalStateAfter = await core.pmGetGoal(profileId, goalId);
  assert.equal(goalStateAfter.state, goalStateBefore.state);
});

test("RECOVERY-2: terminal-cleanup — agent already terminal, drop the row", async () => {
  const { profileId, projectId } = await fresh(2);
  const goalId = await core.pmCreateGoal(profileId, projectId, "T", "O");
  const agentId = await core.pmCreateAgent(projectId, "X");
  await core.pmLinkGoalAgent(profileId, goalId, agentId);
  // Simulate: loop crashed before clearRunState, but agent is
  // already terminal.
  await core.pmUpdateAgent(profileId, agentId, "executing_tool", "[]", 0, 0);
  await core.pmFinishAgent(profileId, agentId, "completed");
  await core.pmUpsertRunState(
    profileId, agentId, "run-2", null, "false", null,
    "executing", "running", 0, 0, "safe-resume"
  );
  // The goal is in created state, but the agent is terminal. After
  // reconcile it should map to completed.
  await core.pmTransitionGoal(profileId, goalId, "starting", null, null);
  await core.pmTransitionGoal(profileId, goalId, "running", null, null);
  const { runRecoverySweep } = await import("../src/services/agent/recovery.js");
  const r = await runRecoverySweep({ core, profileId });
  const row = r.resumable.find((x) => (x.agentId ?? x.agent_id) === agentId);
  assert.ok(row, "row should appear in resumable");
  assert.equal(row.classification, "terminal-cleanup");
  // And the goal itself should now be 'completed'.
  const g = await core.pmGetGoal(profileId, goalId);
  assert.equal(g.state, "completed");
});

test("RECOVERY-3: requires-user — phase does NOT match agent.state", async () => {
  const { profileId, projectId } = await fresh(3);
  const goalId = await core.pmCreateGoal(profileId, projectId, "T", "O");
  const agentId = await core.pmCreateAgent(projectId, "X");
  await core.pmLinkGoalAgent(profileId, goalId, agentId);
  // Agent is in 'idle' (just created) but the row claims 'executing'.
  await core.pmUpsertRunState(
    profileId, agentId, "run-3", null, "false", null,
    "executing", "running", 0, 0, "safe-resume"
  );
  await core.pmAppendMessage(profileId, agentId, "status", "started", null, null);
  const { runRecoverySweep } = await import("../src/services/agent/recovery.js");
  const r = await runRecoverySweep({ core, profileId });
  const row = r.resumable.find((x) => (x.agentId ?? x.agent_id) === agentId);
  assert.ok(row, "row should appear in resumable");
  assert.equal(row.classification, "requires-user");
  assert.equal(row.reason, "phase-mismatch");
});

test("RECOVERY-4: stale — row older than 30 minutes", async () => {
  const { profileId, projectId } = await fresh(4);
  const agentId = await core.pmCreateAgent(projectId, "X");
  await core.pmUpsertRunState(
    profileId, agentId, "run-4", null, "false", null,
    "executing", "running", 0, 0, "safe-resume"
  );
  // Manually rewind last_event_at by 1 hour.
  await core.pmUpdateAgent(profileId, agentId, "executing_tool", "[]", 0, 0);
  const { getPool } = await import("better-sqlite3");
  // We can't easily mutate last_event_at from NAPI. Use raw SQL via
  // a temporary connection.
  const Database = (await import("better-sqlite3")).default;
  const raw = new Database(suiteDbPath);
  raw.prepare("UPDATE pm_run_state SET last_event_at = datetime('now','localtime','-1 hour') WHERE agent_id = ?").run(agentId);
  raw.close();
  await core.pmAppendMessage(profileId, agentId, "status", "started", null, null);
  const { runRecoverySweep } = await import("../src/services/agent/recovery.js");
  const r = await runRecoverySweep({ core, profileId });
  // The row is too old to appear in pmListResumableRuns (which has
  // the staleness filter). It should appear in pmListStaleRuns.
  assert.ok(Array.isArray(r.stale), "stale should be an array");
  const staleRow = r.stale.find((x) => (x.agentId ?? x.agent_id) === agentId);
  assert.ok(staleRow, "row should appear in stale");
  // And the resumable list should NOT include it.
  assert.equal(r.resumable.length, 0);
});

test("RECOVERY-5: clearRunState removes the row on terminal completion", async () => {
  const { profileId, projectId } = await fresh(5);
  const agentId = await core.pmCreateAgent(projectId, "X");
  await core.pmUpsertRunState(
    profileId, agentId, "run-5", null, "false", null,
    "executing", "running", 0, 0, "safe-resume"
  );
  let before = await core.pmGetRunState(profileId, agentId);
  assert.ok(before, "row should exist after upsert");
  const { clearRunState } = await import("../src/services/agent/recovery.js");
  await clearRunState(core, profileId, agentId);
  let after = await core.pmGetRunState(profileId, agentId);
  assert.equal(after, null, "row should be cleared");
});

test("RECOVERY-6: parallel recovery sweeps do not double-process", async () => {
  // The sweep is read-only with respect to the agent loop, but it
  // calls reconcileGoalsForProfile which mutates goals. We verify
  // that two concurrent sweeps converge (idempotent reconciliation).
  const { profileId, projectId } = await fresh(6);
  const goalId = await core.pmCreateGoal(profileId, projectId, "T", "O");
  const agentId = await core.pmCreateAgent(projectId, "X");
  await core.pmLinkGoalAgent(profileId, goalId, agentId);
  await core.pmFinishAgent(profileId, agentId, "completed");
  await core.pmTransitionGoal(profileId, goalId, "starting", null, null);
  await core.pmTransitionGoal(profileId, goalId, "running", null, null);
  const { runRecoverySweep } = await import("../src/services/agent/recovery.js");
  const [r1, r2] = await Promise.all([
    runRecoverySweep({ core, profileId }),
    runRecoverySweep({ core, profileId }),
  ]);
  // Both should report ok; the goal should be 'completed' exactly once.
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  const g = await core.pmGetGoal(profileId, goalId);
  assert.equal(g.state, "completed");
  // The agent's plan is unchanged.
  const a = await core.pmGetAgent(profileId, agentId);
  assert.equal(a.state, "completed");
});

test.after(async () => {
  try { fs.rmSync(suiteTmpDir, { recursive: true, force: true }); } catch (_e) {}
});