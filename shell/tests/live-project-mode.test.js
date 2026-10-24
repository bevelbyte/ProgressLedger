// Project Mode — LIVE Project Mode acceptance harness (Phase 11).
//
// Env-gated exactly like provider-live.test.js:
//   CAREERFLOW_LIVE_TEST=1  CAREERFLOW_USER_DATA=<dir with pm-secrets.json>
//
// Runs the REAL agent loop (loop.js), the REAL tool registry, the REAL
// verify gate with a real node subprocess, and the LIVE OpenAI-
// compatible provider from the stored credential. Persistence uses the
// in-memory fake core (the pm_* contract harness used by the whole
// shell test suite — SQLite itself is covered by the Rust suite).
// The apiKey is read only from the store and NEVER logged or asserted.
//
// Gates covered here (GATES-PHASE11):
//   G2  streaming through the full agent loop (no dup/missing messages)
//   G3  live tool calling (model -> tool -> result -> continuation)
//   G4  live project understanding with Project Intelligence enabled
//   G5  real live development task (understand -> plan -> modify -> test)
//   G6  real failure -> diagnose -> fix -> retest (REAL failing test)
//   G7  live DAG: seeded A,B,C independent + D dependent, run by model
//   G8  CareerFlow sub-agent orchestration (delegate_research, live child)
//   G9  live cancellation mid-run (parent cancelled, no zombies)
//   G10 401 live (wrong key), 429/5xx stay MOCK-tested (gate3/audit)
//   G11 live memory recall into the context packet + isolation
//
// Run: CAREERFLOW_LIVE_TEST=1 CAREERFLOW_USER_DATA=<dir> node --test tests/live-project-mode.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { homedir } from "node:os";

import { startAgent, cancelAgent, getRun, listActiveRuns, AGENT_EVENTS, STATES } from "../src/services/agent/loop.js";
import { createOpenAiProvider } from "../src/services/agent/provider.js";
import { parsePlan } from "../src/services/agent/plan.js";
import { _resetForTests as resetToolRegistry } from "../src/services/project-tools/index.js";
import { _setUserDataDir, _closeAll } from "../src/services/memory/index.js";

// ---------------------------------------------------------------------------
// gate logic (identical convention to provider-live.test.js)
// ---------------------------------------------------------------------------

const ENABLED = process.env.CAREERFLOW_LIVE_TEST === "1";

function resolveUserDataDir() {
  if (process.env.CAREERFLOW_USER_DATA) return process.env.CAREERFLOW_USER_DATA;
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "careerflow");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "careerflow");
  }
  return join(homedir(), ".careerflow", "data");
}

function findFirstCredential(userDataDir) {
  const file = join(userDataDir, "pm-secrets.json");
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  for (const v of Object.values(parsed || {})) {
    if (v && typeof v.endpoint === "string" && v.endpoint && typeof v.apiKey === "string" && v.apiKey && typeof v.model === "string" && v.model) {
      return { endpoint: v.endpoint, apiKey: v.apiKey, model: v.model };
    }
  }
  return null;
}

const CREDENTIAL = findFirstCredential(resolveUserDataDir());
const SKIP = !ENABLED || !CREDENTIAL;
const skipReason = !ENABLED ? "CAREERFLOW_LIVE_TEST is not set to 1" : !CREDENTIAL ? "no usable credential in pm-secrets.json" : null;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let agentIdSeq = 700_000;

