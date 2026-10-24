// Project Mode — agent resume persistence tests.
//
// Covers the long-running persistence + resume contract:
//   1. resumeAgent refuses a terminal state (completed) with reason
//      `terminal-state`.
//   2. resumeAgent refuses when a loop is already active for the agent.
//   3. resumeAgent on a mid-run persisted state (state = "planning")
//      succeeds and returns a fresh runId + bus.
//   4. The resumed run emits an `agent.resumed` event with the
//      persisted plan step count.
//   5. After resume, the loop continues from the persisted plan_json
//      (not from an empty / freshly-built plan) and the original step
//      statuses survive the resume.
//
// The loop runs to a terminal state for tests 3-5 (using a no-op
// verification gate — no test_command), so we wait on the bus. The
// Memory module's userDataDir is pointed at a temp dir to avoid
// touching the real on-disk DB.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  startAgent,
  resumeAgent,
  AGENT_EVENTS,
  STATES,
  getRun,
} from "../src/services/agent/loop.js";
import { scriptedProvider } from "../src/services/agent/fixture.js";
import { parsePlan } from "../src/services/agent/plan.js";
import { _setUserDataDir, _closeAll } from "../src/services/memory/index.js";

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

// Module-level counter so multiple fakeCore() instances produce
// distinct agent ids. Without this, every test creates agent id 1000
// and they collide in the module-scope RUNS map of loop.js.
let nextAgentIdSeq = 10_000;

function makeFakeCore() {
  const agents = new Map();
  const core = {
    pmCreateAgent(projectId, objective) {
      const id = nextAgentIdSeq++;
      agents.set(id, {
        id,
        project_id: projectId,
        objective,
        state: STATES.IDLE,
        plan_json: "[]",
        tokens_in: 0,
        tokens_out: 0,
        finished_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        parent_agent_id: null,
      });
      return { id };
    },
    pmGetAgent(_profileId, agentId) {
      const a = agents.get(agentId);
      if (!a) return null;
      return { ...a };
    },
    pmUpdateAgent(_profileId, agentId, state, planJson, tokensIn, tokensOut) {
      const a = agents.get(agentId);
      if (!a) return { ok: false, error: { code: "not-found" } };
      a.state = state;
      a.plan_json = planJson;
      a.tokens_in = tokensIn;
      a.tokens_out = tokensOut;
      a.updated_at = new Date().toISOString();
      return { ok: true };
    },
    pmAppendMessage(_profileId, _agentId, _role, _content, _name, _payloadJson) {
      return { seq: 1 };
    },
    pmFinishAgent(_profileId, agentId, state) {
      const a = agents.get(agentId);
      if (!a) return;
      a.state = state;
      a.finished_at = new Date().toISOString();
    },
    pmGetProject(_profileId, _projectId) {
      // No test_command → verify.js treats this as "no test configured"
      // and trivially passes. The verification gate therefore does not
      // run a subprocess and the loop reaches `completed`.
      return {
        id: 10,
        profile_id: 1,
        name: "Resume fixture project",
        description: "deterministic resume test",
        root_path: "/tmp/resume",
        config_json: "{}",
        created_at: "1970-01-01T00:00:00Z",
        updated_at: "1970-01-01T00:00:00Z",
      };
    },
    _agents: agents,
  };
  return core;
}

// Scripted provider that returns "stop" with no tool calls on every
// invocation. The loop will therefore:
//   - mark whichever step pickNextStep returned as `done` on no-tool
//     rounds, OR
//   - treat it as a "model gave up" round (no active step)
// and the verification gate (no test_command) trivially passes.
function stopOnlyProvider() {
  return scriptedProvider([
    { text: "ok", finishReason: "stop" },
    { text: "ok", finishReason: "stop" },
    { text: "ok", finishReason: "stop" },
    { text: "ok", finishReason: "stop" },
    { text: "ok", finishReason: "stop" },
    { text: "ok", finishReason: "stop" },
    { text: "ok", finishReason: "stop" },
    { text: "ok", finishReason: "stop" },
  ]);
}

function waitForTerminal(bus) {
  return new Promise((resolve) => {
    bus.on(AGENT_EVENTS.AGENT_COMPLETED, (e) => resolve({ kind: "completed", payload: e.payload }));
    bus.on(AGENT_EVENTS.AGENT_FAILED, (e) => resolve({ kind: "failed", payload: e.payload }));
    bus.on(AGENT_EVENTS.AGENT_CANCELLED, () => resolve({ kind: "cancelled" }));
  });
}

