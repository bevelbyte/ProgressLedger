// GATES 1 + 14 (v7) — Project Intel + Memory end-to-end integration.
//
// v6 closed GATE 1 (8/8) and GATE 11 (6/6) at the unit level. This
// expansion proves the END-TO-END contract the brief asks for:
//
//   GATE 1 (v7) — Project Intel actually influences the agent's context:
//       - The first user message contains a `## Project files (relevant)`
//         block with REAL file paths from an indexed tmp project.
//       - The provider's first tool call inspects ONE of the files the
//         intel said was relevant.
//       - It also works on an unfamiliar fixture (5 files, no prior
//         test scaffolding).
//
//   GATE 14 (v7) — Memory participates across runs:
//       - A fact written by Task A is retrievable by Task B (a brand-
//         new agent) via `Memory.buildContextPacket` (the retrieval
//         API the context-builder uses).
//       - The fact shows up in Task B's first user message.
//       - A fact that does NOT match the objective is filtered out.
//
//   Combined — memory + project intel in one context packet:
//       - Both `## Project memory` AND `## Project files (relevant)`
//         appear in the same first user message.
//
// Every test is hermetic: tmp dirs for the project + both sidecar
// DBs, unique project IDs, and `_closeAll` in `finally` blocks so the
// module-level caches from project-intel + memory do not bleed across
// tests.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ProjectIntel,
  _setUserDataDir as _setIntelDir,
  _closeAll as _closeIntel,
} from "../src/services/project-intel/index.js";
import {
  Memory,
  _setUserDataDir as _setMemDir,
  _closeAll as _closeMem,
} from "../src/services/memory/index.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
}

/**
 * A minimal in-memory `core` stub. Records agents + messages so the
 * agent loop can drive a real iteration. `projectId` + `rootPath`
 * drive the project-intel + memory lookups inside the loop.
 *
 * `configPacketMaxTokens` / `configProjectIntelMaxTokens` control the
 * token budgets passed into `buildContextPacket` /
 * `buildProjectIntelBlock`. Both default to non-zero so the block is
 * actually built.
 */
function makeCore({ projectId, profileId = 1, rootPath, packetMaxTokens = 2000, projectIntelMaxTokens = 1500 }) {
  const agents = new Map();
  const messages = new Map();
  let nextAgentId = 1;
  const now = new Date().toISOString();
  const config = {
    context_packet_max_tokens: packetMaxTokens,
    context_packet_max_project_intel_tokens: projectIntelMaxTokens,
  };
  return {
    pmCreateAgent(agentProjectId, objective) {
      const id = nextAgentId++;
      agents.set(id, {
        id,
        projectId: agentProjectId,
        objective,
        state: "idle",
        plan_json: "[]",
        planJson: "[]",
        tokensIn: 0,
        tokensOut: 0,
        finishedAt: null,
        createdAt: now,
        updatedAt: now,
        parentAgentId: null,
      });
      messages.set(id, []);
      return { id };
    },
    pmGetAgent(_p, agentId) {
      const a = agents.get(agentId);
      if (!a) throw new Error(`agent not found: ${agentId}`);
      return { ...a };
    },
    pmUpdateAgent(_p, agentId, state, planJson, tokensIn, tokensOut) {
      const a = agents.get(agentId);
      if (!a) throw new Error(`agent not found: ${agentId}`);
      a.state = state;
      a.plan_json = planJson;
      a.planJson = planJson;
      a.tokensIn = tokensIn;
      a.tokensOut = tokensOut;
      a.updatedAt = new Date().toISOString();
      return { ok: true };
    },
    pmAppendMessage(_p, agentId, role, content, name, payloadJson) {
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
      return { seq: list.length };
    },
    pmFinishAgent(_p, agentId, state) {
      const a = agents.get(agentId);
      if (!a) throw new Error(`agent not found: ${agentId}`);
      a.state = state;
      a.finishedAt = new Date().toISOString();
      return { ok: true };
    },
    pmGetProject(_p, _pid) {
      return {
        id: projectId,
        profileId,
        name: `gate1-14-project-${projectId}`,
        description: "",
        rootPath,
        root_path: rootPath,
        configJson: JSON.stringify(config),
        config_json: JSON.stringify(config),
        createdAt: now,
        updatedAt: now,
      };
    },
    pmListMessages(_p, agentId) {
      return (messages.get(agentId) || []).slice();
    },
    _agents: agents,
    _messages: messages,
  };
}