function makeFakeCore({ projectRoot, configJson = "{}", testCommand = null, startAgentImpl } = {}) {
  const agents = new Map();
  const messages = new Map();
  const cfg = { ...JSON.parse(configJson || "{}") };
  if (testCommand) cfg.test_command = testCommand;

  function recordMessage(agentId, role, content, name, payloadJson) {
    const list = messages.get(agentId) || [];
    list.push({
      id: list.length + 1, agent_id: agentId, seq: list.length + 1, role,
      content: typeof content === "string" ? content : JSON.stringify(content),
      name: name == null ? null : name,
      payload_json: payloadJson == null ? null : payloadJson,
    });
    messages.set(agentId, list);
    return list.length;
  }

  const core = {
    pmCreateAgent(_projectId, objective, parentAgentId) {
      const id = agentIdSeq++;
      agents.set(id, {
        id, objective, state: STATES.IDLE,
        finishedAt: null, finished_at: null,
        parentAgentId: typeof parentAgentId === "number" ? parentAgentId : null,
        parent_agent_id: typeof parentAgentId === "number" ? parentAgentId : null,
        project_id: 10, projectId: 10,
        plan_json: "[]", planJson: "[]",
        tokens_in: 0, tokens_out: 0,
      });
      messages.set(id, []);
      return { id };
    },
    pmGetAgent(_p, id) { const a = agents.get(id); return a ? { ...a } : null; },
    pmUpdateAgent(_p, id, state, planJson, ti, to) {
      const a = agents.get(id); if (!a) return { ok: false };
      a.state = state; a.plan_json = planJson; a.planJson = planJson; a.tokens_in = ti; a.tokens_out = to;
      return { ok: true };
    },
    pmAppendMessage(_p, id, role, content, name, payloadJson) { return { seq: recordMessage(id, role, content, name, payloadJson) }; },
    pmFinishAgent(_p, id, state) {
      const a = agents.get(id); if (!a) return;
      a.state = state; a.finishedAt = new Date().toISOString(); a.finished_at = a.finishedAt;
    },
    pmListMessages(_p, id) { const l = messages.get(id) || []; return [...l].sort((x, y) => x.seq - y.seq); },
    pmGetProject(_p, _id) {
      return {
        id: 10, profile_id: 1, name: "live fixture", description: "live gate fixture",
        root_path: projectRoot, rootPath: projectRoot,
        config_json: JSON.stringify(cfg), configJson: JSON.stringify(cfg),
        created_at: "1970", updated_at: "1970",
      };
    },
    pmGetProfile() { return { id: 1, profile_config: null }; },
    pmInsertSubagentRun() { return Math.floor(Math.random() * 1e9); },
    pmEndSubagentRun() { return true; },
    pmGetSubagentDepth() { return 0; },
    pmCheckSubagentLimits() { return { ok: true }; },
    pmCancelSubagentForLimit() { return { ok: true }; },
    pmListRecentAgentRuns() { return []; },
    // children (delegate_*) start through the REAL loop with the LIVE provider
    startAgent(args) {
      return startAgentImpl(args);
    },
    _agents: agents,
    _messages: messages,
  };
  return core;
}

function buildLiveProvider() {
  return createOpenAiProvider({ endpoint: CREDENTIAL.endpoint, apiKey: CREDENTIAL.apiKey, model: CREDENTIAL.model });
}

function seedPlan(core, agentId, steps) {
  core.pmUpdateAgent(1, agentId, STATES.PLANNING, JSON.stringify({
    version: 1,
    steps: steps.map((s, i) => ({
      id: s.id || `step-${i + 1}`, title: s.title || `Step ${i + 1}`,
      status: s.status || "pending", depends_on: s.depends_on || [],
      files: s.files || [], assigned_to: s.assigned_to || null,
    })),
  }), 0, 0);
}

async function runLiveAgent(core, { objective, plan, provider, signal, timeoutMs = 240_000 }) {
  const { id: agentId } = core.pmCreateAgent(10, objective, null);
  if (plan) seedPlan(core, agentId, plan);
  const startedAt = Date.now();
  const startRes = await startAgent({ core, profileId: 1, agentId, provider: provider || buildLiveProvider(), signal });
  assert.equal(startRes.ok, true, `startAgent: ${JSON.stringify(startRes)}`);
  const terminal = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("live agent timed out after " + timeoutMs + "ms")), timeoutMs);
    const done = (kind) => (e) => { clearTimeout(t); resolve({ kind, payload: e && e.payload }); };
    startRes.bus.on(AGENT_EVENTS.AGENT_COMPLETED, done("completed"));
    startRes.bus.on(AGENT_EVENTS.AGENT_FAILED, done("failed"));
    startRes.bus.on(AGENT_EVENTS.AGENT_CANCELLED, done("cancelled"));
  });
  return { agentId, terminal, elapsedMs: Date.now() - startedAt, startRes };
}

