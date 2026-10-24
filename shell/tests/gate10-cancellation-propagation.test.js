// Project Mode — GATE 1 (Phase 10): sub-agent CANCELLATION PROPAGATION (P0).
//
// Phase 9 left this unimplemented: cancelling a parent did not abort
// its in-flight children. This file proves the new contract:
//
//   1. Parent cancel propagates through the delegate_* path: the
//      child's controller is aborted, the child persists `cancelled`,
//      the parent persists `cancelled`, both run slots clear, and a
//      second cancelAgent refuses with `not-running` (idempotent).
//      Runs against a NAPI-SHAPED core (camelCase rows) to also prove
//      the row-field normalization fix.
//   2. Same scenario against the classic snake_case fake core.
//   3. cancelAgent aborts a 3-generation tree
//      PARENT → {CHILD A → GRANDCHILD A1, CHILD B} via the run-registry
//      walk; every descendant persists `cancelled` with exactly ONE
//      terminal event each (no duplicate finalization).
//   4. Cancel during verification cannot commit COMPLETED afterwards
//      (the verify-gate race is closed).
//   5. runDelegate releases the parent's in-flight slot on EVERY exit
//      path (cancel + success) and aborts the child controller it
//      attached.

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
  _attachInFlightForTest,
  AGENT_EVENTS,
  STATES,
} from "../src/services/agent/loop.js";
import { runDelegate } from "../src/services/project-tools/delegate_research.js";
import { scriptedProvider } from "../src/services/agent/fixture.js";
import {
  register as registerTool,
  unregister as unregisterTool,
  _resetForTests as resetToolRegistry,
} from "../src/services/project-tools/index.js";
import { parsePlan } from "../src/services/agent/plan.js";
import { _setUserDataDir, _closeAll } from "../src/services/memory/index.js";

// ---------------------------------------------------------------------------
// Hanging tool: stays in execute() until its agent's cancel signal fires.
// ---------------------------------------------------------------------------

