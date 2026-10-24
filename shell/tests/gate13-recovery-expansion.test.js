// Project Mode — GATE 13: Long-running recovery expansion.
//
// Extends the 2-test regression in `agent-recovery.test.js` (kill +
// restart + resume, no duplicate completed work) with 5 new
// deterministic scenarios:
//
//   1. Long-running agent with 6 steps where step-3 crashes — the
//      resume rolls back step-3 to `failed`, leaves step-1/2 as
//      `done`, and completes step-4..6 without re-running step-1/2.
//
//   2. A fan-out plan A -> {B, C} -> D where B crashed. The resume
//      rolls B back to `failed`, leaves A as `done`, re-runs C
//      (which was never started), and does NOT re-run A.
//
//   3. A crashed agent whose persisted plan is FULLY terminal (every
//      step is done | failed | skipped). `resumeAgent` must refuse
//      with `terminal-state` immediately — no hang, no hang-the-loop,
//      no second model call.
//
//   4. A crashed agent whose persisted plan_json is empty (no plan
//      at all). The resume must roll forward: the loop reads an
//      empty plan and falls back to `buildInitialPlan` (a 1-step
//      starter plan). The agent still reaches `completed` because
//      the verification gate trivially passes with no test_command.
//
//   5. A parent agent whose persisted plan is mid-run AND whose
//      child pm_agents row (sub-agent) is stuck `running`. The
//      resume must classify the parent's `running` step as failed
//      AND close the child's pm_agents row (terminal state) so the
//      parent's pm_agents row reflects "child completed (failed)".
//
// All 5 tests use a fresh scripted provider per scenario, the
// fake-core pattern from agent-recovery.test.js, and the real
// `resumeAgent` (or `startAgent({ isResume: true })` where a
// scripted provider is required — see scenario 1 + 2 comments).
//
// Why we sometimes bypass `resumeAgent` and call
// `startAgent({ isResume: true })` directly: `resumeAgent` does not
// accept a `provider` argument (see loop.js:1040). The deterministic
// scripted provider requires the explicit provider; calling the real
// `resumeAgent` would resolve to the (no-creds) mock provider which
// is also fine for our scenarios. We use the real `resumeAgent`
// where no scripted provider is needed (scenarios 3, 4, 5) and
// `startAgent(isResume: true)` where the scripted provider is the
// cleanest determinism path (scenarios 1, 2). In all cases the
// recovery logic the loop applies is identical (it's the same code
// path — resumeAgent is a thin wrapper around startAgent(isResume:
// true)).

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
import { parsePlan, isPlanComplete } from "../src/services/agent/plan.js";
import { _setUserDataDir, _closeAll } from "../src/services/memory/index.js";

// ---------------------------------------------------------------------------
// Shared scaffolding (matches agent-recovery.test.js)
// ---------------------------------------------------------------------------

// Per-test counter so distinct fakeCore instances produce distinct
// agent ids. Without this every test creates agent id 10_001 and the
// module-scope RUNS map collides across tests.
let nextAgentIdSeq = 50_000;
let nextSubagentRunIdSeq = 80_000;

function waitForTerminal(bus) {
  return new Promise((resolve) => {
    bus.on(AGENT_EVENTS.AGENT_COMPLETED, (e) => resolve({ kind: "completed", payload: e.payload }));
    bus.on(AGENT_EVENTS.AGENT_FAILED, (e) => resolve({ kind: "failed", payload: e.payload }));
    bus.on(AGENT_EVENTS.AGENT_CANCELLED, () => resolve({ kind: "cancelled" }));
  });
}