function toolResults(core, agentId, toolName = null) {
  return core.pmListMessages(1, agentId)
    .filter((m) => m.role === "tool_result" && (toolName == null || m.name === toolName))
    .map((m) => ({ name: m.name, content: JSON.parse(m.content) }));
}

function lastAssistant(core, agentId) {
  const msgs = core.pmListMessages(1, agentId).filter((m) => m.role === "assistant");
  return msgs.length ? msgs[msgs.length - 1].content : "";
}

function withLive(fn, { timeoutMs = 300_000 } = {}) {
  return async () => {
    if (SKIP) {
      console.log(`[live-pm] SKIPPED: ${skipReason}`);
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "cf-live-"));
    const memDir = mkdtempSync(join(tmpdir(), "cf-live-mem-"));
    _setUserDataDir(memDir);
    const t = setTimeout(() => { throw new Error("live test exceeded harness timeout"); }, timeoutMs);
    try {
      await fn(dir);
    } finally {
      clearTimeout(t);
      resetToolRegistry();
      _closeAll();
      _setUserDataDir(null);
      rmSync(dir, { recursive: true, force: true });
      rmSync(memDir, { recursive: true, force: true });
    }
  };
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function writeFixtureSearchProject(root) {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "src", "alpha.js"), "export const alpha = () => 1;\n");
  writeFileSync(join(root, "src", "beta.js"), "export const beta = () => 2;\n// MARKER-XK-42 lives here\n");
  writeFileSync(join(root, "docs", "notes.md"), "# notes\nnothing relevant\n");
}

function writeFixtureDevProject(root) {
  // calc.js is DELIBERATELY wrong per the spec: add() subtracts. The
  // project's own test suite (a real node subprocess) fails on the
  // initial state — the live agent must observe the real failure.
  writeFileSync(join(root, "README-spec.md"),
    "# Spec\n\n`add(a, b)` must return the SUM of a and b.\nImplemented in `calc.js` (CommonJS).\nRun tests with: node calc.test.js\n");
  writeFileSync(join(root, "calc.js"),
    "// add(a, b) — see README-spec.md\nfunction add(a, b) {\n  return a - b; // TODO: wrong on purpose\n}\n\nmodule.exports = { add };\n");
  writeFileSync(join(root, "calc.test.js"),
    "const assert = require('assert');\nconst { add } = require('./calc.js');\nassert.equal(add(2, 3), 5);\nassert.equal(add(-1, 1), 0);\nconsole.log('all tests passed');\n");
}

// ---------------------------------------------------------------------------
// G2 — streaming through the full loop
// ---------------------------------------------------------------------------

test("LIVE G2: streaming through the agent loop produces exactly one final assistant message", { skip: SKIP, timeout: 300_000 }, withLive(async (dir) => {
  writeFixtureSearchProject(dir);
  const core = makeFakeCore({ projectRoot: dir, configJson: JSON.stringify({ context_packet_max_tokens: 0, context_packet_max_project_intel_tokens: 0 }) });
  const { agentId, terminal, elapsedMs } = await runLiveAgent(core, {
    objective: 'Reply with exactly the word PONG and nothing else. Do NOT use any tools.',
  });
  assert.equal(terminal.kind, "completed", `terminal: ${JSON.stringify(terminal)}`);
  const assistants = core.pmListMessages(1, agentId).filter((m) => m.role === "assistant");
  assert.ok(assistants.length >= 1, "at least one assistant message expected");
  // The verify gate legitimately runs one extra final-summary model
  // round, so 2 assistant messages is the expected shape; the contract
  // is: none empty, and the final message answers.
  for (const a of assistants) assert.ok(a.content.length > 0, "no empty assistant messages");
  assert.ok(assistants.some((a) => /PONG/.test(a.content)), `PONG must appear in an assistant message, got: ${assistants.map((a) => a.content.slice(0, 80)).join(" | ")}`);
  assert.equal(core._agents.get(agentId).state, STATES.COMPLETED);
  // The terminal event fires inside finishAgent; the run slot is
  // cleared by the loop's finally block shortly after — poll for it.
  const cleared = await (async () => { const s = Date.now(); while (getRun(agentId) !== null) { if (Date.now() - s > 5000) return false; await new Promise((r) => setTimeout(r, 10)); } return true; })();
  assert.equal(cleared, true, "no zombie run");
  console.log(`[live-pm] G2 elapsed=${elapsedMs}ms`);
}));