const SLOW_TOOL = {
  name: "slow_tool",
  description: "test-only tool that hangs until ctx.isCancellable()",
  permission: "EXECUTE",
  inputSchema: { type: "object", properties: {}, required: [] },
  outputSchema: { type: "object" },
  timeoutMs: 60_000,
  async execute(_input, ctx) {
    // 15s cap: 3000x the 5ms poll interval — plenty of margin for the
    // cancel signal, and short enough that a failure leaves no long
    // timer tails in the test process.
    for (let i = 0; i < 3_000; i++) {
      if (ctx && typeof ctx.isCancellable === "function" && ctx.isCancellable()) {
        return {
          ok: false,
          error: { code: "aborted", message: "tool aborted by caller" },
          elapsedMs: i * 5,
        };
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    return { ok: true, result: { value: "never" }, elapsedMs: 15_000 };
  },
};

function slowToolProvider() {
  return scriptedProvider([
    { toolCalls: [{ id: "tc-slow", name: "slow_tool", args: "{}" }], finishReason: "tool_calls" },
  ]);
}

// ---------------------------------------------------------------------------
// Fake cores. `style: "napi"` emits camelCase rows exactly like the real
// @progress-ledger/core (see core/index.d.ts); `style: "snake"` emits the
// classic snake_case shape used by the older test fakes.
// ---------------------------------------------------------------------------

let nextAgentIdSeq = 80_000;

function makeFakeCore(style = "snake", { testCommand = null } = {}) {
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

  const projectRow =
    style === "napi"
      ? {
          id: 10,
          profileId: 1,
          name: "gate10 project",
          description: "napi-shaped",
          rootPath: "/tmp/gate10",
          configJson: JSON.stringify(testCommand ? { test_command: testCommand } : {}),
          createdAt: "1970-01-01T00:00:00Z",
          updatedAt: "1970-01-01T00:00:00Z",
        }
      : {
          id: 10,
          profile_id: 1,
          name: "gate10 project",
          description: "snake-shaped",
          root_path: "/tmp/gate10",
          config_json: JSON.stringify(testCommand ? { test_command: testCommand } : {}),
          created_at: "1970-01-01T00:00:00Z",
          updated_at: "1970-01-01T00:00:00Z",
        };

  const core = {
    pmCreateAgent(_projectId, objective, parentAgentId) {
      const id = nextAgentIdSeq++;
      const row = {
        id,
        objective,
        state: STATES.IDLE,
        finished: false,
        finishedAt: null,
        parentAgentId: typeof parentAgentId === "number" ? parentAgentId : null,
        parent_agent_id: typeof parentAgentId === "number" ? parentAgentId : null,
      };
      if (style === "napi") {
        row.projectId = 10;
        row.planJson = "[]";
        row.tokensIn = 0;
        row.tokensOut = 0;
      } else {
        row.project_id = 10;
        row.plan_json = "[]";
        row.tokens_in = 0;
        row.tokens_out = 0;
        row.finished_at = null;
      }
      agents.set(id, row);
      messages.set(id, []);
      return { id };
    },
    pmGetAgent(_profileId, agentId) {
      const a = agents.get(agentId);
      if (!a) return null;
      if (style === "napi") {
        return {
          id: a.id,
          projectId: a.projectId,
          objective: a.objective,
          state: a.state,
          planJson: a.planJson,
          tokensIn: a.tokensIn,
          tokensOut: a.tokensOut,
          finishedAt: a.finishedAt,
          parentAgentId: a.parentAgentId,
          createdAt: "1970-01-01T00:00:00Z",
          updatedAt: new Date().toISOString(),
        };
      }
      return { ...a };
    },
    pmUpdateAgent(_profileId, agentId, state, planJson, tokensIn, tokensOut) {
      const a = agents.get(agentId);
      if (!a) return { ok: false };
      a.state = state;
      if (style === "napi") {
        a.planJson = planJson;
        a.tokensIn = tokensIn;
        a.tokensOut = tokensOut;
      } else {
        a.plan_json = planJson;
        a.tokens_in = tokensIn;
        a.tokens_out = tokensOut;
      }
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
      if (style === "snake") a.finished_at = a.finishedAt;
    },
    pmListMessages(_profileId, agentId) {
      const list = messages.get(agentId) || [];
      return [...list].sort((x, y) => x.seq - y.seq);
    },
    pmGetProject(_profileId, _projectId) {
      return { ...projectRow };
    },
    pmGetProfile(_profileId) {
      return style === "napi" ? { id: _profileId, profileConfig: null } : { id: _profileId, profile_config: null };
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
    _agents: agents,
    _messages: messages,
    // Wire child starts through the REAL loop with a hanging provider so
    // delegate-created children actually run (and hang until cancelled).
    startAgent(args) {
      return startAgent({ ...args, core, provider: slowToolProvider() });
    },
  };
  return core;
}

function withTempUserData(fn) {
  const dir = mkdtempSync(join(tmpdir(), "cf-gate10-"));
  _setUserDataDir(dir);
  return Promise.resolve(fn()).finally(() => {
    try { resetToolRegistry(); } catch (_e) { /* best effort */ }
    try { _closeAll(); } catch (_e) { /* best effort */ }
    try { _setUserDataDir(null); } catch (_e) { /* best effort */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  });
}

async function waitFor(cond, { timeoutMs = 5000, stepMs = 5 } = {}) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function waitForTerminal(bus, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("waitForTerminal timed out")), timeoutMs);
    const done = (kind) => (e) => {
      clearTimeout(timer);
      resolve({ kind, payload: e && e.payload });
    };
    bus.on(AGENT_EVENTS.AGENT_COMPLETED, done("completed"));
    bus.on(AGENT_EVENTS.AGENT_FAILED, done("failed"));
    bus.on(AGENT_EVENTS.AGENT_CANCELLED, done("cancelled"));
  });
}

