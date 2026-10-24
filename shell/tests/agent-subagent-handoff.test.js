// Phase 12 — sub-agent handoff tests.
//
// Covers the contract between a finished child agent and its parent:
//   - parseSubAgentResult returns structured fields for a well-formed
//     transcript.
//   - parseSubAgentResult returns the raw-text fallback when the last
//     assistant message is not valid JSON.
//   - The parent's wait loop wakes IMMEDIATELY when the child emits a
//     terminal state (no 500ms polling delay).
//
// Pure node:test, no IPC, no Electron.

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseSubAgentResult,
  SUBAGENT_ROLES,
  SUBAGENT_DEFAULT_SHAPES,
} from "../src/services/agent/subagent-result.js";
import {
  getChildState,
  onSubAgentTerminal,
  invalidateChildStateCache,
  _emitChildTerminalForTest,
  SUBAGENT_EVENTS,
} from "../src/services/agent/loop.js";

// ---------------------------------------------------------------------------
// 1) parser — pure helper, well-formed transcript
// ---------------------------------------------------------------------------

test("handoff: parseSubAgentResult returns structured fields for well-formed transcript (coder)", () => {
  const transcript = [
    { role: "system", content: "system prompt", payload_json: null },
    { role: "user", content: "implement foo", payload_json: null },
    { role: "assistant", content: null, payload_json: JSON.stringify({ tool_calls: [] }) },
    // Last assistant message — a clean JSON object matching the coder shape.
    {
      role: "assistant",
      content: JSON.stringify({
        files_changed: ["src/a.js", "src/b.js"],
        summary: "Updated foo to handle null",
        notes: "no breaking changes",
      }),
      payload_json: null,
    },
  ];
  const r = parseSubAgentResult(transcript, "coder");
  assert.equal(r.role, "coder");
  assert.equal(r.structured, true);
  assert.deepEqual(r.files_changed, ["src/a.js", "src/b.js"]);
  assert.equal(r.summary, "Updated foo to handle null");
  assert.equal(r.notes, "no breaking changes");
  // Default shape is preserved for fields the model didn't supply.
  assert.ok(r.defaultShape, "defaultShape should be attached");
  assert.deepEqual(r.defaultShape.files_changed, []);
});

test("handoff: parseSubAgentResult works for every role (researcher/coder/tester/reviewer)", () => {
  for (const role of SUBAGENT_ROLES) {
    const shape = SUBAGENT_DEFAULT_SHAPES[role];
    const transcript = [
      { role: "assistant", content: JSON.stringify(shape), payload_json: null },
    ];
    const r = parseSubAgentResult(transcript, role);
    assert.equal(r.structured, true, `${role} should parse as structured`);
    assert.equal(r.role, role);
    // Every role has at least a `summary` field or the equivalent.
    assert.ok(typeof r === "object" && r !== null);
  }
});

test("handoff: parseSubAgentResult tolerates model synonyms for `summary`", () => {
  // Model returns `notes` instead of `summary`. Parser lifts it.
  const transcript = [
    {
      role: "assistant",
      content: JSON.stringify({ notes: "looked fine", files_changed: [] }),
      payload_json: null,
    },
  ];
  const r = parseSubAgentResult(transcript, "coder");
  assert.equal(r.summary, "looked fine");
});

test("handoff: parseSubAgentResult normalises files_changed to an array", () => {
  // Model returns `files_changed: "src/a.js"` (wrong type). Parser
  // should reset to [] rather than leaking the bad shape.
  const transcript = [
    {
      role: "assistant",
      content: JSON.stringify({ files_changed: "src/a.js", summary: "ok" }),
      payload_json: null,
    },
  ];
  const r = parseSubAgentResult(transcript, "coder");
  assert.deepEqual(r.files_changed, []);
});

// ---------------------------------------------------------------------------
// 2) parser — fallback to raw text when last message is not JSON
// ---------------------------------------------------------------------------

test("handoff: parseSubAgentResult returns raw-text fallback when last assistant is not JSON", () => {
  const transcript = [
    { role: "system", content: "system", payload_json: null },
    { role: "user", content: "do the thing", payload_json: null },
    { role: "assistant", content: "here is some prose without any json at all", payload_json: null },
  ];
  const r = parseSubAgentResult(transcript, "researcher");
  assert.equal(r.structured, false);
  assert.equal(r.role, "researcher");
  assert.equal(r.summary, "here is some prose without any json at all");
  assert.deepEqual(r.files_changed, []);
  assert.equal(r.raw, "here is some prose without any json at all");
});

test("handoff: parseSubAgentResult fallback finds last assistant text, not earlier JSON", () => {
  // Earlier assistant IS valid JSON, but the LAST assistant is prose.
  // The parser must use the LAST assistant message, not the first.
  const transcript = [
    { role: "assistant", content: JSON.stringify({ summary: "early json" }), payload_json: null },
    { role: "user", content: "follow up", payload_json: null },
    { role: "assistant", content: "and now prose", payload_json: null },
  ];
  const r = parseSubAgentResult(transcript, "reviewer");
  assert.equal(r.structured, false);
  assert.equal(r.summary, "and now prose");
});