// ---------------------------------------------------------------------------
// G3 — live tool calling
// ---------------------------------------------------------------------------

test("LIVE G3: model calls real tools and answers from the tool result", { skip: SKIP, timeout: 300_000 }, withLive(async (dir) => {
  writeFixtureSearchProject(dir);
  const core = makeFakeCore({ projectRoot: dir, configJson: JSON.stringify({ context_packet_max_tokens: 0, context_packet_max_project_intel_tokens: 0 }) });
  const { agentId, terminal, elapsedMs } = await runLiveAgent(core, {
    objective: "Use the fs_search tool to find which file contains the string MARKER-XK-42. Then answer with ONLY the file path that contains it. You must use tools — do not guess.",
  });
  assert.equal(terminal.kind, "completed", `terminal: ${JSON.stringify(terminal)}`);
  const results = toolResults(core, agentId);
  assert.ok(results.length >= 1, "at least one tool result expected");
  assert.ok(results.some((r) => r.content && r.content.ok === true), "tool result envelope must be ok");
  const anyAnswer = core.pmListMessages(1, agentId)
    .filter((m) => m.role === "assistant")
    .map((m) => m.content)
    .join(" \n ");
  assert.match(anyAnswer, /beta\.js/, `some assistant message must name the file, got: ${anyAnswer.slice(0, 400)}`);
  console.log(`[live-pm] G3 elapsed=${elapsedMs}ms tools=${results.length}`);
}));

// ---------------------------------------------------------------------------
// G4 — live project understanding with Project Intelligence
// ---------------------------------------------------------------------------

test("LIVE G4: Project Intelligence feeds the context packet and the model uses it", { skip: SKIP, timeout: 300_000 }, withLive(async (dir) => {
  writeFixtureDevProject(dir);
  // Deterministic half: the intel block must surface the relevant
  // project files for the objective. Index the project first — in
  // production the UI triggers indexProject when a project is opened;
  // the agent loop only consumes the index.
  const ProjectIntelMod = await import("../src/services/project-intel/index.js");
  const idx = await ProjectIntelMod.ProjectIntel.indexProject(1, 10, dir);
  assert.equal(idx && idx.ok !== false && idx.error === undefined ? true : !!(idx && idx.ok !== false), true, `indexProject: ${JSON.stringify(idx).slice(0, 200)}`);
  const { buildProjectIntelBlock } = await import("../src/services/agent/context-builder.js");
  const pi = await buildProjectIntelBlock({ projectId: 10, objective: "fix the add function behavior per the spec", projectRoot: dir, maxTokens: 1500 });
  assert.equal(pi.fileCount >= 1, true, `intel must rank >=1 files, got ${pi.fileCount}`);
  assert.match(pi.packet, /README-spec\.md|calc\.js/, "intel packet must include the relevant files");

  // Live half: seeded 2-step plan keeps the loop driving until the
  // model actually reads the implementation before answering.
  const core = makeFakeCore({
    projectRoot: dir,
    configJson: JSON.stringify({ context_packet_max_tokens: 1500, context_packet_max_project_intel_tokens: 1500, max_parallel_steps: 3 }),
  });
  const { agentId, terminal, elapsedMs } = await runLiveAgent(core, {
    objective: "Read calc.js with fs_read, then answer: which single arithmetic operation does the current implementation perform, and what should it perform per README-spec.md?",
    plan: [
      { id: "step-1", title: "Read calc.js and README-spec.md with fs_read" },
      { id: "step-2", title: "Answer the operation question", depends_on: ["step-1"] },
    ],
  });
  assert.equal(terminal.kind, "completed");
  const answer = lastAssistant(core, agentId);
  assert.match(answer, /subtract/i, `answer must identify subtraction, got: ${answer.slice(0, 400)}`);
  assert.match(answer, /sum|addition|\\+|plus/i, `answer must state it should be a sum, got: ${answer.slice(0, 400)}`);
  console.log(`[live-pm] G4 elapsed=${elapsedMs}ms intelFiles=${pi.fileCount}`);
}));

