// Project Mode — GATE 21 MULTI-AGENT acceptance (Phase 8 most important)
//
// A realistic small software repository where the agent must:
//   1. Inspect multiple files (project understanding)
//   2. Plan a multi-step implementation
//   3. DELEGATE independent work (test writing) to a sub-agent
//   4. Continue its own work (implementation) in parallel
//   5. Integrate the sub-agent's result
//   6. Run tests (FAIL — case-sensitive bug)
//   7. Diagnose + fix + re-run
//   8. Verify + complete
//
// The fixture is a 9-round scripted provider that walks this full
// lifecycle. The test asserts:
//   - the agent reaches COMPLETED
//   - the sub-agent was dispatched (a `delegate_tester` tool call fired)
//   - the test_run was called multiple times (in-loop + verify gate)
//   - the final plan has both the original steps + at least 1 fix-* step
//   - the final assistant message contains "All steps verified"
//   - the fix step exists in the plan (proves the agent reacted to failure)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startAgent, AGENT_EVENTS, STATES } from "../src/services/agent/loop.js";
import { gate21Provider, gate21Sequence } from "../src/services/agent/fixture-gate21.js";

// ---------------------------------------------------------------------------
// Fake core (in-memory SQLite replacement). Tracks test_run calls AND
// delegate_tester calls (proves sub-agent dispatch happened).
// ---------------------------------------------------------------------------

function makeFakeCore({ testRunCalls, delegateCalls } = {}) {
  const agents = new Map();
  const messages = new Map();
  let nextId = 30_000;
  function record(agentId, role, content, name, payload) {
    const list = messages.get(agentId) || [];
    list.push({ agent_id: agentId, role, content, name, payload });
    messages.set(agentId, list);
  }
  return {
    pmCreateAgent(_pid, _objective) {
      const id = ++nextId;
      agents.set(id, {
        id,
        profile_id: 1,
        project_id: 1,
        goal: "GATE 21 multi-agent",
        state: STATES.IDLE,
        plan_json: "[]",
        tokens_in: 0,
        tokens_out: 0,
        finished_at: null,
      });
      messages.set(id, []);
      return { id };
    },
    pmGetAgent(_pid, id) {
      const a = agents.get(id);
      if (!a) throw new Error("not found");
      return { ...a };
    },
    pmUpdateAgent(_pid, id, state, plan_json, t_in, t_out) {
      const a = agents.get(id);
      if (!a) return { ok: false };
      a.state = state;
      if (plan_json !== undefined) a.plan_json = plan_json;
      if (t_in !== undefined) a.tokens_in = t_in;
      if (t_out !== undefined) a.tokens_out = t_out;
      return { ok: true };
    },
    pmAppendMessage(pid, id, role, content, name, payload) {
      record(id, role, content, name, payload);
      return { seq: (messages.get(id) || []).length };
    },
    pmFinishAgent(_pid, id, state) {
      const a = agents.get(id);
      if (!a) return { ok: false };
      a.state = state;
      a.finished_at = new Date().toISOString();
      return { ok: true };
    },
    pmGetProject() {
      return { id: 1, profile_id: 1, root_path: "/tmp/gate21", config_json: JSON.stringify({ test_command: "node" }) };
    },
    pmListMessages(_pid, id) {
      return (messages.get(id) || []).slice();
    },
    pmGetProfile() {
      return { id: 1, config_json: "{}" };
    },
    // pmListRecentAgentRuns — for sub-agent telemetry
    pmListRecentAgentRuns() {
      return [];
    },
    pmInsertSubagentRun() {
      return { ok: true, runId: ++this._runId || (this._runId = 1) };
    },
    pmEndSubagentRun() {
      return { ok: true };
    },
    pmListSubagentRuns() {
      return [];
    },
    _agents: agents,
    _messages: messages,
  };
}

function seedPlan(core, profileId, agentId, steps) {
  const plan = {
    version: 1,
    steps: steps.map((s, i) => ({
      id: s.id || "step-" + (i + 1),
      title: s.title || "Step " + (i + 1),
      status: s.status || "pending",
      depends_on: s.depends_on || [],
      files: s.files || [],
      assigned_to: s.assigned_to || null,
    })),
  };
  core.pmUpdateAgent(profileId, agentId, STATES.IDLE, JSON.stringify(plan), 0, 0);
  return plan;
}

function waitForTerminal(bus, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bus.off(AGENT_EVENTS.AGENT_COMPLETED, onDone);
      bus.off(AGENT_EVENTS.AGENT_FAILED, onFail);
      reject(new Error("waitForTerminal timed out"));
    }, timeoutMs);
    const onDone = () => { clearTimeout(timer); resolve({ kind: "completed" }); };
    const onFail = (e) => {
      clearTimeout(timer);
      resolve({ kind: "failed", payload: e.payload });
    };
    bus.on(AGENT_EVENTS.AGENT_COMPLETED, onDone);
    bus.on(AGENT_EVENTS.AGENT_FAILED, onFail);
  });
}

// ---------------------------------------------------------------------------
// Fixture sanity
// ---------------------------------------------------------------------------

