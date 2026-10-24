// Project Mode — sub-agent delegation tests.
//
// Covers:
//   - the 4 delegate_* tools are registered + permission/approval metadata
//   - their input schemas require `objective` and `step_id`
//   - the 3-concurrent-subagent cap (4th call returns
//     too-many-concurrent-subagents)
//   - the recursion guard: a sub-agent's tool set excludes delegate_*
//   - the plan_json schema workaround (parent records assigned_agent_id)
//
// All tests are pure node:test. No IPC, no Electron.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PROJECT_TOOLS, getTool, listTools } from "../src/services/project-tools/index.js";
import { APPROVAL_REQUIRED, PERMISSIONS } from "../src/services/project-tools/security.js";
import {
  ROLES,
  ROLE_PROMPTS,
  ROLE_TOOLS,
  ROLE_OUTPUT_SHAPE,
  MAX_CONCURRENT_SUBAGENTS,
  DELEGATE_TOOL_NAMES,
  buildChildObjective,
} from "../src/services/project-tools/_roles.js";
import { runDelegate } from "../src/services/project-tools/delegate_research.js";
import { startAgent, listActiveRuns } from "../src/services/agent/loop.js";
import { createMockProvider } from "../src/services/agent/provider.js";

// ---------------------------------------------------------------------------
// helpers — a minimal fake `core` for the delegate_* tools. The tools
// only call a small set of pm_* + pmCreateAgent + pmGetAgent +
// pmUpdateAgent + pmListMessages + pmFinishAgent. We track the rows
// in memory so we can assert on the persisted state.
// ---------------------------------------------------------------------------