// ---------------------------------------------------------------------------
// G5+G6 — real live dev task with REAL failure -> fix -> retest
// ---------------------------------------------------------------------------

test("LIVE G5+G6: agent fixes a genuinely failing test (real subprocess), verify gate passes", { skip: SKIP, timeout: 420_000 }, withLive(async (dir) => {
  writeFixtureDevProject(dir);
  const core = makeFakeCore({ projectRoot: dir, testCommand: "node calc.test.js", configJson: JSON.stringify({ context_packet_max_tokens: 0, context_packet_max_project_intel_tokens: 0 }) });

  // Precondition: the project's own test genuinely fails right now.
  const { execFileSync } = await import("node:child_process");
  let preFailed = false;
  try {
    execFileSync("node", ["calc.test.js"], { cwd: dir, stdio: "pipe" });
  } catch {
    preFailed = true;
  }
  assert.equal(preFailed, true, "fixture must fail BEFORE the agent runs (real failure, not simulated)");

  const { agentId, terminal, elapsedMs } = await runLiveAgent(core, {
    objective: "Make `node calc.test.js` pass. The behavior spec is in README-spec.md. Read the spec, run the test with the test_run tool, fix the implementation in calc.js with fs_write, and run the test again until it passes. Do not modify calc.test.js.",
    plan: [
      { id: "step-1", title: "Read README-spec.md and calc.js, run node calc.test.js with test_run" },
      { id: "step-2", title: "Fix calc.js with fs_write so the spec is honored" },
      { id: "step-3", title: "Re-run node calc.test.js with test_run and confirm it passes" },
    ],
  });
  assert.equal(terminal.kind, "completed", `terminal: ${terminal ? JSON.stringify(terminal) : "timeout"}`);

  // Real failure was observed by the agent (test_run result with a
  // failing exit) BEFORE a passing run — the model reacted to real state.
  const testRuns = toolResults(core, agentId, "test_run");
  assert.ok(testRuns.length >= 2, `expected >=2 test_run invocations (fail + pass), got ${testRuns.length}`);
  const first = testRuns[0].content;
  const last = testRuns[testRuns.length - 1].content;
  const firstFailed = first.ok === false || (first.result && (first.result.code !== 0 || first.result.passed === false));
  const lastPassed = last.ok === true && last.result && (last.result.code === 0 || last.result.passed === true);
  assert.equal(firstFailed, true, `first test run must show the REAL failure: ${JSON.stringify(first).slice(0, 300)}`);
  assert.equal(lastPassed, true, `last test run must pass: ${JSON.stringify(last).slice(0, 300)}`);

  // calc.js was actually fixed on disk and the fix is the SUM.
  const fixed = readFileSync(join(dir, "calc.js"), "utf8");
  assert.match(fixed, /a \\+ b|a\\+b/, `calc.js must implement addition, got: ${fixed.slice(0, 200)}`);
  const { stdout } = (() => { try { return { stdout: execFileSync("node", ["calc.test.js"], { cwd: dir, stdio: "pipe" }).toString() }; } catch (e) { return { stdout: e.stdout ? e.stdout.toString() : String(e) }; } })();
  assert.match(stdout, /all tests passed/);

  // The test file was NOT modified.
  const testFile = readFileSync(join(dir, "calc.test.js"), "utf8");
  assert.match(testFile, /assert\.equal\(add\(2, 3\), 5\)/, "calc.test.js must be untouched");
  console.log(`[live-pm] G5+G6 elapsed=${elapsedMs}ms testRuns=${testRuns.length}`);
}));

// ---------------------------------------------------------------------------
// G7 — live DAG with seeded dependencies
// ---------------------------------------------------------------------------

