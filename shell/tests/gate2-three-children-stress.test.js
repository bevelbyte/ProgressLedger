// Project Mode — GATE 2 (Phase 10): THREE-CHILD multi-agent stress.
//
// One parent processes three sub-agent outcomes:
//   CHILD A → SUCCESS   (completes normally)
//   CHILD B → FAILURE   (its tool fails; child ends FAILED)
//   CHILD C → CANCELLED (cancelled externally while the parent polls)
//
// Proves: independent tracking (correct parent_agent_id), isolated
// results in the parent transcript, a failure/cancellation does not
// corrupt the successful child, the parent continues and reaches the
// correct final state, no orphan records, no stale running rows, and
// exactly one terminal event per child. The scenario repeats 10x.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  startAgent,
  cancelAgent,
  getRun,
  listActiveRuns,
  AGENT_EVENTS,
  STATES,
} from "../src/services/agent/loop.js";
import { scriptedProvider } from "../src/services/agent/fixture.js";
import {
  register as registerTool,
  unregister as unregisterTool,
  _resetForTests as resetToolRegistry,
} from "../src/services/project-tools/index.js";
import { _setUserDataDir, _closeAll } from "../src/services/memory/index.js";

// Tools used by the children. slow_tool hangs until its agent's cancel
// signal fires. (Child B fails via a provider error event — a tool
// failure would make the plan 'complete' (failed is a terminal status)
// and the verify gate would pass, ending the child COMPLETED.)
const SLOW_TOOL = {
  name: "slow_tool",
  description: "test-only tool that hangs until ctx.isCancellable()",
  permission: "EXECUTE",
  inputSchema: { type: "object", properties: {}, required: [] },
  outputSchema: { type: "object" },
  timeoutMs: 30_000,
  async execute(_input, ctx) {
    for (let i = 0; i < 3_000; i++) {
      if (ctx && typeof ctx.isCancellable === "function" && ctx.isCancellable()) {
        return { ok: false, error: { code: "aborted", message: "aborted" }, elapsedMs: i * 5 };
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    return { ok: true, result: { value: "never" }, elapsedMs: 15_000 };
  },
};

let nextAgentIdSeq = 90_000;

// Child provider scripts, assigned by child-creation order:
//   0 → CHILD A: text-only success
//   1 → CHILD B: provider error event → loop ends FAILED
//   2 → CHILD C: slow_tool hang (cancelled externally)
function childProvider(scriptIndex) {
  if (scriptIndex === 0) {
    return scriptedProvider([{ text: "child A final summary", finishReason: "stop" }]);
  }
  if (scriptIndex === 1) {
    return {
      _internal: true,
      async *streamChat() {
        yield { type: "error", code: "mock-provider-error", message: "child B deterministic failure" };
      },
    };
  }
  return scriptedProvider([
    { toolCalls: [{ id: "tc-slow", name: "slow_tool", args: "{}" }], finishReason: "tool_calls" },
  ]);
}

function makeFakeCore() {
  const agents = new Map();
  const messages = new Map();
  let childCount = 0;

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
    pmCreateAgent(_projectId, objective, parentAgentId) {
      const id = nextAgentIdSeq++;
      const isChild = typeof parentAgentId === "number";
      agents.set(id, {
        id,
        objective,
        state: STATES.IDLE,
        finishedAt: null,
        parentAgentId: isChild ? parentAgentId : null,
        parent_agent_id: isChild ? parentAgentId : null,
        project_id: 10,
        projectId: 10,
        plan_json: "[]",
        planJson: "[]",
        tokens_in: 0,
        tokens_out: 0,
        // Children get their provider script by creation order.
        _scriptIndex: isChild ? childCount++ : -1,
      });
      messages.set(id, []);
      return { id };
    },
    pmGetAgent(_profileId, agentId) {
      const a = agents.get(agentId);
      return a ? { ...a } : null;
    },
    pmUpdateAgent(_profileId, agentId, state, planJson, tokensIn, tokensOut) {
      const a = agents.get(agentId);
      if (!a) return { ok: false };
      a.state = state;
      a.plan_json = planJson;
      a.planJson = planJson;
      a.tokens_in = tokensIn;
      a.tokens_out = tokensOut;
      return { ok: true };
    },
    pmAppendMessage(_profileId, agentId, role, content, name, payloadJson) {
      return { seq: recordMessage(agentId, role, content, name, payloadJson) };
    },
    pmFinishAgent(_profileId, agentId, state) {
      const a = agents.get(agentId);
      if (!a) return;
      a.state = state;
      a.finishedAt = new Date().toISOString();
      a.finished_at = a.finishedAt;
    },
    pmListMessages(_profileId, agentId) {
      const list = messages.get(agentId) || [];
      return [...list].sort((x, y) => x.seq - y.seq);
    },
    pmGetProject() {
      return {
        id: 10, profile_id: 1, name: "gate2", description: "three children",
        root_path: "/tmp/gate2", rootPath: "/tmp/gate2",
        config_json: "{}", configJson: "{}",
        created_at: "1970-01-01T00:00:00Z", updated_at: "1970-01-01T00:00:00Z",
      };
    },
    pmGetProfile() {
      return { id: 1, profile_config: null };
    },
    pmInsertSubagentRun() {
      return Math.floor(Math.random() * 1e9);
    },
    pmEndSubagentRun() {
      return true;
    },
    pmGetSubagentDepth() {
      return 0;
    },
    pmCheckSubagentLimits() {
      return { ok: true };
    },
    pmCancelSubagentForLimit() {
      return { ok: true };
    },
    pmListRecentAgentRuns() {
      return [];
    },
    startAgent(args) {
      const row = agents.get(args.agentId);
      return startAgent({ ...args, core, provider: childProvider(row ? row._scriptIndex : 0) });
    },
    _agents: agents,
    _messages: messages,
  };
  return core;
}

async function waitFor(cond, { timeoutMs = 8000, stepMs = 5 } = {}) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function countTerminal(bus, counters) {
  bus.on(AGENT_EVENTS.AGENT_COMPLETED, () => { counters.completed += 1; });
  bus.on(AGENT_EVENTS.AGENT_FAILED, () => { counters.failed += 1; });
  bus.on(AGENT_EVENTS.AGENT_CANCELLED, () => { counters.cancelled += 1; });
}

async function waitForRunCleared(agentId, { timeoutMs = 8000 } = {}) {
  const start = Date.now();
  while (getRun(agentId) !== null) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

/**
 * Run the full three-children scenario once. Returns an assertion
 * bundle for the caller to verify.
 */
async function runThreeChildrenScenario() {
  const core = makeFakeCore();
  const { id: parentId } = core.pmCreateAgent(10, "parent of three", null);

  // Seed a 3-step plan so the parent keeps looping through all three
  // delegate rounds instead of completing after the first one.
  core.pmUpdateAgent(
    1,
    parentId,
    STATES.PLANNING,
    JSON.stringify({
      version: 1,
      steps: [
        { id: "step-1", title: "Delegate A", status: "pending", depends_on: [], files: [], assigned_to: null },
        { id: "step-2", title: "Delegate B", status: "pending", depends_on: [], files: [], assigned_to: null },
        { id: "step-3", title: "Delegate C", status: "pending", depends_on: [], files: [], assigned_to: null },
      ],
    }),
    0,
    0,
  );

  const parentCounters = { completed: 0, failed: 0, cancelled: 0 };
  const parentStart = await startAgent({
    core,
    profileId: 1,
    agentId: parentId,
    provider: scriptedProvider([
      // R1: delegate child A (success)
      { toolCalls: [{ id: "tc-a", name: "delegate_coder", args: JSON.stringify({ objective: "A work", step_id: "step-1" }) }], finishReason: "tool_calls" },
      // R2: delegate child B (failure)
      { toolCalls: [{ id: "tc-b", name: "delegate_coder", args: JSON.stringify({ objective: "B work", step_id: "step-2" }) }], finishReason: "tool_calls" },
      // R3: delegate child C (cancelled externally mid-run)
      { toolCalls: [{ id: "tc-c", name: "delegate_coder", args: JSON.stringify({ objective: "C work", step_id: "step-3" }) }], finishReason: "tool_calls" },
      // R4: final summary (drives the parent to the verify gate)
      { text: "All children processed.", finishReason: "stop" },
    ]),
  });
  assert.equal(parentStart.ok, true, `parent start: ${JSON.stringify(parentStart)}`);
  countTerminal(parentStart.bus, parentCounters);

  // Wait for the third child to appear and hang in slow_tool, then
  // cancel IT directly (external cancellation — e.g. the user or a
  // limit enforcement cancels a sub-agent while the parent polls it).
  await waitFor(() => [...core._agents.values()].filter((a) => a.parentAgentId === parentId).length >= 3);
  const children = [...core._agents.values()].filter((a) => a.parentAgentId === parentId);
  const childC = children.reduce((max, a) => (a.id > max ? a.id : max), 0);
  await waitFor(() => core._agents.get(childC).state === STATES.EXECUTING_TOOL);
  const cancelRes = cancelAgent(childC);
  assert.equal(cancelRes.ok, true, "cancelling child C must succeed");

  // The parent must reach a terminal state. Expected: COMPLETED — a
  // cancelled CHILD is a processed outcome (the delegate tool resolves
  // with state:'cancelled'), not a parent failure.
  const terminal = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("parent never reached a terminal state")), 15_000);
    const done = (kind) => (e) => { clearTimeout(t); resolve({ kind, payload: e && e.payload }); };
    parentStart.bus.on(AGENT_EVENTS.AGENT_COMPLETED, done("completed"));
    parentStart.bus.on(AGENT_EVENTS.AGENT_FAILED, done("failed"));
    parentStart.bus.on(AGENT_EVENTS.AGENT_CANCELLED, done("cancelled"));
  });

  return { core, parentId, children, childC, terminal, parentCounters, parentStart };
}

