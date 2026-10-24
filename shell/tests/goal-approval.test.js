// Goal approval enforcement: privileged tools must fail closed when the
// trusted resolver is absent, and fresh/resumed Goal runs must propagate the
// same explicit approval boundary used by normal Agent runs.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startGoal, stopAllObservations } from "../src/services/goals/engine.js";
import { startAgent, resumeAgent, cancelAgent, getRun, STATES } from "../src/services/agent/loop.js";
import { scriptedProvider } from "../src/services/agent/fixture.js";
import { PROJECT_TOOLS } from "../src/services/project-tools/index.js";
import { _setUserDataDir, _closeAll } from "../src/services/memory/index.js";

let nextId = 70_001;

function makeCore() {
  const agents = new Map();
  const messages = new Map();
  const goals = new Map();

  function record(agentId, role, content, name, payloadJson) {
    const list = messages.get(agentId) || [];
    list.push({ role, content: String(content), name: name ?? null, payload_json: payloadJson ?? null });
    messages.set(agentId, list);
    return { seq: list.length };
  }

  return {
    pmGetGoal(profileId, goalId) { return goals.get(goalId) || null; },
    pmCreateAgent(projectId, objective) {
      const id = nextId++;
      agents.set(id, {
        id,
        project_id: projectId,
        objective,
        state: STATES.IDLE,
        plan_json: "[]",
        tokens_in: 0,
        tokens_out: 0,
        parent_agent_id: null,
        finished_at: null,
      });
      messages.set(id, []);
      return id;
    },
    pmLinkGoalAgent(profileId, goalId, agentId) {
      const goal = goals.get(goalId);
      if (goal) goal.linkedAgentId = agentId;
    },
    pmAppendGoalEvent() { return { ok: true }; },
    pmTransitionGoal(profileId, goalId, state) {
      const goal = goals.get(goalId);
      if (goal) goal.state = state;
      return { ok: true };
    },
    pmGetAgent(profileId, agentId) {
      const agent = agents.get(agentId);
      return agent ? { ...agent } : null;
    },
    pmUpdateAgent(profileId, agentId, state, planJson, tokensIn, tokensOut) {
      const agent = agents.get(agentId);
      if (!agent) return { ok: false, error: { code: "not-found" } };
      Object.assign(agent, { state, plan_json: planJson, tokens_in: tokensIn, tokens_out: tokensOut });
      return { ok: true };
    },
    pmAppendMessage(profileId, agentId, role, content, name, payloadJson) {
      return record(agentId, role, content, name, payloadJson);
    },
    pmFinishAgent(profileId, agentId, state) {
      const agent = agents.get(agentId);
      if (agent) Object.assign(agent, { state, finished_at: new Date().toISOString() });
    },
    pmListMessages(profileId, agentId) {
      return [...(messages.get(agentId) || [])];
    },
    pmGetProject() {
      return { id: 10, profile_id: 1, root_path: process.cwd(), config_json: "{}" };
    },
    _addGoal(goal) {
      goals.set(goal.id, {
        profileId: 1,
        projectId: 10,
        title: "approval goal",
        objective: "exercise approval",
        kind: "coding",
        requireVerification: false,
        linkedAgentId: null,
        ...goal,
      });
    },
    _addResumableAgent(goal) {
      const agentId = this.pmCreateAgent(10, goal.objective);
      agents.get(agentId).state = STATES.PLANNING;
      agents.get(agentId).plan_json = JSON.stringify({
        version: 1,
        steps: [{ id: "step-1", title: "write", status: "pending", depends_on: [], files: [], assigned_to: null }],
      });
      this.pmLinkGoalAgent(1, goal.id, agentId);
      return agentId;
    },
    _agents: agents,
  };
}

async function withTempUserData(fn) {
  const dir = mkdtempSync(join(tmpdir(), "cf-goal-approval-"));
  _setUserDataDir(dir);
  try {
    return await fn();
  } finally {
    stopAllObservations();
    _closeAll();
    _setUserDataDir(null);
    rmSync(dir, { recursive: true, force: true });
  }
}

function toolProvider(toolName) {
  return scriptedProvider([
    { toolCalls: [{ id: `call-${toolName}`, name: toolName, args: "{}" }], finishReason: "tool_calls" },
    { text: "done", finishReason: "stop" },
  ]);
}

