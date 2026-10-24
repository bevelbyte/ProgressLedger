// Browser tools — renderer event boundary (Agent→Browser extension).
//
// The event sanitizer is a structural allowlist: for every event type it
// copies only explicitly permitted fields. These tests pin that guarantee
// for the browser tool surface specifically, so a future change that
// widens the sanitizer (or adds browser-specific payload fields) fails
// loudly here instead of leaking typed text, URLs, or selectors to the
// renderer.
import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeAgentEvent } from "../src/services/agent/event-sanitizer.js";

const TUPLE = { profileId: 7, projectId: 9, agentId: 11 };

function browserEvent(type, payload) {
  return sanitizeAgentEvent({ ...TUPLE, event: { type, ts: 123, runId: "run-b", payload } });
}

test("browser_type typed text never crosses the event boundary", () => {
  const out = browserEvent("agent.tool.started", {
    tool: "browser_type",
    callId: "call-t1",
    input: { selector: "#password", text: "typed-secret-text" },
  });
  assert.equal(out.tool, "browser_type");
  assert.equal(out.callId, "call-t1");
  assert.equal(out.input, undefined);
  assert.equal(JSON.stringify(out).includes("typed-secret-text"), false);
  assert.equal(JSON.stringify(out).includes("password"), false);
});

test("browser_navigate URL is stripped from tool and approval events", () => {
  const started = browserEvent("agent.tool.started", {
    tool: "browser_navigate",
    callId: "call-n1",
    input: { url: "https://internal.example/secret-path?token=abc" },
  });
  assert.equal(started.input, undefined);
  assert.equal(JSON.stringify(started).includes("internal.example"), false);

  const approval = browserEvent("agent.approval.required", {
    approvalId: "11:call-n1",
    callId: "call-n1",
    tool: "browser_navigate",
    permission: "write",
    input: { url: "https://internal.example/secret-path" },
  });
  assert.equal(approval.tool, "browser_navigate");
  assert.equal(approval.permission, "write");
  assert.equal(approval.input, undefined);
  assert.equal(JSON.stringify(approval).includes("internal.example"), false);
});

test("browser selector arguments are stripped from started/completed/failed events", () => {
  const selector = "[data-internal-quota-selector]";
  const started = browserEvent("agent.tool.started", { tool: "browser_click", callId: "call-c1", input: { selector } });
  const completed = browserEvent("agent.tool.completed", { tool: "browser_click", callId: "call-c1", input: { selector }, elapsedMs: 12, result: { selector } });
  const failed = browserEvent("agent.tool.failed", { tool: "browser_click", callId: "call-c1", input: { selector }, error: { code: "selector-not-found", detail: selector } });
  for (const out of [started, completed, failed]) {
    assert.equal(out.input, undefined);
    assert.equal(out.result, undefined);
    assert.equal(JSON.stringify(out).includes("data-internal-quota-selector"), false);
  }
  assert.equal(failed.errorCode, "selector-not-found");
});

test("browser tool output text cannot ride along on completed events", () => {
  const out = browserEvent("agent.tool.completed", {
    tool: "browser_extract_text",
    callId: "call-e1",
    result: { text: "page-body-should-not-render" },
  });
  assert.equal(out.result, undefined);
  assert.equal(JSON.stringify(out).includes("page-body-should-not-render"), false);
});

test("browser events still require the full ownership tuple", () => {
  const out = sanitizeAgentEvent({
    profileId: 7,
    agentId: 11,
    event: { type: "agent.tool.started", ts: 123, runId: "run-b", payload: { tool: "browser_navigate", callId: "x" } },
  });
  assert.equal(out, null);
});
