// GATES 10 + 11 (v7) — MCP + Skills participate in the agent loop E2E.
//
// GATE 7 covered the MCP bridge in isolation; GATE 8 covered Skills in
// isolation. GATES 10/11 (v7) demand that BOTH subsystems be reachable
// from a real agent run driven by the deterministic scripted provider
// (see shell/src/services/agent/fixture.js). The point is to prove the
// subsystems aren't just library code — they are wired into the loop's
// tool path (MCP) and system prompt (Skills).
//
// The brief is precise:
//   1) MCP in the loop: scripted provider emits `mcp_bridge_invoke` for
//      filesystem.read, MCP bridge is invoked, the result is included in
//      the next model round, the agent continues normally.
//   2) Skills in the loop: deterministic test skill ("Always respond in
//      valid JSON") is in the project skills dir, discovered on agent
//      start, the system prompt the provider receives contains the
//      skill's instructions, the model emits a tool call (proving the
//      skill didn't break the normal flow).
//
// What this file DOES NOT do:
//   - Touch the MCP bridge, curated, or skills source code.
//   - Touch the agent loop's prompt-builder or tool dispatcher.
//   - Add new dependencies.
//   - Use a real LLM endpoint (the scripted provider is hermetic).
//
// The only loop integration allowed is the import that already exists:
// Skills.buildSystemPrompt is now consulted by the loop's
// `buildSystemPrompt` (see shell/src/services/agent/loop.js). The MCP
// bridged tool registration happens in the bridgeTools() call inside
// `MCP.connect`, which the gate7 test exercised in isolation; here we
// register the bridged tool directly with PROJECT_TOOLS (the same way
// MCP.bridgeTools does) so the agent's tool dispatcher finds it without
// us having to drive MCP.connect for every test.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startAgent, AGENT_EVENTS, STATES } from "../src/services/agent/loop.js";
import { scriptedProvider } from "../src/services/agent/fixture.js";
import { PROJECT_TOOLS, register as registerTool, unregister as unregisterTool, getTool } from "../src/services/project-tools/index.js";
import { MCP, configureMCP } from "../src/services/mcp/index.js";
import { Skills, configureSkills } from "../src/services/skills/index.js";
import { CURATED_SERVERS } from "../src/services/mcp/curated.js";

// ---------------------------------------------------------------------------
// 1) Hermetic fixtures
// ---------------------------------------------------------------------------

// Minimal fake child process implementing the JSON-RPC line protocol.
// Modeled on gate7-mcp-e2e.test.js but with a configurable
// `toolsCallResult` so the test can pin the result the bridge returns.
class FakeWritable extends EventEmitter {
  write(_chunk) { return true; }
  end() {}
}
class FakeChild extends EventEmitter {
  constructor() { super(); this.stdin = new FakeWritable(); this.stdout = new FakeWritable(); this.stderr = new FakeWritable(); this.killed = false; this.pid = 4242; }
  kill() { this.killed = true; this.emit("close", 0); }
}

function makeFakeMcpServer({ toolsList = [], callResult } = {}) {
  const child = new FakeChild();
  const requests = [];
  const origWrite = child.stdin.write.bind(child.stdin);
  child.stdin.write = (chunk) => {
    const ok = origWrite(chunk);
    setImmediate(() => {
      let parsed;
      try { parsed = JSON.parse(chunk.toString("utf8")); } catch { return; }
      if (typeof parsed.id !== "number") return;
      requests.push(parsed);
      let result;
      if (parsed.method === "initialize") {
        result = { protocolVersion: "2024-11-05", capabilities: {} };
      } else if (parsed.method === "tools/list") {
        result = { tools: toolsList };
      } else if (parsed.method === "tools/call") {
        result = callResult || {
          content: [{ type: "text", text: "default-mcp-echo" }],
        };
      } else {
        return;
      }
      child.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }) + "\n", "utf8"));
    });
    return ok;
  };
  return { child, requests };
}

function freshSkillsRoot() {
  return mkdtempSync(join(tmpdir(), "cf-gate10-11-"));
}

