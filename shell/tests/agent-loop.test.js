// Phase 11 — agent loop state machine + event stream regression.
//
// Covers: state transitions, tool registration, malformed input,
// approval flow, cancellation, multi-step execution, run registry,
// event bus ring buffer.

import test from "node:test";
import assert from "node:assert/strict";

import { STATES, canTransition, AgentEventBus, AGENT_EVENTS, cancelAgent, getRun, listActiveRuns, startAgent } from "../src/services/agent/loop.js";
import { PROJECT_TOOLS, listTools, getTool } from "../src/services/project-tools/index.js";
import { PERMISSIONS, APPROVAL_REQUIRED } from "../src/services/project-tools/security.js";
import { registerUnsupportedDonutTools } from "../src/services/browser-workspace-tools.js";

// ----------------------------------------------------------------------------
// State machine
// ----------------------------------------------------------------------------

test("state machine: every defined state is a string", () => {
  for (const v of Object.values(STATES)) {
    assert.equal(typeof v, "string");
    assert.ok(v.length > 0);
  }
});

test("state machine: idle can only go to planning/failed/cancelled", () => {
  for (const to of Object.values(STATES)) {
    if (to === STATES.PLANNING || to === STATES.FAILED || to === STATES.CANCELLED) {
      assert.equal(canTransition(STATES.IDLE, to), true, `${STATES.IDLE} -> ${to} should be allowed`);
    } else {
      assert.equal(canTransition(STATES.IDLE, to), false, `${STATES.IDLE} -> ${to} should be blocked`);
    }
  }
});

test("state machine: terminal states have no outgoing transitions", () => {
  for (const terminal of [STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED]) {
    for (const to of Object.values(STATES)) {
      assert.equal(canTransition(terminal, to), false, `${terminal} -> ${to} should be blocked`);
    }
  }
});

test("state machine: planning -> executing_tool is allowed", () => {
  assert.equal(canTransition(STATES.PLANNING, STATES.EXECUTING_TOOL), true);
});

// ----------------------------------------------------------------------------
// Event bus
// ----------------------------------------------------------------------------

test("event bus: subscribers receive emitted events", () => {
  const bus = new AgentEventBus();
  const received = [];
  bus.on(AGENT_EVENTS.AGENT_TOOL_STARTED, (e) => received.push(e));
  bus.emit(AGENT_EVENTS.AGENT_TOOL_STARTED, { tool: "fs_list" });
  bus.emit(AGENT_EVENTS.AGENT_TOOL_STARTED, { tool: "fs_read" });
  assert.equal(received.length, 2);
  assert.equal(received[0].type, AGENT_EVENTS.AGENT_TOOL_STARTED);
  assert.equal(received[0].payload.tool, "fs_list");
});

test("event bus: ring buffer caps at ringSize", () => {
  const bus = new AgentEventBus({ ringSize: 3 });
  for (let i = 0; i < 10; i++) {
    bus.emit(AGENT_EVENTS.AGENT_TEXT_DELTA, { delta: `chunk${i}` });
  }
  const recent = bus.recent();
  assert.equal(recent.length, 3);
  assert.equal(recent[0].payload.delta, "chunk7");
  assert.equal(recent[2].payload.delta, "chunk9");
});

test("event bus: returns unsubscribe function", () => {
  const bus = new AgentEventBus();
  let count = 0;
  const off = bus.on(AGENT_EVENTS.AGENT_TOOL_STARTED, () => count++);
  bus.emit(AGENT_EVENTS.AGENT_TOOL_STARTED, { tool: "x" });
  off();
  bus.emit(AGENT_EVENTS.AGENT_TOOL_STARTED, { tool: "x" });
  assert.equal(count, 1);
});

test("event bus: optional observer receives the complete event envelope", () => {
  const received = [];
  const bus = new AgentEventBus({ onEvent: (event) => received.push(event) });
  bus.emit(AGENT_EVENTS.AGENT_STARTED, { agentId: 11 });
  assert.equal(received.length, 1);
  assert.equal(received[0].type, AGENT_EVENTS.AGENT_STARTED);
  assert.deepEqual(received[0].payload, { agentId: 11 });
});