async function waitForRunCleared(agentId, { timeoutMs = 5000 } = {}) {
  const start = Date.now();
  while (getRun(agentId) !== null) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

function seedPlan(core, agentId, steps) {
  const plan = {
    version: 1,
    steps: steps.map((s, i) => ({
      id: s.id || `step-${i + 1}`,
      title: s.title || `Step ${i + 1}`,
      status: s.status || "pending",
      depends_on: s.depends_on || [],
      files: [],
      assigned_to: s.assigned_to || null,
    })),
  };
  core.pmUpdateAgent(1, agentId, STATES.PLANNING, JSON.stringify(plan), 0, 0);
  return plan;
}

// ---------------------------------------------------------------------------
// TEST 1 + 2: parent cancel → delegate-path propagation (napi + snake cores)
// ---------------------------------------------------------------------------

async function delegateCancelScenario(style) {
  const core = makeFakeCore(style);
  const { id: parentId } = core.pmCreateAgent(10, "parent with child");
  seedPlan(core, parentId, [{ id: "step-1", title: "Delegate work" }]);

  const cancelEvents = { parent: 0, child: 0 };
  const startRes = await startAgent({
    core,
    profileId: 1,
    agentId: parentId,
    provider: scriptedProvider([
      {
        toolCalls: [
          {
            id: "tc-del",
            name: "delegate_coder",
            args: JSON.stringify({ objective: "do slow work", step_id: "step-1" }),
          },
        ],
        finishReason: "tool_calls",
      },
    ]),
  });
  assert.equal(startRes.ok, true, `startAgent must succeed: ${JSON.stringify(startRes)}`);
  startRes.bus.on(AGENT_EVENTS.AGENT_CANCELLED, () => { cancelEvents.parent += 1; });

  // Wait for the child to appear and reach EXECUTING_TOOL (hung in slow_tool).
  const childId = await (async () => {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      for (const [id, row] of core._agents) {
        if (id !== parentId && row.parentAgentId === parentId && getRun(id)) return id;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("child run never appeared");
  })();
  const childStart = getRun(childId);
  assert.ok(childStart, "child must be registered in RUNS");
  childStart.bus.on(AGENT_EVENTS.AGENT_CANCELLED, () => { cancelEvents.child += 1; });
  await waitFor(() => core._agents.get(childId).state === STATES.EXECUTING_TOOL);

  // Cancel the PARENT via the production IPC path.
  const cancelRes = cancelAgent(parentId);
  assert.equal(cancelRes.ok, true, "cancelAgent(parent) must succeed");
  assert.ok(
    Array.isArray(cancelRes.cancelledChildren) && cancelRes.cancelledChildren.includes(childId),
    `cancelAgent must report the aborted child, got ${JSON.stringify(cancelRes.cancelledChildren)}`,
  );

  // Parent terminates cancelled.
  const terminal = await waitForTerminal(startRes.bus);
  assert.equal(terminal.kind, "cancelled", `parent must cancel, got ${terminal.kind}`);

  // Child persists CANCELLED with finished_at set (its own loop is the
  // only finalizer — no duplicate, no zombie).
  await waitFor(() => core._agents.get(childId).state === STATES.CANCELLED);
  assert.ok(core._agents.get(childId).finishedAt, "child must have finishedAt set");

  // Parent persists CANCELLED.
  assert.equal(core._agents.get(parentId).state, STATES.CANCELLED, "parent must persist cancelled");

  // No zombie runs.
  assert.equal(await waitForRunCleared(parentId), true, "parent RUNS entry must clear");
  assert.equal(await waitForRunCleared(childId), true, "child RUNS entry must clear");
  assert.equal(listActiveRuns().filter((r) => r.agentId === parentId || r.agentId === childId).length, 0);

  // Exactly one terminal event per agent (no duplicate finalization).
  assert.equal(cancelEvents.parent, 1, `parent AGENT_CANCELLED count, got ${cancelEvents.parent}`);
  assert.equal(cancelEvents.child, 1, `child AGENT_CANCELLED count, got ${cancelEvents.child}`);

  // Idempotent: cancelling non-running agents refuses.
  assert.deepEqual(cancelAgent(parentId), { ok: false, reason: "not-running" });
  assert.deepEqual(cancelAgent(childId), { ok: false, reason: "not-running" });
}

test("gate10-1: parent cancel propagates to delegate child (NAPI camelCase core)", { timeout: 20_000 }, async () => {
  await withTempUserData(async () => {
    registerTool(SLOW_TOOL);
    try {
      await delegateCancelScenario("napi");
    } finally {
      unregisterTool("slow_tool");
    }
  });
});

test("gate10-2: parent cancel propagates to delegate child (classic snake_case core)", { timeout: 20_000 }, async () => {
  await withTempUserData(async () => {
    registerTool(SLOW_TOOL);
    try {
      await delegateCancelScenario("snake");
    } finally {
      unregisterTool("slow_tool");
    }
  });
});

// ---------------------------------------------------------------------------
// TEST 3: three-generation tree — cancelAgent aborts the whole subtree
// ---------------------------------------------------------------------------

test("gate10-3: cancelAgent aborts PARENT → {CHILD A → GRANDCHILD, CHILD B} transitively", { timeout: 20_000 }, async () => {
  await withTempUserData(async () => {
    registerTool(SLOW_TOOL);
    try {
      const core = makeFakeCore("napi");
      const { id: parentId } = core.pmCreateAgent(10, "tree parent");

      const parentStart = await startAgent({
        core, profileId: 1, agentId: parentId, provider: slowToolProvider(),
      });
      assert.equal(parentStart.ok, true);

      // CHILD A + CHILD B (sub-agents of parent) and GRANDCHILD A1
      // (sub-agent of CHILD A). Each hangs in slow_tool.
      const { id: childA } = core.pmCreateAgent(10, "child A", parentId);
      const { id: childB } = core.pmCreateAgent(10, "child B", parentId);
      const { id: grandchildA1 } = core.pmCreateAgent(10, "grandchild A1", childA);

      const starts = { [parentId]: parentStart };
      for (const id of [childA, childB, grandchildA1]) {
        const r = await startAgent({
          core, profileId: 1, agentId: id, isSubAgent: true,
          role: id === grandchildA1 ? "coder" : "researcher",
          provider: slowToolProvider(),
        });
        assert.equal(r.ok, true, `startAgent(${id}) must succeed: ${JSON.stringify(r)}`);
        starts[id] = r;
      }

      // Register the in-flight links exactly the way runDelegate's
      // subAgentSlotAttach does in production.
      assert.equal(_attachInFlightForTest(parentId, childA, { controller: starts[childA].controller }), true);
      assert.equal(_attachInFlightForTest(parentId, childB, { controller: starts[childB].controller }), true);
      assert.equal(_attachInFlightForTest(childA, grandchildA1, { controller: starts[grandchildA1].controller }), true);

      const terminalCounts = new Map(
        [parentId, childA, childB, grandchildA1].map((id) => [id, { c: 0, kind: null }]),
      );
      for (const id of terminalCounts.keys()) {
        starts[id].bus.on(AGENT_EVENTS.AGENT_CANCELLED, () => {
          terminalCounts.get(id).c += 1;
          terminalCounts.get(id).kind = "cancelled";
        });
      }

      // Wait until every loop is hung inside slow_tool.
      await waitFor(() =>
        [parentId, childA, childB, grandchildA1].every(
          (id) => core._agents.get(id).state === STATES.EXECUTING_TOOL,
        ),
      );

      const cancelRes = cancelAgent(parentId);
      assert.equal(cancelRes.ok, true);
      assert.deepEqual(
        [...cancelRes.cancelledChildren].sort((a, b) => a - b),
        [childA, childB, grandchildA1].sort((a, b) => a - b),
        `BFS must reach all three descendants, got ${JSON.stringify(cancelRes.cancelledChildren)}`,
      );

      // Every generation reaches persisted CANCELLED with finishedAt.
      for (const id of [parentId, childA, childB, grandchildA1]) {
        await waitFor(() => core._agents.get(id).state === STATES.CANCELLED);
        assert.ok(core._agents.get(id).finishedAt, `agent ${id} must have finishedAt`);
        assert.equal(await waitForRunCleared(id), true, `run slot for ${id} must clear`);
        assert.equal(terminalCounts.get(id).c, 1, `agent ${id} must emit exactly ONE AGENT_CANCELLED`);
        assert.equal(terminalCounts.get(id).kind, "cancelled");
      }

      // Idempotent.
      assert.deepEqual(cancelAgent(parentId), { ok: false, reason: "not-running" });
    } finally {
      unregisterTool("slow_tool");
    }
  });
});

// ---------------------------------------------------------------------------
// TEST 4: cancel during verification must NOT commit COMPLETED
// ---------------------------------------------------------------------------

test("gate10-4: cancel while the verification gate runs ends CANCELLED, not COMPLETED", { timeout: 20_000 }, async () => {
  await withTempUserData(async () => {
    const core = makeFakeCore("snake", { testCommand: "node" });
    const { id: agentId } = core.pmCreateAgent(10, "verify race");
    seedPlan(core, agentId, [{ id: "step-1", title: "Done work", status: "done" }]);

    // Slow down verification deterministically: patch the static test_run
    // tool's execute (same pattern as the gate21 harness).
    const ptModule = await import("../src/services/project-tools/index.js");
    const testRunTool = ptModule.getTool("test_run");
    const origExecute = testRunTool.execute;
    testRunTool.execute = async () => {
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true, result: { passed: true, stdout: "ok", exitCode: 0 }, elapsedMs: 400 };
    };

    try {
      const abortExternal = new AbortController();
      const startRes = await startAgent({
        core, profileId: 1, agentId,
        provider: scriptedProvider([{ text: "done", finishReason: "stop" }]),
        signal: abortExternal.signal,
      });
      assert.equal(startRes.ok, true);

      // Wait until the loop entered VERIFYING (persisted), then abort.
      await waitFor(() => core._agents.get(agentId).state === STATES.VERIFYING);
      abortExternal.abort();

      const terminal = await waitForTerminal(startRes.bus);
      assert.equal(
        terminal.kind,
        "cancelled",
        `agent cancelled during verification must NOT complete, got ${terminal.kind}`,
      );
      assert.equal(core._agents.get(agentId).state, STATES.CANCELLED);
      assert.equal(await waitForRunCleared(agentId), true);
    } finally {
      testRunTool.execute = origExecute;
    }
  });
});

// ---------------------------------------------------------------------------
// TEST 5: runDelegate slot discipline + child-controller abort
// ---------------------------------------------------------------------------

test("gate10-5: runDelegate releases the in-flight slot on cancel AND success, aborts attached child", { timeout: 20_000 }, async () => {
  await withTempUserData(async () => {
    const slot = new Map();
    const input = { objective: "x", step_id: "s1" };

    function makeDirectCore({ childRow, parentRow }) {
      return {
        pmGetAgent(_p, agentId) {
          if (agentId === 100) return parentRow;
          return typeof childRow === "function" ? childRow() : childRow;
        },
        pmUpdateAgent() { return { ok: true }; },
        pmListMessages() { return []; },
        pmCreateAgent() { return { id: 555 }; },
        startAgent: null, // set per scenario
      };
    }

    function makeCtx(core, { cancelFlag }) {
      const watchers = [];
      return {
        core,
        profileId: 1,
        agentId: 100,
        projectId: 10,
        isCancellable: () => cancelFlag.value,
        nowMs: () => Date.now(),
        subAgentSlotAvailable: () => slot.size < 3,
        subAgentSlotReserve: (id) => { slot.set(id, {}); return true; },
        subAgentSlotAttach: (id, info) => {
          const cur = slot.get(id);
          if (!cur) return false;
          Object.assign(cur, info || {});
          return true;
        },
        subAgentSlotRelease: (id) => { slot.delete(id); },
        subAgentInFlight: () => slot.size,
        onCancelled: (cb) => {
          watchers.push(cb);
          return () => watchers.splice(watchers.indexOf(cb), 1);
        },
        _watchers: watchers,
      };
    }

    // ---- Scenario A: parent cancelled mid-poll ----
    {
      const childCtrl = new AbortController();
      const core = makeDirectCore({
        parentRow: { id: 100, plan_json: "[]" },
        childRow: () =>
          childCtrl.signal.aborted
            ? { id: 555, state: "cancelled", finished_at: new Date().toISOString() }
            : { id: 555, state: "executing_tool" },
      });
      core.startAgent = async () => ({ ok: true, runId: "child-run", controller: childCtrl });
      const cancelFlag = { value: false };
      const ctx = makeCtx(core, { cancelFlag });

      const promise = runDelegate("coder", input, ctx);
      await waitFor(() => slot.size === 1);
      const childId = [...slot.keys()][0];
      await waitFor(() => slot.get(childId) && slot.get(childId).controller === childCtrl);

      cancelFlag.value = true;
      for (const cb of ctx._watchers) cb(); // simulate the abort wake

      const res = await promise;
      assert.equal(res.ok, false, "cancelled delegate must return an error envelope");
      assert.equal(res.error && res.error.code, "cancelled");
      assert.equal(childCtrl.signal.aborted, true, "child controller must be aborted on parent cancel");
      assert.equal(slot.size, 0, "slot must be released after the cancel path");
    }

    // ---- Scenario B: child completes normally ----
    {
      const childCtrl = new AbortController();
      const core = makeDirectCore({
        parentRow: { id: 100, plan_json: "[]" },
        childRow: { id: 556, state: "completed", finished_at: new Date().toISOString() },
      });
      core.startAgent = async () => ({ ok: true, runId: "child-run-2", controller: childCtrl });
      const ctx = makeCtx(core, { cancelFlag: { value: false } });

      const res = await runDelegate("coder", input, ctx);
      assert.equal(res.ok, true, `success-path delegate must resolve, got ${JSON.stringify(res)}`);
      assert.equal(res.result.state, "completed");
      assert.equal(childCtrl.signal.aborted, false, "child must NOT be aborted on the success path");
      assert.equal(slot.size, 0, "slot must be released after success");
    }
  });
});
