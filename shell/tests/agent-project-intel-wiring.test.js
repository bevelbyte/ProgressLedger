// Agent loop + Project Intelligence wiring tests.
//
// Pins the contract that the agent loop injects a project-intel
// contextPacket (per-file header list) into the FIRST user message,
// gated by `project.config_json.context_packet_max_project_intel_tokens`,
// and that the agent remains functional when ProjectIntel has no
// index for the project.
//
// Test matrix:
//   1. context_packet_max_project_intel_tokens = 1500 → block injected
//   2. objective has no matching files → block is empty
//   3. context_packet_max_project_intel_tokens = 0 → block disabled
//   4. ProjectIntel.start() never called → block empty (graceful degrade)
//   5. Block is capped at maxTokens (the 1.1× trim pass)
//   6. Files outside the project root are NOT included (path safety)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";

import { startAgent, AGENT_EVENTS, STATES } from "../src/services/agent/loop.js";
import {
  ProjectIntel,
  _setUserDataDir as _setProjectIntelUserDataDir,
  _closeAll as _closeAllProjectIntel,
} from "../src/services/project-intel/index.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeFakeCore({ configJson = "{}", projectRoot = "/tmp/cf-pi-wiring" } = {}) {
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
        projectId,
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
      a.tokensOut = tokensOut;
      a.updatedAt = new Date().toISOString();
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
    },
    pmGetProject(_profileId, _projectId) {
      return {
        id: 20,
        profileId: 1,
        name: "Project Intel wiring project",
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
    _agents: agents,
    _messages: messages,
  };
  return core;
}

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
    bus.on("agent.failed", (e) => resolve({ kind: "loop-failed", payload: e.payload }));
  });
}

/**
 * Seed a temp project root with a small handful of files that share
 * tokens with the test objective ("loop helper") so the ranker has
 * something to match against.
 */
function seedProjectRoot(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
}

// ---------------------------------------------------------------------------
// 1) block injected when ProjectIntel has matching files
// ---------------------------------------------------------------------------