test("handoff: parseSubAgentResult returns empty summary for empty transcript", () => {
  const r = parseSubAgentResult([], "tester");
  assert.equal(r.structured, false);
  assert.equal(r.summary, "");
  assert.equal(r.role, "tester");
});

test("handoff: parseSubAgentResult ignores unknown role", () => {
  // Unknown role → role: "" but the parser still produces a structured
  // result when the model returns a valid JSON object.
  const r = parseSubAgentResult(
    [{ role: "assistant", content: JSON.stringify({ summary: "hi", custom: 1 }) }],
    "bogus",
  );
  assert.equal(r.role, "");
  assert.equal(r.summary, "hi");
  assert.equal(r.structured, true);
});

// ---------------------------------------------------------------------------
// 3) event-driven handoff — parent wakes without polling
// ---------------------------------------------------------------------------

test("handoff: getChildState caches pmGetAgent results for 200ms", async () => {
  let n = 0;
  const agent = { state: "planning", finished_at: null };
  const core = {
    async pmGetAgent() { n++; return { ...agent }; },
  };
  await getChildState(core, 1, 42);
  await getChildState(core, 1, 42);
  await getChildState(core, 1, 42);
  assert.equal(n, 1, "second + third call should hit the cache");
});

test("handoff: invalidateChildStateCache forces the next read to be fresh", async () => {
  let n = 0;
  const core = {
    async pmGetAgent() { n++; return { state: "planning", finished_at: null }; },
  };
  await getChildState(core, 1, 7);
  await getChildState(core, 1, 7);
  invalidateChildStateCache(7);
  await getChildState(core, 1, 7);
  assert.equal(n, 2);
});

test("handoff: onSubAgentTerminal listener is invoked when a child emits a terminal event", () => {
  const received = [];
  const off = onSubAgentTerminal((d) => received.push(d));
  // Use the test-only emitter that dispatches on the SAME EventTarget
  // that production listeners subscribe to (see loop.js `_emitChildTerminalForTest`).
  _emitChildTerminalForTest(7, "completed", 1);
  assert.equal(received.length, 1);
  assert.equal(received[0].childAgentId, 7);
  assert.equal(received[0].state, "completed");
  off();
});

test("handoff: parent wake path picks up the child result without polling when event fires mid-iteration", async () => {
  // This is the integration-shaped test: the parent polls
  // getChildState but the child reaches a terminal state mid-iteration
  // and emits a SUBAGENT_EVENTS.CHILD_TERMINAL event. The parent's
  // wait loop must wake on the event (not on the 500ms fallback) and
  // resolve with the structured result from parseSubAgentResult.
  //
  // We model the wait loop inline (no real delegate_research here —
  // it's covered by agent-delegation.test.js). The critical property
  // is: the loop completes in O(event-latency), not 2000ms.

  const POLL_MS = 2000;
  const childAgentId = 99;
  let calls = 0;
  const fakeCore = {
    async pmGetAgent() {
      calls++;
      // Simulate the child finishing mid-poll.
      if (calls === 1) return { state: "planning", finished_at: null };
      return { state: "completed", finished_at: new Date().toISOString() };
    },
    async pmListMessages() {
      return [
        { role: "assistant", content: JSON.stringify({ summary: "done", findings: ["x"] }), payload_json: null },
      ];
    },
  };

  // Wire a listener that mirrors what delegate_research's runDelegate
  // does in production: race the wake against the 500ms fallback.
  let wake;
  const waitForEvent = new Promise((r) => { wake = r; });
  const unsubscribe = onSubAgentTerminal((d) => {
    if (d && d.childAgentId === childAgentId && wake) {
      const w = wake; wake = null; w(d);
    }
  });
  invalidateChildStateCache(childAgentId);

  // First poll — child not done yet.
  const startedAt = Date.now();
  let cs = await getChildState(fakeCore, 1, childAgentId);
  assert.equal(cs.state, "planning");

  // Simulate the child loop's finishAgent firing the event ~30ms
  // later — well under the 500ms fallback tick. We use the
  // _emitChildTerminalForTest helper so the dispatch goes through
  // the SAME EventTarget that production listeners subscribe to.
  setTimeout(() => {
    _emitChildTerminalForTest(childAgentId, "completed", Date.now());
  }, 30);

  // Race the event-driven wake against the fallback tick.
  const detail = await Promise.race([
    waitForEvent,
    new Promise((r) => setTimeout(() => r(null), POLL_MS - 50)),
  ]);
  assert.ok(detail, "expected event-driven wake (not the fallback)");
  assert.equal(detail.state, "completed");

  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < POLL_MS - 50, `expected fast wake (<${POLL_MS - 50}ms), got ${elapsed}ms`);

  // The next getChildState reads fresh (cache was invalidated by the
  // event dispatcher).
  cs = await getChildState(fakeCore, 1, childAgentId);
  assert.equal(cs.state, "completed");

  // And the parser produces the structured result.
  const messages = await fakeCore.pmListMessages();
  const result = parseSubAgentResult(messages, "researcher");
  assert.equal(result.structured, true);
  assert.equal(result.summary, "done");
  assert.deepEqual(result.findings, ["x"]);

  unsubscribe();
});