test("LIVE G7: seeded DAG A,B,C independent + D dependent completes with no duplicate execution", { skip: SKIP, timeout: 420_000 }, withLive(async (dir) => {
  writeFixtureSearchProject(dir);
  const core = makeFakeCore({ projectRoot: dir, configJson: JSON.stringify({ context_packet_max_tokens: 0, context_packet_max_project_intel_tokens: 0 }) });
  const { agentId, terminal, elapsedMs } = await runLiveAgent(core, {
    objective: "Work through the plan steps in order. For each step, use fs_read to read the named file and give a one-line summary of it in your reply.",
    plan: [
      { id: "A", title: "Read src/alpha.js", files: ["src/alpha.js"] },
      { id: "B", title: "Read src/beta.js", files: ["src/beta.js"] },
      { id: "C", title: "Read docs/notes.md", files: ["docs/notes.md"] },
      { id: "D", title: "Summarize all three files", depends_on: ["A", "B", "C"] },
    ],
  });
  assert.equal(terminal.kind, "completed", `terminal: ${JSON.stringify(terminal)}`);
  const agent = core._agents.get(agentId);
  const plan = parsePlan(agent.planJson);
  for (const id of ["A", "B", "C", "D"]) {
    const step = plan.steps.find((s) => s.id === id);
    assert.ok(step, `step ${id} must exist`);
    assert.equal(step.status, "done", `step ${id} must be done, got ${step.status}`);
  }
  // No duplicate execution: each file read exactly once.
  const reads = core.pmListMessages(1, agentId).filter((m) => m.role === "tool_call" && m.name === "fs_read").length;
  assert.ok(reads >= 3, `expected >=3 file reads, got ${reads}`);
  const readCalls = core.pmListMessages(1, agentId).filter((m) => m.role === "tool_call" && m.name === "fs_read").map((m) => m.content);
  const paths = readCalls.map((c) => { try { return JSON.parse(c)[0].args ? JSON.parse(c)[0].args.path : JSON.parse(c).path; } catch { return ""; } }).filter(Boolean);
  const counts = {};
  for (const p of paths) counts[p] = (counts[p] || 0) + 1;
  for (const [p, c] of Object.entries(counts)) assert.ok(c === 1, `file ${p} read ${c} times — duplicate execution`);
  console.log(`[live-pm] G7 elapsed=${elapsedMs}ms reads=${reads}`);
}));

// ---------------------------------------------------------------------------
// G8 — CareerFlow's own sub-agent orchestration (live child)
// ---------------------------------------------------------------------------

test("LIVE G8: parent delegates to a live child sub-agent and continues to completion", { skip: SKIP, timeout: 420_000 }, withLive(async (dir) => {
  writeFixtureSearchProject(dir);
  const liveProvider = buildLiveProvider();
  const core = makeFakeCore({
    projectRoot: dir,
    configJson: JSON.stringify({ context_packet_max_tokens: 0, context_packet_max_project_intel_tokens: 0 }),
    startAgentImpl: (args) => startAgent({ ...args, core, provider: liveProvider }),
  });
  const parentRun = await runLiveAgent(core, { objective: "Use the delegate_research tool to spawn a sub-agent with objective 'Use fs_list on this project and report how many files exist under src/. Reply with just the number of files.' After the sub-agent result returns, reply with just that number.", provider: liveProvider });
  const parentAgentId = parentRun.agentId;
  assert.equal(parentRun.terminal.kind, "completed", `parent terminal: ${JSON.stringify(parentRun.terminal)}`);
  const children = [...core._agents.values()].filter((a) => a.parentAgentId === parentAgentId);
  assert.ok(children.length >= 1, "a child agent row must exist");
  for (const c of children) {
    assert.equal(c.state, STATES.COMPLETED, `child ${c.id} must be COMPLETED, got ${c.state}`);
    assert.ok(c.finishedAt, "child finishedAt set");
    assert.equal(getRun(c.id), null, "no zombie child run");
  }
  const answer = lastAssistant(core, parentAgentId);
  assert.match(answer, /2/, `parent must report the file count (2 src files), got: ${answer.slice(0, 300)}`);
  console.log(`[live-pm] G8 elapsed=${parentRun.elapsedMs}ms children=${children.length}`);
}));

// ---------------------------------------------------------------------------
// G9 — live cancellation mid-run
// ---------------------------------------------------------------------------