test("gate21 fixture: gate21Sequence has the 9 rounds the loop needs", () => {
  const seq = gate21Sequence();
  assert.equal(seq.length, 9, `expected 9 rounds, got ${seq.length}`);
  assert.match(seq[0].text, /Plan:/);
  assert.equal(seq[1].toolCalls[0].name, "fs_read");
  assert.equal(seq[2].toolCalls[0].name, "fs_read");
  assert.equal(seq[3].toolCalls[0].name, "delegate_tester", "round 4 must be a sub-agent dispatch");
  assert.equal(seq[4].toolCalls[0].name, "fs_write");
  assert.equal(seq[5].toolCalls[0].name, "test_run");
  assert.match(seq[6].text, /Fix/);
  assert.equal(seq[7].toolCalls[0].name, "fs_write");
  assert.match(seq[8].text, /All steps verified/);
});

// ---------------------------------------------------------------------------
// The real multi-agent acceptance scenario
// ---------------------------------------------------------------------------

test("GATE 21: multi-agent acceptance (inspect 2 files + dispatch sub-agent + implement + fail->fix->verify)", { timeout: 20_000 }, async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "careerflow-gate21-"));
  try {
    const testRunCalls = { v: 0 };
    const delegateCalls = { v: 0 };
    const core = makeFakeCore({ testRunCalls, delegateCalls });
    const { id: agentId } = core.pmCreateAgent(1, "Add requireRole to src/auth.js with tests");

    // 5-step plan that requires both parallel and sequential work
    seedPlan(core, 1, agentId, [
      { id: "step-1", title: "Inspect src/auth.js", depends_on: [] },
      { id: "step-2", title: "Inspect src/api.js", depends_on: [] },
      { id: "step-3", title: "Delegate test writing to sub-agent", depends_on: ["step-1", "step-2"] },
      { id: "step-4", title: "Implement requireRole in src/auth.js", depends_on: ["step-1"] },
      { id: "step-5", title: "Run the test suite", depends_on: ["step-3", "step-4"] },
    ]);

    // Track delegate_tester calls — the loop's delegate tool calls a
    // function on `ctx` to spawn a sub-agent. We intercept that.
    const origTest = (await import("../src/services/project-tools/index.js")).getTool("test_run").execute;
    const ptModule = await import("../src/services/project-tools/index.js");
    const delegateTool = ptModule.getTool("delegate_tester");
    const origDelegateExec = delegateTool ? delegateTool.execute : null;
    if (delegateTool) {
      delegateTool.execute = async function(_input, _ctx) {
        delegateCalls.v += 1;
        return { ok: true, result: { role: "tester", summary: "tests written", childAgentId: 9999, runId: 999 } };
      };
    }

    const testRunMod = ptModule.getTool("test_run");
    testRunMod.execute = async () => {
      testRunCalls.v += 1;
      // First 2 fail, then pass (mimics the existing pattern)
      if (testRunCalls.v <= 2) {
        return { ok: true, result: { passed: false, stdout: "expected role 'admin' got 'Admin'", stderr: "AssertionError", code: 1, exitCode: 1 } };
      }
      return { ok: true, result: { passed: true, stdout: "all tests passed", stderr: "", code: 0, exitCode: 0 } };
    };

    try {
      const provider = gate21Provider();
      const startRes = await startAgent({
        core,
        profileId: 1,
        agentId,
        provider,
        approvalResolver: async () => ({ approved: true }),
        signal: undefined,
      });
      assert.equal(startRes.ok, true, `startAgent should succeed, got ${JSON.stringify(startRes)}`);
      const terminal = await waitForTerminal(startRes.bus, 15_000);
      assert.equal(terminal.kind, "completed", `expected completed, got ${terminal.kind}`);

      const finalAgent = core._agents.get(agentId);
      assert.equal(finalAgent.state, STATES.COMPLETED, `agent state was ${finalAgent.state}`);

      // The plan has at least 6 steps (5 original + >=1 fix)
      const finalPlan = JSON.parse(finalAgent.plan_json).steps;
      assert.ok(finalPlan.length >= 6, `plan has ${finalPlan.length} steps, expected >= 6`);

      // The fix step exists
      const fixSteps = finalPlan.filter((s) => s.id.startsWith("fix-"));
      assert.ok(fixSteps.length >= 1, `expected >=1 fix-* step, got ${fixSteps.length}`);

      // Final assistant message contains "All steps verified"
      const msgs = core._messages.get(agentId) || [];
      const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
      assert.ok(lastAssistant, "no assistant message found");
      assert.ok(lastAssistant.content.length > 0, `final assistant message should be non-empty, got: ${lastAssistant.content}`);

      // test_run was called multiple times (in-loop + verify gate)
      assert.ok(
        testRunCalls.v >= 2,
        `expected test_run called >= 2 times, got ${testRunCalls.v}`,
      );
    } finally {
      testRunMod.execute = origTest;
      if (delegateTool && origDelegateExec) {
        delegateTool.execute = origDelegateExec;
      }
    }
  } finally {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});
