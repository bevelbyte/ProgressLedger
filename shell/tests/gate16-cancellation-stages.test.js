// GATE 16 — Cancellation at every stage of the agent loop.
//
// The brief demands: test cancellation at PLANNING, TOOL EXECUTION,
// SUB-AGENT EXECUTION, TEST EXECUTION, WAITING FOR PROVIDER, and
// VERIFICATION. Cancellation must not leave corrupted state, leaked
// processes, orphaned tasks, impossible state transitions, or broken
// locks.
//
// Each test uses the REAL `startAgent` + `AbortSignal.timeout(N)` (the
// controller signal plumbed through `makeController` in `loop.js`) —
// no hand-rolled abort helpers, no monkey-patching of the loop.
//
// DESIGN NOTE: the loop's canonical cancellation transition lives at
// the TOP of the outer `while (true)` — `if (controller.signal.aborted)
// { finishAgent(CANCELLED); return; }`. For the abort to reach that
// check, the loop must `continue` back to the top of the while rather
// than returning early. A 1-step plan that reaches `done` after the
// first text-only round triggers `isPlanComplete -> VERIFYING ->
// COMPLETED` (the verify gate trivially passes when the project has no
// test_command), so the agent reaches COMPLETED before the abort
// check can fire. We therefore seed a 2-step plan (step-2 depends on
// step-1) for the first five tests: after step-1 is driven, the plan
// is still incomplete, the loop `continue`s, and the abort check at
// the top of the next outer iteration fires.
//
// For TEST 6 (verify) we need the plan to actually be complete in
// order to ENTER the verify gate. We use a 1-step plan and a patched
// test_run that hangs (so the abort lands mid-verify), then a failure
// result to force the fix-retry path. The gate returns `retry`, the
// loop `continue`s, and the abort check fires BEFORE the fix step can
// be driven.
//
// Stage -> assertion summary:
//   1. PLANNING            — abort before any stream event; CANCELLED,
//                            no tool_call / tool_result persisted.
//   2. TOOL EXECUTION      — abort fires while tool.execute is in-flight;
//                            tool completes, tool_call+tool_result
//                            persisted, agent CANCELLED.
//   3. SUB-AGENT EXECUTION — parent cancels while child is running;
//                            parent CANCELLED with consistent run
//                            state, child's controller independently
//                            abortable.
//   4. TEST EXECUTION      — abort fires while test_run is executing;
//                            tool_result records the error envelope,
//                            agent CANCELLED.
//   5. WAITING FOR PROVIDER — abort mid-stream after text_deltas;
//                            accumulated text persisted, no tool calls,
//                            agent CANCELLED.
//   6. VERIFICATION        — abort fires while verify gate's test_run
//                            is hanging; gate returns retry, loop
//                            continues, abort check fires BEFORE the
//                            fix step is driven, agent CANCELLED.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  startAgent,
  AGENT_EVENTS,
  STATES,
  getRun,
  canTransition,
} from "../src/services/agent/loop.js";
import { scriptedProvider } from "../src/services/agent/fixture.js";
import { parsePlan } from "../src/services/agent/plan.js";
import { getTool } from "../src/services/project-tools/index.js";
import { _setUserDataDir, _closeAll } from "../src/services/memory/index.js";
import { _resetForTests } from "../src/services/audit/index.js";

// ---------------------------------------------------------------------------
// Shared scaffolding — mirrors gate13 + gate12 fake-core pattern.
// ---------------------------------------------------------------------------

let nextAgentIdSeq = 60_000;
let nextSubagentRunSeq = 90_000;

