import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeAgentEvent, isCurrentAgentRunEvent } from "../src/services/agent/event-sanitizer.js";

test("agent event sanitizer preserves live metadata but strips tool input", () => {
  const result = sanitizeAgentEvent({
    profileId: 7,
    projectId: 9,
    agentId: 11,
    event: {
      type: "agent.tool.started",
      ts: 123,
      runId: "run-1",
      payload: { tool: "fs_write", callId: "call-1", input: { content: "SECRET" }, token: "SECRET" },
    },
  });
  assert.deepEqual(result, {
    profileId: 7,
    projectId: 9,
    agentId: 11,
    runId: "run-1",
    type: "agent.tool.started",
    ts: 123,
    tool: "fs_write",
    callId: "call-1",
  });
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
});

test("agent event sanitizer preserves approval correlation but strips input", () => {
  const out = sanitizeAgentEvent({
    profileId: 3,
    projectId: 4,
    agentId: 11,
    event: {
      type: "agent.approval.required",
      ts: 123,
      runId: "run-2",
      payload: {
        approvalId: "11:call-7",
        callId: "call-7",
        tool: "exec_run",
        permission: "execute",
        input: { command: "do-not-render" },
      },
    },
  });
  assert.deepEqual(out, {
    profileId: 3,
    projectId: 4,
    agentId: 11,
    runId: "run-2",
    type: "agent.approval.required",
    ts: 123,
    approvalId: "11:call-7",
    callId: "call-7",
    tool: "exec_run",
    permission: "execute",
  });
  assert.equal(out.input, undefined);
});

test("agent event sanitizer keeps safe completion/error fields", () => {
  assert.deepEqual(
    sanitizeAgentEvent({ profileId: 7, projectId: 9, agentId: 11, event: {
      type: "agent.tool.failed", ts: 456,
      runId: "run-3",
      payload: { tool: "exec_run", callId: "c2", error: { code: "exit-nonzero", message: "private" }, input: "private" },
    }}),
    { profileId: 7, projectId: 9, agentId: 11, runId: "run-3", type: "agent.tool.failed", ts: 456, tool: "exec_run", callId: "c2", errorCode: "exit-nonzero" },
  );
});

test("agent event sanitizer requires the complete ownership tuple", () => {
  const event = { type: "agent.started", ts: 1, runId: "r1", payload: {} };
  assert.equal(sanitizeAgentEvent({ profileId: 7, agentId: 11, event }), null);
  assert.equal(sanitizeAgentEvent({ profileId: 7, projectId: 0, agentId: 11, event }), null);
  assert.notEqual(sanitizeAgentEvent({ profileId: 7, projectId: 9, agentId: 11, event }), null);
});


test("agent event sanitizer rejects missing run id and bounds model text", () => {
  assert.equal(sanitizeAgentEvent({ profileId: 1, projectId: 2, agentId: 3, event: { type: "agent.text.delta", payload: { delta: "x" } } }), null);
  const out = sanitizeAgentEvent({ profileId: 1, projectId: 2, agentId: 3, event: {
    type: "agent.text.delta", runId: "run-current", payload: { delta: "x".repeat(10000) },
  }});
  assert.equal(out.delta.length, 4096);
});

test("agent event run guard rejects stale and cross-run events", () => {
  assert.equal(isCurrentAgentRunEvent({ runId: "old" }, { runId: "new" }), false);
  assert.equal(isCurrentAgentRunEvent({ runId: "new" }, { runId: "new" }), true);
  assert.equal(isCurrentAgentRunEvent({ runId: "new" }, null), false);
});