function writeSkill(root, id, fm, body) {
  const dir = join(root, "skills", id);
  mkdirSync(dir, { recursive: true });
  const head = Object.entries(fm).map(([k, v]) => `---${k}: ${v}---`).join("\n");
  writeFileSync(join(dir, "SKILL.md"), `${head}\n${body}\n`, "utf8");
}

// In-memory fake `core` matching the agent loop's pm_* surface. Same
// shape as agent-e2e.test.js / agent-loop.test.js.
function makeFakeCore() {
  const agents = new Map();
  const messages = new Map();
  let nextAgentId = 1000;
  function record(agentId, role, content, name, payloadJson) {
    const list = messages.get(agentId) || [];
    list.push({ id: list.length + 1, agent_id: agentId, seq: list.length + 1, role, content: typeof content === "string" ? content : JSON.stringify(content), name: name == null ? null : name, payload_json: payloadJson == null ? null : payloadJson });
    messages.set(agentId, list);
  }
  const core = {
    pmCreateAgent(projectId, objective) {
      const id = nextAgentId++;
      // Real DB layer: agent rows have projectId (camelCase), pmGetProject
      // returns id (no underscore). These names MUST match the interface
      // the loop expects.
      agents.set(id, { id, projectId, objective, state: STATES.IDLE, plan_json: "[]", tokens_in: 0, tokens_out: 0, finished_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), parentAgentId: null });
      messages.set(id, []);
      return { id };
    },
    pmGetAgent(_p, agentId) { const a = agents.get(agentId); if (!a) throw new Error("not found"); return { ...a }; },
    pmUpdateAgent(_p, agentId, state, planJson, tokensIn, tokensOut) {
      const a = agents.get(agentId); if (!a) throw new Error("not found");
      a.state = state; a.plan_json = planJson; a.tokens_in = tokensIn; a.tokens_out = tokensOut; a.updated_at = new Date().toISOString();
      return { ok: true };
    },
    pmAppendMessage(profileId, agentId, role, content, name, payloadJson) {
      record(agentId, role, content, name, payloadJson);
      return { seq: (messages.get(agentId) || []).length };
    },
    pmFinishAgent(_p, agentId, state) {
      const a = agents.get(agentId); if (!a) throw new Error("not found");
      a.state = state; a.finished_at = new Date().toISOString();
    },
    pmGetProject(_p, projectId) {
      return { id: projectId, profile_id: 1, name: "GATE 10/11 project", description: "mcp+skills loop", root_path: "/tmp/gate10-11", config_json: "{}", created_at: "1970-01-01T00:00:00Z", updated_at: "1970-01-01T00:00:00Z" };
    },
    pmListMessages(_p, agentId) { return (messages.get(agentId) || []).slice(); },
    _agents: agents, _messages: messages,
  };
  return core;
}

function seedPlan(core, agentId) {
  const plan = { version: 1, steps: [
    { id: "step-1", title: "Call MCP", status: "pending", depends_on: [], files: [], assigned_to: null },
  ] };
  core.pmUpdateAgent(1, agentId, STATES.IDLE, JSON.stringify(plan), 0, 0);
  return plan;
}

// Wait for the bus to emit a terminal event. Resolves with the event
// payload (or `null` for cancellation).
function waitTerminal(bus) {
  return new Promise((resolve) => {
    bus.on(AGENT_EVENTS.AGENT_COMPLETED, (e) => resolve({ kind: "completed", payload: e.payload }));
    bus.on(AGENT_EVENTS.AGENT_FAILED, (e) => resolve({ kind: "failed", payload: e.payload }));
    bus.on(AGENT_EVENTS.AGENT_CANCELLED, () => resolve({ kind: "cancelled" }));
  });
}

// Build the bridged tool entry exactly the way MCP.bridgeTools() does
// in shell/src/services/mcp/index.js: visible name `mcp_<server>__<tool>`,
// READ permission, calls MCP.callTool on invocation. We build it
// inline so the test does NOT have to drive MCP.connect / bridgeTools
// (gate7 already covered that path) and so a single test can inject
// whatever server name it wants.
function buildBridgedMcpTool(serverName, toolName, inputSchema) {
  return {
    name: `mcp_${serverName}__${toolName}`,
    description: `MCP tool: ${toolName}`,
    permission: "READ",
    inputSchema: inputSchema || { type: "object", properties: {} },
    timeoutMs: 10_000,
    async execute(input, _ctx) {
      const res = await MCP.callTool(serverName, toolName, input || {}, { profileId: 1, projectId: 10 });
      if (!res || res.ok === false) {
        return { ok: false, error: { code: (res && res.error && res.error.code) || "not-connected", message: (res && res.error && res.error.message) || "MCP tool call failed" } };
      }
      return { ok: true, result: res.result };
    },
  };
}

