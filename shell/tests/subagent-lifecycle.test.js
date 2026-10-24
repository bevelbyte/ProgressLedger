// Sub-agent lifecycle hardening (Phase 13).
//
// Gap coverage on top of the existing suites (gate2 stress, gate10
// propagation, agent-delegation recursion guard, gate5 limits):
//
//   T1  child provider request fails -> child row FAILED in the real
//       shape, parent receives the failed state through delegate_research
//       and still completes; no orphan run slots.
//   T2  verification fix-retry signal round trip: a REAL failing verify
//       gate must reach the MODEL as a user message (persisted in the
//       transcript AND present in the next round's model context).
//
// Uses the faithful real-NAPI-shape core double (plain-number creates,
// camelCase-only rows, no startAgent on the core object) and the REAL
// test_run tool against real node subprocesses.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startAgent, getRun, AGENT_EVENTS, STATES } from "../src/services/agent/loop.js";
import { createMockProvider } from "../src/services/agent/provider.js";
import { _resetForTests as resetToolRegistry } from "../src/services/project-tools/index.js";

// ---------------------------------------------------------------------------
// real-shaped core double (mirrors the compiled NAPI surface exactly)
// ---------------------------------------------------------------------------

let agentIdSeq = 950_000;
let projectIdSeq = 950;

function makeRealShapeCore() {
  const agents = new Map();
  const messages = new Map();
  const projects = new Map();
  const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

  function recordMessage(agentId, role, content, name) {
    const list = messages.get(agentId) || [];
    const row = { id: list.length + 1, agentId, seq: list.length + 1, role, content, createdAt: now() };
    if (name != null) row.name = name;
    list.push(row);
    messages.set(agentId, list);
    return row.seq;
  }

  return {
    pmCreateProject(profileId, name, description, rootPath, configJson) {
      const id = projectIdSeq++;
      projects.set(id, { id, profileId, name, description: description ?? null, rootPath: rootPath ?? null, configJson: configJson ?? null, createdAt: now(), updatedAt: now() });
      return id;
    },
    pmCreateAgent(projectId, objective, parentAgentId) {
      const id = agentIdSeq++;
      const row = { id, projectId, objective, state: STATES.IDLE, planJson: "[]", tokensIn: 0, tokensOut: 0, createdAt: now(), updatedAt: now() };
      if (parentAgentId != null) row.parentAgentId = parentAgentId;
      agents.set(id, row);
      messages.set(id, []);
      return id;
    },
    pmGetAgent(_p, id) { const a = agents.get(id); return a ? { ...a } : null; },
    pmUpdateAgent(_p, id, state, planJson, ti, to) {
      const a = agents.get(id); if (!a) return;
      a.state = state; a.planJson = planJson; a.tokensIn = ti; a.tokensOut = to; a.updatedAt = now();
    },
    pmFinishAgent(_p, id, state) { const a = agents.get(id); if (a) { a.state = state; a.updatedAt = now(); } },
    pmAppendMessage(_p, id, role, content, name) { return recordMessage(id, role, content, name); },
    pmListMessages(_p, id) { return [...(messages.get(id) || [])].sort((x, y) => x.seq - y.seq).map((m) => ({ ...m })); },
    pmGetProject(_p, id) { const p = projects.get(id); return p ? { ...p } : null; },
    pmGetChildren(_p, parentId) {
      return [...agents.values()].filter((a) => a.parentAgentId === parentId).map((a) => ({ ...a }));
    },
    pmInsertSubagentRun() { return 1; },
    pmEndSubagentRun() {},
    pmListSubagentRuns() { return []; },
    _agents: agents,
    _messages: messages,
  };
}

async function runToTerminal(core, { profileId, agentId, provider, startSubAgent, timeoutMs = 60_000 }) {
  const startRes = await startAgent({
    core,
    profileId,
    agentId,
    provider,
    startSubAgent,
    approvalResolver: async () => ({ approved: true }),
  });
  assert.equal(startRes.ok, true, `startAgent: ${JSON.stringify(startRes)}`);
  const terminal = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), timeoutMs);
    const done = (kind) => (e) => { clearTimeout(t); resolve({ kind, payload: e && e.payload }); };
    startRes.bus.on(AGENT_EVENTS.AGENT_COMPLETED, done("completed"));
    startRes.bus.on(AGENT_EVENTS.AGENT_FAILED, done("failed"));
    startRes.bus.on(AGENT_EVENTS.AGENT_CANCELLED, done("cancelled"));
  });
  const s = Date.now();
  while (getRun(agentId) !== null && Date.now() - s < 5000) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return { startRes, terminal };
}

