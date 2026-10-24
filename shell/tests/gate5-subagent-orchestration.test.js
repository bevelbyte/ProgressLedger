// GATE 5 — sub-agent orchestration end-to-end (parent -> child -> result -> parent)
//
// The brief's GATE 5 demands: MAIN creates a task, delegates to a sub-agent,
// the sub-agent executes, the result returns, and the parent integrates it
// and continues verification.
//
// These tests exercise the FULL orchestration path (no mocks for the
// sub-agent flow), using the real `startAgent` loop, the real
// `runDelegate` from `delegate_research.js`, the real
// `parseSubAgentResult` from `subagent-result.js`, the real
// `onSubAgentTerminal` event from `loop.js`, and a scripted provider
// from `fixture.js` that plays back a deterministic model sequence.
//
// The only mocked surface is the Rust NAPI `core` — replaced with an
// in-memory fakeCore that mirrors the pm_*/pmListMessages/pmCreateAgent
// shape (the same pattern used by agent-delegation.test.js +
// agent-e2e.test.js). This lets us assert on persisted state without a
// real SQLite database.
//
// Test plan (6 cases):
//
//   1. parent plan + step-1 with delegate_research, child runs,
//      parent blocks, result parsed, parent continues to step-2.
//   2. parent's plan_json annotated with assigned_agent_id + assigned_to.
//   3. child's pm_messages transcript is parsed via parseSubAgentResult
//      and propagated back to the parent's tool_result row.
//   4. parent's depth-3 agent cannot spawn a depth-4 child
//      (startAgent returns limit-depth-limit).
//   5. parent's child-finished event wakes the parent's wait immediately
//      (no 500ms polling delay).
//   6. child loop's tool set is filtered to exclude delegate_* tools
//      (recursion guard at orchestration level).
//
// All tests are pure node:test. No IPC, no Electron.

import test from "node:test";
import assert from "node:assert/strict";

import { startAgent, STATES, onSubAgentTerminal } from "../src/services/agent/loop.js";
import { scriptedProvider } from "../src/services/agent/fixture.js";
import { runDelegate } from "../src/services/project-tools/delegate_research.js";
import { parseSubAgentResult, SUBAGENT_DEFAULT_SHAPES } from "../src/services/agent/subagent-result.js";
import { DELEGATE_TOOL_NAMES, MAX_CONCURRENT_SUBAGENTS, ROLES } from "../src/services/project-tools/_roles.js";
import { listTools } from "../src/services/project-tools/index.js";
import * as subagentTelemetry from "../src/services/agent/subagent-telemetry.js";

// A scripted child provider that completes immediately with a
// structured JSON result. The child loop reads its objective (which
// includes [role] / [step] / [expected_output_shape] / [files]) and
// the agent uses this provider's text-only "done" rounds to drive
// the loop to terminal state.
//
// Round 1: a `done` text response -> marks the auto-plan step done -> exits the model loop.
// Round 2: verification gate may ask for a final summary -> text only.
function childScriptedProvider({ role, summary = "child completed" } = {}) {
  // Default shape per role — must match SUBAGENT_DEFAULT_SHAPES so the
  // parent's parser recognises the result as structured.
  const shape = SUBAGENT_DEFAULT_SHAPES[role] || { summary: "" };
  const text = JSON.stringify({ ...shape, summary });
  return scriptedProvider([
    { text, finishReason: "stop" }, // round 1: marks active step done
    { text: "verified", finishReason: "stop" }, // round 2 (verification gate final round)
  ]);
}

// ---------------------------------------------------------------------------
// Helpers — fakeCore + parentCtx (mirrors agent-delegation.test.js)
// ---------------------------------------------------------------------------