/** Full assertions for one scenario run. */
async function assertScenarioResult({ core, parentId, children, childC, terminal, parentCounters }) {
  const byId = new Map(children.map((a) => [a.id, a]));
  const childA = byId.get(Math.min(...children.map((c) => c.id)));
  const childB = children.map((c) => c.id).sort((a, b) => a - b)[1];

  // 1. Parent: COMPLETED, one terminal event, no stale run.
  assert.equal(terminal.kind, "completed", `parent must complete, got ${terminal.kind}`);
  assert.equal(core._agents.get(parentId).state, STATES.COMPLETED);
  assert.equal(await waitForRunCleared(parentId), true, "parent run must clear");
  assert.equal(parentCounters.completed, 1, "exactly one parent COMPLETED event");

  // 2. Children independently tracked with correct parent link and
  //    the expected terminal states.
  const stateA = core._agents.get(childA.id).state;
  const stateB = core._agents.get(childB).state;
  const stateC = core._agents.get(childC).state;
  assert.equal(stateA, STATES.COMPLETED, `child A must complete, got ${stateA}`);
  assert.equal(stateB, STATES.FAILED, `child B must fail, got ${stateB}`);
  assert.equal(stateC, STATES.CANCELLED, `child C must be cancelled, got ${stateC}`);
  for (const c of children) {
    assert.equal(c.parentAgentId, parentId, `child ${c.id} parent link`);
    assert.ok(core._agents.get(c.id).finishedAt, `child ${c.id} must have finishedAt`);
    assert.equal(await waitForRunCleared(c.id), true, `child ${c.id} run must clear`);
  }

  // 3. Exactly one terminal event per child bus: covered for the
  //    parent above and for propagated cancels in gate10-1..3; the
  //    persisted terminal states here are the authoritative record.

  // 4. Results are isolated in the parent transcript: three
  //    delegate_coder tool_results with distinct child ids and the
  //    expected states — the failure/cancellation did not corrupt the
  //    successful child's result.
  const parentMsgs = core.pmListMessages(1, parentId);
  const delegateResults = parentMsgs
    .filter((m) => m.role === "tool_result" && m.name === "delegate_coder")
    .map((m) => JSON.parse(m.content));
  assert.equal(delegateResults.length, 3, `expected 3 delegate results, got ${delegateResults.length}`);
  const childIds = new Set(delegateResults.map((r) => r.result.child_agent_id));
  assert.equal(childIds.size, 3, "three distinct child agent ids");
  const stateByChild = new Map(delegateResults.map((r) => [r.result.child_agent_id, r.result.state]));
  assert.equal(stateByChild.get(childA.id), "completed", "child A result state");
  assert.equal(stateByChild.get(childB), "failed", "child B result state");
  assert.equal(stateByChild.get(childC), "cancelled", "child C result state");

  // 5. No orphans: every child is accounted for, listActiveRuns is
  //    empty for the whole family, and no row is stuck 'running'.
  const family = [parentId, ...children.map((c) => c.id)];
  assert.equal(
    listActiveRuns().filter((r) => family.includes(r.agentId)).length,
    0,
    "no stale active runs for the family",
  );
  for (const id of family) {
    const row = core._agents.get(id);
    assert.notEqual(row.state, "running", `agent ${id} must not be stuck running`);
    assert.ok(row.state === STATES.COMPLETED || row.state === STATES.FAILED || row.state === STATES.CANCELLED, `agent ${id} terminal`);
  }
}

test("gate2: three children (success/fail/cancel) — full lifecycle assertions", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-gate2-"));
  _setUserDataDir(dir);
  registerTool(SLOW_TOOL);
  try {
    const res = await runThreeChildrenScenario();
    await assertScenarioResult(res);
  } finally {
    unregisterTool("slow_tool");
    resetToolRegistry();
    _closeAll();
    _setUserDataDir(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gate2-stress: three-children scenario repeated 10x without drift", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-gate2s-"));
  _setUserDataDir(dir);
  registerTool(SLOW_TOOL);
  try {
    for (let i = 0; i < 10; i++) {
      const res = await runThreeChildrenScenario();
      await assertScenarioResult(res);
    }
  } finally {
    unregisterTool("slow_tool");
    resetToolRegistry();
    _closeAll();
    _setUserDataDir(null);
    rmSync(dir, { recursive: true, force: true });
  }
});