// A provider that scripts a DIFFERENT stream per model round.
function scriptedProvider(rounds) {
  let round = 0;
  const seenContexts = [];
  return {
    seenContexts,
    async *streamChat(args = {}) {
      const r = Math.min(round, rounds.length - 1);
      round += 1;
      seenContexts.push((args.messages || []).map((m) => ({
        role: m.role,
        content: String(m.content || ""),
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      })));
      const spec = rounds[r];
      for (const ev of spec) yield ev;
    },
  };
}

const toolCall = (id, name, args) => ({ type: "tool_call", id, name, args: JSON.stringify(args) });
const textReply = (t) => [
  { type: "text_delta", delta: t },
  { type: "usage", inputTokens: 5, outputTokens: 7 },
  { type: "finish", reason: "stop" },
];
const providerError = (code, msg) => [{ type: "error", code, message: msg }];

// ---------------------------------------------------------------------------
// T1 — child provider request fails: parent is informed and completes
// ---------------------------------------------------------------------------

test("T1: child provider failure -> child FAILED row, parent receives state and completes", async () => {
  resetToolRegistry();
  const root = mkdtempSync(join(tmpdir(), "cf-subagent-lifecycle-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.js"), "export const a = 1;\n");
  const core = makeRealShapeCore();
  try {
    const profileId = 1;
    const projectId = core.pmCreateProject(profileId, "lifecycle", null, root, JSON.stringify({ context_packet_max_tokens: 0 }));
    const agentId = core.pmCreateAgent(projectId, "Delegate research for step-1, then report the outcome.", null);

    // Parent round 1: delegate. Parent round 2: report the failure.
    // Child provider: first (and only) model round errors out.
    const childProvider = scriptedProvider([providerError("stream-error", "connection reset by peer")]);

    const rounds = [
      [toolCall("d1", "delegate_research", { objective: "Read src/a.js and summarize it.", step_id: "step-1" })],
      textReply("The researcher failed with a stream error; reporting that outcome."),
    ];
    const parentProvider2 = scriptedProvider(rounds);

    const startSubAgent = (childArgs) => startAgent({ ...childArgs, core, provider: childProvider });
    const { terminal } = await runToTerminal(core, { profileId, agentId, provider: parentProvider2, startSubAgent });
    assert.equal(terminal.kind, "completed", `parent terminal: ${JSON.stringify(terminal)}`);

    const children = core.pmGetChildren(profileId, agentId);
    assert.equal(children.length, 1, "one child row");
    assert.equal(children[0].state, STATES.FAILED, `child must be FAILED in the real-shaped store, got ${children[0].state}`);

    const toolResults = core.pmListMessages(profileId, agentId).filter((m) => m.role === "tool_result");
    const delegate = JSON.parse(toolResults[toolResults.length - 1].content);
    assert.equal(delegate.ok, true, "delegate returns ok envelope (the tool itself succeeded in observing the child)");
    assert.equal(delegate.result.state, STATES.FAILED, "parent sees the child's failed state");

    // No orphan run slots.
    const s = Date.now();
    while (getRun(children[0].id) !== null && Date.now() - s < 5000) await new Promise((r) => setTimeout(r, 10));
    assert.equal(getRun(children[0].id), null, "no zombie child run");
  } finally {
    resetToolRegistry();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T2 — the fix-retry verification signal reaches the MODEL
// ---------------------------------------------------------------------------

test("T2: real verify failure -> user fix-signal persisted AND present in the next model round", async () => {
  resetToolRegistry();
  const root = mkdtempSync(join(tmpdir(), "cf-subagent-fixsignal-"));
  const WRONG = "function add(a, b) {\n  return a * b; // wrong on purpose (still not the sum)\n}\nmodule.exports = { add };\n";
  const RIGHT = "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n";
  writeFileSync(join(root, "calc.js"), WRONG);
  writeFileSync(join(root, "calc.test.js"), "const assert = require('assert');\nconst { add } = require('./calc.js');\nassert.equal(add(2, 3), 5);\nconsole.log('all tests passed');\n");
  const core = makeRealShapeCore();
  try {
    const profileId = 1;
    const projectId = core.pmCreateProject(profileId, "fixsignal", null, root, JSON.stringify({
      context_packet_max_tokens: 0,
      test_command: "npm test",
    }));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node calc.test.js" } }));
    const agentId = core.pmCreateAgent(projectId, "Make node calc.test.js pass by fixing calc.js.", null);
    core.pmUpdateAgent(profileId, agentId, STATES.PLANNING, JSON.stringify({
      version: 1,
      steps: [{ id: "step-1", title: "Fix calc.js so node calc.test.js passes", status: "pending", depends_on: [], files: [], assigned_to: null }],
    }), 0, 0);

    const provider = scriptedProvider([
      [toolCall("w1", "fs_write", { path: join(root, "calc.js"), content: WRONG })], // wrong fix -> verify #1 fails
      [toolCall("w2", "fs_write", { path: join(root, "calc.js"), content: RIGHT })], // correct fix after the signal
      textReply("Fixed; verification passed."),
    ]);

    const { terminal } = await runToTerminal(core, { profileId, agentId, provider });
    assert.equal(terminal.kind, "completed", `terminal: ${JSON.stringify(terminal)}`);

    // The persisted transcript carries the user fix-signal BETWEEN the
    // first failure and the correction.
    const transcript = core.pmListMessages(profileId, agentId);
    const signalIdx = transcript.findIndex((m) => m.role === "user" && /Verification failed \(attempt 1\)/.test(m.content));
    assert.ok(signalIdx > 0, "user fix-signal message persisted");
    const fixRetryingIdx = transcript.findIndex((m) => m.role === "status" && m.name === "fix-retrying");
    const secondWriteIdx = transcript.findIndex((m) => m.role === "tool_call" && String(m.content).includes("w2"));
    assert.ok(fixRetryingIdx > 0 && signalIdx > fixRetryingIdx, "signal comes after fix-retrying status");
    assert.ok(secondWriteIdx > signalIdx, "the correction happens after the signal");

    // The MODEL actually received the signal in the round that produced
    // the correction (round 3 = index 2 in seenContexts).
    const correctionRound = provider.seenContexts[2];
    assert.ok(correctionRound, "correction round captured");
    assert.ok(
      correctionRound.some((m) => m.role === "user" && /Verification failed \(attempt 1\)/.test(m.content)),
      "the correction round's model context contains the fix-signal",
    );

    // The disk outcome is the correct fix and the verify gate passed.
    assert.equal(readFileSync(join(root, "calc.js"), "utf8"), RIGHT);
    const row = core.pmGetAgent(profileId, agentId);
    assert.equal(row.state, STATES.COMPLETED);
    const statuses = transcript.filter((m) => m.role === "status").map((m) => m.name);
    assert.ok(statuses.includes("verified"), `statuses: ${statuses.join(",")}`);
  } finally {
    resetToolRegistry();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T3 — D5: pure-tool-call rounds anchor their tool results in the model
// context with an assistant tool_calls message
// ---------------------------------------------------------------------------

test("T3: after a pure tool-call round, the next round's context has assistant(tool_calls) before its tool results", async () => {
  resetToolRegistry();
  const root = mkdtempSync(join(tmpdir(), "cf-subagent-d5-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "m.js"), "export const m = 'MARKER-D5';\n");
  const core = makeRealShapeCore();
  try {
    const profileId = 1;
    const projectId = core.pmCreateProject(profileId, "d5", null, root, JSON.stringify({ context_packet_max_tokens: 0 }));
    const agentId = core.pmCreateAgent(projectId, "Read src/m.js, then report the marker value.", null);
    core.pmUpdateAgent(profileId, agentId, STATES.PLANNING, JSON.stringify({
      version: 1,
      steps: [{ id: "step-1", title: "Read src/m.js", status: "pending", depends_on: [], files: [], assigned_to: null }],
    }), 0, 0);

    // Round 1: PURE tool call (no text). Round 2: text answer.
    const provider = scriptedProvider([
      [toolCall("c-d5", "fs_read", { path: join(root, "src", "m.js") })],
      textReply("The marker is MARKER-D5."),
    ]);

    const { terminal } = await runToTerminal(core, { profileId, agentId, provider });
    assert.equal(terminal.kind, "completed", `terminal: ${JSON.stringify(terminal)}`);

    // Round 2's model context must be: [..., assistant(tool_calls), tool, ...]
    const ctx = provider.seenContexts[1];
    assert.ok(ctx, "round-2 context captured");
    const toolIdx = ctx.findIndex((m) => m.role === "tool");
    assert.ok(toolIdx > 0, "round-2 context contains the tool result");
    const prev = ctx[toolIdx - 1];
    assert.equal(prev.role, "assistant", `message before the tool result must be assistant, got ${prev.role}`);
    assert.ok(prev.tool_calls && prev.tool_calls.length >= 1, "assistant carries tool_calls");
    assert.equal(prev.tool_calls[0].id, "c-d5");
    assert.equal(prev.tool_calls[0].function.name, "fs_read");
    assert.match(prev.tool_calls[0].function.arguments, /m\.js/);
  } finally {
    resetToolRegistry();
    rmSync(root, { recursive: true, force: true });
  }
});