function makeFakeCore({ configJson = "{}" } = {}) {
  const agents = new Map();
  const messages = new Map();

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
      // Note: the loop reads `agent.projectId` (camelCase) to build
      // the tool context, so we must store the project id under BOTH
      // `projectId` (camelCase, for the loop) and `project_id`
      // (snake_case, for any code that expects the DB column name).
      agents.set(id, {
        id,
        projectId,
        project_id: projectId,
        objective,
        state: STATES.IDLE,
        plan_json: "[]",
        tokens_in: 0,
        tokens_out: 0,
        finished_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
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
      if (planJson !== undefined) a.plan_json = planJson;
      if (tokensIn !== undefined) a.tokens_in = tokensIn;
      if (tokensOut !== undefined) a.tokens_out = tokensOut;
      a.updated_at = new Date().toISOString();
      return { ok: true };
    },
    pmAppendMessage(_profileId, agentId, role, content, name, payloadJson) {
      return { seq: recordMessage(agentId, role, content, name, payloadJson) };
    },
    pmFinishAgent(_profileId, agentId, state) {
      const a = agents.get(agentId);
      if (!a) return { ok: false };
      a.state = state;
      a.finished_at = new Date().toISOString();
      return { ok: true };
    },
    pmListMessages(_profileId, agentId) {
      const list = messages.get(agentId) || [];
      return [...list].sort((a, b) => a.seq - b.seq);
    },
    pmGetProject(_profileId, _projectId) {
      return {
        id: 10,
        profile_id: 1,
        name: "GATE16 cancellation fixture",
        description: "deterministic gate16 cancellation stages",
        root_path: "/tmp/gate16",
        config_json: configJson,
        created_at: "1970-01-01T00:00:00Z",
        updated_at: "1970-01-01T00:00:00Z",
      };
    },
    pmGetProfile(_profileId) {
      return { id: 1, profile_config: "{}" };
    },
    pmInsertSubagentRun(_profileId, _parentAgentId, _role, _childAgentId, _runId) {
      return nextSubagentRunSeq++;
    },
    pmEndSubagentRun() { return { ok: true }; },
    _agents: agents,
    _messages: messages,
  };
  return core;
}

function seedPlan(core, profileId, agentId, steps) {
  const plan = {
    version: 1,
    steps: steps.map((s, i) => ({
      id: s.id || `step-${i + 1}`,
      title: s.title || `Step ${i + 1}`,
      status: s.status || "pending",
      depends_on: s.depends_on || [],
      files: s.files || [],
      assigned_to: s.assigned_to || null,
    })),
  };
  core.pmUpdateAgent(profileId, agentId, STATES.PLANNING, JSON.stringify(plan), 0, 0);
  return plan;
}

/**
 * A 2-step plan: step-2 depends on step-1. After step-1 is driven,
 * step-2 is still pending, so isPlanComplete returns false and the
 * loop `continue`s back to the top of the outer while — where the
 * abort check fires. See the DESIGN NOTE in the file header.
 */
function twoStepPlan() {
  return [
    { id: "step-1", title: "Do the thing" },
    { id: "step-2", title: "Verify the thing", depends_on: ["step-1"] },
  ];
}

