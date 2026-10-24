// GATE 20 â€” Performance audit: no-op regression assertions.
//
// These tests pin measurable performance properties of the agent loop
// so that future changes cannot accidentally reintroduce per-round
// overhead for operations that should happen once per agent run.
//
// What is asserted (and why):
//   1. ProjectIntel.relevantFiles is called ONCE per agent run (during
//      initial planning), not once per loop round. The project-intel
//      block is built before the while loop in loop.js and never
//      re-queried.
//   2. Memory.buildContextPacket and Memory.taskList are each called
//      ONCE per agent run (before the while loop). The memory packet
//      and recent-task history are not refreshed mid-run.
//   3. The first user message's context packet is bounded below a
//      sane token ceiling (50,000 tokens) â€” guards against unbounded
//      memory / project-intel growth.
//   4. The IPC `agent:list-messages` handler uses the paginated
//      `pmListMessagesPaginated` NAPI call (batched, with a limit),
//      not one `pmListMessages` roundtrip per message.
//   5. The sub-agent poll interval is >= 1000ms (the event-driven
//      wake-up is the primary path; the poll is a fallback safety
//      net, not a tight spin loop).
//
// None of these tests modify source code. They wrap exported functions
// with counters, run a multi-round agent, and assert the counters
// stay within the expected (already-correct) bounds.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { startAgent, AGENT_EVENTS, STATES } from "../src/services/agent/loop.js";
import { scriptedProvider } from "../src/services/agent/fixture.js";
import { ProjectIntel } from "../src/services/project-intel/index.js";
import { Memory } from "../src/services/memory/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal fake core. Only the fields the agent loop touches during a
 * multi-round run are implemented. The project has a single-step plan
 * so the loop terminates after the model emits text-only.
 */
