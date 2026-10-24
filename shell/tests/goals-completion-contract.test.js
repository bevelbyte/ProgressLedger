// Goal Mode — Completion contract adversarial tests.
//
// Phase 15 audit. These tests verify that the goal engine's
// completion contract cannot be bypassed by an agent that emits
// self-reports without actually reaching the terminal state, and
// that inconsistent goal/agent states are reconciled to a truthful
// terminal.
//
// Persistence uses the real Rust/NAPI core (real SQLite).

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
const core = requireCJS(path.join(REPO_ROOT, "core", "progress_ledger_core.win32-x64-msvc.node"));

const suiteTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "goals-contract-suite-"));
const suiteDbPath = path.join(suiteTmpDir, "suite.db");
let suiteInited = false;
let counter = 0;

async function ensureSuite() {
  if (!suiteInited) {
    await core.initDb(suiteDbPath);
    suiteInited = true;
  }
}

async function withFreshState(fn) {
  await ensureSuite();
  counter += 1;
  return await fn(counter);
}

async function newProfileAndProject() {
  const a = await core.addProfile("Contract", `c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const profileId = a.id;
  const projectId = await core.pmCreateProject(
    profileId,
    "Contract Project",
    "Test project for completion contract tests",
    path.dirname(suiteDbPath),
    "{}"
  );
  return { profileId, projectId };
}

async function setGoalState(profileId, goalId, state, reason = "") {
  // Walk the state machine forward. The NAPI refuses invalid
  // transitions, so we drive each one explicitly.
  const path = {
    created: ["starting"],
    starting: ["running"],
    running: ["verifying", "failed", "cancelled", "completed"],
    verifying: ["completed", "failed", "cancelled"],
  };
  const target = state;
  // Simple BFS over the path from current state to target.
  const current = await core.pmGetGoal(profileId, goalId);
  if (current.state === target) return;
  if (target === "completed" || target === "failed" || target === "cancelled") {
    // Drive through starting -> running -> verifying -> target.
    if (current.state === "created") {
      await core.pmTransitionGoal(profileId, goalId, "starting", null, null);
    }
    const afterStart = await core.pmGetGoal(profileId, goalId);
    if (afterStart.state === "starting") {
      await core.pmTransitionGoal(profileId, goalId, "running", null, null);
    }
    if (target === "cancelled") {
      await core.pmTransitionGoal(profileId, goalId, "cancelled", reason || "test", null);
    } else {
      const afterRun = await core.pmGetGoal(profileId, goalId);
      if (afterRun.state === "running" && (target === "completed" || target === "failed")) {
        await core.pmTransitionGoal(profileId, goalId, "verifying", null, null);
      }
      await core.pmTransitionGoal(profileId, goalId, target, reason || null, null);
    }
  } else if (target === "running") {
    if (current.state === "created") {
      await core.pmTransitionGoal(profileId, goalId, "starting", null, null);
    }
    const afterStart = await core.pmGetGoal(profileId, goalId);
    if (afterStart.state === "starting") {
      await core.pmTransitionGoal(profileId, goalId, "running", null, null);
    }
  }
}

test("ADVERSARIAL-1: model self-report cannot mark a goal completed", async () => {
  // Even if the model's last assistant message says "done", the goal
  // engine requires the linked agent to reach state=completed. We
  // simulate this by appending a fake "result" assistant message
  // while the agent is still in planning phase.
  await withFreshState(async () => {
    const { profileId, projectId } = await newProfileAndProject();
    const agentId = await core.pmCreateAgent(projectId, "Do the thing");
    await core.pmUpdateAgent(profileId, agentId, "planning", "[]", 10, 20);
    const goalId = await core.pmCreateGoal(profileId, projectId, "T", "O");
    await core.pmLinkGoalAgent(profileId, goalId, agentId);
    await setGoalState(profileId, goalId, "running");
    // "Model" emits a final assistant message claiming completion.
    await core.pmAppendMessage(profileId, agentId, "assistant", "I'm done. The refactor is complete.", null, null);
    // Goal engine's observer sees agent.state = planning (NOT completed)
    // and must NOT move the goal.
    const g = await core.pmGetGoal(profileId, goalId);
    assert.equal(g.state, "running", "model self-report must NOT mark goal completed");
    assert.equal(g.linkedAgentId, agentId);
    // For good measure, ensure the engine's reconcile function keeps
    // the goal in 'running' because the agent isn't terminal.
    const { reconcileGoalsForProfile } = await import(
      "../src/services/goals/engine.js"
    );
    await reconcileGoalsForProfile({ core, profileId });
    const g2 = await core.pmGetGoal(profileId, goalId);
    assert.equal(g2.state, "running");
  });
});

test("ADVERSARIAL-2: agent completed but verification failed -> goal = failed", async () => {
  await withFreshState(async () => {
    const { profileId, projectId } = await newProfileAndProject();
    const goalId = await core.pmCreateGoal(
      profileId, projectId, "T", "O", "code_change", "normal", true
    );
    const agentId = await core.pmCreateAgent(projectId, "X");
    await core.pmLinkGoalAgent(profileId, goalId, agentId);
    // Drive the agent through planning -> verifying -> failed (Phase 12
    // verify-gate contract: if verify fails the agent is failed).
    await core.pmUpdateAgent(profileId, agentId, "verifying", "[]", 100, 200);
    await core.pmUpdateAgent(profileId, agentId, "failed", "[]", 100, 200);
    await core.pmFinishAgent(profileId, agentId, "failed");
    // Append a status message carrying the failure reason — the
    // engine reads this for the goal's failure_reason field.
    await core.pmAppendMessage(profileId, agentId, "status", "verify-failed: tests timed out", "verify", null);
    // Drive the goal to running.
    await setGoalState(profileId, goalId, "running");
    const { reconcileGoalsForProfile } = await import(
      "../src/services/goals/engine.js"
    );
    const r = await reconcileGoalsForProfile({ core, profileId });
    const g = await core.pmGetGoal(profileId, goalId);
    assert.equal(g.state, "failed", "verification-failed agent must propagate to goal");
    assert.ok(g.failureReason.length > 0, "failure_reason must be recorded");
  });
});

test("ADVERSARIAL-3: verification passes but agent failed -> goal = failed (not completed)", async () => {
  // If an agent somehow ends up failed while a 'verifying' status message
  // exists in the transcript, the goal must NOT be completed. The
  // completion contract is grounded in agent.state, not transcript text.
  await withFreshState(async () => {
    const { profileId, projectId } = await newProfileAndProject();
    const goalId = await core.pmCreateGoal(
      profileId, projectId, "T", "O", "code_change", "normal", true
    );
    const agentId = await core.pmCreateAgent(projectId, "X");
    await core.pmLinkGoalAgent(profileId, goalId, agentId);
    // Append a "verifying -> passed" status message.
    await core.pmAppendMessage(profileId, agentId, "status", "verify passed", "verify", null);
    // Then the agent is marked failed.
    await core.pmFinishAgent(profileId, agentId, "failed");
    await setGoalState(profileId, goalId, "running");
    const { reconcileGoalsForProfile } = await import(
      "../src/services/goals/engine.js"
    );
    await reconcileGoalsForProfile({ core, profileId });
    const g = await core.pmGetGoal(profileId, goalId);
    assert.equal(g.state, "failed", "agent.failed must win over a verify-passed transcript");
  });
});

test("ADVERSARIAL-4: cancellation after apparent completion is final", async () => {
  await withFreshState(async () => {
    const { profileId, projectId } = await newProfileAndProject();
    const goalId = await core.pmCreateGoal(profileId, projectId, "T", "O");
    const agentId = await core.pmCreateAgent(projectId, "X");
    await core.pmLinkGoalAgent(profileId, goalId, agentId);
    // Drive the goal to running then cancel it.
    await setGoalState(profileId, goalId, "running");
    await setGoalState(profileId, goalId, "cancelled", "user-cancel");
    // Now suppose the agent loop happens to reach 'completed' AFTER
    // the goal was cancelled. The cancel should NOT be re-stamped.
    await core.pmFinishAgent(profileId, agentId, "completed");
    const { reconcileGoalsForProfile } = await import(
      "../src/services/goals/engine.js"
    );
    await reconcileGoalsForProfile({ core, profileId });
    const g = await core.pmGetGoal(profileId, goalId);
    assert.equal(g.state, "cancelled", "cancel must remain terminal after agent completes later");
    // completed_at must not be re-stamped.
    const before = g.completedAt;
    await new Promise((r) => setTimeout(r, 5));
    await reconcileGoalsForProfile({ core, profileId });
    const g2 = await core.pmGetGoal(profileId, goalId);
    assert.equal(g2.state, "cancelled");
    assert.equal(g2.completedAt, before, "completed_at must not be re-stamped");
  });
});

test("ADVERSARIAL-5: stale goal state — agent already terminal before goal start", async () => {
  await withFreshState(async () => {
    const { profileId, projectId } = await newProfileAndProject();
    // Create an agent and finish it BEFORE the goal exists.
    const agentId = await core.pmCreateAgent(projectId, "X");
    await core.pmUpdateAgent(profileId, agentId, "verifying", "[]", 0, 0);
    await core.pmFinishAgent(profileId, agentId, "completed");
    // Now create a goal and link it to the already-completed agent.
    const goalId = await core.pmCreateGoal(profileId, projectId, "T", "O");
    await core.pmLinkGoalAgent(profileId, goalId, agentId);
    await setGoalState(profileId, goalId, "running");
    const { reconcileGoalsForProfile } = await import(
      "../src/services/goals/engine.js"
    );
    await reconcileGoalsForProfile({ core, profileId });
    const g = await core.pmGetGoal(profileId, goalId);
    assert.equal(g.state, "completed", "stale-agent-already-completed must map to goal completed");
    assert.ok(g.completedAt, "completed_at must be set");
  });
});

test("ADVERSARIAL-6: goal completion requires agent + (verify if required)", async () => {
  // Phase 15 explicit completion contract:
  //   code_change: agent.completed AND verify-passed
  //   research:    agent.completed (no verify required)
  //   analysis:    agent.completed (no verify required)
  //
  // We exercise the research vs code_change distinction.

  await withFreshState(async () => {
    const { profileId, projectId } = await newProfileAndProject();
    // research goal — agent completes -> goal completes immediately.
    const goalR = await core.pmCreateGoal(profileId, projectId, "R", "O", "research", "normal", false);
    const agentR = await core.pmCreateAgent(projectId, "research");
    await core.pmLinkGoalAgent(profileId, goalR, agentR);
    await setGoalState(profileId, goalR, "running");
    await core.pmFinishAgent(profileId, agentR, "completed");
    const { reconcileGoalsForProfile } = await import("../src/services/goals/engine.js");
    await reconcileGoalsForProfile({ core, profileId });
    const gR = await core.pmGetGoal(profileId, goalR);
    assert.equal(gR.state, "completed");
    // code_change goal — agent completed but the engine DOES NOT
    // auto-complete because verify_required is set; the agent loop
    // already moved through verifying (which the engine sees via the
    // agent.state mirror). To simulate the verify path, set the agent
    // state to verifying first, then to completed.
    const goalC = await core.pmCreateGoal(profileId, projectId, "C", "O", "code_change", "normal", true);
    const agentC = await core.pmCreateAgent(projectId, "code");
    await core.pmLinkGoalAgent(profileId, goalC, agentC);
    await setGoalState(profileId, goalC, "running");
    await core.pmUpdateAgent(profileId, agentC, "verifying", "[]", 0, 0);
    await core.pmUpdateAgent(profileId, agentC, "completed", "[]", 0, 0);
    await core.pmFinishAgent(profileId, agentC, "completed");
    await reconcileGoalsForProfile({ core, profileId });
    const gC = await core.pmGetGoal(profileId, goalC);
    assert.equal(gC.state, "completed");
  });
});

test.after(async () => {
  try { fs.rmSync(suiteTmpDir, { recursive: true, force: true }); } catch (_e) {}
});