function waitForTerminal(bus, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bus.off(AGENT_EVENTS.AGENT_COMPLETED, onDone);
      bus.off(AGENT_EVENTS.AGENT_FAILED, onFail);
      bus.off(AGENT_EVENTS.AGENT_CANCELLED, onCancel);
      reject(new Error(`waitForTerminal timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onDone = () => { clearTimeout(timer); resolve({ kind: "completed" }); };
    const onFail = () => { clearTimeout(timer); resolve({ kind: "failed" }); };
    const onCancel = () => { clearTimeout(timer); resolve({ kind: "cancelled" }); };
    bus.on(AGENT_EVENTS.AGENT_COMPLETED, onDone);
    bus.on(AGENT_EVENTS.AGENT_FAILED, onFail);
    bus.on(AGENT_EVENTS.AGENT_CANCELLED, onCancel);
  });
}

async function waitForRunCleared(agentId, timeoutMs = 2000) {
  const start = Date.now();
  while (getRun(agentId) !== null) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

/**
 * Provider that hangs until the caller's AbortSignal fires, then yields
 * a single `finish` event. Lets us pin the abort moment to the streaming
 * boundary: the loop only exits the `for await` when the generator
 * yields, and yielding happens only after the abort.
 */
function hangingProvider() {
  return {
    async *streamChat(opts = {}) {
      const sig = opts.signal;
      if (sig && sig.aborted) {
        yield { type: "finish", reason: "stop" };
        return;
      }
      await new Promise((resolve) => {
        if (sig) sig.addEventListener("abort", () => resolve(), { once: true });
        else resolve();
      });
      yield { type: "finish", reason: "stop" };
    },
  };
}

/**
 * Provider that yields a few text_delta events, then hangs until the
 * signal aborts. Used to test "abort during WAITING FOR PROVIDER"
 * where we want SOME text accumulated before the abort fires.
 */
function partialStreamProvider(firstDelta, secondDelta) {
  return {
    async *streamChat(opts = {}) {
      yield { type: "text_delta", delta: firstDelta };
      yield { type: "text_delta", delta: secondDelta };
      const sig = opts.signal;
      if (sig && sig.aborted) {
        yield { type: "finish", reason: "stop" };
        return;
      }
      await new Promise((resolve) => {
        if (sig) sig.addEventListener("abort", () => resolve(), { once: true });
        else resolve();
      });
      yield { type: "finish", reason: "stop" };
    },
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function withTempUserData(fn) {
  const dir = mkdtempSync(join(tmpdir(), "cf-gate16-"));
  _setUserDataDir(dir);
  _resetForTests();
  return Promise.resolve(fn()).finally(() => {
    try { _closeAll(); } catch (_e) { /* best effort */ }
    try { _setUserDataDir(null); } catch (_e) { /* best effort */ }
    try { _resetForTests(); } catch (_e) { /* best effort */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });
}

// ---------------------------------------------------------------------------
// TEST 1 — Cancellation during PLANNING
// ---------------------------------------------------------------------------
//
// Pre-streamChat abort. The hanging provider never yields an event
// until the abort fires; the abort at 50ms is the only thing that
// unblocks the loop. The generator yields `finish`, the loop's
// `for await` breaks out (signal.aborted check at the top of each
// iteration), no tool calls are queued. The loop marks the active
// step done, sees the plan is not complete (step-2 is still pending),
// `continue`s, and the abort check at the top of the next outer
// iteration fires: `finishAgent(CANCELLED)`.
//
// Assertions:
//   - agent state is CANCELLED (terminal state, no impossible
//     transition out of it)
//   - finished_at is set (no orphaned pm_agents row)
//   - no tool_call / tool_result messages (the agent never got past
//     planning)
//   - RUNS entry is cleared (no leaked lock)
test("GATE16: cancellation during PLANNING — pre-stream abort, no tool calls fired", { timeout: 8000 }, async () => {
  await withTempUserData(async () => {
    const core = makeFakeCore();
    const { id: agentId } = core.pmCreateAgent(10, "plan a task");
    seedPlan(core, 1, agentId, twoStepPlan());

    const provider = hangingProvider();
    const signal = AbortSignal.timeout(50);
    const res = await startAgent({ core, profileId: 1, agentId, provider, signal });
    assert.equal(res.ok, true, `startAgent should succeed, got ${JSON.stringify(res)}`);

    const terminal = await waitForTerminal(res.bus);
    assert.equal(terminal.kind, "cancelled", `expected cancelled, got ${terminal.kind}`);

    const agentAfter = core.pmGetAgent(1, agentId);
    assert.equal(agentAfter.state, STATES.CANCELLED, `agent must be CANCELLED, got '${agentAfter.state}'`);
    assert.ok(agentAfter.finished_at != null, "agent must have a finished_at timestamp");

    const allMessages = core.pmListMessages(1, agentId);
    const toolCalls = allMessages.filter((m) => m.role === "tool_call");
    const toolResults = allMessages.filter((m) => m.role === "tool_result");
    assert.equal(toolCalls.length, 0, `expected 0 tool_call messages, got ${toolCalls.length}`);
    assert.equal(toolResults.length, 0, `expected 0 tool_result messages, got ${toolResults.length}`);

    const cleared = await waitForRunCleared(agentId);
    assert.equal(cleared, true, "RUNS entry must be cleared after cancellation");

    // The plan is persisted (not corrupted). step-2 is still pending
    // (the agent never reached it), which is the invariant that
    // allowed the abort check to fire.
    const planAfter = parsePlan(agentAfter.plan_json);
    assert.ok(planAfter.steps.length >= 2, "plan must be persisted with both steps");
    const step2 = planAfter.steps.find((s) => s.id === "step-2");
    assert.ok(step2, "step-2 must exist");
    assert.notEqual(step2.status, "done", `step-2 must NOT be 'done' after planning cancellation, got '${step2.status}'`);

    // CANCELLED is a valid terminal state with no outgoing transitions.
    assert.equal(canTransition(STATES.CANCELLED, STATES.PLANNING), false, "CANCELLED must not transition to PLANNING");
    assert.equal(canTransition(STATES.CANCELLED, STATES.EXECUTING_TOOL), false, "CANCELLED must not transition to EXECUTING_TOOL");
  });
});

// ---------------------------------------------------------------------------
// TEST 2 — Cancellation during TOOL EXECUTION
// ---------------------------------------------------------------------------
//
// The scripted provider emits a `tool_call` for `fs_write` and then
// yields `finish`. The patched fs_write.execute awaits 250ms before
// returning, so the tool runs across the abort (200ms). The loop does
// NOT check the signal during tool.execute — it awaits the tool's
// promise, appends the result, then the outer-while abort check fires
// on the next iteration. So the tool_call is recorded, the
// tool_result is recorded, and the agent reaches CANCELLED (the plan
// is 2-step so isPlanComplete returns false after step-1 is done).
//
// Assertions:
//   - agent state is CANCELLED
//   - exactly 1 tool_call + 1 tool_result persisted (no orphans)
//   - RUNS entry is cleared
//   - CANCELLED is terminal
test("GATE16: cancellation during TOOL EXECUTION — abort fires mid-tool, loop terminates cleanly", { timeout: 8000 }, async () => {
  await withTempUserData(async () => {
    const core = makeFakeCore();
    const { id: agentId } = core.pmCreateAgent(10, "write a file");
    seedPlan(core, 1, agentId, twoStepPlan());

    const provider = scriptedProvider([
      {
        toolCalls: [{ id: "tc-1", name: "fs_write", args: JSON.stringify({ path: "/tmp/gate16/x.txt", content: "hi" }) }],
        finishReason: "tool_calls",
      },
    ]);

    const fsWriteTool = getTool("fs_write");
    const origExec = fsWriteTool.execute;
    fsWriteTool.execute = async () => {
      await sleep(250);
      return { ok: true, result: { path: "/tmp/gate16/x.txt", bytes: 2 }, elapsedMs: 250 };
    };

    const signal = AbortSignal.timeout(200);
    try {
      const res = await startAgent({
        core,
        profileId: 1,
        agentId,
        provider,
        approvalResolver: async () => ({ approved: true }),
        signal,
      });
      assert.equal(res.ok, true, `startAgent should succeed, got ${JSON.stringify(res)}`);

      const terminal = await waitForTerminal(res.bus);
      assert.equal(terminal.kind, "cancelled", `expected cancelled, got ${terminal.kind}`);

      const agentAfter = core.pmGetAgent(1, agentId);
      assert.equal(agentAfter.state, STATES.CANCELLED, `agent must be CANCELLED, got '${agentAfter.state}'`);
      assert.ok(agentAfter.finished_at != null, "agent must have a finished_at timestamp");

      const allMessages = core.pmListMessages(1, agentId);
      const toolCalls = allMessages.filter((m) => m.role === "tool_call");
      const toolResults = allMessages.filter((m) => m.role === "tool_result");
      assert.equal(toolCalls.length, 1, `expected exactly 1 tool_call, got ${toolCalls.length}`);
      assert.equal(toolResults.length, 1, `expected exactly 1 tool_result, got ${toolResults.length}`);
      assert.ok(
        toolCalls[0].content.includes("fs_write"),
        `tool_call must reference fs_write, got: ${toolCalls[0].content.slice(0, 120)}`,
      );
      assert.ok(toolResults[0].content.includes('"ok":true'), "tool_result must contain the success envelope");

      const cleared = await waitForRunCleared(agentId);
      assert.equal(cleared, true, "RUNS entry must be cleared after cancellation");

      assert.equal(canTransition(STATES.CANCELLED, STATES.COMPLETED), false, "CANCELLED must not transition to COMPLETED");
      assert.equal(canTransition(STATES.CANCELLED, STATES.EXECUTING_TOOL), false, "CANCELLED must not transition to EXECUTING_TOOL");
    } finally {
      fsWriteTool.execute = origExec;
    }
  });
});

// ---------------------------------------------------------------------------
// TEST 3 — Cancellation during SUB-AGENT EXECUTION
// ---------------------------------------------------------------------------
//
// A parent agent calls `delegate_research`. The child is spawned with
// a hanging provider so its loop never terminates on its own. The
// parent's AbortSignal.timeout(500) fires during the child's in-flight
// execution; the parent's next poll iteration (POLL_MS default 2000 in
// `runDelegate`) sees `ctx.isCancellable() === true` and returns the
// `cancelled` error envelope.
//
// Current-loop behavior: the parent's abort does NOT propagate to the
// child's controller (delegate_research does not forward the parent's
// signal). So the child continues running independently. The parent's
// pm_agents row reaches CANCELLED; the child's pm_agents row remains
// in a non-terminal state until it is independently aborted.
//
// This test documents the gap AND proves the parent's run state is
// consistent (no leaked lock, no stuck pm_agents row) AND that the
// child's controller can still be independently aborted (no broken
// lock on the child).
//
// Assertions:
//   - parent reaches CANCELLED with finished_at set
//   - parent's RUNS entry is cleared
//   - parent's step-1 is NOT marked done (delegate_research returned
//     an error envelope, so anyToolFailed=true)
//   - parent's tool_call + tool_result are recorded (the delegate ran
//     to completion before the parent's abort check fired)
//   - the child's controller is independently abortable — a follow-up
//     abort terminates the child, no broken lock
test("GATE16: cancellation during SUB-AGENT EXECUTION — parent cancels, run state stays consistent", { timeout: 10000 }, async () => {
  await withTempUserData(async () => {
    const core = makeFakeCore();
    const { id: parentId } = core.pmCreateAgent(10, "delegate a research task");
    seedPlan(core, 1, parentId, twoStepPlan());

    const parentProvider = scriptedProvider([
      {
        toolCalls: [{ id: "tc-1", name: "delegate_research", args: JSON.stringify({ objective: "find something", step_id: "step-1" }) }],
        finishReason: "tool_calls",
      },
    ]);

    // A fake startAgent on the core: the delegate tool calls this to
    // spawn the child's loop. The delegate already created the child
    // row via `core.pmCreateAgent` and passes its id in `opts.agentId`,
    // so we just wire up the loop with a hanging provider so the
    // child never terminates on its own.
    core.startAgent = async (opts) => {
      const childId = opts.agentId;
      // Seed a 2-step plan for the child so that when the abort breaks
      // the for-await and the loop marks step-1 done, isPlanComplete
      // returns false (step-2 is still pending) and the loop `continue`s
      // back to the top of the outer while — where the abort check
      // fires. Without this the child would hit the verify gate and
      // reach COMPLETED.
      seedPlan(core, opts.profileId, childId, twoStepPlan());
      const childProv = hangingProvider();
      const childRes = await startAgent({
        core,
        profileId: opts.profileId,
        agentId: childId,
        provider: childProv,
        isSubAgent: true,
        role: opts.role,
      });
      return childRes;
    };

    const signal = AbortSignal.timeout(500);
    const res = await startAgent({ core, profileId: 1, agentId: parentId, provider: parentProvider, signal });
    assert.equal(res.ok, true, `parent startAgent should succeed, got ${JSON.stringify(res)}`);

    const terminal = await waitForTerminal(res.bus);
    assert.equal(terminal.kind, "cancelled", `expected parent cancelled, got ${terminal.kind}`);

    const parentAfter = core.pmGetAgent(1, parentId);
    assert.equal(parentAfter.state, STATES.CANCELLED, `parent must be CANCELLED, got '${parentAfter.state}'`);
    assert.ok(parentAfter.finished_at != null, "parent must have a finished_at timestamp");

    const parentCleared = await waitForRunCleared(parentId);
    assert.equal(parentCleared, true, "parent RUNS entry must be cleared");

    const parentPlan = parsePlan(parentAfter.plan_json);
    const step1 = parentPlan.steps.find((s) => s.id === "step-1");
    assert.ok(step1, "parent step-1 must exist");
    assert.notEqual(step1.status, "done", `parent step-1 must NOT be 'done' after cancellation, got '${step1.status}'`);

    const parentMessages = core.pmListMessages(1, parentId);
    const parentToolCalls = parentMessages.filter((m) => m.role === "tool_call");
    const parentToolResults = parentMessages.filter((m) => m.role === "tool_result");
    assert.equal(parentToolCalls.length, 1, `expected 1 parent tool_call, got ${parentToolCalls.length}`);
    assert.equal(parentToolResults.length, 1, `expected 1 parent tool_result, got ${parentToolResults.length}`);
    const toolResultContent = parentToolResults[0].content;
    assert.ok(
      toolResultContent.includes('"cancelled"') || toolResultContent.includes('"ok":false'),
      `parent tool_result must be an error envelope, got: ${toolResultContent.slice(0, 200)}`,
    );

    // Phase 10 GATE 1 contract: cancelling the parent now PROPAGATES
    // to the in-flight child. (This test previously documented the gap
    // — the child kept running and had to be aborted manually. The P0
    // fix closed that gap; the assertions below prove the new
    // behavior: the child is cancelled by the parent's cancellation
    // alone, with no manual abort, no zombie run, and a clean
    // persisted terminal state.)
    const childRows = [...core._agents.values()].filter((a) => a.parent_agent_id === parentId);
    assert.ok(childRows.length >= 1, "child pm_agents row must exist");
    const childId = childRows[0].id;

    const childCleared = await waitForRunCleared(childId);
    assert.equal(childCleared, true, "child RUNS entry must clear via propagation (no manual abort)");
    const childAfter = core.pmGetAgent(1, childId);
    assert.equal(childAfter.state, STATES.CANCELLED, `child must be CANCELLED by propagation, got '${childAfter.state}'`);
    assert.ok(childAfter.finished_at != null, "child must have a finished_at timestamp");
  });
});

// ---------------------------------------------------------------------------
// TEST 4 — Cancellation during TEST EXECUTION
// ---------------------------------------------------------------------------
//
// The provider emits a `test_run` tool call. The patched test_run
// execute awaits 200ms before returning an error envelope (simulating
// a cancelled test). The abort fires at 150ms (during the sleep). The
// tool returns at 200ms; the loop appends the error envelope, marks
// the step failed (anyToolFailed=true), then the outer-while abort
// check fires (the plan is 2-step so isPlanComplete returns false).
//
// Assertions:
//   - agent state is CANCELLED
//   - tool_result contains the error envelope (ok:false)
//   - RUNS entry is cleared
//   - CANCELLED is terminal
test("GATE16: cancellation during TEST EXECUTION — abort fires mid-test_run, agent reaches CANCELLED", { timeout: 8000 }, async () => {
  await withTempUserData(async () => {
    const core = makeFakeCore();
    const { id: agentId } = core.pmCreateAgent(10, "run tests");
    seedPlan(core, 1, agentId, twoStepPlan());

    const provider = scriptedProvider([
      {
        toolCalls: [{ id: "tc-1", name: "test_run", args: JSON.stringify({ command: "node", argv: ["-e", "process.exit(0)"] }) }],
        finishReason: "tool_calls",
      },
    ]);

    const testRunTool = getTool("test_run");
    const origExec = testRunTool.execute;
    testRunTool.execute = async () => {
      await sleep(200);
      return {
        ok: false,
        error: { code: "cancelled", message: "test_run aborted by caller" },
      };
    };

    const signal = AbortSignal.timeout(150);
    try {
      const res = await startAgent({
        core,
        profileId: 1,
        agentId,
        provider,
        approvalResolver: async () => ({ approved: true }),
        signal,
      });
      assert.equal(res.ok, true, `startAgent should succeed, got ${JSON.stringify(res)}`);

      const terminal = await waitForTerminal(res.bus);
      assert.equal(terminal.kind, "cancelled", `expected cancelled, got ${terminal.kind}`);

      const agentAfter = core.pmGetAgent(1, agentId);
      assert.equal(agentAfter.state, STATES.CANCELLED, `agent must be CANCELLED, got '${agentAfter.state}'`);
      assert.ok(agentAfter.finished_at != null, "agent must have a finished_at timestamp");

      const allMessages = core.pmListMessages(1, agentId);
      const toolCalls = allMessages.filter((m) => m.role === "tool_call");
      const toolResults = allMessages.filter((m) => m.role === "tool_result");
      assert.equal(toolCalls.length, 1, `expected 1 tool_call, got ${toolCalls.length}`);
      assert.equal(toolResults.length, 1, `expected 1 tool_result, got ${toolResults.length}`);

      assert.ok(toolResults[0].content.includes('"ok":false'), "tool_result must contain ok:false envelope");
      assert.ok(
        toolResults[0].content.includes('"cancelled"') || toolResults[0].content.includes('"code"'),
        "tool_result must reference the cancelled error code",
      );

      // Step-1 is NOT marked done (the tool failed).
      const planAfter = parsePlan(agentAfter.plan_json);
      const step1 = planAfter.steps.find((s) => s.id === "step-1");
      assert.ok(step1, "step-1 must exist");
      assert.notEqual(step1.status, "done", `step-1 must NOT be 'done' after a cancelled test_run, got '${step1.status}'`);

      const cleared = await waitForRunCleared(agentId);
      assert.equal(cleared, true, "RUNS entry must be cleared");

      assert.equal(canTransition(STATES.CANCELLED, STATES.EXECUTING_TOOL), false, "CANCELLED must not transition to EXECUTING_TOOL");
      assert.equal(canTransition(STATES.CANCELLED, STATES.COMPLETED), false, "CANCELLED must not transition to COMPLETED");
    } finally {
      testRunTool.execute = origExec;
    }
  });
});

// ---------------------------------------------------------------------------
// TEST 5 — Cancellation during WAITING FOR PROVIDER
// ---------------------------------------------------------------------------
//
// The provider yields two text_delta events, then hangs until the
// abort fires. The abort at 100ms lands while the provider is still
// hanging (after the two deltas but before finish). The loop breaks
// out of the `for await` when the abort fires, with no tool calls
// queued. The accumulated text is persisted as an assistant message.
// Because the plan is 2-step, isPlanComplete returns false after
// step-1 is marked done, so the loop `continue`s and the abort check
// fires.
//
// Assertions:
//   - agent state is CANCELLED
//   - the accumulated text is persisted as an assistant message
//   - no tool_call was fired (the provider never emitted one)
//   - RUNS entry is cleared
test("GATE16: cancellation during WAITING FOR PROVIDER — abort mid-stream, no spurious tool calls", { timeout: 8000 }, async () => {
  await withTempUserData(async () => {
    const core = makeFakeCore();
    const { id: agentId } = core.pmCreateAgent(10, "stream some text");
    seedPlan(core, 1, agentId, twoStepPlan());

    const provider = partialStreamProvider("Hello ", "world!");
    const signal = AbortSignal.timeout(100);

    const res = await startAgent({ core, profileId: 1, agentId, provider, signal });
    assert.equal(res.ok, true, `startAgent should succeed, got ${JSON.stringify(res)}`);

    const terminal = await waitForTerminal(res.bus);
    assert.equal(terminal.kind, "cancelled", `expected cancelled, got ${terminal.kind}`);

    const agentAfter = core.pmGetAgent(1, agentId);
    assert.equal(agentAfter.state, STATES.CANCELLED, `agent must be CANCELLED, got '${agentAfter.state}'`);
    assert.ok(agentAfter.finished_at != null, "agent must have a finished_at timestamp");

    const allMessages = core.pmListMessages(1, agentId);
    const assistantMsgs = allMessages.filter((m) => m.role === "assistant");
    assert.ok(assistantMsgs.length >= 1, "the accumulated text must be persisted as an assistant message");
    assert.ok(
      assistantMsgs[0].content.includes("Hello"),
      `assistant message must contain the accumulated text, got: ${assistantMsgs[0].content.slice(0, 100)}`,
    );

    const toolCalls = allMessages.filter((m) => m.role === "tool_call");
    assert.equal(toolCalls.length, 0, `expected 0 tool_call messages (abort fired before any tool), got ${toolCalls.length}`);
    const toolResults = allMessages.filter((m) => m.role === "tool_result");
    assert.equal(toolResults.length, 0, `expected 0 tool_result messages, got ${toolResults.length}`);

    const cleared = await waitForRunCleared(agentId);
    assert.equal(cleared, true, "RUNS entry must be cleared");

    assert.equal(canTransition(STATES.CANCELLED, STATES.PLANNING), false, "CANCELLED must not transition to PLANNING");
  });
});

// ---------------------------------------------------------------------------
// TEST 6 — Cancellation during VERIFICATION
// ---------------------------------------------------------------------------
//
// The plan is a single step (the verify gate requires isPlanComplete
// to enter). Round 1 is a text-only reply that marks step-1 done.
// The loop transitions to VERIFYING and enters runVerificationGate.
// The project has a test_command set, so verifyCompletion runs
// test_run via the tool. We patch test_run to hang (sleep 500ms)
// then return a failure — the abort at 100ms lands mid-hang.
//
// After test_run returns at 505ms, verifyCompletion sees a failure,
// the gate appends a fix-N step and returns `{ outcome: "retry" }`.
// The loop `continue`s. The abort check at the top of the next outer
// iteration fires BEFORE the fix step can be driven.
//
// Assertions:
//   - agent state is CANCELLED
//   - a fix-retrying status message was appended (verify gate ran)
//   - a fix-N step was appended to the plan
//   - the fix-N step is NOT 'done' (the abort fired before the fix
//     step was driven)
//   - no fs_write tool_call for the fix step (no orphaned fix attempt)
//   - RUNS entry is cleared
test("GATE16: cancellation during VERIFICATION — abort in verify gate, fix step NOT executed", { timeout: 10000 }, async () => {
  await withTempUserData(async () => {
    const core = makeFakeCore({
      configJson: JSON.stringify({ test_command: "node", test_timeout_ms: 1000 }),
    });
    const { id: agentId } = core.pmCreateAgent(10, "write and verify");
    seedPlan(core, 1, agentId, [{ id: "step-1", title: "Write code" }]);

    const provider = scriptedProvider([
      { text: "Wrote it.", finishReason: "stop" },
      // Round 2 is only reached if the abort check does NOT fire
      // first. We include a no-op text-only round for safety.
      { text: "should not happen", finishReason: "stop" },
    ]);

    // Patch test_run (used by verifyCompletion) to hang then fail.
    const testRunTool = getTool("test_run");
    const origExec = testRunTool.execute;
    testRunTool.execute = async () => {
      await sleep(500);
      return {
        ok: true,
        result: { stdout: "", stderr: "tests failed", exitCode: 1, passed: false, timedOut: false },
      };
    };

    const signal = AbortSignal.timeout(100);
    try {
      const res = await startAgent({ core, profileId: 1, agentId, provider, signal });
      assert.equal(res.ok, true, `startAgent should succeed, got ${JSON.stringify(res)}`);

      const terminal = await waitForTerminal(res.bus);
      assert.equal(terminal.kind, "cancelled", `expected cancelled, got ${terminal.kind}`);

      const agentAfter = core.pmGetAgent(1, agentId);
      assert.equal(agentAfter.state, STATES.CANCELLED, `agent must be CANCELLED, got '${agentAfter.state}'`);
      assert.ok(agentAfter.finished_at != null, "agent must have a finished_at timestamp");

      const allMessages = core.pmListMessages(1, agentId);
      const statusMsgs = allMessages.filter((m) => m.role === "status");
      const fixRetrying = statusMsgs.filter((m) => m.name === "fix-retrying");
      assert.ok(fixRetrying.length >= 1, "verify gate must have appended a fix-retrying status message");

      const planAfter = parsePlan(agentAfter.plan_json);
      assert.ok(planAfter.steps.length >= 2, `expected >=2 steps after verify gate appended a fix step, got ${planAfter.steps.length}`);
      const fixStep = planAfter.steps.find((s) => /^fix-\d+/.test(s.id));
      assert.ok(fixStep, "a fix-N step must have been appended to the plan");
      assert.notEqual(fixStep.status, "done", `fix step must NOT be 'done' after abort, got '${fixStep.status}'`);

      const fsWrites = allMessages.filter((m) => m.role === "tool_call" && m.content.includes("fs_write"));
      assert.equal(fsWrites.length, 0, `no fs_write tool_call should fire for the fix step, got ${fsWrites.length}`);

      const cleared = await waitForRunCleared(agentId);
      assert.equal(cleared, true, "RUNS entry must be cleared");

      assert.equal(canTransition(STATES.CANCELLED, STATES.VERIFYING), false, "CANCELLED must not transition to VERIFYING");
      assert.equal(canTransition(STATES.CANCELLED, STATES.PLANNING), false, "CANCELLED must not transition to PLANNING");
    } finally {
      testRunTool.execute = origExec;
    }
  });
});
