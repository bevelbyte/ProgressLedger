// Project Mode — GATE 2: Real agent loop multi-round regression.
//
// Verifies the agent loop:
// 1. Does NOT terminate prematurely after one tool call
// 2. Can chain multiple tool calls (inspect -> read -> write -> test -> fix)
// 3. Reacts to tool failure (e.g. test_run FAIL -> fix-retry path)
// 4. Can call another tool after consuming a result
// 5. Loops correctly through planning -> execution -> verification -> completion
//
// Built from first principles (not derived from defaultE2ESequence) so it
// catches regressions where the existing fixture becomes accidentally
// coupled to the loop's internal behavior.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startAgent, AGENT_EVENTS, STATES } from "../src/services/agent/loop.js";
import { PROJECT_TOOLS } from "../src/services/project-tools/index.js";
import { scriptedProvider } from "../src/services/agent/fixture.js";

// ---------------------------------------------------------------------------
// In-memory fake core. Mirrors the shape used by agent-e2e.test.js but
// is a fresh implementation here so the test stands on its own.
// ---------------------------------------------------------------------------

function makeCore() {
  const agents = new Map();
  const messages = new Map();
  let nextId = 10_000;
  function seed(id, plan) {
    agents.set(id, {
      id,
      profile_id: 1,
      project_id: 1,
      goal: "GATE 2 multi-round",
      state: STATES.IDLE,
      plan_json: JSON.stringify({ steps: plan }),
      tokens_in: 0,
      tokens_out: 0,
      finished_at: null,
    });
    messages.set(id, []);
  }
  function record(agentId, role, content, name, payload) {
    const list = messages.get(agentId) || [];
    list.push({ id: list.length + 1, agent_id: agentId, role, content, name, payload });
    messages.set(agentId, list);
  }
  return {
    pmCreateAgent(_pid, _objective) {
      const id = ++nextId;
      seed(id, []);
      return { id };
    },
    pmGetAgent(_pid, id) {
      const a = agents.get(id);
      if (!a) throw new Error("unknown agent " + id);
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
      return { id: 1, profile_id: 1, root_path: "/tmp/gate2", config_json: JSON.stringify({ test_command: "node" }) };
    },
    pmListMessages(_pid, id) {
      return (messages.get(id) || []).slice();
    },
    pmGetProfile() {
      return { id: 1, config_json: "{}" };
    },
    _agents: agents,
    _messages: messages,
    _seed: seed,
  };
}

// ---------------------------------------------------------------------------
// GATE 2 tests
// ---------------------------------------------------------------------------

test("GATE 2: agent does NOT terminate after one tool call", { timeout: 15_000 }, async () => {
  const core = makeCore();
  const created = core.pmCreateAgent(1, "multi-round");
  const agentId = created.id;
  core._seed(agentId, [
    { id: "step-1", title: "Read", depends_on: [], status: "pending", files: [], assigned_to: null },
    { id: "step-2", title: "Write", depends_on: ["step-1"], status: "pending", files: [], assigned_to: null },
    { id: "step-3", title: "Test", depends_on: ["step-2"], status: "pending", files: [], assigned_to: null },
  ]);

  // Provider: text-plan -> inspect_project -> fs_write -> test_run (fail)
  // -> text-fix -> fs_write-fix -> text-summary
  const provider = scriptedProvider([
    { text: "Plan: 1) Read 2) Write 3) Test.", finishReason: "stop" },
    { toolCalls: [{ id: "t1", name: "inspect_project", args: "{}" }], finishReason: "tool_calls" },
    { toolCalls: [{ id: "t2", name: "fs_write", args: JSON.stringify({ path: "/tmp/gate2/x.js", content: "ok" }) }], finishReason: "tool_calls" },
    { toolCalls: [{ id: "t3", name: "test_run", args: JSON.stringify({ command: "node" }) }], finishReason: "tool_calls" },
    { text: "Fix.", finishReason: "stop" },
    { toolCalls: [{ id: "t4", name: "fs_write", args: JSON.stringify({ path: "/tmp/gate2/x.js", content: "ok-fixed" }) }], finishReason: "tool_calls" },
    { text: "All steps verified.", finishReason: "stop" },
  ]);

  // Patch test_run: call 1 FAIL, call 2 PASS (gate)
  const origTest = PROJECT_TOOLS.test_run.execute;
  let testCallCount = 0;
  PROJECT_TOOLS.test_run.execute = async () => {
    testCallCount += 1;
    if (testCallCount === 1) {
      return { ok: true, result: { passed: false, stdout: "", stderr: "fail", code: 1, exitCode: 1 } };
    }
    return { ok: true, result: { passed: true, stdout: "ok", stderr: "", code: 0, exitCode: 0 } };
  };

  try {
    const startRes = await startAgent({ core, profileId: 1, agentId, provider, isSubAgent: false, role: null });
    assert.equal(startRes.ok, true);
    const bus = startRes.bus;
    const terminal = await new Promise((resolve) => {
      bus.on(AGENT_EVENTS.AGENT_COMPLETED, (e) => resolve({ kind: "completed" }));
      bus.on(AGENT_EVENTS.AGENT_FAILED, (e) => resolve({ kind: "failed", reason: e.payload && e.payload.reason }));
    });
    assert.equal(terminal.kind, "completed", `expected completed, got ${terminal.kind} ${JSON.stringify(terminal)}`);

    // The agent made > 1 tool call (inspect + fs_write + test_run + fix-fs_write = 4)
    const msgs = core._messages.get(agentId) || [];
    const toolCalls = msgs.filter((m) => m.role === "tool_call");
    assert.ok(toolCalls.length >= 3, `expected >=3 tool_call rows, got ${toolCalls.length}`);
  } finally {
    PROJECT_TOOLS.test_run.execute = origTest;
  }
});