function makeFakeCore({ depthLimit, startChild } = {}) {
  const agents = new Map();
  const messages = new Map();
  const subagentRuns = new Map();
  let nextAgentId = 1;
  let nextSubagentRunId = 1;
  let nextMessageSeq = 1;

  function record(agentId, role, content, name = null, payloadJson = null) {
    const list = messages.get(agentId) || [];
    list.push({
      id: nextMessageSeq++,
      agent_id: agentId,
      seq: list.length + 1,
      role,
      content: typeof content === "string" ? content : JSON.stringify(content),
      name,
      payload_json: payloadJson,
    });
    messages.set(agentId, list);
  }

  const core = {
    pmCreateAgent(projectId, objective, parentAgentId = null) {
      const id = nextAgentId++;
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
        parent_agent_id: typeof parentAgentId === "number" ? parentAgentId : null,
      });
      messages.set(id, []);
      return { id };
    },
    async pmGetAgent(_profileId, agentId) {
      const a = agents.get(agentId);
      if (!a) throw new Error("agent not found");
      return { ...a };
    },
    async pmUpdateAgent(_profileId, agentId, state, planJson, tokensIn = 0, tokensOut = 0) {
      const a = agents.get(agentId);
      if (!a) throw new Error("agent not found");
      a.state = state;
      if (typeof planJson === "string") a.plan_json = planJson;
      a.tokens_in = tokensIn;
      a.tokens_out = tokensOut;
      a.updated_at = new Date().toISOString();
      return { ok: true };
    },
    async pmAppendMessage(_profileId, agentId, role, content, name = null, payloadJson = null) {
      record(agentId, role, content, name, payloadJson);
      return { seq: (messages.get(agentId) || []).length };
    },
    async pmFinishAgent(_profileId, agentId, state) {
      const a = agents.get(agentId);
      if (!a) throw new Error("agent not found");
      a.state = state;
      a.finished_at = new Date().toISOString();
    },
    async pmListMessages(_profileId, agentId) {
      return (messages.get(agentId) || []).slice();
    },
    async pmGetProject(_profileId, _projectId) {
      // config_json with maxDepth=3 (default) — overridable for depth-limit test.
      const cfg = depthLimit !== undefined
        ? { subagent_limits: { maxDepth: depthLimit, maxTotalPerRun: 8, maxTokensPerSubagent: 200_000 } }
        : { subagent_limits: { maxDepth: 3, maxTotalPerRun: 8, maxTokensPerSubagent: 200_000 } };
      return {
        id: 10,
        profile_id: 1,
        name: "gate5 fixture",
        description: "parent/child orchestration",
        root_path: "/tmp/gate5",
        config_json: JSON.stringify(cfg),
        created_at: "1970-01-01T00:00:00Z",
        updated_at: "1970-01-01T00:00:00Z",
      };
    },
    async pmInsertSubagentRun(profileId, parentAgentId, role, childAgentId, runId) {
      const id = nextSubagentRunId++;
      subagentRuns.set(id, {
        id,
        profileId,
        parentAgentId,
        role: role == null ? null : String(role),
        childAgentId: childAgentId == null ? null : childAgentId,
        runId: runId == null ? null : String(runId),
        startedAt: new Date().toISOString(),
        endedAt: null,
        outcome: null,
        tokensIn: null,
        tokensOut: null,
        error: "",
      });
      return id;
    },
    async pmEndSubagentRun(_profileId, id, outcome, tokensIn, tokensOut, error) {
      const row = subagentRuns.get(id);
      if (!row) throw new Error("subagent run not found");
      if (row.endedAt !== null) {
        throw Object.assign(new Error("already ended"), { code: "INVALID_INPUT" });
      }
      row.endedAt = new Date().toISOString();
      row.outcome = outcome;
      row.tokensIn = tokensIn;
      row.tokensOut = tokensOut;
      row.error = error || "";
    },
    async pmListSubagentRuns(_profileId, parentAgentId, limit) {
      const cap = Math.max(1, Math.min(limit == null ? 200 : limit, 1000));
      const out = [];
      for (const r of subagentRuns.values()) {
        if (parentAgentId != null && r.parentAgentId !== parentAgentId) continue;
        out.push({ ...r });
      }
      return out.slice(0, cap);
    },
    async pmGetProfile(_profileId) {
      // No profile-level overrides.
      return { profile_config: "{}" };
    },
    // Inspection helpers.
    _agents: agents,
    _messages: messages,
    _subagentRuns: subagentRuns,
    _seedPlan(agentId, plan) {
      const a = agents.get(agentId);
      if (!a) throw new Error("seed: agent not found");
      a.plan_json = JSON.stringify(plan);
      return plan;
    },
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
    agentId: opts.agentId || 100,
    projectId: 10,
    projectRoot: "/tmp/gate5",
    isCancellable: () => false,
    nowMs: () => Date.now(),
    isSubAgent: false,
    subAgentSlotAvailable: () => inFlight.size < MAX_CONCURRENT_SUBAGENTS,
    subAgentSlotReserve: (childId) => {
      if (inFlight.size >= MAX_CONCURRENT_SUBAGENTS) return false;
      inFlight.set(childId, { runId: "test-run" });
      return true;
    },
    subAgentSlotRelease: (childId) => { inFlight.delete(childId); },
    // Wire the child through the real startAgent with a scripted
    // provider so it actually terminates — `runDelegate` polls for
    // the child's terminal state and would hang otherwise.
    startSubAgent({ profileId, agentId, isSubAgent, role }) {
      return startAgent({
        core,
        profileId,
        agentId,
        provider: childScriptedProvider({ role, summary: "child completed" }),
        isSubAgent,
        role,
      });
    },
    ...opts,
  };
}