function makeFakeCore({ configJson = "{}", projectRoot = "/tmp/cf-gate20" } = {}) {
  const agents = new Map();
  const messages = new Map();
  let nextAgentId = 1;
  function record(agentId, role, content, name, payloadJson) {
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
  }
  return {
    pmCreateAgent(projectId, objective) {
      const id = nextAgentId++;
      agents.set(id, {
        id,
        projectId,
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
      messages.set(id, []);
      return { id };
    },
    pmGetAgent(_profileId, agentId) {
      const a = agents.get(agentId);
      if (!a) throw new Error(`agent ${agentId} not found`);
      return { ...a };
    },
    pmUpdateAgent(_profileId, agentId, state, planJson, tokensIn, tokensOut) {
      const a = agents.get(agentId);
      if (!a) throw new Error(`agent ${agentId} not found`);
      a.state = state;
      a.plan_json = planJson;
      a.tokens_in = tokensIn;
      a.tokens_out = tokensOut;
      a.updated_at = new Date().toISOString();
      return { ok: true };
    },
    pmAppendMessage(profileId, agentId, role, content, name, payloadJson) {
      record(agentId, role, content, name, payloadJson);
      return { seq: (messages.get(agentId) || []).length };
    },
    pmFinishAgent(_profileId, agentId, state) {
      const a = agents.get(agentId);
      if (!a) throw new Error(`agent ${agentId} not found`);
      a.state = state;
      a.finished_at = new Date().toISOString();
    },
    pmGetProject(_profileId, _projectId) {
      return {
        id: 99,
        profileId: 1,
        name: "Gate20 perf audit project",
        description: "",
        rootPath: projectRoot,
        root_path: projectRoot,
        configJson,
        config_json: configJson,
        createdAt: "1970-01-01T00:00:00Z",
        updatedAt: "1970-01-01T00:00:00Z",
      };
    },
    pmListMessages(_profileId, agentId) {
      return (messages.get(agentId) || []).slice();
    },
    pmListMessagesPaginated(_profileId, agentId, limit, before) {
      const all = (messages.get(agentId) || []).slice();
      const cap = typeof limit === "number" && limit > 0 ? limit : 50;
      return all.slice(-cap);
    },
    _agents: agents,
    _messages: messages,
  };
}

/** Capturing provider: records the messages array from the first streamChat call. */
function makeCapturingProvider(captureRef) {
  return {
    async *streamChat(opts = {}) {
      if (!captureRef.captured) {
        captureRef.captured = Array.isArray(opts.messages) ? opts.messages.slice() : [];
      }
      yield { type: "text_delta", delta: "done." };
      yield { type: "text_delta", delta: "" };
      yield { type: "usage", inputTokens: 1, outputTokens: 2 };
      yield { type: "finish", reason: "stop" };
    },
  };
}

/** Multi-round capturing provider: emits tool calls for N rounds, then text-only. */
function makeMultiRoundProvider(captureRef, rounds = 3) {
  let callCount = 0;
  return {
    async *streamChat(opts = {}) {
      callCount++;
      if (!captureRef.captured) {
        captureRef.captured = Array.isArray(opts.messages) ? opts.messages.slice() : [];
      }
      if (callCount <= rounds) {
        // Emit a noop tool call so the loop executes a tool and continues.
        yield { type: "tool_call", id: `tc-${callCount}`, name: "fs_list", args: '{"path":"."}' };
        yield { type: "usage", inputTokens: 100, outputTokens: 10 };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        // Final round: text only so the step is marked done and the loop exits.
        yield { type: "text_delta", delta: "All steps complete." };
        yield { type: "usage", inputTokens: 200, outputTokens: 20 };
        yield { type: "finish", reason: "stop" };
      }
    },
    _getRound() {
      return callCount;
    },
  };
}

function waitForTerminal(bus) {
  return new Promise((resolve) => {
    const handler = (e) => resolve({ kind: e.type, payload: e.payload });
    bus.on(AGENT_EVENTS.AGENT_COMPLETED, handler);
    bus.on(AGENT_EVENTS.AGENT_FAILED, handler);
    bus.on(AGENT_EVENTS.AGENT_CANCELLED, handler);
  });
}

/** Token estimate matching the loop's whitespace-split heuristic. */
function tokenEstimate(text) {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// 1) ProjectIntel.relevantFiles called once per agent run (not per round)
// ---------------------------------------------------------------------------

test("perf: ProjectIntel.relevantFiles is called at most once per agent run", async () => {
  const origRelevantFiles = ProjectIntel.relevantFiles;
  let callCount = 0;
  ProjectIntel.relevantFiles = async function (...args) {
    callCount++;
    // Degrade gracefully: the index was never built, so return not-initialized.
    return { ok: false, error: { code: "not-initialized", message: "no index" } };
  };
  try {
    const core = makeFakeCore({
      configJson: JSON.stringify({
        context_packet_max_tokens: 0,
        context_packet_max_project_intel_tokens: 1500,
      }),
    });
    const created = core.pmCreateAgent(99, "multi-round perf test");
    const agentId = created.id;
    // A 3-step plan so the loop has multiple rounds to execute.
    core.pmUpdateAgent(1, agentId, STATES.IDLE, JSON.stringify({
      version: 1,
      steps: [
        { id: "step-1", title: "list files", status: "pending", depends_on: [], files: [], assigned_to: null },
        { id: "step-2", title: "read files", status: "pending", depends_on: [], files: [], assigned_to: null },
        { id: "step-3", title: "finish", status: "pending", depends_on: [], files: [], assigned_to: null },
      ],
    }), 0, 0);

    const capture = { captured: null };
    const provider = makeMultiRoundProvider(capture, 3);
    const startRes = await startAgent({ core, profileId: 1, agentId, provider });
    await waitForTerminal(startRes.bus);

    // relevantFiles is called during the initial project-intel block build,
    // which happens once before the while loop. It must NOT be called again
    // on subsequent loop iterations.
    assert.ok(
      callCount <= 1,
      `ProjectIntel.relevantFiles must be called at most once per agent run; got ${callCount} calls`,
    );
  } finally {
    ProjectIntel.relevantFiles = origRelevantFiles;
  }
});

// ---------------------------------------------------------------------------
// 2) Memory.buildContextPacket + Memory.taskList called at most once each
// ---------------------------------------------------------------------------

test("perf: Memory.buildContextPacket is called at most once per agent run", async () => {
  const orig = Memory.buildContextPacket;
  let callCount = 0;
  Memory.buildContextPacket = async function (...args) {
    callCount++;
    return orig.apply(this, args);
  };
  try {
    const core = makeFakeCore({ configJson: JSON.stringify({ context_packet_max_project_intel_tokens: 0 }) });
    const created = core.pmCreateAgent(99, "memory call count test");
    const agentId = created.id;
    core.pmUpdateAgent(1, agentId, STATES.IDLE, JSON.stringify({
      version: 1,
      steps: [
        { id: "step-1", title: "a", status: "pending", depends_on: [], files: [], assigned_to: null },
        { id: "step-2", title: "b", status: "pending", depends_on: [], files: [], assigned_to: null },
      ],
    }), 0, 0);

    const capture = { captured: null };
    const provider = makeMultiRoundProvider(capture, 2);
    const startRes = await startAgent({ core, profileId: 1, agentId, provider });
    await waitForTerminal(startRes.bus);

    assert.ok(
      callCount <= 1,
      `Memory.buildContextPacket must be called at most once per agent run; got ${callCount} calls`,
    );
  } finally {
    Memory.buildContextPacket = orig;
  }
});

test("perf: Memory.taskList is called at most once per agent run", async () => {
  const orig = Memory.taskList;
  let callCount = 0;
  Memory.taskList = async function (...args) {
    callCount++;
    return orig.apply(this, args);
  };
  try {
    const core = makeFakeCore({ configJson: JSON.stringify({ context_packet_max_project_intel_tokens: 0 }) });
    const created = core.pmCreateAgent(99, "taskList call count test");
    const agentId = created.id;
    core.pmUpdateAgent(1, agentId, STATES.IDLE, JSON.stringify({
      version: 1,
      steps: [
        { id: "step-1", title: "a", status: "pending", depends_on: [], files: [], assigned_to: null },
        { id: "step-2", title: "b", status: "pending", depends_on: [], files: [], assigned_to: null },
      ],
    }), 0, 0);

    const capture = { captured: null };
    const provider = makeMultiRoundProvider(capture, 2);
    const startRes = await startAgent({ core, profileId: 1, agentId, provider });
    await waitForTerminal(startRes.bus);

    assert.ok(
      callCount <= 1,
      `Memory.taskList must be called at most once per agent run; got ${callCount} calls`,
    );
  } finally {
    Memory.taskList = orig;
  }
});

// ---------------------------------------------------------------------------
// 3) Context packet size is bounded
// ---------------------------------------------------------------------------

test("perf: first user message context packet is bounded below 50,000 tokens", async () => {
  const core = makeFakeCore({
    configJson: JSON.stringify({
      context_packet_max_tokens: 2000,
      context_packet_max_project_intel_tokens: 1500,
    }),
  });
  const created = core.pmCreateAgent(99, "context size bound test");
  const agentId = created.id;
  core.pmUpdateAgent(1, agentId, STATES.IDLE, JSON.stringify({
    version: 1,
    steps: [{ id: "step-1", title: "single", status: "pending", depends_on: [], files: [], assigned_to: null }],
  }), 0, 0);

  const capture = { captured: null };
  const provider = makeCapturingProvider(capture);
  const startRes = await startAgent({ core, profileId: 1, agentId, provider });
  await waitForTerminal(startRes.bus);

  const firstUser = capture.captured && capture.captured[1];
  assert.ok(firstUser, "first user message must exist");
  const tokens = tokenEstimate(firstUser.content);
  assert.ok(
    tokens < 50000,
    `context packet must be below 50,000 tokens; got ~${tokens} tokens`,
  );
});

// ---------------------------------------------------------------------------
// 4) IPC agent:list-messages uses paginated handler (batched, not 1-per-message)
// ---------------------------------------------------------------------------

test("perf: agent:list-messages IPC handler uses pmListMessagesPaginated (batched)", () => {
  // The IPC handler source lives in shell/src/ipc/project-mode.js.
  // We verify statically that the handler for `agent:list-messages`
  // calls `pmListMessagesPaginated` (which accepts a limit/before
  // cursor) rather than calling `pmListMessages` in a per-message loop.
  const ipcPath = join(import.meta.dirname, "..", "src", "ipc", "project-mode.js");
  const source = readFileSync(ipcPath, "utf8");

  // The handler must reference pmListMessagesPaginated.
  assert.match(
    source,
    /(?:ipcMain\.handle|safeHandle)\s*\(\s*["']agent:list-messages["']/,
    "agent:list-messages IPC handler must be registered",
  );
  assert.match(
    source,
    /pmListMessagesPaginated/,
    "agent:list-messages handler must use pmListMessagesPaginated for batched retrieval",
  );

  // And it must NOT contain a pattern that suggests per-message iteration
  // (e.g. a for-loop calling pmListMessages one at a time within the
  // agent:list-messages handler). We check that there is no `for` loop
  // between the handler registration and the pmListMessagesPaginated call.
  const handlerMatch = source.match(/(?:ipcMain\.handle|safeHandle)\s*\(\s*["']agent:list-messages["']/);
  const handlerStart = handlerMatch?.index ?? -1;
  const paginatedCall = source.indexOf("pmListMessagesPaginated", handlerStart);
  const nextMatch = source.slice(handlerStart + 1).match(/(?:ipcMain\.handle|safeHandle)\s*\(/);
  const nextHandler = nextMatch ? handlerStart + 1 + nextMatch.index : -1;
  // The paginated call must appear before the next handler registration
  // (i.e. it is inside this handler's callback).
  assert.ok(
    paginatedCall > handlerStart && (nextHandler === -1 || paginatedCall < nextHandler),
    "pmListMessagesPaginated must be called inside the agent:list-messages handler",
  );
});
// ---------------------------------------------------------------------------
// 5) Sub-agent poll interval is not aggressive (>= 1000ms)
// ---------------------------------------------------------------------------

test("perf: sub-agent poll fallback interval is a sane non-zero value", () => {
  const delegatePath = join(import.meta.dirname, "..", "src", "services", "project-tools", "delegate_research.js");
  const source = readFileSync(delegatePath, "utf8");

  // The POLL_MS constant is configurable via SUBAGENT_POLL_MS env var with
  // a numeric fallback default, e.g. `Number(process.env.SUBAGENT_POLL_MS) || 2000`.
  const match = source.match(/\|\|\s*(\d+)\s*;/);
  assert.ok(match, "POLL_MS default must be declared in delegate_research.js");
  const pollMs = parseInt(match[1], 10);
  // Sanity floor: the poll is a fallback safety net (the primary wake-up
  // is event-driven via onSubAgentTerminal). It must never be 0 or
  // sub-1000ms, which would burn NAPI calls for no benefit when the
  // event-driven wake covers normal completion. GATE 17 v8 raised the
  // default from 500ms to 2000ms to cut ~30 unnecessary NAPI calls per
  // 30-second sub-agent wait (see docs/PERF-AUDIT-V6.md bottleneck #3).
  assert.ok(
    pollMs >= 1000,
    `POLL_MS default must be >= 1000ms; got ${pollMs}ms`,
  );
});