test("GATE 2: agent chains tool calls (inspect -> write in one round)", { timeout: 15_000 }, async () => {
  // Chain TWO tool calls in a single model round. The plan has 2
  // steps so the verify gate does NOT fire after step-1 completes —
  // the agent must continue to step-2.
  const core = makeCore();
  const created = core.pmCreateAgent(1, "chain");
  const agentId = created.id;
  core._seed(agentId, [
    { id: "step-1", title: "Inspect and write", depends_on: [], status: "pending", files: [], assigned_to: null },
    { id: "step-2", title: "Test", depends_on: ["step-1"], status: "pending", files: [], assigned_to: null },
  ]);
  const origGetProject = core.pmGetProject;
  core.pmGetProject = () => ({ id: 1, profile_id: 1, root_path: "/tmp/gate2", config_json: "{}" });

  // Round 1: plan (text-only, step-1 marked done)
  // Round 2: 2 tool calls in one round (step-2 marked done after tools run)
  // Round 3: final summary (consumed by verify gate's post-success streamChat)
  const provider = scriptedProvider([
    { text: "Plan.", finishReason: "stop" },
    {
      toolCalls: [
        { id: "t1", name: "inspect_project", args: "{}" },
        { id: "t2", name: "fs_write", args: JSON.stringify({ path: "/tmp/gate2/y.js", content: "y" }) },
      ],
      finishReason: "tool_calls",
    },
    { text: "All steps verified.", finishReason: "stop" },
  ]);

  try {
    const startRes = await startAgent({ core, profileId: 1, agentId, provider, isSubAgent: false, role: null });
    assert.equal(startRes.ok, true);
    const bus = startRes.bus;
    await new Promise((resolve) => {
      bus.on(AGENT_EVENTS.AGENT_COMPLETED, resolve);
      bus.on(AGENT_EVENTS.AGENT_FAILED, resolve);
    });

    const msgs = core._messages.get(agentId) || [];
    // The agent must have called BOTH tools in one round
    const toolCalls = msgs.filter((m) => m.role === "tool_call");
    const toolResults = msgs.filter((m) => m.role === "tool_result");
    assert.ok(toolCalls.length >= 1, `expected >=1 tool_call row, got ${toolCalls.length}`);
    assert.ok(toolResults.length >= 2, `expected >=2 tool_result rows (chain), got ${toolResults.length}`);

    // The tool_call row should contain 2 tool calls
    const firstToolCall = JSON.parse(toolCalls[0].content);
    assert.equal(firstToolCall.length, 2, `expected 2 tool calls in one round, got ${firstToolCall.length}`);

    const finalAgent = core._agents.get(agentId);
    assert.equal(finalAgent.state, STATES.COMPLETED, `agent state was ${finalAgent.state}`);
  } finally {
    core.pmGetProject = origGetProject;
  }
});

test("GATE 2: agent reacts to tool failure (test_run FAIL -> fix step)", { timeout: 15_000 }, async () => {
  const core = makeCore();
  const created = core.pmCreateAgent(1, "react");
  const agentId = created.id;
  core._seed(agentId, [
    { id: "step-1", title: "Test", depends_on: [], status: "pending", files: [], assigned_to: null },
  ]);

  const provider = scriptedProvider([
    { text: "Plan.", finishReason: "stop" },
    { toolCalls: [{ id: "t1", name: "test_run", args: JSON.stringify({ command: "node" }) }], finishReason: "tool_calls" },
    { text: "Fixing.", finishReason: "stop" },
    { toolCalls: [{ id: "t2", name: "fs_write", args: JSON.stringify({ path: "/tmp/gate2/z.js", content: "z" }) }], finishReason: "tool_calls" },
    { text: "All steps verified.", finishReason: "stop" },
  ]);

  const origTest = PROJECT_TOOLS.test_run.execute;
  let testCallCount = 0;
  PROJECT_TOOLS.test_run.execute = async () => {
    testCallCount += 1;
    if (testCallCount === 1) {
      return { ok: true, result: { passed: false, stdout: "", stderr: "fail", code: 1, exitCode: 1 } };
    }
    return { ok: true, result: { passed: true, stdout: "ok", stderr: "", code: 0, exitCode: 0 } };
  };

  try {
    const startRes = await startAgent({ core, profileId: 1, agentId, provider, isSubAgent: false, role: null });
    const bus = startRes.bus;
    await new Promise((resolve) => {
      bus.on(AGENT_EVENTS.AGENT_COMPLETED, resolve);
      bus.on(AGENT_EVENTS.AGENT_FAILED, resolve);
    });

    // The fix-retrying status must have been emitted (proves the loop
    // saw the failure and reacted)
    const msgs = core._messages.get(agentId) || [];
    const fixRetrying = msgs.filter((m) => m.role === "status" && m.name === "fix-retrying");
    assert.ok(fixRetrying.length >= 1, `expected fix-retrying status after test FAIL, got ${fixRetrying.length}`);

    const finalAgent = core._agents.get(agentId);
    assert.equal(finalAgent.state, STATES.COMPLETED, "agent must complete after the fix");
  } finally {
    PROJECT_TOOLS.test_run.execute = origTest;
  }
});