async function runFreshGoal({ toolName = "fs_write", approvalResolverFactory }) {
  const core = makeCore();
  const goalId = 9001;
  core._addGoal({ id: goalId, state: "created" });
  const result = await startGoal({
    core,
    profileId: 1,
    goalId,
    provider: toolProvider(toolName),
    approvalResolverFactory,
  });
  assert.equal(result.ok, true);
  await waitForRunEnd(result.agentId);
  return result.agentId;
}

async function runResumedGoal({ approvalResolver }) {
  const core = makeCore();
  const goal = { id: 9002, state: "running" };
  core._addGoal(goal);
  const agentId = core._addResumableAgent(goal);
  const result = await resumeAgent({
    core,
    profileId: 1,
    agentId,
    provider: toolProvider("fs_write"),
    approvalResolver,
  });
  assert.equal(result.ok, true);
  await waitForRunEnd(agentId);
}

async function withTool(toolName, fn) {
  const tool = PROJECT_TOOLS[toolName];
  const original = tool.execute;
  const calls = [];
  tool.execute = async (input, ctx) => {
    calls.push({ input, ctx });
    return { ok: true, result: { executed: true } };
  };
  try {
    return await fn(calls);
  } finally {
    tool.execute = original;
  }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForRunEnd(agentId) {
  await waitFor(() => getRun(agentId) === null);
}

test("fresh Goal: privileged tool is denied when approval resolver is missing", async () => {
  await withTempUserData(() => withTool("fs_write", async (calls) => {
    await runFreshGoal({ approvalResolverFactory: undefined });
    assert.equal(calls.length, 0);
  }));
});

test("fresh Goal: privileged tool executes only after explicit approval", async () => {
  await withTempUserData(() => withTool("fs_write", async (calls) => {
    await runFreshGoal({ approvalResolverFactory: () => async () => ({ approved: true }) });
    assert.equal(calls.length, 1);
  }));
});

test("fresh Goal: explicit rejection prevents privileged tool execution", async () => {
  await withTempUserData(() => withTool("fs_write", async (calls) => {
    await runFreshGoal({ approvalResolverFactory: () => async () => ({ approved: false, reason: "user-rejected" }) });
    assert.equal(calls.length, 0);
  }));
});

test("resumed Goal: missing/rejected approval denies and explicit approval permits privileged tool", async () => {
  await withTempUserData(() => withTool("fs_write", async (calls) => {
    await runResumedGoal({ approvalResolver: undefined });
    assert.equal(calls.length, 0);

    await runResumedGoal({ approvalResolver: async () => ({ approved: false, reason: "user-rejected" }) });
    assert.equal(calls.length, 0);

    await runResumedGoal({ approvalResolver: async () => ({ approved: true }) });
    assert.equal(calls.length, 1);
  }));
});

test("cancellation while approval is pending removes the gate and never executes the tool", async () => {
  await withTempUserData(() => withTool("fs_write", async (calls) => {
    const core = makeCore();
    const goalId = 9003;
    core._addGoal({ id: goalId, state: "created" });
    let approvalRequested = false;
    const approvalResolver = ({ signal }) => new Promise((resolve) => {
      approvalRequested = true;
      signal.addEventListener("abort", () => resolve({ approved: false, reason: "cancelled" }), { once: true });
    });
    const started = await startGoal({
      core,
      profileId: 1,
      goalId,
      provider: toolProvider("fs_write"),
      approvalResolverFactory: () => approvalResolver,
    });
    await waitFor(() => approvalRequested);
    assert.equal(cancelAgent(started.agentId).ok, true);
    await waitForRunEnd(started.agentId);
    assert.equal(calls.length, 0);
  }));
});

test("non-privileged Goal tool remains executable without an approval resolver", async () => {
  await withTempUserData(() => withTool("inspect_project", async (calls) => {
    await runFreshGoal({ toolName: "inspect_project", approvalResolverFactory: undefined });
    assert.equal(calls.length, 1);
  }));
});

test("normal Agent explicit approval still executes privileged tools", async () => {
  await withTempUserData(() => withTool("fs_write", async (calls) => {
    const core = makeCore();
    const goal = { id: 9004, state: "created" };
    core._addGoal(goal);
    const agentId = core._addResumableAgent(goal);
    const started = await startAgent({
      core,
      profileId: 1,
      agentId,
      provider: toolProvider("fs_write"),
      approvalResolver: async () => ({ approved: true }),
    });
    assert.equal(started.ok, true);
    await waitForRunEnd(agentId);
    assert.equal(calls.length, 1);
  }));
});