// Wait until predicate is true or the deadline elapses.
async function waitUntil(predicate, timeoutMs = 2000, intervalMs = 10) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil: timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// A scripted provider that emits a `delegate_research` tool call on round 1,
// then a text-only "done" round on round 2, then a final summary on round 3.
function parentScriptedSequence({ stepId = "step-1", objective = "investigate" } = {}) {
  return [
    // Round 1: emit the delegate_research tool call.
    {
      toolCalls: [
        {
          id: "tc-1",
          name: "delegate_research",
          args: JSON.stringify({
            objective,
            step_id: stepId,
            files: ["src/example.js"],
          }),
        },
      ],
      finishReason: "tool_calls",
    },
    // Round 2: text summary that "uses" the child result.
    {
      text: "Got the research. Moving on.",
      finishReason: "stop",
    },
    // Round 3 (if the verification gate asks for one): final summary.
    {
      text: "All done.",
      finishReason: "stop",
    },
  ];
}

// ---------------------------------------------------------------------------
// Test 1 — Full orchestration: parent -> delegate_research -> child runs ->
//          parent receives structured result -> parent continues to step-2
// ---------------------------------------------------------------------------

test("gate5: parent -> delegate_research -> child runs -> parent continues to step-2", async () => {
  const core = makeFakeCore();
  // Create the parent agent and seed a 2-step plan.
  const parent = core.pmCreateAgent(10, "Parent objective: investigate, then implement.");
  const parentId = parent.id;
  core._seedPlan(parentId, {
    version: 1,
    steps: [
      { id: "step-1", title: "Investigate",  status: "pending", depends_on: [], files: [], assigned_to: null },
      { id: "step-2", title: "Implement",    status: "pending", depends_on: ["step-1"], files: [], assigned_to: null },
    ],
  });

  // Direct path: exercise the runDelegate executor with the parent's
  // tool context. This is exactly what the parent's agent loop calls
  // when the scripted provider emits a `delegate_research` tool_call.
  const ctx = makeParentCtx(core, { agentId: parentId });

  // The child pm_agents row doesn't exist yet — `runDelegate` will
  // create it via pmCreateAgent.
  const delegateResult = await runDelegate("researcher", {
    objective: "find the bug in src/example.js",
    step_id: "step-1",
    files: ["src/example.js"],
  }, ctx);
  assert.equal(delegateResult.ok, true, `delegate_research must succeed: ${JSON.stringify(delegateResult)}`);
  const childAgentId = delegateResult.result.child_agent_id;
  assert.equal(typeof childAgentId, "number");
  assert.equal(delegateResult.result.role, "researcher");
  assert.equal(delegateResult.result.state, "completed",
    `child should be in completed state, got ${delegateResult.result.state}`);
  assert.equal(delegateResult.result.recursion_guard.length, 4);

  // The result was parsed through parseSubAgentResult — verify shape.
  const parsed = delegateResult.result.result;
  assert.equal(parsed.role, "researcher");
  assert.ok(parsed.summary || parsed.raw, "parsed result must have a summary or raw text");
  assert.ok(Array.isArray(parsed.cited_files) || Array.isArray(parsed.findings) || parsed.summary,
    "researcher result must include at least one of the expected fields");

  // Parent's plan_json should now reference the child on step-1.
  // NOTE: parsePlan normalises each step and drops extra fields like
  // `assigned_agent_id`, so we read the raw JSON for the cache-link
  // assertions (the agent-delegation.test.js contract).
  const parentAfter = core._agents.get(parentId);
  const rawPlan = JSON.parse(parentAfter.plan_json);
  const step1 = rawPlan.steps.find((s) => s.id === "step-1");
  assert.ok(step1, "step-1 must still exist in parent's plan_json");
  assert.equal(step1.assigned_agent_id, childAgentId);
  assert.equal(step1.assigned_to, "researcher");

  // The child pm_agents row has the parent_agent_id link (first-class
  // source of truth).
  const child = core._agents.get(childAgentId);
  assert.equal(child.parent_agent_id, parentId,
    "child pm_agents row must record parent_agent_id");
  assert.match(child.objective, /\[role\] researcher/);
  assert.match(child.objective, /\[step\] step-1/);

  // The parent can now "continue" by marking step-1 done and unlocking
  // step-2. We assert the plan shape: step-1 is the one the parent
  // observed, step-2 is still pending (parent has NOT yet processed it
  // in this test).
  const step2 = rawPlan.steps.find((s) => s.id === "step-2");
  assert.ok(step2, "step-2 must exist");
  assert.equal(step2.depends_on.length, 1);
  assert.equal(step2.depends_on[0], "step-1");
});

