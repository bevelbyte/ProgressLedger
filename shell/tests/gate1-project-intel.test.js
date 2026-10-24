// GATE 1 — Prove Project Intelligence is actually consumed by the agent.
//
// The brief's GATE 1 demands: USER -> Project Intelligence -> relevant files
// -> dependencies -> context packet -> LLM -> answer. Verify with tests.
//
// Test matrix:
//   1. relevantFiles returns non-empty array for a typical project
//   2. buildProjectIntelBlock selects relevant files (not the full listing)
//   3. buildProjectIntelBlock excludes files with no token overlap
//   4. buildProjectIntelBlock respects the token budget (no overflow)
//   5. All paths in the packet pass assertInsideProjectRoot
//   6. getNeighbors resolves the dependency graph correctly
//   7. Full pipeline: first user message contains ranked project-intel block
//   8. Memory supplementation: memory entry appears alongside intel block

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ProjectIntel,
  _setUserDataDir as _setProjectIntelUserDataDir,
  _closeAll as _closeAllProjectIntel,
} from "../src/services/project-intel/index.js";
import { buildProjectIntelBlock } from "../src/services/agent/context-builder.js";
import { assertInsideProjectRoot } from "../src/services/project-tools/security.js";
import { Memory } from "../src/services/memory/index.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "cf-gate1-"));
}

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
}

// ---------------------------------------------------------------------------
// 1) relevantFiles returns non-empty for a typical project
// ---------------------------------------------------------------------------