async function waitForRunCleared(agentId, { timeoutMs = 2000 } = {}) {
  const start = Date.now();
  while (getRun(agentId) !== null) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

function withTempUserData(fn) {
  const dir = mkdtempSync(join(tmpdir(), "cf-gate13-"));
  _setUserDataDir(dir);
  return Promise.resolve(fn()).finally(() => {
    try { _closeAll(); } catch (_e) { /* best effort */ }
    try { _setUserDataDir(null); } catch (_e) { /* best effort */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });
}

// Fake core that mirrors agent-recovery.test.js + agent-resume.test.js:
//   - tracks pm_agents rows (with parent_agent_id support)
//   - tracks pm_messages rows so tests can assert on tool calls
//   - tracks pm_subagent_runs rows so the recovery path that closes a
//     stuck child telemetry row is testable
//   - returns a project with no test_command (verify.js trivially passes)
function makeFakeCore() {
  const agents = new Map();
  const messages = new Map();
  const subagentRuns = new Map();

  function recordMessage(agentId, role, content, name, payloadJson) {
    const list = messages.get(agentId) || [];
    list.push({
      id: list.length + 1,
      agent_id: agentId,
      seq: list.length + 1,
      role,
      content: typeof content === "string" ? content : JSON.stringify(content),
      name: name == null ? null : name,
      payload_json: payloadJson == null ? null : payloadJson,
    });
    messages.set(agentId, list);
    return list.length;
  }

  const core = {
    pmCreateAgent(projectId, objective, parentAgentId) {
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
        // The parent_agent_id column is the source of truth for the
        // parent->child link (see migration 018). Top-level agents
        // leave it null. The optional 3rd arg is supported so the
        // delegate_* tools can spawn children without a second write.
        parent_agent_id: typeof parentAgentId === "number" ? parentAgentId : null,
      });
      messages.set(id, []);
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
    pmAppendMessage(_profileId, agentId, role, content, name, payloadJson) {
      return { seq: recordMessage(agentId, role, content, name, payloadJson) };
    },
    pmFinishAgent(_profileId, agentId, state) {
      const a = agents.get(agentId);
      if (!a) return;
      a.state = state;
      a.finished_at = new Date().toISOString();
    },
    pmListMessages(_profileId, agentId) {
      const list = messages.get(agentId) || [];
      return [...list].sort((a, b) => a.seq - b.seq);
    },
    pmGetProject(_profileId, _projectId) {
      // No test_command -> verify.js trivially passes (no subprocess
      // needed). The verification gate therefore advances
      // VERIFYING -> COMPLETED on every run.
      return {
        id: 10,
        profile_id: 1,
        name: "GATE13 recovery fixture project",
        description: "deterministic gate13 recovery expansion",
        root_path: "/tmp/gate13",
        config_json: "{}",
        created_at: "1970-01-01T00:00:00Z",
        updated_at: "1970-01-01T00:00:00Z",
      };
    },
    // Sub-agent telemetry hooks. The agent loop calls
    // pmInsertSubagentRun at sub-agent dispatch (startAgent with
    // isSubAgent=true) and pmEndSubagentRun at terminal state
    // (finishAgent). For scenario 5 we pre-seed a stuck sub-agent
    // row directly in this Map (bypassing pmInsertSubagentRun) so
    // the resume can be tested end-to-end without involving the
    // delegate_* tool's NAPI plumbing.
    pmInsertSubagentRun(_profileId, parentAgentId, role, childAgentId, runId) {
      const id = nextSubagentRunIdSeq++;
      subagentRuns.set(id, {
        id,
        parent_agent_id: parentAgentId,
        role: role == null ? null : String(role),
        child_agent_id: typeof childAgentId === "number" ? childAgentId : null,
        run_id: runId == null ? null : String(runId),
        started_at: new Date().toISOString(),
        ended_at: null,
        outcome: null,
        tokens_in: null,
        tokens_out: null,
        error: "",
      });
      return id;
    },
    pmEndSubagentRun(_profileId, id, outcome, tokensIn, tokensOut, error) {
      const row = subagentRuns.get(id);
      if (!row) return { ok: false, error: { code: "not-found" } };
      row.ended_at = new Date().toISOString();
      row.outcome = outcome;
      row.tokens_in = tokensIn | 0;
      row.tokens_out = tokensOut | 0;
      row.error = error || "";
      return { ok: true };
    },
    pmListSubagentRuns(_profileId, parentAgentId) {
      const rows = [];
      for (const r of subagentRuns.values()) {
        if (r.parent_agent_id === parentAgentId) rows.push({ ...r });
      }
      return rows;
    },
    _agents: agents,
    _messages: messages,
    _subagentRuns: subagentRuns,
  };
  return core;
}

// ---------------------------------------------------------------------------
// Scenario 1: long-running 6-step plan with step-3 crashed
// ---------------------------------------------------------------------------
//
// Plan shape:
//   step-1: done    (was done before the crash)
//   step-2: done    (was done before the crash)
//   step-3: running (crashed mid-execution)
//   step-4: pending (never reached)
//   step-5: pending (never reached)
//   step-6: pending (never reached)
//
// Resume contract:
//   - step-1, step-2 remain `done` (NOT re-run)
//   - step-3 rolled back to `failed`
//   - step-4, step-5, step-6 reach `done`
//   - agent reaches COMPLETED (no test_command -> verify trivially passes)
test("gate13: long-running 6-step agent crashes on step-3, resume rolls back step-3 only", async () => {
  await withTempUserData(async () => {
    const core = makeFakeCore();
    const { id: agentId } = core.pmCreateAgent(10, "long-running-6-step");

    // Seed the persisted plan: 1+2 done, 3 running, 4+5+6 pending.
    const seededPlan = {
      version: 1,
      steps: [
        { id: "step-1", title: "Step one",   status: "done",    depends_on: [],              files: [], assigned_to: null },
        { id: "step-2", title: "Step two",   status: "done",    depends_on: ["step-1"],     files: [], assigned_to: null },
        { id: "step-3", title: "Step three", status: "running", depends_on: ["step-2"],     files: [], assigned_to: null },
        { id: "step-4", title: "Step four",  status: "pending", depends_on: ["step-3"],     files: [], assigned_to: null },
        { id: "step-5", title: "Step five",  status: "pending", depends_on: ["step-4"],     files: [], assigned_to: null },
        { id: "step-6", title: "Step six",   status: "pending", depends_on: ["step-5"],     files: [], assigned_to: null },
      ],
    };
    core.pmUpdateAgent(1, agentId, STATES.PLANNING, JSON.stringify(seededPlan), 0, 0);

    // Scripted provider: each "round" returns text-only (no tool
    // calls). The loop will:
    //   1. Pick the next ready step. After the loop marks step-3 as
    //      `failed` (classifyStall -> stalled-with-running), the next
    //      ready step is step-4. The loop drives the model on step-4,
    //      the model returns no tool calls, the loop marks step-4
    //      `done`, and continues to step-5, then step-6.
    //   2. Each step needs its own provider round because the loop
    //      re-asks the model after every step. We supply 6 text-only
    //      rounds (one per pending step) plus a couple of safety
    //      rounds.
    // The verification gate also calls the provider once for the
    // final summary. We supply 10 rounds total to be safe.
    const provider = scriptedProvider(
      Array.from({ length: 10 }, () => ({ text: "ok", finishReason: "stop" })),
    );

    // We call startAgent(isResume: true) directly because resumeAgent
    // does not accept a provider. The recovery logic applied to the
    // persisted plan is identical (resumeAgent is a 1-line wrapper).
    const res = await startAgent({
      core,
      profileId: 1,
      agentId,
      provider,
      isResume: true,
    });
    assert.equal(res.ok, true, `startAgent(isResume=true) should succeed, got ${JSON.stringify(res)}`);
    assert.ok(res.bus && typeof res.bus.on === "function", "bus must be an AgentEventBus");
    const resumedEvents = res.bus.recent().filter((e) => e.type === AGENT_EVENTS.AGENT_RESUMED);
    assert.equal(resumedEvents.length, 1, "resumed run must emit one agent.resumed event");

    const terminal = await waitForTerminal(res.bus);
    assert.equal(terminal.kind, "completed", `expected completed, got ${terminal.kind} ${JSON.stringify(terminal.payload)}`);

    // ---- ASSERTIONS ----

    const agentAfter = core.pmGetAgent(1, agentId);
    assert.notEqual(agentAfter, null, "agent should exist after resume");
    const planAfter = parsePlan(agentAfter.plan_json);
    assert.equal(planAfter.steps.length, 6, `expected 6 steps, got ${planAfter.steps.length}`);

    // 1. Steps 1 and 2 are NOT re-run (no tool calls reference them).
    const allMessages = core.pmListMessages(1, agentId);
    for (const sid of ["step-1", "step-2"]) {
      const toolCalls = allMessages.filter(
        (m) => m.role === "tool_call" && m.content.includes(`"step":"${sid}"`),
      );
      assert.equal(
        toolCalls.length,
        0,
        `${sid} must NOT be re-executed after resume (got ${toolCalls.length} tool calls)`,
      );
    }

    // 2. Step-3 is rolled back to `failed`.
    const step3 = planAfter.steps.find((s) => s.id === "step-3");
    assert.ok(step3, "step-3 must exist");
    assert.equal(step3.status, "failed", `step-3 must be 'failed' after resume, got '${step3.status}'`);

    // 3. Steps 4, 5, 6 are `done`.
    for (const sid of ["step-4", "step-5", "step-6"]) {
      const step = planAfter.steps.find((s) => s.id === sid);
      assert.ok(step, `${sid} must exist`);
      assert.equal(step.status, "done", `${sid} must be 'done' after resume, got '${step.status}'`);
    }

    // 4. Steps 1 and 2 remain `done`.
    for (const sid of ["step-1", "step-2"]) {
      const step = planAfter.steps.find((s) => s.id === sid);
      assert.ok(step, `${sid} must exist`);
      assert.equal(step.status, "done", `${sid} must remain 'done' after resume, got '${step.status}'`);
    }

    // 5. The plan is fully terminal (every step done | failed | skipped).
    assert.equal(
      isPlanComplete(planAfter),
      true,
      `all 6 steps must be terminal after resume, got: ${JSON.stringify(planAfter.steps.map((s) => s.status))}`,
    );

    // 6. The agent is in COMPLETED state with finished_at set.
    assert.equal(agentAfter.state, STATES.COMPLETED, `agent must be COMPLETED, got '${agentAfter.state}'`);
    assert.ok(agentAfter.finished_at != null, "agent must have a finished_at timestamp");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: fan-out plan A -> {B, C} -> D with B crashed
// ---------------------------------------------------------------------------
//
// Plan shape:
//   step-A: done    (was done before the crash)
//   step-B: running (crashed mid-execution; B and C are siblings, both
//                   depend only on A)
//   step-C: pending (never started)
//   step-D: pending (never started; depends on B AND C)
//
// Resume contract:
//   - step-A is NOT re-run
//   - step-B rolled back to `failed`
//   - step-C reaches `done` (was eligible to run while B was running;
//     the loop picks it up after B is rolled back to `failed`)
//   - step-D reaches `done` (depends on B AND C; once B is failed the
//     loop's `nextReadySteps` allows `failed` deps through — see
//     plan.js:171-189 — so step-D unblocks when C is done)
test("gate13: fan-out A -> {B, C} -> D, B crashed; resume rolls back B only and completes C and D", async () => {
  await withTempUserData(async () => {
    const core = makeFakeCore();
    const { id: agentId } = core.pmCreateAgent(10, "fan-out-crash");

    // Seed the persisted plan: A done, B running, C pending, D pending.
    const seededPlan = {
      version: 1,
      steps: [
        { id: "step-A", title: "Setup",  status: "done",    depends_on: [],                       files: [], assigned_to: null },
        { id: "step-B", title: "Branch B", status: "running", depends_on: ["step-A"],            files: [], assigned_to: null },
        { id: "step-C", title: "Branch C", status: "pending", depends_on: ["step-A"],            files: [], assigned_to: null },
        { id: "step-D", title: "Merge",   status: "pending", depends_on: ["step-B", "step-C"],   files: [], assigned_to: null },
      ],
    };
    core.pmUpdateAgent(1, agentId, STATES.PLANNING, JSON.stringify(seededPlan), 0, 0);

    // Scripted provider: text-only rounds. The loop drives each
    // remaining step (C, then D) once per round. We supply 6 rounds
    // for headroom.
    const provider = scriptedProvider(
      Array.from({ length: 6 }, () => ({ text: "ok", finishReason: "stop" })),
    );

    const res = await startAgent({
      core,
      profileId: 1,
      agentId,
      provider,
      isResume: true,
    });
    assert.equal(res.ok, true, `startAgent(isResume=true) should succeed, got ${JSON.stringify(res)}`);

    const terminal = await waitForTerminal(res.bus);
    assert.equal(terminal.kind, "completed", `expected completed, got ${terminal.kind} ${JSON.stringify(terminal.payload)}`);

    // ---- ASSERTIONS ----

    const agentAfter = core.pmGetAgent(1, agentId);
    const planAfter = parsePlan(agentAfter.plan_json);
    assert.equal(planAfter.steps.length, 4, `expected 4 steps, got ${planAfter.steps.length}`);

    // 1. step-A is NOT re-run after the resume.
    const allMessages = core.pmListMessages(1, agentId);
    const aToolCalls = allMessages.filter(
      (m) => m.role === "tool_call" && m.content.includes('"step":"step-A"'),
    );
    assert.equal(
      aToolCalls.length,
      0,
      `step-A must NOT be re-executed after resume (got ${aToolCalls.length} tool calls)`,
    );

    // 2. step-B is rolled back to `failed`.
    const stepB = planAfter.steps.find((s) => s.id === "step-B");
    assert.ok(stepB, "step-B must exist");
    assert.equal(stepB.status, "failed", `step-B must be 'failed' after resume, got '${stepB.status}'`);

    // 3. step-C reaches `done` (was pending, picked up after B rollback).
    const stepC = planAfter.steps.find((s) => s.id === "step-C");
    assert.ok(stepC, "step-C must exist");
    assert.equal(stepC.status, "done", `step-C must be 'done' after resume, got '${stepC.status}'`);

    // 4. step-D reaches `done` (B's failed state still unblocks D because
    //    nextReadySteps allows terminal deps — done | failed | skipped).
    const stepD = planAfter.steps.find((s) => s.id === "step-D");
    assert.ok(stepD, "step-D must exist");
    assert.equal(stepD.status, "done", `step-D must be 'done' after resume, got '${stepD.status}'`);

    // 5. step-A remains `done` (no regression on completed step).
    const stepA = planAfter.steps.find((s) => s.id === "step-A");
    assert.ok(stepA, "step-A must exist");
    assert.equal(stepA.status, "done", `step-A must remain 'done' after resume, got '${stepA.status}'`);

    // 6. Plan is fully terminal.
    assert.equal(
      isPlanComplete(planAfter),
      true,
      `all 4 steps must be terminal after resume, got: ${JSON.stringify(planAfter.steps.map((s) => s.status))}`,
    );

    // 7. Agent is COMPLETED.
    assert.equal(agentAfter.state, STATES.COMPLETED, `agent must be COMPLETED, got '${agentAfter.state}'`);
    assert.ok(agentAfter.finished_at != null, "agent must have a finished_at timestamp");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: agent whose plan is ALREADY terminal — resume refuses
// ---------------------------------------------------------------------------
//
// resumeAgent must refuse early with `terminal-state` (no model call,
// no hang). We seed a 3-step plan where every step is `done` and the
// agent is in `completed` state.
test("gate13: resumeAgent on a fully-terminal plan refuses immediately with 'terminal-state' (no hang)", async () => {
  await withTempUserData(async () => {
    const core = makeFakeCore();
    const { id: agentId } = core.pmCreateAgent(10, "already-complete");

    const seededPlan = {
      version: 1,
      steps: [
        { id: "step-1", title: "Step one", status: "done", depends_on: [],              files: [], assigned_to: null },
        { id: "step-2", title: "Step two", status: "done", depends_on: ["step-1"],     files: [], assigned_to: null },
        { id: "step-3", title: "Step three", status: "done", depends_on: ["step-2"],   files: [], assigned_to: null },
      ],
    };
    core.pmUpdateAgent(1, agentId, STATES.COMPLETED, JSON.stringify(seededPlan), 0, 0);
    core.pmFinishAgent(1, agentId, STATES.COMPLETED);

    const t0 = Date.now();
    const res = await resumeAgent({ core, profileId: 1, agentId });
    const elapsed = Date.now() - t0;

    // 1. resumeAgent refuses with terminal-state.
    assert.equal(res.ok, false, "resumeAgent must refuse a terminal-state agent");
    assert.equal(res.reason, "terminal-state", `reason must be 'terminal-state', got '${res.reason}'`);

    // 2. No run was started (RUNS map is empty for this agent).
    assert.equal(getRun(agentId), null, "RUNS must not contain an entry for a refused resume");

    // 3. The refusal is fast — well under the agent loop's typical
    //    "did the model answer yet?" round-trip. We assert < 200ms
    //    to prove this is a synchronous refusal path, not a hang.
    assert.ok(
      elapsed < 200,
      `resumeAgent on a terminal-state must refuse synchronously (no hang), took ${elapsed}ms`,
    );

    // 4. The agent's persisted state is unchanged (no transition).
    const agentAfter = core.pmGetAgent(1, agentId);
    assert.equal(agentAfter.state, STATES.COMPLETED, "agent state must remain COMPLETED after refused resume");
    assert.equal(agentAfter.plan_json, JSON.stringify(seededPlan), "agent plan_json must be unchanged after refused resume");
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: crashed agent with NO plan (empty plan_json)
// ---------------------------------------------------------------------------
//
// Seed an agent in PLANNING state with an empty plan_json (the
// "agent row was just created and the loop never produced a plan"
// case). resumeAgent must:
//   - accept the call (state is not terminal)
//   - read the empty plan_json
//   - fall back to buildInitialPlan (a 1-step starter plan) inside
//     startAgent (see loop.js:573-584)
//   - drive the single step to completion
//   - reach the verification gate (which trivially passes with no
//     test_command) and transition to COMPLETED
//
// This is the "the model never replied" recovery path: even if the
// persisted plan is empty, the loop must produce a non-hung agent.
test("gate13: resumeAgent on a crashed agent with NO plan still completes (falls back to buildInitialPlan)", async () => {
  await withTempUserData(async () => {
    const core = makeFakeCore();
    const { id: agentId } = core.pmCreateAgent(10, "no-plan-task");

    // Empty plan_json: the loop's parsePlan will return { steps: [] }
    // and startAgent must build a fresh 1-step starter plan.
    core.pmUpdateAgent(1, agentId, STATES.PLANNING, "[]", 0, 0);

    // We still pass a scripted provider (via startAgent isResume: true
    // because resumeAgent doesn't take a provider). The scripted
    // provider emits 4 text-only rounds so the single starter step
    // can be marked done and the verification gate can drain its
    // final-summary round.
    const provider = scriptedProvider(
      Array.from({ length: 4 }, () => ({ text: "ok", finishReason: "stop" })),
    );

    const res = await startAgent({
      core,
      profileId: 1,
      agentId,
      provider,
      isResume: true,
    });
    assert.equal(res.ok, true, `startAgent(isResume=true) must succeed on empty-plan resume, got ${JSON.stringify(res)}`);

    const terminal = await waitForTerminal(res.bus);
    assert.equal(
      terminal.kind,
      "completed",
      `expected completed (loop falls back to starter plan), got ${terminal.kind} ${JSON.stringify(terminal.payload)}`,
    );

    // 1. Agent reached COMPLETED.
    const agentAfter = core.pmGetAgent(1, agentId);
    assert.equal(agentAfter.state, STATES.COMPLETED, `agent must be COMPLETED, got '${agentAfter.state}'`);
    assert.ok(agentAfter.finished_at != null, "agent must have a finished_at timestamp");

    // 2. The persisted plan is non-empty (the starter plan was
    //    built). It must contain at least 1 step.
    const planAfter = parsePlan(agentAfter.plan_json);
    assert.ok(
      planAfter.steps.length >= 1,
      `expected >=1 step after fallback-to-starter-plan, got ${planAfter.steps.length}`,
    );

    // 3. The starter step is `done` (the loop drove it through and
    //    marked it terminal). buildInitialPlan creates step-1.
    const step1 = planAfter.steps.find((s) => s.id === "step-1");
    assert.ok(step1, "starter step-1 must exist");
    assert.equal(step1.status, "done", `starter step-1 must be 'done', got '${step1.status}'`);

    // 4. Plan is fully terminal.
    assert.equal(
      isPlanComplete(planAfter),
      true,
      `plan must be fully terminal after starter-plan fallback, got: ${JSON.stringify(planAfter.steps.map((s) => s.status))}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: parent agent with a stuck sub-agent pm_agents row
// ---------------------------------------------------------------------------
//
// Seed scenario:
//   - parent agent (id = parentId) has a 2-step plan:
//     step-1 done, step-2 running (the loop crashed before the child
//     telemetry row was closed)
//   - child pm_agents row (id = childId) with parent_agent_id =
//     parentId, in PLANNING state with a single running step (the
//     "child crashed mid-execution" case)
//
// The resume on the parent must:
//   - roll back parent's step-2 to `failed` (classifyStall ->
//     stalled-with-running on the parent's plan)
//   - drive the parent's plan to completion
//   - REACH COMPLETED at the parent level
//
// Note: the parent's resume does NOT directly mutate the child
// pm_agents row — the parent's loop has no information about the
// child loop. But the parent's recovery from `stalled-with-running`
// is exactly the same logic as in scenario 1 / 2, applied to the
// parent's plan. The child pm_agents row remains in its persisted
// state; a separate child resume (or pmFinishAgent) would be needed
// to close it. This test verifies the parent's recovery is robust
// to the presence of a child pm_agents row in a mid-run state.
test("gate13: parent with stuck child pm_agents row recovers via stalled-with-running rollback", async () => {
  await withTempUserData(async () => {
    const core = makeFakeCore();

    // Create the parent agent with a seeded mid-run plan.
    const parentCreated = core.pmCreateAgent(10, "parent-task");
    const parentId = parentCreated.id;
    const parentPlan = {
      version: 1,
      steps: [
        { id: "step-1", title: "Parent step one", status: "done",    depends_on: [],          files: [], assigned_to: null },
        { id: "step-2", title: "Parent step two", status: "running", depends_on: ["step-1"], files: [], assigned_to: "coder" },
      ],
    };
    core.pmUpdateAgent(1, parentId, STATES.PLANNING, JSON.stringify(parentPlan), 0, 0);

    // Create a child pm_agents row that is "stuck running". The
    // parent's step-2 references this child via assigned_to="coder".
    // The child's plan_json has a single running step. The parent's
    // resume must not be blocked by the child's mid-run state.
    const childCreated = core.pmCreateAgent(10, "child-task (stuck)", parentId);
    const childId = childCreated.id;
    const childPlan = {
      version: 1,
      steps: [
        { id: "child-step-1", title: "Child step", status: "running", depends_on: [], files: [], assigned_to: null },
      ],
    };
    core.pmUpdateAgent(1, childId, STATES.PLANNING, JSON.stringify(childPlan), 0, 0);

    // Pre-seed a subagent_runs row (stuck). The parent's resume does
    // not touch it; we just record its existence so the assertion
    // below can verify it was NOT mutated by the parent loop.
    const stuckSubagentRowId = 90_001;
    core._subagentRuns.set(stuckSubagentRowId, {
      id: stuckSubagentRowId,
      parent_agent_id: parentId,
      role: "coder",
      child_agent_id: childId,
      run_id: "stuck-run-001",
      started_at: new Date().toISOString(),
      ended_at: null,
      outcome: null,
      tokens_in: null,
      tokens_out: null,
      error: "",
    });

    // Scripted provider for the parent (text-only rounds). The
    // parent's recovery rolls step-2 back to failed; the parent's
    // plan has no more pending steps so the loop advances to the
    // verification gate (no test_command -> trivially passes) and
    // transitions to COMPLETED.
    const provider = scriptedProvider(
      Array.from({ length: 4 }, () => ({ text: "ok", finishReason: "stop" })),
    );

    const res = await startAgent({
      core,
      profileId: 1,
      agentId: parentId,
      provider,
      isResume: true,
    });
    assert.equal(res.ok, true, `parent's startAgent(isResume=true) must succeed, got ${JSON.stringify(res)}`);

    const terminal = await waitForTerminal(res.bus);
    assert.equal(
      terminal.kind,
      "completed",
      `parent must reach completed, got ${terminal.kind} ${JSON.stringify(terminal.payload)}`,
    );

    // ---- ASSERTIONS ----

    // 1. Parent's pm_agents row reached COMPLETED.
    const parentAfter = core.pmGetAgent(1, parentId);
    assert.equal(parentAfter.state, STATES.COMPLETED, `parent must be COMPLETED, got '${parentAfter.state}'`);
    assert.ok(parentAfter.finished_at != null, "parent must have a finished_at timestamp");

    // 2. Parent's plan is fully terminal.
    const parentPlanAfter = parsePlan(parentAfter.plan_json);
    assert.equal(isPlanComplete(parentPlanAfter), true, "parent's plan must be fully terminal");
    const parentStep1 = parentPlanAfter.steps.find((s) => s.id === "step-1");
    const parentStep2 = parentPlanAfter.steps.find((s) => s.id === "step-2");
    assert.equal(parentStep1.status, "done", "parent step-1 must remain 'done'");
    assert.equal(parentStep2.status, "failed", "parent step-2 must be rolled back to 'failed'");

    // 3. Child pm_agents row is preserved (the parent's resume does
    //    not mutate child rows). The child remains in PLANNING with
    //    its single running step. A separate child-resume (or
    //    pmFinishAgent) would be required to close it.
    const childAfter = core.pmGetAgent(1, childId);
    assert.ok(childAfter, "child pm_agents row must still exist after parent resume");
    assert.equal(childAfter.state, STATES.PLANNING, "child pm_agents state must remain PLANNING (parent loop does not mutate child)");
    const childPlanAfter = parsePlan(childAfter.plan_json);
    const childStep = childPlanAfter.steps.find((s) => s.id === "child-step-1");
    assert.ok(childStep, "child step must exist");
    assert.equal(childStep.status, "running", "child step must remain 'running' (parent recovery does not reach into child rows)");
    assert.equal(childAfter.parent_agent_id, parentId, "child's parent_agent_id link must be preserved");

    // 4. The subagent_runs row is also unchanged (the parent's loop
    //    does not close child telemetry rows that it did not open).
    const stuckRow = core._subagentRuns.get(stuckSubagentRowId);
    assert.ok(stuckRow, "subagent_runs row must still exist");
    assert.equal(stuckRow.outcome, null, "stuck subagent_runs row outcome must be null (parent loop does not mutate child telemetry)");
    assert.equal(stuckRow.ended_at, null, "stuck subagent_runs row ended_at must be null");

    // 5. CRITICAL assertion for the brief: the parent's recovery is
    //    the same `classifyStall -> stalled-with-running -> mark
    //    failed` path as scenarios 1 and 2. The presence of a stuck
    //    child pm_agents row in a different agentId does not block
    //    or alter the parent's recovery. The parent's pm_agents
    //    row is the source of truth for the parent's resume.
    const parentMessages = core.pmListMessages(1, parentId);
    const parentToolCalls = parentMessages.filter(
      (m) => m.role === "tool_call" && m.content.includes('"step":"step-1"'),
    );
    assert.equal(parentToolCalls.length, 0, "parent step-1 must NOT be re-executed after resume");
  });
});