// Wait for the module-scope RUNS registry to clear an agent entry.
// `bus` events fire from finishAgent BEFORE the loop's `finally`
// block deletes from RUNS; tests that want to start a fresh run for
// the same agentId must wait for the teardown to finish.
async function waitForRunCleared(agentId, { timeoutMs = 2000 } = {}) {
  const start = Date.now();
  while (getRun(agentId) !== null) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

function withTempUserData(fn) {
  const dir = mkdtempSync(join(tmpdir(), "cf-agent-resume-"));
  _setUserDataDir(dir);
  return Promise.resolve(fn()).finally(() => {
    try { _closeAll(); } catch (_e) { /* best effort */ }
    try { _setUserDataDir(null); } catch (_e) { /* best effort */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });
}

// Seed a 3-step mid-run plan into a persisted agent. step-1 is done,
// step-2 is running, step-3 is pending. This mirrors the "agent was
// killed mid-loop" scenario.
function seedMidRunPlan(core, agentId) {
  const plan = {
    version: 1,
    steps: [
      { id: "step-1", title: "Understand",    status: "done",    depends_on: [],         files: [], assigned_to: null },
      { id: "step-2", title: "Implement",    status: "running", depends_on: ["step-1"], files: [], assigned_to: null },
      { id: "step-3", title: "Test",         status: "pending", depends_on: ["step-2"], files: [], assigned_to: null },
    ],
  };
  core.pmUpdateAgent(1, agentId, STATES.PLANNING, JSON.stringify(plan), 0, 0);
  return plan;
}

// ---------------------------------------------------------------------------
// 1. terminal-state refusal
// ---------------------------------------------------------------------------

test("resumeAgent: refuses a terminal (completed) state with reason 'terminal-state'", async () => {
  await withTempUserData(async () => {
    const core = makeFakeCore();
    const { id: agentId } = core.pmCreateAgent(10, "completed-task");
    core.pmUpdateAgent(1, agentId, STATES.COMPLETED, "[]", 0, 0);
    core.pmFinishAgent(1, agentId, STATES.COMPLETED);

    const res = await resumeAgent({ core, profileId: 1, agentId });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "terminal-state");
    assert.equal(getRun(agentId), null, "no run should have been started");
  });
});

// ---------------------------------------------------------------------------
// 2. already-running refusal
// ---------------------------------------------------------------------------

test("resumeAgent: refuses an already-running agent with reason 'already-running'", async () => {
  await withTempUserData(async () => {
    const core = makeFakeCore();
    const { id: agentId } = core.pmCreateAgent(10, "running-task");
    // Use a 1-step plan so the loop completes quickly and we can then
    // start a fresh run for the duplicate-resume assertion.
    core.pmUpdateAgent(1, agentId, STATES.PLANNING, JSON.stringify({
      version: 1,
      steps: [{ id: "step-1", title: "single", status: "pending", depends_on: [], files: [], assigned_to: null }],
    }), 0, 0);

    const startRes = await startAgent({
      core, profileId: 1, agentId, provider: stopOnlyProvider(),
    });
    assert.equal(startRes.ok, true, "first startAgent should succeed");
    const firstRunId = startRes.runId;
    const firstBus = startRes.bus;
    await waitForTerminal(firstBus);
    // The bus emits AGENT_COMPLETED from finishAgent BEFORE the loop's
    // finally block deletes from RUNS. Wait for the teardown so the
    // second startAgent can claim the slot.
    assert.equal(await waitForRunCleared(agentId), true, "RUNS must clear after the first run terminates");
    // The persisted state is now COMPLETED. Reset it back to PLANNING
    // so a second startAgent is accepted (we are simulating a user who
    // wants to re-run the agent; in production they would create a new
    // agent).
    core.pmUpdateAgent(1, agentId, STATES.PLANNING, JSON.stringify({
      version: 1,
      steps: [{ id: "step-1", title: "single", status: "pending", depends_on: [], files: [], assigned_to: null }],
    }), 0, 0);

    // Now run again, then attempt a duplicate resume before the second
    // run completes.
    const startRes2 = await startAgent({
      core, profileId: 1, agentId, provider: stopOnlyProvider(),
    });
    assert.equal(startRes2.ok, true, `second startAgent should succeed, got ${JSON.stringify(startRes2)}`);
    const secondRunId = startRes2.runId;

    const res = await resumeAgent({ core, profileId: 1, agentId });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "already-running");
    assert.equal(res.runId, secondRunId, "must report the existing runId, not a new one");
    assert.notEqual(secondRunId, firstRunId, "second run must have a fresh runId");

    // Drain so the test exits.
    await waitForTerminal(startRes2.bus);
  });
});

// ---------------------------------------------------------------------------
// 3. resume on a mid-run planning state succeeds
// ---------------------------------------------------------------------------