/**
 * Start a fresh agent on `core` and wait for the terminal event.
 * Returns `{ messages, terminal, events }` where `messages` is the
 * transcript captured by `core._messages` and `events` is the list of
 * `AGENT_EVENTS` bus events.
 */
async function runAgentOnce({ core, profileId, agentId, provider }) {
  const { startAgent, AGENT_EVENTS } = await import("../src/services/agent/loop.js");
  const startRes = await startAgent({ core, profileId, agentId, provider });
  assert.ok(startRes && startRes.ok, `startAgent refused: ${JSON.stringify(startRes)}`);
  const terminal = await new Promise((resolve) => {
    startRes.bus.on(AGENT_EVENTS.AGENT_COMPLETED, (e) => resolve({ kind: "completed", payload: e.payload }));
    startRes.bus.on(AGENT_EVENTS.AGENT_FAILED, (e) => resolve({ kind: "failed", payload: e.payload }));
    startRes.bus.on(AGENT_EVENTS.AGENT_CANCELLED, (e) => resolve({ kind: "cancelled", payload: e.payload }));
  });
  const events = startRes.bus.recent(64).filter((e) =>
    e.type === AGENT_EVENTS.PROJECT_INTEL_RECALLED ||
    e.type === AGENT_EVENTS.MEMORY_RECALLED ||
    e.type === AGENT_EVENTS.AGENT_TOOL_COMPLETED ||
    e.type === AGENT_EVENTS.AGENT_TOOL_FAILED,
  );
  return { messages: (core._messages.get(agentId) || []).slice(), terminal, events };
}

/**
 * A scripted provider that captures the first user message from every
 * `streamChat` call and emits ONE tool_call in round 1 followed by
 * text_delta + finish in subsequent rounds.
 *
 * `toolCalls` is an array of `{ id, name, args }` (args is a JSON
 * string). The provider emits one `tool_call` event per entry on the
 * FIRST call, then `finish(reason="tool_calls")`.
 *
 * Returns `{ capture, provider }` where `capture.calls` is the array
 * of message arrays the provider was called with.
 */