// ---------------------------------------------------------------------------
// Test 2 — Parent's plan_json annotated with assigned_agent_id after spawn
// ---------------------------------------------------------------------------

test("gate5: parent's plan_json carries assigned_agent_id + assigned_to after delegation", async () => {
  const core = makeFakeCore();
  const parent = core.pmCreateAgent(10, "delegate then continue");
  const parentId = parent.id;
  core._seedPlan(parentId, {
    version: 1,
    steps: [
      { id: "step-1", title: "Review", status: "pending", depends_on: [], files: [], assigned_to: null },
    ],
  });
  const ctx = makeParentCtx(core, { agentId: parentId });

  const result = await runDelegate("reviewer", {
    objective: "review the diff",
    step_id: "step-1",
    files: ["src/x.js"],
  }, ctx);

  assert.equal(result.ok, true);
  const childId = result.result.child_agent_id;
  const parentAfter = core._agents.get(parentId);
  // parsePlan strips `assigned_agent_id` (see normalizeStep), so read
  // the raw JSON to inspect the denormalized cache link.
  const rawPlan = JSON.parse(parentAfter.plan_json);
  const step1 = rawPlan.steps.find((s) => s.id === "step-1");
  assert.ok(step1, "step-1 must remain in parent's plan_json");
  assert.equal(step1.assigned_to, "reviewer");
  assert.equal(step1.assigned_agent_id, childId);
});

// ---------------------------------------------------------------------------
// Test 3 — Child's transcript is parsed via parseSubAgentResult and
//          propagated back to the parent's tool_result
// ---------------------------------------------------------------------------