test("resumeAgent: on a mid-run persisted state (planning) succeeds and returns a fresh runId", async () => {
  await withTempUserData(async () => {
    const core = makeFakeCore();
    const { id: agentId } = core.pmCreateAgent(10, "mid-run-task");
    seedMidRunPlan(core, agentId);

    const res = await resumeAgent({ core, profileId: 1, agentId });
    assert.equal(res.ok, true, `expected ok:true, got ${JSON.stringify(res)}`);
    assert.ok(typeof res.runId === "string" && res.runId.length > 0, "runId must be a non-empty string");
    assert.ok(res.bus && typeof res.bus.on === "function", "bus must be an AgentEventBus");
    // A fresh runId (not derived from any prior value).
    assert.match(res.runId, /^[a-z0-9]+$/, "runId must be alphanumeric (shortUuid)");

    // Drain so the test exits.
    await waitForTerminal(res.bus);
  });
});

// ---------------------------------------------------------------------------
// 4. agent.resumed event emitted with plan step count
// ---------------------------------------------------------------------------

test("resumeAgent: the resumed run emits an agent.resumed event with the persisted plan step count", async () => {
  await withTempUserData(async () => {
    const core = makeFakeCore();
    const { id: agentId } = core.pmCreateAgent(10, "emit-resumed-event");
    seedMidRunPlan(core, agentId);

    const res = await resumeAgent({ core, profileId: 1, agentId });
    assert.equal(res.ok, true);

    // The event is emitted synchronously inside startAgent, BEFORE
    // resumeAgent returns. The bus ring buffer retains it.
    const fromBus = res.bus.recent().filter((e) => e.type === AGENT_EVENTS.AGENT_RESUMED);
    assert.equal(fromBus.length, 1, `expected exactly one agent.resumed event, got ${fromBus.length}`);
    const ev = fromBus[0];
    assert.equal(ev.payload.agentId, agentId, "event payload must carry agentId");
    assert.equal(ev.payload.planStepCount, 3, "event payload must carry the persisted plan step count");
    assert.ok(typeof ev.payload.runId === "string" && ev.payload.runId.length > 0, "event payload must carry the new runId");

    // Confirm a non-resume startAgent does NOT emit the event.
    const core2 = makeFakeCore();
    const created = core2.pmCreateAgent(10, "fresh-start");
    core2.pmUpdateAgent(1, created.id, STATES.PLANNING, JSON.stringify({
      version: 1,
      steps: [{ id: "step-1", title: "single", status: "pending", depends_on: [], files: [], assigned_to: null }],
    }), 0, 0);
    const freshRes = await startAgent({ core: core2, profileId: 1, agentId: created.id, provider: stopOnlyProvider() });
    assert.equal(freshRes.ok, true);
    const freshResumes = freshRes.bus.recent().filter((e) => e.type === AGENT_EVENTS.AGENT_RESUMED);
    assert.equal(freshResumes.length, 0, "non-resume startAgent must not emit agent.resumed");
    await waitForTerminal(freshRes.bus);

    // Drain the resumed run.
    await waitForTerminal(res.bus);
  });
});

// ---------------------------------------------------------------------------
// 5. resumed loop continues from persisted plan_json (not from empty plan)
// ---------------------------------------------------------------------------

test("resumeAgent: the resumed loop continues from the persisted plan_json (not an empty plan)", async () => {
  await withTempUserData(async () => {
    const core = makeFakeCore();
    const { id: agentId } = core.pmCreateAgent(10, "continue-from-persisted-plan");
    const seeded = seedMidRunPlan(core, agentId);

    const res = await resumeAgent({ core, profileId: 1, agentId });
    assert.equal(res.ok, true);

    const terminal = await waitForTerminal(res.bus);
    // With no test_command and a 3-step plan, the loop must reach
    // completed (not stall or fail).
    assert.equal(terminal.kind, "completed", `expected completed, got ${terminal.kind} ${JSON.stringify(terminal.payload)}`);

    // The persisted plan must NOT have been replaced by buildInitialPlan
    // (which would yield a 1-step plan). parsePlan of the seeded JSON
    // has 3 steps; if the loop cleared it, steps.length would be 0 or 1.
    const a = core._agents.get(agentId);
    const planAfter = parsePlan(a.plan_json);
    assert.equal(
      planAfter.steps.length,
      3,
      `resumed loop must preserve the 3-step persisted plan, got ${planAfter.steps.length} steps: ${JSON.stringify(planAfter)}`,
    );
    // Step ids must match the seeded plan — proves the loop read the
    // persisted plan_json (not a freshly-built one).
    assert.deepEqual(
      planAfter.steps.map((s) => s.id),
      seeded.steps.map((s) => s.id),
      "step ids must match the persisted plan",
    );
    // The loop never regresses: step-1 must remain `done`.
    const step1 = planAfter.steps.find((s) => s.id === "step-1");
    assert.ok(step1, "step-1 must still exist after resume");
    assert.equal(step1.status, "done", "step-1 must remain `done` across resume");
    // The plan reaches a terminal state (every step done | failed | skipped).
    const allTerminal = planAfter.steps.every((s) => s.status === "done" || s.status === "failed" || s.status === "skipped");
    assert.equal(allTerminal, true, "all steps must be in a terminal status after resume completes");
  });
});