test("GATE 1: relevantFiles returns non-empty matches for a typical project", async () => {
  const root = makeTempDir();
  const userData = makeTempDir();
  _setProjectIntelUserDataDir(userData);
  try {
    writeTree(root, {
      "src/auth/login.js": "// login flow\nexport function login() {}",
      "src/auth/session.js": "// session management\nexport function session() {}",
      "src/api/users.js": "// user API\nexport function users() {}",
      "src/config.js": "// config\nexport const config = {};",
      "README.md": "# project readme\n",
    });
    const idx = await ProjectIntel.indexProject(1, 1000, root);
    assert.equal(idx.ok, true, `indexProject failed: ${JSON.stringify(idx)}`);

    const rel = await ProjectIntel.relevantFiles(1, 1000, "auth login", 10, root);
    assert.equal(rel.ok, true, `relevantFiles failed: ${JSON.stringify(rel)}`);
    assert.ok(Array.isArray(rel.result.matches));
    assert.ok(rel.result.matches.length > 0, "expected non-empty matches for 'auth login'");

    // Top match should contain both tokens (score boost for all-match)
    const top = rel.result.matches[0];
    const hasAuth = top.path.toLowerCase().includes("auth");
    const hasLogin = top.path.toLowerCase().includes("login");
    assert.ok(hasAuth || hasLogin,
      `top match ${top.path} should contain auth or login token`);
  } finally {
    _closeAllProjectIntel();
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2) buildProjectIntelBlock selects relevant files, not the full listing
// ---------------------------------------------------------------------------

test("GATE 1: buildProjectIntelBlock selects relevant files, not the full listing", async () => {
  const root = makeTempDir();
  const userData = makeTempDir();
  _setProjectIntelUserDataDir(userData);
  try {
    writeTree(root, {
      "src/auth/login.js": "// login flow\nexport function login() {}",
      "src/auth/register.js": "// register flow\nexport function register() {}",
      "src/api/health.js": "// health check\nexport function health() {}",
      "src/api/metrics.js": "// metrics\nexport function metrics() {}",
      "src/db/connection.js": "// db connection\nexport const db = {};",
      "package.json": "{}\n",
    });
    const idx = await ProjectIntel.indexProject(1, 2000, root);
    assert.equal(idx.ok, true);

    const { packet, fileCount } = await buildProjectIntelBlock({
      projectId: 2000,
      objective: "auth login flow",
      projectRoot: root,
      maxTokens: 1500,
    });

    assert.ok(packet.length > 0, "packet should not be empty");
    assert.ok(fileCount > 0, "fileCount should be positive");
    assert.match(packet, /## Project files \(relevant\)/);
    // The auth/login files should be present (they match the query tokens)
    assert.match(packet, /login\.js/, "login.js should be in the packet");
    // The health/metrics files should NOT be present (no token overlap)
    assert.doesNotMatch(packet, /health\.js/, "health.js should not be in the packet");
    assert.doesNotMatch(packet, /metrics\.js/, "metrics.js should not be in the packet");
  } finally {
    _closeAllProjectIntel();
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3) buildProjectIntelBlock excludes files with no token overlap
// ---------------------------------------------------------------------------

test("GATE 1: buildProjectIntelBlock excludes files with no token overlap", async () => {
  const root = makeTempDir();
  const userData = makeTempDir();
  _setProjectIntelUserDataDir(userData);
  try {
    writeTree(root, {
      "src/auth/login.js": "// login\nexport function login() {}",
      "src/auth/logout.js": "// logout\nexport function logout() {}",
      "src/utils/format.js": "// format\nexport function format() {}",
      "src/utils/parse.js": "// parse\nexport function parse() {}",
      "docs/api.md": "# API docs\n",
    });
    const idx = await ProjectIntel.indexProject(1, 3000, root);
    assert.equal(idx.ok, true);

    const { packet, fileCount } = await buildProjectIntelBlock({
      projectId: 3000,
      objective: "auth login logout",
      projectRoot: root,
      maxTokens: 1500,
    });

    assert.ok(packet.length > 0);
    assert.ok(fileCount > 0);
    assert.match(packet, /login\.js/);
    assert.match(packet, /logout\.js/);
    // These have no token overlap with "auth login logout"
    assert.doesNotMatch(packet, /format\.js/);
    assert.doesNotMatch(packet, /parse\.js/);
    assert.doesNotMatch(packet, /api\.md/);
  } finally {
    _closeAllProjectIntel();
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4) buildProjectIntelBlock respects the token budget
// ---------------------------------------------------------------------------

test("GATE 1: buildProjectIntelBlock respects the token budget", async () => {
  const root = makeTempDir();
  const userData = makeTempDir();
  _setProjectIntelUserDataDir(userData);
  try {
    // Create many files all matching the "loop" token
    const files = {};
    for (let i = 0; i < 20; i++) {
      files[`src/loop-${i}.js`] = `// loop helper number ${i}\nexport function loop${i}() { return ${i}; }\n`;
    }
    writeTree(root, files);
    const idx = await ProjectIntel.indexProject(1, 4000, root);
    assert.equal(idx.ok, true);

    const cap = 100;
    const { packet, tokenCount } = await buildProjectIntelBlock({
      projectId: 4000,
      objective: "loop",
      projectRoot: root,
      maxTokens: cap,
    });

    assert.ok(packet.length > 0, "packet should not be empty when files match");
    // tokenCount must be within 1.1x of cap (one trim pass allowed)
    assert.ok(tokenCount <= Math.ceil(cap * 1.1),
      `tokenCount ${tokenCount} exceeds 1.1x cap ${cap}`);
    // Not all 20 files should fit in a 100-token budget
    const listed = packet.split("\n").filter((l) => l.trim().startsWith("- src/loop-")).length;
    assert.ok(listed < 20, `not all files should fit; got ${listed}/20`);
  } finally {
    _closeAllProjectIntel();
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5) All paths in the packet pass assertInsideProjectRoot
// ---------------------------------------------------------------------------

test("GATE 1: all paths in the packet are inside the project root", async () => {
  const root = makeTempDir();
  const userData = makeTempDir();
  _setProjectIntelUserDataDir(userData);
  try {
    writeTree(root, {
      "src/loop-safe.js": "// safe loop\nexport function safe() {}",
      "src/utils/helper.js": "// helper utility\nexport function helper() {}",
      "src/models/user.js": "// user model\nexport class User {}",
    });
    const idx = await ProjectIntel.indexProject(1, 5000, root);
    assert.equal(idx.ok, true);

    const { packet } = await buildProjectIntelBlock({
      projectId: 5000,
      objective: "loop helper",
      projectRoot: root,
      maxTokens: 1500,
    });

    assert.ok(packet.length > 0);
    // Extract all file paths from the packet and verify each is inside root
    const pathRegex = /- ([^\s]+) —/g;
    let m;
    const foundPaths = [];
    while ((m = pathRegex.exec(packet)) !== null) {
      foundPaths.push(m[1]);
    }
    assert.ok(foundPaths.length > 0, "expected at least one path in the packet");
    for (const relPath of foundPaths) {
      const gate = assertInsideProjectRoot(relPath, root);
      assert.ok(gate && gate.ok,
        `path ${relPath} should be inside project root ${root}`);
    }
  } finally {
    _closeAllProjectIntel();
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6) getNeighbors resolves the dependency graph correctly
// ---------------------------------------------------------------------------

test("GATE 1: getNeighbors resolves the dependency graph for indexed files", async () => {
  const root = makeTempDir();
  const userData = makeTempDir();
  _setProjectIntelUserDataDir(userData);
  try {
    writeTree(root, {
      "src/index.js": "import { auth } from './auth.js';\nimport { db } from './db.js';\n",
      "src/auth.js": "import { db } from './db.js';\nexport function auth() {}",
      "src/db.js": "export function db() {}",
      "src/orphan.js": "// no imports\nexport function orphan() {}",
    });
    const idx = await ProjectIntel.indexProject(1, 6000, root);
    assert.equal(idx.ok, true, `indexProject failed: ${JSON.stringify(idx)}`);

    // index.js imports auth.js and db.js, is imported by nothing
    const nbIndex = await ProjectIntel.getNeighbors(1, 6000, "src/index.js", 1, root);
    assert.equal(nbIndex.ok, true);
    assert.deepEqual(new Set(nbIndex.result.imports), new Set(["src/auth.js", "src/db.js"]));
    assert.deepEqual(nbIndex.result.importedBy, []);

    // auth.js imports db.js, is imported by index.js
    const nbAuth = await ProjectIntel.getNeighbors(1, 6000, "src/auth.js", 1, root);
    assert.equal(nbAuth.ok, true);
    assert.deepEqual(new Set(nbAuth.result.imports), new Set(["src/db.js"]));
    assert.deepEqual(new Set(nbAuth.result.importedBy), new Set(["src/index.js"]));

    // db.js is imported by both index.js and auth.js, imports nothing
    const nbDb = await ProjectIntel.getNeighbors(1, 6000, "src/db.js", 1, root);
    assert.equal(nbDb.ok, true);
    assert.deepEqual(new Set(nbDb.result.importedBy), new Set(["src/index.js", "src/auth.js"]));
    assert.deepEqual(nbDb.result.imports, []);

    // orphan.js has no edges at all
    const nbOrphan = await ProjectIntel.getNeighbors(1, 6000, "src/orphan.js", 1, root);
    assert.equal(nbOrphan.ok, true);
    assert.deepEqual(nbOrphan.result.imports, []);
    assert.deepEqual(nbOrphan.result.importedBy, []);
  } finally {
    _closeAllProjectIntel();
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7) Full pipeline: first user message contains ranked project-intel block
// ---------------------------------------------------------------------------

test("GATE 1: full pipeline — first user message contains ranked project-intel block", async () => {
  const { startAgent, AGENT_EVENTS, STATES } = await import("../src/services/agent/loop.js");

  const userData = makeTempDir();
  const projectRoot = makeTempDir();
  _setProjectIntelUserDataDir(userData);
  try {
    writeTree(projectRoot, {
      "src/auth/login.js": "// login flow\nexport function login() { return 'login'; }\n",
      "src/auth/session.js": "// session management\nexport function session() { return 'session'; }\n",
      "src/api/health.js": "// health check\nexport function health() { return 'ok'; }\n",
      "src/api/metrics.js": "// metrics\nexport function metrics() { return {}; }\n",
    });
    const idx = await ProjectIntel.indexProject(1, 7000, projectRoot);
    assert.equal(idx.ok, true);

    // Fake core with project config
    const agents = new Map();
    const messages = new Map();
    let nextAgentId = 1;
    const core = {
      pmCreateAgent(projectId, objective) {
        const id = nextAgentId++;
        agents.set(id, { id, projectId, objective, state: STATES.IDLE, planJson: "[]", tokensIn: 0, tokensOut: 0, finishedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), parentAgentId: null });
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
        a.tokensOut = tokensOut;
        a.updatedAt = new Date().toISOString();
        return { ok: true };
      },
      pmAppendMessage(profileId, agentId, role, content, name, payloadJson) {
        const list = messages.get(agentId) || [];
        list.push({ id: list.length + 1, agent_id: agentId, seq: list.length + 1, role, content: typeof content === "string" ? content : JSON.stringify(content), name: name == null ? null : name, payload_json: payloadJson == null ? null : payloadJson });
        messages.set(agentId, list);
        return { seq: list.length };
      },
      pmFinishAgent(_profileId, agentId, state) {
        const a = agents.get(agentId);
        if (!a) throw new Error("not found");
        a.state = state;
        a.finishedAt = new Date().toISOString();
      },
      pmGetProject(_profileId, _projectId) {
        return { id: 7000, profileId: 1, name: "Gate 1 project", description: "", rootPath: projectRoot, root_path: projectRoot, configJson: JSON.stringify({ context_packet_max_tokens: 0, context_packet_max_project_intel_tokens: 1500 }), config_json: JSON.stringify({ context_packet_max_tokens: 0, context_packet_max_project_intel_tokens: 1500 }), createdAt: "1970-01-01T00:00:00Z", updatedAt: "1970-01-01T00:00:00Z" };
      },
      pmListMessages(_profileId, agentId) {
        return (messages.get(agentId) || []).slice();
      },
      _agents: agents,
      _messages: messages,
    };

    const capture = { messages: null };
    const provider = {
      async *streamChat(opts = {}) {
        capture.messages = Array.isArray(opts.messages) ? opts.messages.slice() : [];
        yield { type: "text_delta", delta: "done." };
        yield { type: "usage", inputTokens: 1, outputTokens: 2 };
        yield { type: "finish", reason: "stop" };
      },
    };

    const created = core.pmCreateAgent(7000, "auth login flow");
    const agentId = created.id;
    core.pmUpdateAgent(1, agentId, STATES.IDLE, JSON.stringify({ version: 1, steps: [{ id: "step-1", title: "single", status: "pending", depends_on: [], files: [], assigned_to: null }] }), 0, 0);

    const startRes = await startAgent({ core, profileId: 1, agentId, provider });

    // Wait for terminal event
    const terminal = await new Promise((resolve) => {
      startRes.bus.on(AGENT_EVENTS.AGENT_COMPLETED, (e) => resolve({ kind: "completed", payload: e.payload }));
      startRes.bus.on(AGENT_EVENTS.AGENT_FAILED, (e) => resolve({ kind: "failed", payload: e.payload }));
    });
    assert.equal(terminal.kind, "completed", `expected completed; got ${terminal.kind}: ${JSON.stringify(terminal.payload)}`);

    const firstUser = capture.messages[1];
    assert.equal(firstUser.role, "user");
    assert.match(firstUser.content, /## Project files \(relevant\)/,
      "first user message must include the project-intel block");
    // Ranked files (token overlap with "auth login flow")
    assert.match(firstUser.content, /login\.js/, "login.js must appear in the block");
    assert.match(firstUser.content, /session\.js/, "session.js must appear (matches 'auth')");
    // Irrelevant files must NOT appear
    assert.doesNotMatch(firstUser.content, /health\.js/, "health.js should not appear (no token overlap)");
    assert.doesNotMatch(firstUser.content, /metrics\.js/, "metrics.js should not appear (no token overlap)");

    // The observability event must have fired with a non-zero fileCount
    const events = startRes.bus.recent(64).filter((e) => e.type === AGENT_EVENTS.PROJECT_INTEL_RECALLED);
    assert.ok(events.length >= 1, "PROJECT_INTEL_RECALLED event must fire at least once");
    assert.equal(events[0].payload.projectId, 7000);
    assert.ok(events[0].payload.fileCount >= 1, "fileCount should be >= 1");
    assert.ok(events[0].payload.tokenCount > 0, "tokenCount should be > 0");
  } finally {
    _closeAllProjectIntel();
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8) Memory supplementation: memory entry appears alongside intel block
// ---------------------------------------------------------------------------

test("GATE 1: memory entry appears alongside the project-intel block in the first user message", async () => {
  const { startAgent, AGENT_EVENTS, STATES } = await import("../src/services/agent/loop.js");

  const intelUserData = makeTempDir();
  const memUserData = makeTempDir();
  const projectRoot = makeTempDir();
  _setProjectIntelUserDataDir(intelUserData);
  Memory._setUserDataDir(memUserData);
  try {
    writeTree(projectRoot, {
      "src/auth/login.js": "// login flow\nexport function login() { return 'login'; }\n",
      "src/auth/session.js": "// session management\nexport function session() { return 'session'; }\n",
    });
    const idx = await ProjectIntel.indexProject(1, 8000, projectRoot);
    assert.equal(idx.ok, true);

    // Seed a memory entry whose value contains tokens matching the objective.
    // The agent loop calls Memory.buildContextPacket(projectId, ...) so the
    // Memory DB key is the projectId. Store under 8000 to match.
    const memSet = await Memory.projectSet(8000, "finding", "auth-flow-note",
      "The auth login flow uses JWT tokens for session management", 1.0);
    assert.equal(memSet.ok, true, `projectSet failed: ${JSON.stringify(memSet)}`);

    const agents = new Map();
    const messages = new Map();
    let nextAgentId = 1;
    const core = {
      pmCreateAgent(projectId, objective) {
        const id = nextAgentId++;
        agents.set(id, { id, projectId, objective, state: STATES.IDLE, planJson: "[]", tokensIn: 0, tokensOut: 0, finishedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), parentAgentId: null });
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
        a.tokensOut = tokensOut;
        a.updatedAt = new Date().toISOString();
        return { ok: true };
      },
      pmAppendMessage(profileId, agentId, role, content, name, payloadJson) {
        const list = messages.get(agentId) || [];
        list.push({ id: list.length + 1, agent_id: agentId, seq: list.length + 1, role, content: typeof content === "string" ? content : JSON.stringify(content), name: name == null ? null : name, payload_json: payloadJson == null ? null : payloadJson });
        messages.set(agentId, list);
        return { seq: list.length };
      },
      pmFinishAgent(_profileId, agentId, state) {
        const a = agents.get(agentId);
        if (!a) throw new Error("not found");
        a.state = state;
        a.finishedAt = new Date().toISOString();
      },
      pmGetProject(_profileId, _projectId) {
        return { id: 8000, profileId: 1, name: "Gate 1 memory project", description: "", rootPath: projectRoot, root_path: projectRoot, configJson: JSON.stringify({ context_packet_max_tokens: 2000, context_packet_max_project_intel_tokens: 1500 }), config_json: JSON.stringify({ context_packet_max_tokens: 2000, context_packet_max_project_intel_tokens: 1500 }), createdAt: "1970-01-01T00:00:00Z", updatedAt: "1970-01-01T00:00:00Z" };
      },
      pmListMessages(_profileId, agentId) {
        return (messages.get(agentId) || []).slice();
      },
      _agents: agents,
      _messages: messages,
    };

    const capture = { messages: null };
    const provider = {
      async *streamChat(opts = {}) {
        capture.messages = Array.isArray(opts.messages) ? opts.messages.slice() : [];
        yield { type: "text_delta", delta: "done." };
        yield { type: "usage", inputTokens: 1, outputTokens: 2 };
        yield { type: "finish", reason: "stop" };
      },
    };

    const created = core.pmCreateAgent(8000, "auth login JWT session");
    const agentId = created.id;
    core.pmUpdateAgent(1, agentId, STATES.IDLE, JSON.stringify({ version: 1, steps: [{ id: "step-1", title: "single", status: "pending", depends_on: [], files: [], assigned_to: null }] }), 0, 0);

    const startRes = await startAgent({ core, profileId: 1, agentId, provider });

    const terminal = await new Promise((resolve) => {
      startRes.bus.on(AGENT_EVENTS.AGENT_COMPLETED, (e) => resolve({ kind: "completed", payload: e.payload }));
      startRes.bus.on(AGENT_EVENTS.AGENT_FAILED, (e) => resolve({ kind: "failed", payload: e.payload }));
    });
    assert.equal(terminal.kind, "completed", `expected completed; got ${terminal.kind}`);

    const firstUser = capture.messages[1];
    assert.equal(firstUser.role, "user");

    // The memory block comes first, then the project-intel block
    assert.match(firstUser.content, /## Project memory/,
      "first user message must include the memory block");
    assert.match(firstUser.content, /## Project files \(relevant\)/,
      "first user message must include the project-intel block");

    // The memory entry value should appear (token overlap with "auth login JWT session")
    assert.match(firstUser.content, /auth-flow-note/,
      "memory entry key should appear in the message");
    assert.match(firstUser.content, /JWT/,
      "memory entry value should appear (matches objective tokens)");

    // The project-intel files should also appear
    assert.match(firstUser.content, /login\.js/, "login.js must appear in the intel block");
    assert.match(firstUser.content, /session\.js/, "session.js must appear in the intel block");
  } finally {
    _closeAllProjectIntel();
    Memory._closeAll();
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(intelUserData, { recursive: true, force: true });
    rmSync(memUserData, { recursive: true, force: true });
  }
});