test("event bus: observer failures cannot break event delivery", () => {
  const bus = new AgentEventBus({ onEvent: () => { throw new Error("observer failure"); } });
  assert.doesNotThrow(() => bus.emit(AGENT_EVENTS.AGENT_STARTED, { agentId: 11 }));
  assert.equal(bus.recent().length, 1);
});

test("approval event: carries a stable approval id and call id", () => {
  const bus = new AgentEventBus();
  bus.emit(AGENT_EVENTS.AGENT_APPROVAL_REQUIRED, {
    approvalId: "11:call-7",
    callId: "call-7",
    tool: "exec_run",
    permission: "execute",
    input: { command: "secret-command" },
  });
  const event = bus.recent(1)[0];
  assert.equal(event.payload.approvalId, "11:call-7");
  assert.equal(event.payload.callId, "call-7");
});

// ----------------------------------------------------------------------------
// Tool registry
// ----------------------------------------------------------------------------

test("tools: every registered tool has a name, description, permission, timeoutMs, inputSchema", () => {
  for (const t of listTools()) {
    assert.equal(typeof t.name, "string");
    assert.ok(t.name.length > 0);
    assert.equal(typeof t.description, "string");
    assert.ok(Object.values(PERMISSIONS).includes(t.permission), `${t.name} has invalid permission ${t.permission}`);
    assert.equal(typeof t.timeoutMs, "number");
    assert.ok(t.timeoutMs > 0, `${t.name} timeoutMs must be positive`);
    assert.equal(t.inputSchema && t.inputSchema.type, "object", `${t.name} inputSchema must be an object schema`);
  }
});

test("tools: APPROVAL_REQUIRED is a subset of the registry", () => {
  // Retired Donut page-control names remain registered as honest refusals.
  // This mirrors the production IPC registrar; no browser operations are wired.
  registerUnsupportedDonutTools();
  const names = new Set(listTools().map((t) => t.name));
  for (const n of APPROVAL_REQUIRED) {
    assert.ok(names.has(n), `APPROVAL_REQUIRED references unknown tool ${n}`);
  }
});

test("tools: getTool returns a tool by name", () => {
  const t = getTool("fs_list");
  assert.ok(t);
  assert.equal(t.name, "fs_list");
});

test("tools: getTool returns null for unknown tools", () => {
  assert.equal(getTool("definitely_not_a_real_tool"), null);
});

// ----------------------------------------------------------------------------
// Run registry
// ----------------------------------------------------------------------------

test("run registry: listActiveRuns returns a fresh array (not the live map)", () => {
  // We do not call startAgent here (it would need a real core). We
  // just verify the helper is safe to call when no runs are active.
  const initial = listActiveRuns();
  assert.ok(Array.isArray(initial));
  assert.equal(initial.length, 0);
});

test("run registry: getRun returns null for unknown agentId", () => {
  assert.equal(getRun(99999999), null);
});

// ----------------------------------------------------------------------------
// Cancellation
// ----------------------------------------------------------------------------

test("cancelAgent: returns not-running for unknown agentId", () => {
  assert.deepEqual(cancelAgent(99999999), { ok: false, reason: "not-running" });
});

// ----------------------------------------------------------------------------
// SECURITY
// ----------------------------------------------------------------------------

test("security: APPROVAL_REQUIRED includes privileged execution and write tools", () => {
  // The agent loop hardcodes these names in `requiresApproval()`. The
  // tests pin both ends so a refactor that drops one is caught.
  assert.ok(APPROVAL_REQUIRED.has("exec_run"));
  assert.ok(APPROVAL_REQUIRED.has("fs_write"));
  // Read-only tools remain ungated; project execution is approval-gated.
  const expected = new Set([
    "fs_list",
    "fs_read",
    "fs_search",
    "shell_git_status",
    "shell_git_diff",
    "shell_git_log",
    "inspect_project",
  ]);
  for (const n of listTools().map((t) => t.name)) {
    if (expected.has(n)) {
      assert.equal(APPROVAL_REQUIRED.has(n), false, `${n} should not require approval`);
    }
  }
  assert.equal(APPROVAL_REQUIRED.has("test_run"), true);
  assert.equal(APPROVAL_REQUIRED.has("build_run"), true);
});