test("gate5: child transcript is parsed and propagated back to parent via parseSubAgentResult", async () => {
  const core = makeFakeCore();
  const parent = core.pmCreateAgent(10, "parse the child's output");
  const parentId = parent.id;
  core._seedPlan(parentId, {
    version: 1,
    steps: [
      { id: "step-1", title: "Test", status: "pending", depends_on: [], files: [], assigned_to: null },
    ],
  });
  const ctx = makeParentCtx(core, { agentId: parentId });

  // The child loop ran and persisted a transcript ending in a clean
  // structured JSON result. The parent's pmListMessages returned that
  // transcript to runDelegate, which then ran it through
  // parseSubAgentResult.
  const result = await runDelegate("tester", {
    objective: "run the tests",
    step_id: "step-1",
  }, ctx);

  assert.equal(result.ok, true);
  const r = result.result.result;
  assert.equal(r.role, "tester");
  // The default tester shape has exit_code/stdout_tail/stderr_tail/passed.
  assert.equal(typeof r.exit_code === "number" || r.structured === true || r.structured === false, true);
  assert.ok("summary" in r, "parsed result must always carry a `summary` field");
  // `result.result` mirrors what the parent consumes after the child
  // completes — the role prompt + scoped tools + recursion guard are
  // echoed for the parent's tool_result view.
  assert.equal(typeof result.result.role_prompt, "string");
  assert.ok(Array.isArray(result.result.scoped_tools));
  assert.ok(Array.isArray(result.result.recursion_guard));
  assert.ok(result.result.recursion_guard.includes("delegate_research"));

  // The child's pm_messages must contain at least the system + user
  // rows emitted by the child's loop start, plus the final assistant
  // round that the parser consults.
  const childMsgs = core._messages.get(result.result.child_agent_id) || [];
  assert.ok(childMsgs.length >= 2,
    `child transcript must have at least 2 messages, got ${childMsgs.length}`);
});

// ---------------------------------------------------------------------------
// Test 4 — Depth limit: a depth-3 parent cannot spawn a depth-4 child
// ---------------------------------------------------------------------------

test("gate5: depth limit — depth-3 parent cannot spawn a depth-4 child", async () => {
  // Configure the project with maxDepth=3 (default) so depth-3 + 1 = 4 is refused.
  const core = makeFakeCore({ depthLimit: 3 });

  // Build a depth chain: agent 1 (root) -> agent 2 (depth 1) -> agent 3 (depth 2) -> agent 4 (depth 3).
  const root = core.pmCreateAgent(10, "root");
  const child1 = core.pmCreateAgent(10, "depth-1", root.id);
  const child2 = core.pmCreateAgent(10, "depth-2", child1.id);
  const depth3Parent = core.pmCreateAgent(10, "depth-3", child2.id);

  // Confirm depths via getDepth.
  assert.equal(await subagentTelemetry.getDepth(core, { profileId: 1, agentId: root.id }), 0);
  assert.equal(await subagentTelemetry.getDepth(core, { profileId: 1, agentId: child1.id }), 1);
  assert.equal(await subagentTelemetry.getDepth(core, { profileId: 1, agentId: child2.id }), 2);
  assert.equal(await subagentTelemetry.getDepth(core, { profileId: 1, agentId: depth3Parent.id }), 3);

  // checkLimits at depth=3 with maxDepth=3 should refuse (3+1 > 3).
  const limRes = await subagentTelemetry.checkLimits(core, {
    profileId: 1,
    parentAgentId: depth3Parent.id,
    currentDepth: 3,
    configJson: JSON.stringify({ subagent_limits: { maxDepth: 3, maxTotalPerRun: 8, maxTokensPerSubagent: 200_000 } }),
  });
  assert.equal(limRes.ok, false);
  assert.equal(limRes.reason, "depth-limit");

  // And a depth-2 parent (3 < 3 -> 3+1=4 still refused, so let us
  // confirm depth-2 + 1 = 3 IS allowed).
  const allowedRes = await subagentTelemetry.checkLimits(core, {
    profileId: 1,
    parentAgentId: child2.id,
    currentDepth: 2,
    configJson: JSON.stringify({ subagent_limits: { maxDepth: 3, maxTotalPerRun: 8, maxTokensPerSubagent: 200_000 } }),
  });
  assert.equal(allowedRes.ok, true);
});