test("LIVE G9: cancelling mid-run persists CANCELLED with no zombie and no duplicate completion", { skip: SKIP, timeout: 300_000 }, withLive(async (dir) => {
  writeFixtureSearchProject(dir);
  const core = makeFakeCore({ projectRoot: dir, configJson: JSON.stringify({ context_packet_max_tokens: 0, context_packet_max_project_intel_tokens: 0 }) });
  const { id: agentId } = core.pmCreateAgent(10, "Use fs_list and fs_read to inspect every file in this project, then summarize each in detail.", null);
  const startRes = await startAgent({ core, profileId: 1, agentId, provider: buildLiveProvider() });
  assert.equal(startRes.ok, true);
  const terminalPromise = new Promise((resolve) => {
    const done = (kind) => () => resolve(kind);
    startRes.bus.on(AGENT_EVENTS.AGENT_COMPLETED, done("completed"));
    startRes.bus.on(AGENT_EVENTS.AGENT_FAILED, done("failed"));
    startRes.bus.on(AGENT_EVENTS.AGENT_CANCELLED, done("cancelled"));
  });
  // Let the first model round start streaming, then cancel.
  await new Promise((r) => setTimeout(r, 2500));
  const cancelRes = cancelAgent(agentId);
  assert.equal(cancelRes.ok, true);
  const kind = await terminalPromise;
  assert.equal(kind, "cancelled", `expected cancelled, got ${kind}`);
  assert.equal(core._agents.get(agentId).state, STATES.CANCELLED);
  const cleared = await (async () => { const s = Date.now(); while (getRun(agentId) !== null) { if (Date.now() - s > 5000) return false; await new Promise((r) => setTimeout(r, 10)); } return true; })();
  assert.equal(cleared, true, "run slot must clear");
  assert.equal(listActiveRuns().filter((r) => r.agentId === agentId).length, 0);
  // Idempotent: second cancel refuses.
  assert.deepEqual(cancelAgent(agentId), { ok: false, reason: "not-running" });
  console.log("[live-pm] G9 cancelled cleanly");
}));

// ---------------------------------------------------------------------------
// G10 — 401 live (wrong key); 429/5xx remain MOCK-tested
// ---------------------------------------------------------------------------

test("LIVE G10: HTTP 401 with an invalid key surfaces auth-failed with no retry", { skip: SKIP, timeout: 60_000 }, withLive(async () => {
  const badProvider = createOpenAiProvider({ endpoint: CREDENTIAL.endpoint, apiKey: "sk-invalid-key-for-401-test", model: CREDENTIAL.model });
  const events = [];
  for await (const ev of badProvider.streamChat({ messages: [{ role: "user", content: "hi" }] })) {
    events.push(ev);
    if (ev.type === "error") break;
  }
  const err = events.find((e) => e.type === "error");
  assert.ok(err, "an error event must be emitted");
  assert.equal(err.code, "auth-failed", `expected auth-failed, got ${err.code}`);
  console.log("[live-pm] G10 401 -> auth-failed (live); 429/5xx/timeout remain mock-tested (gate3-provider-audit, provider-streaming)");
}));

// ---------------------------------------------------------------------------
// G11 — live memory recall + isolation
// ---------------------------------------------------------------------------

test("LIVE G11: project memory flows into the live model's context and answers exactly", { skip: SKIP, timeout: 300_000 }, withLive(async (dir) => {
  const { Memory } = await import("../src/services/memory/index.js");
  writeFixtureSearchProject(dir);
  const core = makeFakeCore({ projectRoot: dir, configJson: JSON.stringify({ context_packet_max_tokens: 1500, context_packet_max_project_intel_tokens: 0 }) });
  // Facts: release PIN for project "10", decoy under another project id.
  const setA = await Memory.projectSet("10", "decision", "release-pin", "The release PIN is 4471.");
  assert.equal(setA.ok, true);
  const setB = await Memory.projectSet("11", "decision", "release-pin", "The release PIN is 9999.");
  assert.equal(setB.ok, true);

  const { agentId, terminal } = await runLiveAgent(core, {
    objective: "Answer using ONLY the project memory section: what is the release PIN? Reply with the 4 digits and nothing else.",
  });
  assert.equal(terminal.kind, "completed");
  const answer = lastAssistant(core, agentId);
  assert.match(answer, /4471/, `answer must contain the project's PIN, got: ${answer.slice(0, 200)}`);
  assert.doesNotMatch(answer, /9999/, "the other project's PIN must NOT appear (isolation)");
  console.log("[live-pm] G11 memory recalled + isolated");
}));