// ---------------------------------------------------------------------------
// GATE 10.1 — MCP tool call flows through the loop: the scripted provider
//             emits an MCP tool call, the loop dispatches it, the result
//             is included in the next model round, the agent continues.
// ---------------------------------------------------------------------------

test("GATE 10.1: scripted mcp_bridge_invoke for filesystem.read reaches the bridge, result reaches the model, agent continues", async () => {
  MCP._resetForTests();
  const { child, requests } = makeFakeMcpServer({
    toolsList: [{ name: "read", description: "read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
    callResult: {
      content: [{ type: "text", text: "echo:filesize=42" }],
    },
  });
  configureMCP({ spawn: () => child });

  // Use the real MCP.register + connect path. connect() spawns the
  // child (via our mock spawn), performs the initialize handshake,
  // fetches tools/list, and calls bridgeTools() to register the
  // namespaced tool into the project-tools registry. This is the
  // exact same code path gate7-mcp-e2e exercises in isolation.
  const serverName = "filesystem";
  const toolName = "read";
  MCP.register({ profileId: 1, projectId: 10, name: serverName, command: "node", args: ["fake-mcp.js"], env: {} });
  const connectRes = await MCP.connect(serverName, { profileId: 1, projectId: 10 });
  assert.equal(connectRes.ok, true, `MCP.connect must succeed, got ${JSON.stringify(connectRes)}`);

  // The bridged tool name follows the same convention MCP.bridgeTools uses.
  const bridgedName = `mcp_${serverName}__${toolName}`;
  // Sanity: the tool is in the dynamic registry after bridgeTools() ran.
  assert.ok(getTool(bridgedName), `bridged tool ${bridgedName} must be registered after connect`);

  const core = makeFakeCore();
  const created = core.pmCreateAgent(10, "GATE 10.1: drive an MCP tool call through the agent loop");
  const agentId = created.id;
  seedPlan(core, agentId);

  // Round 1: model emits a tool call for the bridged MCP tool.
  // Round 2: model receives the tool_result and emits the final summary.
  const provider = scriptedProvider([
    {
      toolCalls: [{ id: "tc-mcp-1", name: bridgedName, args: JSON.stringify({ path: "/tmp/gate10-11/secret.txt" }) }],
      finishReason: "tool_calls",
    },
    { text: "MCP read complete; filesize=42.", finishReason: "stop" },
  ]);

  // Capture the tool result the loop appended to the model on round 2.
  // (The system prompt is unchanged across rounds, so we just verify
  // the tool result reached the model.)
  let round2ToolResultContent = null;
  const origStreamChat = provider.streamChat;
  provider.streamChat = function (opts = {}) {
    const currentRound = provider._getRound() + 1;
    const inner = origStreamChat.call(provider, opts);
    return (async function* () {
      if (currentRound === 2) {
        const msgs = (opts && opts.messages) || [];
        const toolMsg = msgs.find((m) => m.role === "tool" && m.tool_call_id === "tc-mcp-1");
        round2ToolResultContent = toolMsg ? toolMsg.content : null;
      }
      for await (const ev of inner) yield ev;
    })();
  };

  try {
    const startRes = await startAgent({
      core,
      profileId: 1,
      agentId,
      provider,
      approvalResolver: async () => ({ approved: true }),
    });
    assert.equal(startRes.ok, true);
    const terminal = await waitTerminal(startRes.bus);
    assert.equal(terminal.kind, "completed", `expected completed, got ${terminal.kind} ${JSON.stringify(terminal.payload)}`);

    // (a) The bridge actually received a tools/call for the right server + tool.
    const calls = requests.filter((r) => r.method === "tools/call");
    assert.equal(calls.length, 1, `exactly one tools/call must be sent to the MCP server, got ${calls.length}. all requests: ${JSON.stringify(requests.map((r) => r.method))}`);
    assert.equal(calls[0].params.name, toolName);
    assert.deepEqual(calls[0].params.arguments, { path: "/tmp/gate10-11/secret.txt" });

    // (b) The tool result reached the model on the next round.
    assert.ok(round2ToolResultContent != null, "round 2 tool result must be present in messages");
    assert.match(round2ToolResultContent, /echo:filesize=42|filesize=42/, `tool result must contain MCP echo, got ${round2ToolResultContent}`);

    // (c) A tool_call + tool_result message pair was persisted.
    const msgs = core._messages.get(agentId) || [];
    const toolCalls = msgs.filter((m) => m.role === "tool_call");
    const toolResults = msgs.filter((m) => m.role === "tool_result");
    assert.ok(toolCalls.length >= 1, `expected >=1 tool_call row, got ${toolCalls.length}`);
    assert.ok(toolResults.length >= 1, `expected >=1 tool_result row, got ${toolResults.length}`);
    const persisted = toolResults.find((m) => m.name === bridgedName);
    assert.ok(persisted, `expected a tool_result row for ${bridgedName}, got names: ${toolResults.map((r) => r.name).join(",")}`);
    assert.match(persisted.content, /filesize=42/, `persisted tool_result must include MCP echo, got ${persisted.content}`);

    // (d) The agent transitioned to COMPLETED (the loop did not stall).
    const a = core._agents.get(agentId);
    assert.equal(a.state, STATES.COMPLETED, `agent should be completed, got ${a.state}`);
  } finally {
    MCP.disconnect(serverName);
    MCP._resetForTests();
  }
});

// ---------------------------------------------------------------------------
// GATE 10.2 — Negative path: an unknown server name causes the bridge to
//             return not-connected, the loop records the error, and the
//             agent does NOT silently succeed.
// ---------------------------------------------------------------------------

test("GATE 10.2: an MCP tool call for an unconnected server surfaces the error to the loop", async () => {
  MCP._resetForTests();
  configureMCP({ spawn: () => new FakeChild() }); // never used; we don't connect

  const bridged = buildBridgedMcpTool("nope-server", "read");
  registerTool(bridged);

  const core = makeFakeCore();
  const created = core.pmCreateAgent(10, "GATE 10.2: unconnected server");
  const agentId = created.id;
  seedPlan(core, agentId);

  const provider = scriptedProvider([
    { toolCalls: [{ id: "tc-bad-1", name: bridged.name, args: "{}" }], finishReason: "tool_calls" },
    { text: "done.", finishReason: "stop" },
  ]);

  try {
    const startRes = await startAgent({ core, profileId: 1, agentId, provider });
    assert.equal(startRes.ok, true);
    const terminal = await waitTerminal(startRes.bus);
    // The error path: the tool returns { ok:false, error }, the loop
    // surfaces it as a tool_result message and the agent continues to
    // the next round. The agent does NOT crash; the agent reaches a
    // terminal state.
    assert.ok(terminal.kind === "completed" || terminal.kind === "failed", `expected completed or failed, got ${terminal.kind}`);

    const msgs = core._messages.get(agentId) || [];
    const toolResult = msgs.find((m) => m.role === "tool_result" && m.name === bridged.name);
    assert.ok(toolResult, "expected a tool_result row for the bridged tool");
    // The result must encode the error (not silently succeed).
    assert.match(toolResult.content, /not-connected|failed|error/i, `tool result must indicate failure, got ${toolResult.content}`);
  } finally {
    unregisterTool(bridged.name);
    MCP._resetForTests();
  }
});

// ---------------------------------------------------------------------------
// GATE 11.1 — Skills in the loop: a SKILL.md on disk is discovered, its
//             instructions appear in the system prompt the provider sees,
//             and the agent still emits a normal tool call (proving the
//             skill didn't break the normal flow).
// ---------------------------------------------------------------------------

test("GATE 11.1: enabled skill's instructions appear in the system prompt the agent loop sends to the model", async () => {
  // Hermetic skills root.
  const root = freshSkillsRoot();
  writeSkill(
    root,
    "json-only",
    { id: "json-only", name: "JSON Only", scope: "global" },
    "RESPOND_JSON\nAlways respond in valid JSON. Do not include any prose outside the JSON object."
  );
  configureSkills({ rootDir: root });
  Skills.loadFromDisk();
  Skills.enable(1, 10, "json-only");

  const core = makeFakeCore();
  const created = core.pmCreateAgent(10, "GATE 11.1: skill instructions reach the model");
  const agentId = created.id;
  seedPlan(core, agentId);

  // Capture the system prompt on round 1.
  let round1SystemPrompt = null;
  const provider = scriptedProvider([
    { toolCalls: [{ id: "tc-1", name: "fs_list", args: "{}" }], finishReason: "tool_calls" },
    { text: '{"status":"ok"}', finishReason: "stop" },
  ]);
  const origStreamChat = provider.streamChat;
  provider.streamChat = function (opts = {}) {
    const currentRound = provider._getRound() + 1;
    const inner = origStreamChat.call(provider, opts);
    return (async function* () {
      if (currentRound === 1) {
        const msgs = (opts && opts.messages) || [];
        const sys = msgs.find((m) => m.role === "system");
        round1SystemPrompt = sys ? sys.content : null;
      }
      for await (const ev of inner) yield ev;
    })();
  };

  // Patch fs_list to a no-op so the loop can complete.
  const fsList = PROJECT_TOOLS.fs_list;
  const origFsList = fsList.execute;
  fsList.execute = async () => ({ ok: true, result: { entries: [], fileCount: 0, dirCount: 0 } });

  try {
    const startRes = await startAgent({ core, profileId: 1, agentId, provider });
    assert.equal(startRes.ok, true);
    const terminal = await waitTerminal(startRes.bus);
    assert.equal(terminal.kind, "completed", `expected completed, got ${terminal.kind} ${JSON.stringify(terminal.payload)}`);

    // (a) The system prompt the model received contains the skill's instructions.
    assert.ok(round1SystemPrompt, "round 1 system prompt must be captured");
    assert.match(round1SystemPrompt, /RESPOND_JSON/, `system prompt must contain the skill marker, got: ${round1SystemPrompt}`);
    assert.match(round1SystemPrompt, /Always respond in valid JSON/, `system prompt must contain the skill body, got: ${round1SystemPrompt}`);

    // (b) The agent still emitted a tool call in round 1 (proving the
    //     skill didn't break the normal flow). The fs_list tool call is
    //     present in the persisted message log.
    const msgs = core._messages.get(agentId) || [];
    const toolCalls = msgs.filter((m) => m.role === "tool_call" && m.name === "fs_list");
    assert.ok(toolCalls.length >= 1, `expected >=1 fs_list tool_call row, got ${toolCalls.length}`);

    // (c) The agent transitioned to COMPLETED.
    const a = core._agents.get(agentId);
    assert.equal(a.state, STATES.COMPLETED, `agent should be completed, got ${a.state}`);
  } finally {
    fsList.execute = origFsList;
    Skills._resetForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// GATE 11.2 — Skills priority: when two skills are enabled, both reach the
//             system prompt and the loop's behavior is unchanged (no
//             runtime regression from the skill injection).
// ---------------------------------------------------------------------------

test("GATE 11.2: two enabled skills concatenate into the system prompt; the agent still completes normally", async () => {
  const root = freshSkillsRoot();
  writeSkill(root, "json-only", { id: "json-only", name: "JSON", scope: "global" }, "RESPOND_JSON\nReply in JSON.");
  writeSkill(root, "concise", { id: "concise", name: "Concise", scope: "global" }, "CONCISE\nBe brief.");
  configureSkills({ rootDir: root });
  Skills.loadFromDisk();
  Skills.enable(1, 10, "json-only");
  Skills.enable(1, 10, "concise");

  const core = makeFakeCore();
  const created = core.pmCreateAgent(10, "GATE 11.2: two skills merged");
  const agentId = created.id;
  seedPlan(core, agentId);

  let round1SystemPrompt = null;
  const provider = scriptedProvider([
    { toolCalls: [{ id: "tc-1", name: "fs_list", args: "{}" }], finishReason: "tool_calls" },
    { text: "{}", finishReason: "stop" },
  ]);
  const origStreamChat = provider.streamChat;
  provider.streamChat = function (opts = {}) {
    const currentRound = provider._getRound() + 1;
    const inner = origStreamChat.call(provider, opts);
    return (async function* () {
      if (currentRound === 1) {
        const msgs = (opts && opts.messages) || [];
        const sys = msgs.find((m) => m.role === "system");
        round1SystemPrompt = sys ? sys.content : null;
      }
      for await (const ev of inner) yield ev;
    })();
  };

  const fsList = PROJECT_TOOLS.fs_list;
  const origFsList = fsList.execute;
  fsList.execute = async () => ({ ok: true, result: { entries: [], fileCount: 0, dirCount: 0 } });

  try {
    const startRes = await startAgent({ core, profileId: 1, agentId, provider });
    assert.equal(startRes.ok, true);
    const terminal = await waitTerminal(startRes.bus);
    assert.equal(terminal.kind, "completed", `expected completed, got ${terminal.kind} ${JSON.stringify(terminal.payload)}`);

    assert.ok(round1SystemPrompt, "system prompt must be captured");
    assert.match(round1SystemPrompt, /RESPOND_JSON/, "first skill marker must be present");
    assert.match(round1SystemPrompt, /CONCISE/, "second skill marker must be present");
    assert.match(round1SystemPrompt, /Reply in JSON/, "first skill body must be present");
    assert.match(round1SystemPrompt, /Be brief/, "second skill body must be present");

    const a = core._agents.get(agentId);
    assert.equal(a.state, STATES.COMPLETED, `agent should be completed, got ${a.state}`);
  } finally {
    fsList.execute = origFsList;
    Skills._resetForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// GATE 11.3 — Disabled skills do NOT pollute the system prompt.
// ---------------------------------------------------------------------------

test("GATE 11.3: a disabled skill's instructions are absent from the system prompt the loop sends", async () => {
  const root = freshSkillsRoot();
  writeSkill(root, "json-only", { id: "json-only", name: "JSON", scope: "global" }, "RESPOND_JSON\nReply in JSON.");
  configureSkills({ rootDir: root });
  Skills.loadFromDisk();
  // NOT enabled — the prompt must be clean.

  const core = makeFakeCore();
  const created = core.pmCreateAgent(10, "GATE 11.3: no enabled skills");
  const agentId = created.id;
  seedPlan(core, agentId);

  let round1SystemPrompt = null;
  const provider = scriptedProvider([
    { toolCalls: [{ id: "tc-1", name: "fs_list", args: "{}" }], finishReason: "tool_calls" },
    { text: "ok", finishReason: "stop" },
  ]);
  const origStreamChat = provider.streamChat;
  provider.streamChat = function (opts = {}) {
    const currentRound = provider._getRound() + 1;
    const inner = origStreamChat.call(provider, opts);
    return (async function* () {
      if (currentRound === 1) {
        const msgs = (opts && opts.messages) || [];
        const sys = msgs.find((m) => m.role === "system");
        round1SystemPrompt = sys ? sys.content : null;
      }
      for await (const ev of inner) yield ev;
    })();
  };

  const fsList = PROJECT_TOOLS.fs_list;
  const origFsList = fsList.execute;
  fsList.execute = async () => ({ ok: true, result: { entries: [], fileCount: 0, dirCount: 0 } });

  try {
    const startRes = await startAgent({ core, profileId: 1, agentId, provider });
    assert.equal(startRes.ok, true);
    const terminal = await waitTerminal(startRes.bus);
    assert.equal(terminal.kind, "completed");

    assert.ok(round1SystemPrompt, "system prompt must be captured");
    assert.doesNotMatch(round1SystemPrompt, /RESPOND_JSON/, "disabled skill's marker must NOT appear in the system prompt");
    assert.doesNotMatch(round1SystemPrompt, /Reply in JSON/, "disabled skill's body must NOT appear in the system prompt");
    // The base loop prompt must still be present.
    assert.match(round1SystemPrompt, /Project Mode agent/, "base loop prompt must be present");
  } finally {
    fsList.execute = origFsList;
    Skills._resetForTests();
    rmSync(root, { recursive: true, force: true });
  }
});