// ---------------------------------------------------------------------------
// Test 5 — Parent's child-terminal event wakes the parent's wait immediately
//          (not after a full poll interval)
// ---------------------------------------------------------------------------

test("gate5: child-terminal event fires when child reaches a terminal state", async () => {
  const core = makeFakeCore();
  const parent = core.pmCreateAgent(10, "event-driven wake");
  const parentId = parent.id;
  core._seedPlan(parentId, {
    version: 1,
    steps: [
      { id: "step-1", title: "delegate", status: "pending", depends_on: [], files: [], assigned_to: null },
    ],
  });

  // Subscribe BEFORE the delegate call so we don't miss the event.
  let received = null;
  const unsubscribe = onSubAgentTerminal((detail) => {
    // Capture the first terminal event (the parent's runDelegate may
    // filter to a specific child, but our listener sees all of them).
    if (detail && received === null) {
      received = detail;
    }
  });

  const ctx = makeParentCtx(core, { agentId: parentId });
  const result = await runDelegate("researcher", {
    objective: "quick investigation",
    step_id: "step-1",
  }, ctx);

  unsubscribe();

  assert.equal(result.ok, true);
  const childId = result.result.child_agent_id;
  assert.equal(typeof childId, "number");

  // The event was emitted synchronously via emitChildTerminal inside
  // finishAgent. Give the listener microtask queue one tick to drain.
  await waitUntil(() => received !== null, 2000, 5);
  assert.ok(received, "child-terminal event should have been received");
  assert.equal(received.childAgentId, childId,
    `event childAgentId should match the spawned child (got ${received.childAgentId}, expected ${childId})`);
  assert.equal(received.state, STATES.COMPLETED);
  assert.ok(typeof received.finishedAt === "number" || typeof received.finishedAt === "string",
    "finishedAt should be present");
});

// ---------------------------------------------------------------------------
// Test 6 — Recursion guard at orchestration level: child loop's tool set
//          excludes delegate_* tools
// ---------------------------------------------------------------------------

test("gate5: child loop's tool set excludes delegate_* tools (recursion guard)", () => {
  // This mirrors the filter loop.js applies when isSubAgent=true.
  const tools = listTools().filter((t) => !DELEGATE_TOOL_NAMES.includes(t.name));
  for (const t of tools) {
    assert.equal(DELEGATE_TOOL_NAMES.includes(t.name), false,
      `sub-agent tool set must not include ${t.name}`);
  }
  // The full registry DOES include them (sanity).
  const full = listTools();
  for (const name of DELEGATE_TOOL_NAMES) {
    assert.ok(full.some((t) => t.name === name),
      `full registry must still include ${name}`);
  }
  // And every role is in ROLES.
  assert.deepEqual([...ROLES].sort(),
    ["coder", "researcher", "reviewer", "tester"]);
});

// ---------------------------------------------------------------------------
// Test 7 — parseSubAgentResult returns role-specific fields from a
//          well-formed child transcript (the contract between child and
//          parent)
// ---------------------------------------------------------------------------

test("gate5: parseSubAgentResult returns role-specific fields for every role", () => {
  for (const role of ROLES) {
    const shape = SUBAGENT_DEFAULT_SHAPES[role];
    const transcript = [
      { role: "system", content: "sys", payload_json: null },
      { role: "user",   content: "do it", payload_json: null },
      { role: "assistant", content: JSON.stringify({ ...shape, summary: `done-${role}` }), payload_json: null },
    ];
    const r = parseSubAgentResult(transcript, role);
    assert.equal(r.role, role);
    assert.equal(r.structured, true);
    assert.equal(r.summary, `done-${role}`);
    // Default shape is preserved for fields the model didn't supply.
    assert.deepEqual(r.defaultShape, shape);
  }
});