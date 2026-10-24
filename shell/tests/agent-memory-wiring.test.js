// Phase K — agent loop + memory wiring tests.
//
// Pins the contract that the agent loop injects a memory contextPacket
// (and recent task history) into the FIRST user message sent to the
// model. The packet is read ONCE per agent run (not per step), is
// gated by `project.config_json`, and the loop must remain functional
// when Memory has not been seeded for the project.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startAgent, AGENT_EVENTS, STATES } from "../src/services/agent/loop.js";
import { scriptedProvider } from "../src/services/agent/fixture.js";
import {
  Memory,
  _setUserDataDir,
  _closeAll,
} from "../src/services/memory/index.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeFakeCore({ configJson = "{}" } = {}) {
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
  const core = {
    pmCreateAgent(projectId, objective) {
      const id = nextAgentId++;
      agents.set(id, {
        id,
        projectId: projectId,
        objective,
        state: STATES.IDLE,
        planJson: "[]",
        tokensIn: 0,
        tokensOut: 0,
        finishedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        parentAgentId: null,
      });
      messages.set(id, []);
      return { id };
    },
    pmGetAgent(_profileId, agentId) {
      const a = agents.get(agentId);
      if (!a) throw new Error("not found");
      return { ...a };
    },
    pmUpdateAgent(_profileId, agentId, state, planJson, tokensIn, tokensOut) {
      const a = agents.get(agentId);
      if (!a) throw new Error("not found");
      a.state = state;
      a.planJson = planJson;
      a.plan_json = planJson;
      a.tokensIn = tokensIn;
      a.tokensIn_legacy = tokensIn;
      a.tokensOut = tokensOut;
      a.updatedAt = new Date().toISOString();
      a.updated_at = new Date().toISOString();
      return { ok: true };
    },
    pmAppendMessage(profileId, agentId, role, content, name, payloadJson) {
      record(agentId, role, content, name, payloadJson);
      return { seq: (messages.get(agentId) || []).length };
    },
    pmFinishAgent(_profileId, agentId, state) {
      const a = agents.get(agentId);
      if (!a) throw new Error("not found");
      a.state = state;
      a.finishedAt = new Date().toISOString();
      a.finished_at = new Date().toISOString();
    },
    pmGetProject(_profileId, _projectId) {
      return {
        id: 10,
        profileId: 1,
        name: "Memory wiring project",
        description: "",
        rootPath: "/tmp/cf-memory-wiring",
        configJson: configJson,
        createdAt: "1970-01-01T00:00:00Z",
        updatedAt: "1970-01-01T00:00:00Z",
      };
    },
    pmListMessages(_profileId, agentId) {
      return (messages.get(agentId) || []).slice();
    },
    _agents: agents,
    _messages: messages,
  };
  return core;
}

/**
 * Build a recording provider that captures the `messages` argument on
 * the first `streamChat` call and then yields a single text-only
 * "done" reply so the loop advances to verification. We capture on the
 * first call because that is where the augmented first user message
 * lives.
 */
function makeCapturingProvider(captureRef) {
  let firstCallSeen = false;
  return {
    async *streamChat(opts = {}) {
      if (!firstCallSeen) {
        firstCallSeen = true;
        captureRef.messages = Array.isArray(opts.messages) ? opts.messages.slice() : [];
      }
      yield { type: "text_delta", delta: "done." };
      yield { type: "text_delta", delta: "" };
      yield { type: "usage", inputTokens: 1, outputTokens: 2 };
      yield { type: "finish", reason: "stop" };
    },
  };
}

function waitForTerminal(bus) {
  return new Promise((resolve) => {
    bus.on(AGENT_EVENTS.AGENT_COMPLETED, (e) => resolve({ kind: "completed", payload: e.payload }));
    bus.on(AGENT_EVENTS.AGENT_FAILED, (e) => resolve({ kind: "failed", payload: e.payload }));
    bus.on(AGENT_EVENTS.AGENT_CANCELLED, () => resolve({ kind: "cancelled" }));
  });
}

// ---------------------------------------------------------------------------
// 1) config_json.context_packet_max_tokens = 2000 -> packet injected
// ---------------------------------------------------------------------------