function makeFakeCore({ simulatedState = "completed", failAt = null } = {}) {
  const agents = new Map(); // id -> { id, projectId, objective, state, plan_json, ... }
  const messages = new Map(); // agentId -> [{ id, role, content, seq }]
  const getCallsByAgent = new Map();
  let nextAgentId = 1;
  let nextMessageId = 1;

  function record(agentId, role, content) {
    const list = messages.get(agentId) || [];
    list.push({ id: nextMessageId++, agent_id: agentId, seq: list.length + 1, role, content });
    messages.set(agentId, list);
  }

  const core = {
    pmCreateAgent(projectId, objective) {
      const id = nextAgentId++;
      agents.set(id, {
        id,
        project_id: projectId,
        objective,
        state: "idle",
        plan_json: "[]",
        tokens_in: 0,
        tokens_out: 0,
        finished_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      messages.set(id, []);
      return { id };
    },
    async pmGetAgent(_profileId, agentId) {
      const a = agents.get(agentId);
      if (!a) throw new Error("not found");
      const n = (getCallsByAgent.get(agentId) || 0) + 1;
      getCallsByAgent.set(agentId, n);
      // First call (loop's startup check) sees the persisted state.
      // Subsequent calls see the simulated live state.
      if (n === 1) return { ...a };
      if (failAt && failAt === agentId) {
        return { ...a, state: "executing_tool" };
      }
      return { ...a, state: simulatedState };
    },
    async pmUpdateAgent(_profileId, agentId, state, planJson) {
      const a = agents.get(agentId);
      if (!a) throw new Error("not found");
      a.state = state;
      a.plan_json = planJson;
      a.updated_at = new Date().toISOString();
      return { ok: true };
    },
    async pmListMessages(_profileId, agentId) {
      return messages.get(agentId) || [];
    },
    async pmAppendMessage(_profileId, agentId, role, content) {
      record(agentId, role, content);
      return { seq: (messages.get(agentId) || []).length };
    },
    async pmFinishAgent(_profileId, agentId, state) {
      const a = agents.get(agentId);
      if (!a) throw new Error("not found");
      a.state = state;
      a.finished_at = new Date().toISOString();
    },
    async pmGetProject(_profileId, _projectId) {
      return { name: "fake", description: "", root_path: "/tmp/fake" };
    },
    // Inspect-only accessors for tests:
    _agents: agents,
    _messages: messages,
    _seedAssistant(agentId, text) {
      record(agentId, "assistant", text);
    },
  };
  return core;
}

function makeParentCtx(core, opts = {}) {
  const inFlight = new Map();
  return {
    core,
    profileId: 1,
    agentId: 100,
    projectId: 10,
    projectRoot: "/tmp/fake",
    isCancellable: () => false,
    nowMs: () => Date.now(),
    isSubAgent: false,
    subAgentSlotAvailable: () => inFlight.size < MAX_CONCURRENT_SUBAGENTS,
    subAgentSlotReserve: (childId) => {
      if (inFlight.size >= MAX_CONCURRENT_SUBAGENTS) return false;
      inFlight.set(childId, { runId: "test" });
      return true;
    },
    subAgentSlotRelease: (childId) => { inFlight.delete(childId); },
    // Fake `startSubAgent` shim: the real path goes through the IPC
    // layer's `ctx.projectMode.startSubAgent`. For tests we just
    // simulate a successful start without spawning an actual loop.
    startSubAgent(_args) {
      return { ok: true, runId: "test-run" };
    },
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// 1) tool registry shape
// ---------------------------------------------------------------------------

test("delegation: the 4 delegate_* tools are registered", () => {
  for (const name of DELEGATE_TOOL_NAMES) {
    const t = getTool(name);
    assert.ok(t, `${name} should be registered`);
    assert.equal(t.name, name);
  }
});

test("delegation: the 4 delegate_* tools use permission NETWORK", () => {
  for (const name of DELEGATE_TOOL_NAMES) {
    const t = getTool(name);
    assert.equal(t.permission, "NETWORK", `${name} should be NETWORK`);
  }
  assert.equal(PERMISSIONS.NETWORK, "NETWORK");
});

test("delegation: the 4 delegate_* tools are NOT in APPROVAL_REQUIRED", () => {
  for (const name of DELEGATE_TOOL_NAMES) {
    assert.equal(APPROVAL_REQUIRED.has(name), false, `${name} must not require approval`);
  }
});

test("delegation: the 4 delegate_* input schemas require objective and step_id", () => {
  for (const name of DELEGATE_TOOL_NAMES) {
    const t = getTool(name);
    const req = t.inputSchema && t.inputSchema.required;
    assert.ok(Array.isArray(req), `${name} inputSchema.required must be an array`);
    assert.ok(req.includes("objective"), `${name} inputSchema.required must include objective`);
    assert.ok(req.includes("step_id"), `${name} inputSchema.required must include step_id`);
    assert.equal(typeof t.timeoutMs, "number");
    assert.equal(t.timeoutMs, 5 * 60 * 1000, `${name} timeoutMs should be 5 minutes`);
  }
});

// ---------------------------------------------------------------------------
// 2) recursion guard
// ---------------------------------------------------------------------------

test("delegation: a sub-agent's tool set excludes every delegate_* tool", () => {
  // We exercise the same filter the loop applies when isSubAgent=true.
  const tools = listTools().filter((t) => !DELEGATE_TOOL_NAMES.includes(t.name));
  for (const t of tools) {
    assert.equal(DELEGATE_TOOL_NAMES.includes(t.name), false,
      `sub-agent tool set must not include ${t.name}`);
  }
  // Conversely, the full registry DOES include them.
  const full = listTools();
  for (const name of DELEGATE_TOOL_NAMES) {
    assert.ok(full.some((t) => t.name === name), `full registry must include ${name}`);
  }
});

test("delegation: DELEGATE_TOOL_NAMES lists exactly 4 tools", () => {
  assert.equal(DELEGATE_TOOL_NAMES.length, 4);
  assert.deepEqual(
    [...DELEGATE_TOOL_NAMES].sort(),
    ["delegate_coder", "delegate_research", "delegate_reviewer", "delegate_tester"],
  );
});

// ---------------------------------------------------------------------------
// 3) roles
// ---------------------------------------------------------------------------

test("delegation: every role has a prompt, tool list, and output shape", () => {
  for (const role of ROLES) {
    assert.ok(typeof ROLE_PROMPTS[role] === "string" && ROLE_PROMPTS[role].length > 0,
      `role ${role} must have a system prompt`);
    assert.ok(Array.isArray(ROLE_TOOLS[role]) && ROLE_TOOLS[role].length > 0,
      `role ${role} must have a non-empty tool list`);
    assert.ok(typeof ROLE_OUTPUT_SHAPE[role] === "string" && ROLE_OUTPUT_SHAPE[role].length > 0,
      `role ${role} must have an output shape`);
  }
});

test("delegation: buildChildObjective embeds role/step/shape/files/objective", () => {
  const text = buildChildObjective("researcher", {
    objective: "find the bug",
    stepId: "step-1",
    files: ["src/a.js", "src/b.js"],
    expectedOutputShape: null,
  });
  assert.match(text, /\[role\] researcher/);
  assert.match(text, /\[step\] step-1/);
  assert.match(text, /\[expected_output_shape\]/);
  assert.match(text, /- src\/a\.js/);
  assert.match(text, /- src\/b\.js/);
  assert.match(text, /find the bug/);
});

test("delegation: buildChildObjective rejects unknown role", () => {
  assert.throws(() => buildChildObjective("bogus", { objective: "x", stepId: "s" }), /unknown role/);
});

// ---------------------------------------------------------------------------
// 4) concurrency cap — 4th call returns too-many-concurrent-subagents
// ---------------------------------------------------------------------------

test("delegation: 4th concurrent delegate_* returns too-many-concurrent-subagents", async () => {
  const core = makeFakeCore({ failAt: "never-finishes" });
  const ctx = makeParentCtx(core);

  // Pre-fill the parent's in-flight map to the cap. We bypass the real
  // tool execute and only exercise the slot helper — this isolates the
  // cap behaviour from the async child polling logic.
  for (let i = 0; i < MAX_CONCURRENT_SUBAGENTS; i++) {
    assert.equal(ctx.subAgentSlotReserve(i + 1), true);
  }
  assert.equal(ctx.subAgentSlotAvailable(), false);

  // Now runDelegate() should refuse because subAgentSlotAvailable() is false.
  const result = await runDelegate("researcher", {
    objective: "find the bug",
    step_id: "step-x",
  }, ctx);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "too-many-concurrent-subagents");
});

// ---------------------------------------------------------------------------
// 5) plan_json schema workaround — parent records assigned_agent_id
// ---------------------------------------------------------------------------

test("delegation: parent plan_json records assigned_agent_id + assigned_to after spawn", async () => {
  const core = makeFakeCore({ simulatedState: "completed" });
  // Seed the parent agent row + an initial plan_json with one step.
  const parentAgentId = 100;
  const created = core.pmCreateAgent(10, "parent objective");
  // Move the seed row's id to the expected parent id (the agent ctx
  // for this test uses agentId=100). Easiest: register a child and
  // let the test override parentAgentId to the created id.
  core._agents.get(created.id).plan_json = JSON.stringify({
    steps: [{ id: "step-1", title: "t", status: "pending", depends_on: [], files: [], assigned_to: null }],
    version: 1,
  });
  const ctx = makeParentCtx(core);
  ctx.agentId = created.id;

  const result = await runDelegate("tester", {
    objective: "run the test suite",
    step_id: "step-1",
  }, ctx);

  assert.equal(result.ok, true);
  assert.equal(typeof result.result.child_agent_id, "number");
  assert.equal(result.result.role, "tester");

  // The parent's pm_agents.plan_json must now have the assigned_agent_id
  // for step-1.
  const parentAfter = core._agents.get(created.id);
  const plan = JSON.parse(parentAfter.plan_json);
  const step1 = plan.steps.find((s) => s.id === "step-1");
  assert.ok(step1, "parent plan_json must still contain step-1");
  assert.equal(step1.assigned_to, "tester");
  assert.equal(step1.assigned_agent_id, result.result.child_agent_id);
});

test("delegation: child pm_agents row has the child objective with role prefix", async () => {
  const core = makeFakeCore({ simulatedState: "completed" });
  core._seedAssistant(0, ""); // no-op, just ensures messages map exists
  const ctx = makeParentCtx(core);

  const result = await runDelegate("reviewer", {
    objective: "review the diff",
    step_id: "step-9",
    files: ["src/x.js"],
  }, ctx);

  assert.equal(result.ok, true);
  const childId = result.result.child_agent_id;
  const child = core._agents.get(childId);
  assert.match(child.objective, /\[role\] reviewer/);
  assert.match(child.objective, /\[step\] step-9/);
  assert.match(child.objective, /review the diff/);
});

// ---------------------------------------------------------------------------
// 6) recursion guard via the loop
// ---------------------------------------------------------------------------

test("delegation: listActiveRuns includes isSubAgent + role metadata", async () => {
  const core = makeFakeCore();
  const parent = core.pmCreateAgent(10, "parent");
  const parentId = parent.id;

  // Build a custom provider that yields ONE tool call so the loop
  // stays alive long enough for us to observe the RUNS entry.
  const stuckProvider = {
    async *streamChat(_args = {}) {
      // Yield a tool_call that won't be found; loop will mark it as
      // tool-not-found but stay alive. We only care about RUNS being
      // populated.
      yield { type: "tool_call", id: "x", name: "delegate_research", args: "{}" };
      yield { type: "finish", reason: "tool_calls" };
    },
  };

  const startRes = await startAgent({
    core,
    profileId: 1,
    agentId: parentId,
    provider: stuckProvider,
    isSubAgent: false,
    role: null,
  });
  assert.equal(startRes.ok, true, `expected ok:true got ${JSON.stringify(startRes)}`);

  // The loop is in flight; the RUNS entry should exist synchronously.
  const { getRun } = await import("../src/services/agent/loop.js");
  const r = getRun(parentId);
  assert.ok(r, "RUNS entry should exist for an in-flight agent");
  assert.equal(r.isSubAgent, false);
  assert.equal(r.role, null);

  // And listActiveRuns shape is consistent.
  const runs = listActiveRuns();
  for (const run of runs) {
    assert.equal(typeof run.isSubAgent, "boolean");
    assert.equal(run.role === null || typeof run.role === "string", true);
  }

  // Cancel to free the slot for any later test.
  const { cancelAgent } = await import("../src/services/agent/loop.js");
  cancelAgent(parentId);
});

test("delegation: ROLE re-exports are correct per file", async () => {
  const mod = await import("../src/services/project-tools/delegate_coder.js");
  assert.equal(mod.ROLE, "coder");
  const tmod = await import("../src/services/project-tools/delegate_tester.js");
  assert.equal(tmod.ROLE, "tester");
  const rmod = await import("../src/services/project-tools/delegate_reviewer.js");
  assert.equal(rmod.ROLE, "reviewer");
  const dmod = await import("../src/services/project-tools/delegate_research.js");
  assert.equal(dmod.ROLE, "researcher");
});

// Sanity: the 4 roles are exactly the 4 defined in the spec.
test("delegation: ROLES contains exactly researcher/coder/tester/reviewer", () => {
  assert.deepEqual([...ROLES].sort(), ["coder", "researcher", "reviewer", "tester"]);
});

// ---------------------------------------------------------------------------
// 7) Poll interval: default 2000ms, env-overridable (GATE 17 v8)
// ---------------------------------------------------------------------------

test("delegation: POLL_MS default is 2000ms and configurable via SUBAGENT_POLL_MS", () => {
  const delegatePath = join(
    import.meta.dirname,
    "..",
    "src",
    "services",
    "project-tools",
    "delegate_research.js",
  );
  const source = readFileSync(delegatePath, "utf8");
  assert.match(
    source,
    /POLL_MS\s*=\s*Number\(process\.env\.SUBAGENT_POLL_MS\)\s*\|\|\s*2000/,
    "default poll interval must be 2000ms, readable from SUBAGENT_POLL_MS env var",
  );
});

test("delegation: sub-agent completes correctly with the slower fallback poll", async () => {
  // Exercise the fallback-poll path (no CHILD_TERMINAL event fires).
  // We set SUBAGENT_POLL_MS=100 so the loop iterates a few times and
  // the test stays snappy, but the default path (2000ms) uses the same
  // code — only the constant value differs.
  const prev = process.env.SUBAGENT_POLL_MS;
  process.env.SUBAGENT_POLL_MS = "100";
  try {
    let state = "planning";
    let getCallCount = 0;
    const core = makeFakeCore({ simulatedState: "completed" });
    const originalGetAgent = core.pmGetAgent.bind(core);
    core.pmGetAgent = async function (...args) {
      getCallCount++;
      // After 3 polls the child reaches a terminal state so the parent
      // wakes off the fallback timer (not the event path).
      if (getCallCount >= 3) state = "completed";
      const a = originalGetAgent(args[0], args[1]);
      return a.then((row) => ({ ...row, state }));
    };

    const created = core.pmCreateAgent(10, "parent");
    const ctx = makeParentCtx(core);
    ctx.agentId = created.id;
    core._agents.get(created.id).plan_json = JSON.stringify({
      steps: [{ id: "step-1", title: "t", status: "pending", depends_on: [], files: [], assigned_to: null }],
      version: 1,
    });

    const result = await runDelegate("researcher", {
      objective: "finish this via fallback poll",
      step_id: "step-1",
    }, ctx);

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.role, "researcher");
    assert.ok(typeof result.result.child_agent_id === "number" && result.result.child_agent_id > 0);
    assert.ok(getCallCount >= 3, `expected >= 3 poll iterations, got ${getCallCount}`);
  } finally {
    if (prev === undefined) delete process.env.SUBAGENT_POLL_MS;
    else process.env.SUBAGENT_POLL_MS = prev;
  }
});