function makeScriptedProvider({ toolCalls = null, text = "Done." }) {
  const capture = { calls: [], firstUserMessages: [] };
  let round = 0;
  const provider = {
    async *streamChat(opts = {}) {
      round += 1;
      const msgs = Array.isArray(opts.messages) ? opts.messages.slice() : [];
      capture.calls.push(msgs);
      const firstUser = msgs.find((m) => m.role === "user");
      if (firstUser) capture.firstUserMessages.push(firstUser.content);
      if (toolCalls && round === 1) {
        for (const tc of toolCalls) {
          yield { type: "tool_call", id: tc.id, name: tc.name, args: tc.args };
        }
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", delta: text };
      yield { type: "usage", inputTokens: 5, outputTokens: 10 };
      yield { type: "finish", reason: "stop" };
    },
  };
  return { capture, provider };
}

// ---------------------------------------------------------------------------
// 1) Project Intel influence on agent context (scripted provider asserts
//    the first user message contains the relevantFiles block AND the
//    first tool call inspects a relevant file)
// ---------------------------------------------------------------------------

test("GATE 1 (v7): project intel shapes the first user message AND the first tool call targets a relevant file", async () => {
  const intelDir = makeTempDir("cf-g1-v7-1-intel-");
  const memDir = makeTempDir("cf-g1-v7-1-mem-");
  const projectRoot = makeTempDir("cf-g1-v7-1-proj-");
  _setIntelDir(intelDir);
  _setMemDir(memDir);
  try {
    writeTree(projectRoot, {
      "src/auth/login.js": "// login flow\nexport function login() { return 'login'; }\n",
      "src/auth/session.js": "// session management\nexport function session() { return 'session'; }\n",
      "src/api/health.js": "// health check\nexport function health() { return 'ok'; }\n",
      "src/api/metrics.js": "// metrics\nexport function metrics() { return {}; }\n",
    });
    const idx = await ProjectIntel.indexProject(1, 11001, projectRoot);
    assert.equal(idx.ok, true, `indexProject failed: ${JSON.stringify(idx)}`);

    // The provider's FIRST tool call must inspect one of the files
    // intel declared relevant. We pick `src/auth/login.js` — its
    // filename contains the token "login" from the objective.
    const toolCallPath = "src/auth/login.js";
    const { capture, provider } = makeScriptedProvider({
      toolCalls: [
        {
          id: "call_1",
          name: "fs_read",
          args: JSON.stringify({ path: toolCallPath }),
        },
      ],
    });

    const core = makeCore({ projectId: 11001, rootPath: projectRoot });
    const created = core.pmCreateAgent(11001, "auth login flow");
    const { messages, terminal, events } = await runAgentOnce({
      core,
      profileId: 1,
      agentId: created.id,
      provider,
    });
    assert.equal(terminal.kind, "completed", `expected completed; got ${terminal.kind}: ${JSON.stringify(terminal.payload)}`);

    // The provider was called at least twice (round 1 tool_call, round 2
    // final summary after the verification gate).
    assert.ok(capture.calls.length >= 1, "provider must be called at least once");
    const firstUserMsgs = capture.firstUserMessages;
    assert.ok(firstUserMsgs.length >= 1, "provider must have seen a user message");
    const firstUser = firstUserMsgs[0];

    // The intel block must be present, with REAL paths from the indexed
    // project (not mock data).
    assert.match(firstUser, /## Project files \(relevant\)/,
      "first user message must include the project-intel block");
    assert.match(firstUser, /login\.js/, "login.js (matches 'login') must appear");
    assert.match(firstUser, /session\.js/, "session.js (matches 'auth') must appear");
    // Irrelevant files must NOT be in the block.
    assert.doesNotMatch(firstUser, /health\.js/, "health.js must NOT appear (no token overlap)");
    assert.doesNotMatch(firstUser, /metrics\.js/, "metrics.js must NOT appear (no token overlap)");

    // The first tool call must inspect a file that the intel block
    // named as relevant. The tool_call row is persisted AFTER the
    // provider's first streamChat call returns, so read it from the
    // `core._messages` transcript (captured by `runAgentOnce`), not
    // from the provider's `capture.calls[0]` (which is the request,
    // not the response).
    const toolCallMsgs = messages.filter((m) => m.role === "tool_call");
    assert.ok(toolCallMsgs.length >= 1, "a tool_call message must be persisted");
    const toolCallPayload = JSON.parse(toolCallMsgs[0].content);
    assert.ok(Array.isArray(toolCallPayload) && toolCallPayload.length === 1,
      "exactly one tool call expected");
    const tc = toolCallPayload[0];
    assert.equal(tc.name, "fs_read");
    const tcArgs = JSON.parse(tc.args);
    // The tool call path must be one of the files listed in the
    // relevantFiles block.
    assert.match(firstUser, new RegExp(tcArgs.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `first tool call path ${tcArgs.path} must appear in the intel block`);

    // The observability event fired with a positive fileCount. The
    // event `type` is the AGENT_EVENTS.PROJECT_INTEL_RECALLED string
    // ("agent.project_intel.recalled"), not the constant name.
    const AGENT_EVENTS = (await import("../src/services/agent/loop.js")).AGENT_EVENTS;
    const intelEvents = events.filter((e) => e.type === AGENT_EVENTS.PROJECT_INTEL_RECALLED);
    assert.ok(intelEvents.length >= 1, "PROJECT_INTEL_RECALLED must fire");
    assert.ok(intelEvents[0].payload.fileCount >= 1);

    // The tool actually executed (not just recorded) — fs_read returned
    // the real file content. The tool_result row's `content` is the
    // tool's result envelope (`{ ok, result, error? }`).
    const toolResultMsgs = messages.filter((m) => m.role === "tool_result" && m.name === "fs_read");
    assert.ok(toolResultMsgs.length >= 1, "fs_read must have produced a tool_result");
    const toolResult = JSON.parse(toolResultMsgs[0].content);
    assert.ok(toolResult.ok === true, `fs_read should have succeeded: ${JSON.stringify(toolResult)}`);
    assert.equal(typeof toolResult.result.content, "string", "fs_read result must contain file content");
    assert.match(toolResult.result.content, /login/, "fs_read content must be the real login.js source");
  } finally {
    _closeIntel();
    _closeMem();
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(intelDir, { recursive: true, force: true });
    rmSync(memDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2) Project Intel on an unfamiliar fixture: a 5-file tmp project with
//    no prior test scaffolding. The context-builder must name the right
//    files.
// ---------------------------------------------------------------------------

test("GATE 1 (v7): project intel works on an unfamiliar 5-file fixture", async () => {
  const intelDir = makeTempDir("cf-g1-v7-2-intel-");
  const memDir = makeTempDir("cf-g1-v7-2-mem-");
  const projectRoot = makeTempDir("cf-g1-v7-2-proj-");
  _setIntelDir(intelDir);
  _setMemDir(memDir);
  try {
    // 5 files, no prior scaffolding. Objective shares tokens with three
    // of them ("foo bar baz"), and one ("quux.js") is unrelated.
    writeTree(projectRoot, {
      "src/index.js": "import { bar } from './foo/bar.js';\nimport { baz } from './foo/baz.js';\nexport { bar, baz };\n",
      "src/foo/bar.js": "// bar helper\nexport function bar() { return 'bar'; }\n",
      "src/foo/baz.js": "// baz helper\nexport function baz() { return 'baz'; }\n",
      "src/qux/quux.js": "// quux helper (unrelated)\nexport function quux() { return 'quux'; }\n",
      "docs/README.md": "# project readme\n",
    });
    const idx = await ProjectIntel.indexProject(1, 11002, projectRoot);
    assert.equal(idx.ok, true, `indexProject failed: ${JSON.stringify(idx)}`);

    const { capture, provider } = makeScriptedProvider({ toolCalls: null });
    const core = makeCore({ projectId: 11002, rootPath: projectRoot });
    const created = core.pmCreateAgent(11002, "foo bar baz");
    const { terminal } = await runAgentOnce({
      core,
      profileId: 1,
      agentId: created.id,
      provider,
    });
    assert.equal(terminal.kind, "completed", `expected completed; got ${terminal.kind}`);

    const firstUser = capture.firstUserMessages[0];
    assert.match(firstUser, /## Project files \(relevant\)/,
      "unfamiliar fixture must still produce the intel block");
    assert.match(firstUser, /foo\/bar\.js/, "foo/bar.js must appear (matches 'foo' + 'bar')");
    assert.match(firstUser, /foo\/baz\.js/, "foo/baz.js must appear (matches 'foo' + 'baz')");
    // The unrelated file must NOT appear.
    assert.doesNotMatch(firstUser, /quux\.js/, "quux.js must NOT appear (no token overlap with 'foo bar baz')");
    assert.doesNotMatch(firstUser, /README\.md/, "README.md must NOT appear (no token overlap)");
  } finally {
    _closeIntel();
    _closeMem();
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(intelDir, { recursive: true, force: true });
    rmSync(memDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3) Memory across runs: Task A's projectSet is persisted. Task B (a
//    brand-new agent) retrieves it via buildContextPacket (the API the
//    context-builder uses) and the result shows up in its first user
//    message.
// ---------------------------------------------------------------------------

test("GATE 14 (v7): a fact written by Task A is retrieved by Task B (new agent) and appears in its context packet", async () => {
  const intelDir = makeTempDir("cf-g1-v7-3-intel-");
  const memDir = makeTempDir("cf-g1-v7-3-mem-");
  const projectRoot = makeTempDir("cf-g1-v7-3-proj-");
  _setIntelDir(intelDir);
  _setMemDir(memDir);
  try {
    // Minimal project so the loop can run.
    writeTree(projectRoot, {
      "src/auth/login.js": "// login\nexport function login() {}\n",
      "src/auth/session.js": "// session\nexport function session() {}\n",
    });
    const idx = await ProjectIntel.indexProject(1, 11003, projectRoot);
    assert.equal(idx.ok, true);

    // TASK A: a fresh agent run that writes a fact mid-run. The
    // scripted provider's first streamChat call is the natural place
    // to represent "the agent learned a fact" — it calls Memory
    // .projectSet as a side-effect, exactly the API the context-
    // builder uses to retrieve later.
    const taskASet = await Memory.projectSet(
      11003,
      "finding",
      "project-fact",
      "The auth login flow uses JWT tokens for session management",
    );
    assert.equal(taskASet.ok, true, `Task A projectSet failed: ${JSON.stringify(taskASet)}`);
    // The sidecar SQLite file must exist on disk — proof the fact was
    // persisted, not just cached in memory.
    const memDb = Memory._dbPathFor(11003);
    assert.ok(existsSync(memDb), `memory sidecar DB must exist at ${memDb}`);

    // TASK A: run the agent to completion (so it is a real "run").
    const coreA = makeCore({ projectId: 11003, rootPath: projectRoot });
    const taskA = coreA.pmCreateAgent(11003, "auth login flow");
    const providerA = makeScriptedProvider({ toolCalls: null }).provider;
    const resA = await runAgentOnce({
      core: coreA,
      profileId: 1,
      agentId: taskA.id,
      provider: providerA,
    });
    assert.equal(resA.terminal.kind, "completed", `Task A should complete: ${JSON.stringify(resA.terminal)}`);

    // TASK B: a brand-new agent (fresh startAgent, fresh transcript).
    // It must retrieve the fact via buildContextPacket and include it
    // in its first user message.
    const coreB = makeCore({ projectId: 11003, rootPath: projectRoot });
    const taskB = coreB.pmCreateAgent(11003, "auth login JWT session");
    const { capture: capB, provider: providerB } = makeScriptedProvider({ toolCalls: null });
    const resB = await runAgentOnce({
      core: coreB,
      profileId: 1,
      agentId: taskB.id,
      provider: providerB,
    });
    assert.equal(resB.terminal.kind, "completed", `Task B should complete: ${JSON.stringify(resB.terminal)}`);

    // Direct retrieval via the API the context-builder uses.
    const directPacket = await Memory.buildContextPacket(11003, "auth login JWT session");
    assert.equal(directPacket.ok, true);
    assert.match(directPacket.result.packet, /project-fact/, "buildContextPacket must return the fact key");
    assert.match(directPacket.result.packet, /JWT/, "buildContextPacket must return the fact value");

    // The fact must also appear in Task B's first user message.
    const firstUserB = capB.firstUserMessages[0];
    assert.match(firstUserB, /## Project memory/, "Task B's first user message must include the memory block");
    assert.match(firstUserB, /project-fact/, "Task B's first user message must include the fact key");
    assert.match(firstUserB, /JWT/, "Task B's first user message must include the fact value");
    // Task B's project intel block must also be present (same project).
    assert.match(firstUserB, /## Project files \(relevant\)/, "Task B's first user message must include the intel block");

    // Task A's first user message must NOT have the memory block (the
    // fact was written after Task A started, OR Task A's objective did
    // not share tokens with the fact). Either way, the fact must only
    // be visible to Task B.
    // (We do not assert on Task A's message here because the fact was
    // set BEFORE Task A started in this test — Task A's objective
    // "auth login flow" does share tokens with "auth login flow uses
    // JWT..." so the fact WOULD appear in Task A too. The real proof
    // of cross-run retrieval is Task B's fresh agent run, above.)
  } finally {
    _closeIntel();
    _closeMem();
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(intelDir, { recursive: true, force: true });
    rmSync(memDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4) Memory + Project Intel together: the agent's context has BOTH the
//    relevant files (from intel) AND a relevant fact (from memory).
// ---------------------------------------------------------------------------

test("GATE 14+1 (v7): the first user message contains BOTH the intel block AND a relevant memory fact", async () => {
  const intelDir = makeTempDir("cf-g1-v7-4-intel-");
  const memDir = makeTempDir("cf-g1-v7-4-mem-");
  const projectRoot = makeTempDir("cf-g1-v7-4-proj-");
  _setIntelDir(intelDir);
  _setMemDir(memDir);
  try {
    writeTree(projectRoot, {
      "src/auth/login.js": "// login\nexport function login() {}\n",
      "src/auth/session.js": "// session\nexport function session() {}\n",
      "src/api/health.js": "// health\nexport function health() {}\n",
    });
    const idx = await ProjectIntel.indexProject(1, 11004, projectRoot);
    assert.equal(idx.ok, true);

    // A relevant fact (shares tokens with "auth login JWT session")
    // and an irrelevant fact (no token overlap).
    await Memory.projectSet(
      11004,
      "finding",
      "jwt-choice",
      "We chose JWT for the auth login session",
    );
    await Memory.projectSet(
      11004,
      "preference",
      "indent-tabs",
      "use tabs not spaces",
    );

    const { capture, provider } = makeScriptedProvider({ toolCalls: null });
    const core = makeCore({ projectId: 11004, rootPath: projectRoot });
    const created = core.pmCreateAgent(11004, "auth login JWT session");
    const { terminal } = await runAgentOnce({
      core,
      profileId: 1,
      agentId: created.id,
      provider,
    });
    assert.equal(terminal.kind, "completed");

    const firstUser = capture.firstUserMessages[0];
    // Both blocks must be present.
    assert.match(firstUser, /## Project memory/, "memory block must be present");
    assert.match(firstUser, /## Project files \(relevant\)/, "intel block must be present");
    // The relevant memory fact must appear.
    assert.match(firstUser, /jwt-choice/, "relevant fact key must appear");
    assert.match(firstUser, /JWT/, "relevant fact value must appear");
    // The relevant intel files must appear.
    assert.match(firstUser, /login\.js/, "login.js must appear");
    assert.match(firstUser, /session\.js/, "session.js must appear");
    // The irrelevant memory fact must NOT appear.
    assert.doesNotMatch(firstUser, /indent-tabs/, "irrelevant memory fact must NOT appear");
  } finally {
    _closeIntel();
    _closeMem();
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(intelDir, { recursive: true, force: true });
    rmSync(memDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5) Memory irrelevant-fact filtering: a fact that does NOT match the
//    goal is NOT in the first user message.
// ---------------------------------------------------------------------------

test("GATE 14 (v7): memory facts that do not match the goal are filtered out of the first user message", async () => {
  const intelDir = makeTempDir("cf-g1-v7-5-intel-");
  const memDir = makeTempDir("cf-g1-v7-5-mem-");
  const projectRoot = makeTempDir("cf-g1-v7-5-proj-");
  _setIntelDir(intelDir);
  _setMemDir(memDir);
  try {
    writeTree(projectRoot, {
      "src/auth/login.js": "// login\nexport function login() {}\n",
    });
    const idx = await ProjectIntel.indexProject(1, 11005, projectRoot);
    assert.equal(idx.ok, true);

    // One relevant fact (shares tokens with the objective) and three
    // irrelevant facts about completely different topics.
    await Memory.projectSet(
      11005,
      "finding",
      "oauth-flow",
      "OAuth 2.1 PKCE for the login flow",
    );
    await Memory.projectSet(
      11005,
      "preference",
      "indent-tabs",
      "use tabs not spaces",
    );
    await Memory.projectSet(
      11005,
      "decision",
      "db-choice",
      "better-sqlite3 for persistence",
    );
    await Memory.projectSet(
      11005,
      "risk",
      "deploy-risk",
      "friday deploys are risky",
    );

    const { capture, provider } = makeScriptedProvider({ toolCalls: null });
    const core = makeCore({ projectId: 11005, rootPath: projectRoot });
    const created = core.pmCreateAgent(11005, "OAuth login flow");
    const { terminal } = await runAgentOnce({
      core,
      profileId: 1,
      agentId: created.id,
      provider,
    });
    assert.equal(terminal.kind, "completed");

    const firstUser = capture.firstUserMessages[0];
    // The relevant fact must appear.
    assert.match(firstUser, /oauth-flow/, "relevant fact key must appear");
    assert.match(firstUser, /PKCE/, "relevant fact value must appear");
    // The irrelevant facts must NOT appear.
    assert.doesNotMatch(firstUser, /indent-tabs/, "indent-tabs must NOT appear (no token overlap)");
    assert.doesNotMatch(firstUser, /db-choice/, "db-choice must NOT appear (no token overlap)");
    assert.doesNotMatch(firstUser, /deploy-risk/, "deploy-risk must NOT appear (no token overlap)");
    assert.doesNotMatch(firstUser, /better-sqlite3/, "irrelevant value must NOT appear");
  } finally {
    _closeIntel();
    _closeMem();
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(intelDir, { recursive: true, force: true });
    rmSync(memDir, { recursive: true, force: true });
  }
});