test("project-intel wiring: first user message includes the ## Project files (relevant) block when the index has matches", async () => {
  const userData = mkdtempSync(join(tmpdir(), "cf-pi-wire-ud-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "cf-pi-wire-proj-"));
  _setProjectIntelUserDataDir(userData);
  try {
    seedProjectRoot(projectRoot, {
      "src/loop-helper.js": "// loop helper\nexport function helper() { return 1; }\n",
      "src/util.js": "// unrelated utility\nexport const x = 1;\n",
      "README.md": "# readme\n",
    });
    const idx = await ProjectIntel.indexProject(1, 20, projectRoot);
    assert.equal(idx.ok, true);

    const core = makeFakeCore({
      projectRoot,
      configJson: JSON.stringify({
        context_packet_max_tokens: 0, // disable memory so we test the intel block in isolation
        context_packet_max_project_intel_tokens: 1500,
      }),
    });
    const created = core.pmCreateAgent(20, "loop helper refactor");
    const agentId = created.id;
    core.pmUpdateAgent(1, agentId, STATES.IDLE, JSON.stringify({
      version: 1,
      steps: [{ id: "step-1", title: "single", status: "pending", depends_on: [], files: [], assigned_to: null }],
    }), 0, 0);

    const capture = { messages: null };
    const provider = makeCapturingProvider(capture);
    const startRes = await startAgent({ core, profileId: 1, agentId, provider });
    const terminal = await waitForTerminal(startRes.bus);
    if (terminal.kind !== "completed") {
      const recent = startRes.bus.recent(64).map((e) => ({ type: e.type, payload: e.payload }));
      assert.fail(`expected completed; got ${terminal.kind} payload=${JSON.stringify(terminal.payload)} events=${JSON.stringify(recent)}`);
    }

    const firstUser = capture.messages[1];
    assert.equal(firstUser.role, "user");
    assert.match(
      firstUser.content,
      /## Project files \(relevant\)/,
      `first user message must include the project-intel block; got: ${JSON.stringify(firstUser.content.slice(0, 120))}`,
    );
    assert.match(firstUser.content, /loop-helper\.js/, "ranked file 'loop-helper.js' must appear in the block");
    assert.ok(
      firstUser.content.startsWith("loop helper refactor"),
      `first user message must START with the bare objective; got: ${JSON.stringify(firstUser.content.slice(0, 80))}`,
    );

    // The observability event must have fired with a non-zero fileCount.
    const events = startRes.bus.recent(64).filter((e) => e.type === AGENT_EVENTS.PROJECT_INTEL_RECALLED);
    assert.ok(events.length >= 1, "agent.project_intel.recalled must fire at least once");
    assert.equal(events[0].payload.projectId, 20);
    assert.ok(events[0].payload.fileCount >= 1);
    assert.ok(events[0].payload.tokenCount > 0);
  } finally {
    _closeAllProjectIntel();
    rmSync(userData, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2) no matches → block is empty
// ---------------------------------------------------------------------------

test("project-intel wiring: block is empty when no files match the objective", async () => {
  const userData = mkdtempSync(join(tmpdir(), "cf-pi-wire-ud-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "cf-pi-wire-proj-"));
  _setProjectIntelUserDataDir(userData);
  try {
    seedProjectRoot(projectRoot, {
      "src/alpha.js": "// alpha\nexport const a = 1;\n",
      "src/beta.js": "// beta\nexport const b = 2;\n",
    });
    const idx = await ProjectIntel.indexProject(1, 20, projectRoot);
    assert.equal(idx.ok, true);

    const core = makeFakeCore({
      projectRoot,
      configJson: JSON.stringify({
        context_packet_max_tokens: 0,
        context_packet_max_project_intel_tokens: 1500,
      }),
    });
    const created = core.pmCreateAgent(20, "zzzzzz-no-match-token");
    const agentId = created.id;
    core.pmUpdateAgent(1, agentId, STATES.IDLE, JSON.stringify({
      version: 1,
      steps: [{ id: "step-1", title: "single", status: "pending", depends_on: [], files: [], assigned_to: null }],
    }), 0, 0);

    const capture = { messages: null };
    const provider = makeCapturingProvider(capture);
    const startRes = await startAgent({ core, profileId: 1, agentId, provider });
    const terminal = await waitForTerminal(startRes.bus);
    assert.equal(terminal.kind, "completed");

    const firstUser = capture.messages[1];
    assert.equal(firstUser.content, "zzzzzz-no-match-token");
    assert.doesNotMatch(firstUser.content, /## Project files/);

    const events = startRes.bus.recent(64).filter((e) => e.type === AGENT_EVENTS.PROJECT_INTEL_RECALLED);
    assert.equal(events.length, 0, "no PROJECT_INTEL_RECALLED event when there are no matches");
  } finally {
    _closeAllProjectIntel();
    rmSync(userData, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3) cap = 0 → block disabled
// ---------------------------------------------------------------------------

test("project-intel wiring: block is empty when context_packet_max_project_intel_tokens = 0", async () => {
  const userData = mkdtempSync(join(tmpdir(), "cf-pi-wire-ud-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "cf-pi-wire-proj-"));
  _setProjectIntelUserDataDir(userData);
  try {
    seedProjectRoot(projectRoot, {
      "src/loop-helper.js": "// loop helper\nexport function helper() { return 1; }\n",
    });
    await ProjectIntel.indexProject(1, 20, projectRoot);

    const core = makeFakeCore({
      projectRoot,
      configJson: JSON.stringify({
        context_packet_max_tokens: 0,
        context_packet_max_project_intel_tokens: 0,
      }),
    });
    const created = core.pmCreateAgent(20, "loop helper refactor");
    const agentId = created.id;
    core.pmUpdateAgent(1, agentId, STATES.IDLE, JSON.stringify({
      version: 1,
      steps: [{ id: "step-1", title: "single", status: "pending", depends_on: [], files: [], assigned_to: null }],
    }), 0, 0);

    const capture = { messages: null };
    const provider = makeCapturingProvider(capture);
    const startRes = await startAgent({ core, profileId: 1, agentId, provider });
    const terminal = await waitForTerminal(startRes.bus);
    assert.equal(terminal.kind, "completed");

    const firstUser = capture.messages[1];
    assert.equal(firstUser.content, "loop helper refactor");
    assert.doesNotMatch(firstUser.content, /## Project files/);
  } finally {
    _closeAllProjectIntel();
    rmSync(userData, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4) ProjectIntel never started → graceful degradation
// ---------------------------------------------------------------------------

test("project-intel wiring: block is empty when ProjectIntel.start() was never called (graceful degrade)", async () => {
  const userData = mkdtempSync(join(tmpdir(), "cf-pi-wire-ud-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "cf-pi-wire-proj-"));
  _setProjectIntelUserDataDir(userData);
  try {
    // Note: NO indexProject call — the SQLite cache for project 20
    // is closed / missing. relevantFiles must return
    // { ok: false, error: { code: "not-initialized" } } and the
    // loop must not crash.

    const core = makeFakeCore({
      projectRoot,
      configJson: JSON.stringify({
        context_packet_max_tokens: 0,
        context_packet_max_project_intel_tokens: 1500,
      }),
    });
    const created = core.pmCreateAgent(20, "anything here");
    const agentId = created.id;
    core.pmUpdateAgent(1, agentId, STATES.IDLE, JSON.stringify({
      version: 1,
      steps: [{ id: "step-1", title: "single", status: "pending", depends_on: [], files: [], assigned_to: null }],
    }), 0, 0);

    const capture = { messages: null };
    const provider = makeCapturingProvider(capture);
    const startRes = await startAgent({ core, profileId: 1, agentId, provider });
    const terminal = await waitForTerminal(startRes.bus);
    assert.equal(terminal.kind, "completed", `expected completed; got ${terminal.kind}: ${JSON.stringify(terminal.payload)}`);

    const firstUser = capture.messages[1];
    assert.equal(firstUser.content, "anything here");
    assert.doesNotMatch(firstUser.content, /## Project files/);
  } finally {
    _closeAllProjectIntel();
    rmSync(userData, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5) block is capped at maxTokens (within ~1.1×)
// ---------------------------------------------------------------------------

test("project-intel wiring: block is capped at context_packet_max_project_intel_tokens", async () => {
  const userData = mkdtempSync(join(tmpdir(), "cf-pi-wire-ud-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "cf-pi-wire-proj-"));
  _setProjectIntelUserDataDir(userData);
  try {
    // 6 files all matching the "loop" token. Each header is ~30-50
    // tokens of prose so the cumulative token count grows quickly.
    const padding = " ".repeat(40);
    seedProjectRoot(projectRoot, {
      "src/loop-a.js": `// loop a header\n// ${padding}\nexport function a(){return 1;}\n`,
      "src/loop-b.js": `// loop b header\n// ${padding}\nexport function b(){return 2;}\n`,
      "src/loop-c.js": `// loop c header\n// ${padding}\nexport function c(){return 3;}\n`,
      "src/loop-d.js": `// loop d header\n// ${padding}\nexport function d(){return 4;}\n`,
      "src/loop-e.js": `// loop e header\n// ${padding}\nexport function e(){return 5;}\n`,
      "src/loop-f.js": `// loop f header\n// ${padding}\nexport function f(){return 6;}\n`,
    });
    await ProjectIntel.indexProject(1, 20, projectRoot);

    const cap = 30; // small enough to force the trim pass
    const core = makeFakeCore({
      projectRoot,
      configJson: JSON.stringify({
        context_packet_max_tokens: 0,
        context_packet_max_project_intel_tokens: cap,
      }),
    });
    const created = core.pmCreateAgent(20, "loop");
    const agentId = created.id;
    core.pmUpdateAgent(1, agentId, STATES.IDLE, JSON.stringify({
      version: 1,
      steps: [{ id: "step-1", title: "single", status: "pending", depends_on: [], files: [], assigned_to: null }],
    }), 0, 0);

    const capture = { messages: null };
    const provider = makeCapturingProvider(capture);
    const startRes = await startAgent({ core, profileId: 1, agentId, provider });
    const terminal = await waitForTerminal(startRes.bus);
    assert.equal(terminal.kind, "completed");

    const firstUser = capture.messages[1];
    assert.match(firstUser.content, /## Project files \(relevant\)/);
    // Token estimate of the project-intel block must be ≤ cap * 1.1
    // (one trim pass allowed). Extract the block.
    const blockStart = firstUser.content.indexOf("## Project files (relevant)");
    const block = firstUser.content.slice(blockStart);
    const tokens = block.split(/\s+/).filter(Boolean).length;
    assert.ok(
      tokens <= Math.ceil(cap * 1.1) + 2, // +2 for "## Project files (relevant)"
      `block must fit within 1.1x cap (cap=${cap}); got ${tokens} tokens`,
    );
    // And the file list must NOT contain every file (otherwise the cap
    // is being ignored).
    const listed = block.split("\n").filter((l) => l.trim().startsWith("- src/loop-")).length;
    assert.ok(listed < 6, `not every file should fit in the cap; got ${listed}/6`);
  } finally {
    _closeAllProjectIntel();
    rmSync(userData, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6) path safety — files outside the project root are NOT included
// ---------------------------------------------------------------------------

test("project-intel wiring: files outside the project root are NOT included in the block (path safety)", async () => {
  const userData = mkdtempSync(join(tmpdir(), "cf-pi-wire-ud-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "cf-pi-wire-proj-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "cf-pi-wire-out-"));
  _setProjectIntelUserDataDir(userData);
  try {
    seedProjectRoot(projectRoot, {
      "src/loop-safe.js": "// loop safe\nexport function safe(){return 1;}\n",
    });
    seedProjectRoot(outsideRoot, {
      "evil/loop-evil.js": "// loop evil\nexport function evil(){return 0;}\n",
    });

    const idx = await ProjectIntel.indexProject(1, 20, projectRoot);
    assert.equal(idx.ok, true);

    // Now write an "evil" file into the sidecar DB directly with an
    // absolute path that escapes projectRoot. We bypass the normal
    // indexer because it would refuse to walk outside the project.
    // The wiring code MUST filter such rows out via
    // assertInsideProjectRoot.
    const evilAbs = join(outsideRoot, "evil", "loop-evil.js");
    const Database = (await import("better-sqlite3")).default;
    const dbPath = ProjectIntel._dbPathFor(20);
    const raw = new Database(dbPath);
    try {
      raw.prepare(
        `INSERT INTO files (path, size, mtime, language, indexed_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(evilAbs.replace(/\\/g, "/"), 999, Date.now(), "js", Date.now());
    } finally {
      raw.close();
    }

    const core = makeFakeCore({
      projectRoot,
      configJson: JSON.stringify({
        context_packet_max_tokens: 0,
        context_packet_max_project_intel_tokens: 1500,
      }),
    });
    const created = core.pmCreateAgent(20, "loop");
    const agentId = created.id;
    core.pmUpdateAgent(1, agentId, STATES.IDLE, JSON.stringify({
      version: 1,
      steps: [{ id: "step-1", title: "single", status: "pending", depends_on: [], files: [], assigned_to: null }],
    }), 0, 0);

    const capture = { messages: null };
    const provider = makeCapturingProvider(capture);
    const startRes = await startAgent({ core, profileId: 1, agentId, provider });
    const terminal = await waitForTerminal(startRes.bus);
    assert.equal(terminal.kind, "completed");

    const firstUser = capture.messages[1];
    assert.match(firstUser.content, /## Project files \(relevant\)/);
    assert.match(firstUser.content, /loop-safe\.js/, "in-project file must be present");
    assert.doesNotMatch(
      firstUser.content,
      /loop-evil\.js/,
      "out-of-project file must NOT be present in the block",
    );
  } finally {
    _closeAllProjectIntel();
    rmSync(userData, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});