test("memory wiring: first user message includes the contextPacket when context_packet_max_tokens = 2000", async () => {
  const userData = mkdtempSync(join(tmpdir(), "cf-mem-wire-"));
  _setUserDataDir(userData);
  try {
    // Seed two project-memory entries so buildContextPacket has data to
    // return. The entries share a token ("refactor") with the
    // objective so the ranker includes at least one of them. The
    // profileId must equal the project's id so the loop's query finds
    // the seeded rows.
    await Memory.projectSet(10, "decision", "refactor-style", "use ES modules, no default exports");
    await Memory.projectSet(10, "risk", "refactor-risk", "large blast radius across ui + shell");

    const core = makeFakeCore({
      configJson: JSON.stringify({ context_packet_max_tokens: 2000, show_recent_tasks: false }),
    });
    const created = core.pmCreateAgent(10, "refactor the loop to use smaller helpers");
    const agentId = created.id;
    // 1-step plan so verification trivially passes.
    core.pmUpdateAgent(1, agentId, STATES.IDLE, JSON.stringify({
      version: 1,
      steps: [{ id: "step-1", title: "single", status: "pending", depends_on: [], files: [], assigned_to: null }],
    }), 0, 0);

    const capture = { messages: null };
    const provider = makeCapturingProvider(capture);

    const startRes = await startAgent({ core, profileId: 1, agentId, provider });
    assert.equal(startRes.ok, true);
    const terminal = await waitForTerminal(startRes.bus);
    assert.equal(terminal.kind, "completed", `expected completed, got ${terminal.kind}`);

    assert.ok(Array.isArray(capture.messages), "provider must have been called with messages");
    assert.equal(capture.messages.length >= 2, true, "must have at least system + user");
    const firstUser = capture.messages[1];
    assert.equal(firstUser.role, "user");
    assert.match(firstUser.content, /## Project memory/, "first user message must include the ## Project memory section");
    assert.match(firstUser.content, /refactor/, "packet content must be embedded in the first user message");
    // The augmented message must START with the bare objective so the
    // model's instructions remain visible and unaltered.
    assert.ok(
      firstUser.content.startsWith("refactor the loop to use smaller helpers"),
      `first user message must start with the objective; got: ${JSON.stringify(firstUser.content.slice(0, 80))}`,
    );
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2) config_json.context_packet_max_tokens = 0 -> packet NOT injected
// ---------------------------------------------------------------------------

test("memory wiring: first user message does NOT include the packet when context_packet_max_tokens = 0", async () => {
  const userData = mkdtempSync(join(tmpdir(), "cf-mem-wire-"));
  _setUserDataDir(userData);
  try {
    // Seed an entry — it must be ignored when the cap is 0.
    await Memory.projectSet(10, "decision", "ignored", "should not appear");

    const core = makeFakeCore({
      configJson: JSON.stringify({ context_packet_max_tokens: 0, show_recent_tasks: false }),
    });
    const created = core.pmCreateAgent(10, "do the thing");
    const agentId = created.id;
    core.pmUpdateAgent(1, agentId, STATES.IDLE, JSON.stringify({
      version: 1,
      steps: [{ id: "step-1", title: "single", status: "pending", depends_on: [], files: [], assigned_to: null }],
    }), 0, 0);

    const capture = { messages: null };
    const provider = makeCapturingProvider(capture);

    const startRes = await startAgent({ core, profileId: 1, agentId, provider });
    assert.equal(startRes.ok, true);
    const terminal = await waitForTerminal(startRes.bus);
    assert.equal(terminal.kind, "completed");

    const firstUser = capture.messages[1];
    assert.equal(firstUser.content, "do the thing", "first user message must be the bare objective when packet is disabled");
    assert.doesNotMatch(firstUser.content, /## Project memory/);
    assert.doesNotMatch(firstUser.content, /should not appear/);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3) memory.recalled event fires with non-zero token count when packet is non-empty
// ---------------------------------------------------------------------------

test("memory wiring: emits memory.recalled event with non-zero token count when packet is non-empty", async () => {
  const userData = mkdtempSync(join(tmpdir(), "cf-mem-wire-"));
  _setUserDataDir(userData);
  try {
    await Memory.projectSet(10, "decision", "auth", "use OAuth 2.1 PKCE for all flows");
    await Memory.projectSet(10, "finding", "auth-gap", "session refresh never expires");

    const core = makeFakeCore({
      configJson: JSON.stringify({ context_packet_max_tokens: 2000, show_recent_tasks: false }),
    });
    const created = core.pmCreateAgent(10, "audit auth");
    const agentId = created.id;
    core.pmUpdateAgent(1, agentId, STATES.IDLE, JSON.stringify({
      version: 1,
      steps: [{ id: "step-1", title: "single", status: "pending", depends_on: [], files: [], assigned_to: null }],
    }), 0, 0);

    const recalledEvents = [];
    const provider = makeCapturingProvider({ messages: null });

    const startRes = await startAgent({ core, profileId: 1, agentId, provider });
    // The recall event fires synchronously during the first user-message
    // build, inside startAgent's background loop — `bus.on()` here would
    // miss it. Read from the bus's ring buffer after `waitForTerminal`.
    const terminal = await waitForTerminal(startRes.bus);
    assert.equal(terminal.kind, "completed");
    for (const ev of startRes.bus.recent(64)) {
      if (ev.type === AGENT_EVENTS.MEMORY_RECALLED) recalledEvents.push(ev.payload);
    }

    assert.ok(recalledEvents.length >= 1, "memory.recalled must fire at least once");
    const ev = recalledEvents[0];
    assert.equal(typeof ev, "object");
    assert.equal(ev.projectId, 10, "payload must include projectId");
    assert.ok(ev.tokenCount > 0, `tokenCount must be > 0, got ${ev.tokenCount}`);
    assert.equal(ev.historyCount, 0, "historyCount is 0 when show_recent_tasks is false");
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4) Memory uninitialized -> empty packet -> loop completes without crash
// ---------------------------------------------------------------------------

test("memory wiring: loop does NOT crash when Memory has no entries for the project", async () => {
  const userData = mkdtempSync(join(tmpdir(), "cf-mem-wire-"));
  _setUserDataDir(userData);
  try {
    // Deliberately NO projectSet / taskAppend calls — Memory has an
    // open but empty DB for this project. buildContextPacket must
    // return { ok: true, packet: "" } and the loop must proceed.

    const core = makeFakeCore({
      configJson: JSON.stringify({ context_packet_max_tokens: 2000, show_recent_tasks: true }),
    });
    const created = core.pmCreateAgent(10, "just verify the wiring is safe");
    const agentId = created.id;
    core.pmUpdateAgent(1, agentId, STATES.IDLE, JSON.stringify({
      version: 1,
      steps: [{ id: "step-1", title: "single", status: "pending", depends_on: [], files: [], assigned_to: null }],
    }), 0, 0);

    const capture = { messages: null };
    const provider = makeCapturingProvider(capture);

    const startRes = await startAgent({ core, profileId: 1, agentId, provider });
    assert.equal(startRes.ok, true, "startAgent must succeed even with no memory entries");
    const terminal = await waitForTerminal(startRes.bus);
    assert.equal(terminal.kind, "completed", `expected completed, got ${terminal.kind}: ${JSON.stringify(terminal.payload)}`);

    // The first user message must be the bare objective — no memory
    // block is appended because both sources are empty.
    const firstUser = capture.messages[1];
    assert.equal(firstUser.content, "just verify the wiring is safe");
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5) Bonus: show_recent_tasks = true appends the task history list
// ---------------------------------------------------------------------------

test("memory wiring: show_recent_tasks = true appends recent task history to the first user message", async () => {
  const userData = mkdtempSync(join(tmpdir(), "cf-mem-wire-"));
  _setUserDataDir(userData);
  try {
    // Memory is per (profile, project); profileId must equal the
    // project's id so the loop's query finds the seeded rows.
    await Memory.taskAppend(10, 7, "previous run: audited auth", true);
    await Memory.taskAppend(10, 8, "previous run: fixed refresh bug", false);

    const core = makeFakeCore({
      configJson: JSON.stringify({ context_packet_max_tokens: 2000, show_recent_tasks: true }),
    });
    const created = core.pmCreateAgent(10, "follow up on prior audits");
    const agentId = created.id;
    core.pmUpdateAgent(1, agentId, STATES.IDLE, JSON.stringify({
      version: 1,
      steps: [{ id: "step-1", title: "single", status: "pending", depends_on: [], files: [], assigned_to: null }],
    }), 0, 0);

    const capture = { messages: null };
    const provider = makeCapturingProvider(capture);

    const recalledEvents = [];
    const startRes = await startAgent({ core, profileId: 1, agentId, provider });
    const terminal = await waitForTerminal(startRes.bus);
    assert.equal(terminal.kind, "completed");
    for (const ev of startRes.bus.recent(64)) {
      if (ev.type === AGENT_EVENTS.MEMORY_RECALLED) recalledEvents.push(ev.payload);
    }

    const firstUser = capture.messages[1];
    assert.match(firstUser.content, /## Recent task history/, "history section must be present");
    assert.match(firstUser.content, /previous run: audited auth/);
    assert.match(firstUser.content, /previous run: fixed refresh bug/);

    assert.ok(recalledEvents.length >= 1);
    assert.equal(recalledEvents[0].historyCount, 2);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6) Bonus: config_json missing -> defaults applied (2000 tokens, history on)
// ---------------------------------------------------------------------------

test("memory wiring: missing config_json applies defaults (2000 token cap, history on)", async () => {
  const userData = mkdtempSync(join(tmpdir(), "cf-mem-wire-"));
  _setUserDataDir(userData);
  try {
    await Memory.projectSet(10, "decision", "default-key", "default value");
    await Memory.taskAppend(10, 1, "earlier summary", true);

    // config_json = "{}" — no context_packet_max_tokens, no show_recent_tasks
    const core = makeFakeCore({ configJson: "{}" });
    const created = core.pmCreateAgent(10, "default config wiring");
    const agentId = created.id;
    core.pmUpdateAgent(1, agentId, STATES.IDLE, JSON.stringify({
      version: 1,
      steps: [{ id: "step-1", title: "single", status: "pending", depends_on: [], files: [], assigned_to: null }],
    }), 0, 0);

    const capture = { messages: null };
    const provider = makeCapturingProvider(capture);

    const recalledEvents = [];
    const startRes = await startAgent({ core, profileId: 1, agentId, provider });
    const terminal = await waitForTerminal(startRes.bus);
    assert.equal(terminal.kind, "completed");
    for (const ev of startRes.bus.recent(64)) {
      if (ev.type === AGENT_EVENTS.MEMORY_RECALLED) recalledEvents.push(ev.payload);
    }

    const firstUser = capture.messages[1];
    assert.match(firstUser.content, /## Project memory/);
    assert.match(firstUser.content, /## Recent task history/);
    assert.ok(recalledEvents[0].tokenCount > 0);
    assert.equal(recalledEvents[0].historyCount, 1);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});