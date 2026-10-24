// Project Mode — LIVE production-stack acceptance (Phase 12).
//
// Env-gated exactly like provider-live.test.js / live-project-mode.test.js:
//   CAREERFLOW_LIVE_TEST=1  CAREERFLOW_USER_DATA=<dir with pm-secrets.json>
//
// DIFFERENCE from live-project-mode.test.js: that file runs the real
// loop against the IN-MEMORY fake core. This file drives the REAL
// production persistence stack — the compiled Rust/NAPI core via
// initDb() on a temp SQLite file, real profiles/projects/agents rows
// (pmCreateProject / pmCreateAgent / pmGetAgent / pmListMessages) — so
// the acceptance exercises the ACTUAL Project Mode path end to end:
//
//   TEST A  inspect + explain the architecture (read-only; nothing modified)
//   TEST B  small safe improvement: real failing test -> fix -> pass
//   TEST C  multi-step search -> read -> modify -> test
//
// The live provider is built from the stored credential (exactly what
// the production resolveDefaultProvider does in Electron; here it is
// passed explicitly because plain Node cannot resolve the Electron
// userData path). The apiKey is NEVER logged or asserted.
//
// The provider enforces ~429 rate limits; tests are spaced out and the
// count is kept minimal (3 live runs).
//
// Run: CAREERFLOW_LIVE_TEST=1 CAREERFLOW_USER_DATA=<dir> node --test tests/live-production-stack.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { homedir } from "node:os";

import { startAgent, cancelAgent, getRun, AGENT_EVENTS, STATES } from "../src/services/agent/loop.js";
import { createOpenAiProvider } from "../src/services/agent/provider.js";
import { _resetForTests as resetToolRegistry } from "../src/services/project-tools/index.js";
import { _setUserDataDir, _closeAll } from "../src/services/memory/index.js";

const require = createRequire(import.meta.url);
const core = require("@careerflow/core"); // the REAL compiled NAPI core

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
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "careerflow");
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
// shared production-stack setup — ONE real SQLite DB for the whole file
// ---------------------------------------------------------------------------

let dbDir = null;
let profileId = null;
let liveProvider = null;
let projectSeq = 0;

async function setupOnce() {
  dbDir = mkdtempSync(join(tmpdir(), "cf-live-prod-"));
  core.initDb(join(dbDir, "careerflow-live.db"));
  const prof = core.addProfile("live-prod-acceptance", "live-prod-acceptance");
  profileId = prof.id;
  liveProvider = createOpenAiProvider({ endpoint: CREDENTIAL.endpoint, apiKey: CREDENTIAL.apiKey, model: CREDENTIAL.model });
  // Memory service writes its own SQLite under the userData dir.
  const memDir = mkdtempSync(join(tmpdir(), "cf-live-prod-mem-"));
  _setUserDataDir(memDir);
}

function teardownOnce() {
  try { _closeAll(); } catch { /* best effort */ }
  try { _setUserDataDir(null); } catch { /* best effort */ }
  try { resetToolRegistry(); } catch { /* best effort */ }
  // Windows may hold the SQLite file open; force is best-effort.
  try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* leave temp dir */ }
}

/**
 * Create a project + agent row in the REAL DB and run the loop to a
 * terminal state. Mirrors the production IPC wiring (provider resolved
 * from the credential store; children started via the startSubAgent
 * bridge because the NAPI core object has no startAgent method).
 */
async function runProductionAgent({ rootPath, configJson, objective, plan }) {
  projectSeq += 1;
  const projectId = core.pmCreateProject(
    profileId,
    `live-prod-${projectSeq}`,
    "Phase 12 production-stack acceptance fixture",
    rootPath,
    JSON.stringify(configJson),
  );
  assert.equal(typeof projectId, "number", "pmCreateProject must return a row id");
  const agentId = core.pmCreateAgent(projectId, objective, null);
  assert.equal(typeof agentId, "number", "pmCreateAgent must return a row id");

  if (plan) {
    core.pmUpdateAgent(profileId, agentId, STATES.PLANNING, JSON.stringify({
      version: 1,
      steps: plan.map((s, i) => ({
        id: s.id || `step-${i + 1}`,
        title: s.title || `Step ${i + 1}`,
        status: "pending",
        depends_on: s.depends_on || [],
        files: s.files || [],
        assigned_to: null,
      })),
    }), 0, 0);
  }

  const startRes = await startAgent({
    core,
    profileId,
    agentId,
    provider: liveProvider,
    startSubAgent: (childArgs) => startAgent({ ...childArgs, core, provider: liveProvider }),
  });
  assert.equal(startRes.ok, true, `startAgent: ${JSON.stringify(startRes)}`);
  const startedAt = Date.now();
  const terminal = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("live production agent timed out")), 420_000);
    const done = (kind) => (e) => { clearTimeout(t); resolve({ kind, payload: e && e.payload }); };
    startRes.bus.on(AGENT_EVENTS.AGENT_COMPLETED, done("completed"));
    startRes.bus.on(AGENT_EVENTS.AGENT_FAILED, done("failed"));
    startRes.bus.on(AGENT_EVENTS.AGENT_CANCELLED, done("cancelled"));
  });
  // run slot cleared by the loop's finally after the terminal event
  const s = Date.now();
  while (getRun(agentId) !== null && Date.now() - s < 5000) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return { projectId, agentId, terminal, elapsedMs: Date.now() - startedAt };
}

function messages(agentId) {
  return core.pmListMessages(profileId, agentId);
}

function toolResults(agentId, toolName = null) {
  return messages(agentId)
    .filter((m) => m.role === "tool_result" && (toolName == null || m.name === toolName))
    .map((m) => ({ name: m.name, content: JSON.parse(m.content) }));
}

function lastAssistant(agentId) {
  const list = messages(agentId).filter((m) => m.role === "assistant");
  return list.length ? list[list.length - 1].content : "";
}

function hashOf(file) {
  return readFileSync(file, "utf8");
}

function withLive(fn, { timeoutMs = 480_000 } = {}) {
  return async () => {
    if (SKIP) {
      console.log(`[live-prod] SKIPPED: ${skipReason}`);
      return;
    }
    if (!dbDir) await setupOnce();
    const t = setTimeout(() => { throw new Error("live test exceeded harness timeout"); }, timeoutMs);
    try {
      await fn();
    } finally {
      clearTimeout(t);
    }
  };
}

// File-wide ordering: node:test runs tests in declaration order; space
// the live runs out so the provider's rate limits recover. b.ai also
// emits empty-body HTTP 400s under rapid successive load (observed in
// run 4 after a clean prior round of the same shape), and delegation
// bursts (parent + children) consume the per-window quota quickly, so
// generous spacing is part of the harness, not the provider contract.
const SPACING_MS = 75_000;
async function spaceOut() {
  await new Promise((r) => setTimeout(r, SPACING_MS));
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function writeFixtureArchitecture(root) {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# tiny-cli\nA tiny CLI that greets users. Entry point is src/main.js; greeting logic lives in lib/greet.js.\n");
  writeFileSync(join(root, "src", "main.js"), "const { greet } = require('../lib/greet.js');\nconst name = process.argv[2] || 'world';\nconsole.log(greet(name));\n");
  writeFileSync(join(root, "lib", "greet.js"), "function greet(name) {\n  return `Hello, ${name}!`;\n}\n\nmodule.exports = { greet };\n");
}

function writeFixtureDevTask(root) {
  // calc.js is wrong on purpose: subtract instead of add. The project's
  // own test fails on the initial state (real failure, not simulated).
  writeFileSync(join(root, "README-spec.md"), "# Spec\n\n`add(a, b)` must return the SUM of a and b.\nImplemented in `calc.js` (CommonJS).\nRun tests with: node calc.test.js\n");
  writeFileSync(join(root, "calc.js"), "// add(a, b) — see README-spec.md\nfunction add(a, b) {\n  return a - b; // TODO: wrong on purpose\n}\n\nmodule.exports = { add };\n");
  writeFileSync(join(root, "calc.test.js"), "const assert = require('assert');\nconst { add } = require('./calc.js');\nassert.equal(add(2, 3), 5);\nassert.equal(add(-1, 1), 0);\nconsole.log('all tests passed');\n");
}

function writeFixtureMultiStep(root) {
  // src/format.js is missing the slugify function that index.test.js
  // expects. The agent must search for SLUGIFY-MARKER, read the
  // referencing files, implement slugify, and run the test.
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "index.test.js"), "const assert = require('assert');\nconst { slugify } = require('./src/format.js');\nassert.equal(slugify('Hello World'), 'hello-world'); // SLUGIFY-MARKER\nassert.equal(slugify('A  B--c'), 'a-b-c');\nconsole.log('slugify tests passed');\n");
  writeFileSync(join(root, "src", "format.js"), "// text formatting helpers\nfunction titleCase(s) {\n  return s.replace(/\\w\\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());\n}\n\nmodule.exports = { titleCase };\n");
  writeFileSync(join(root, "README.md"), "# format-lib\nRun tests with: node index.test.js\n");
}

// ---------------------------------------------------------------------------
// TEST A — inspect + explain the architecture (read-only)
// ---------------------------------------------------------------------------

test("LIVE TEST A: inspect the project and explain the architecture (no modifications)", { skip: SKIP, timeout: 480_000 }, withLive(async () => {
  spaceOut();
  const root = mkdtempSync(join(tmpdir(), "cf-live-prod-a-"));
  writeFixtureArchitecture(root);
  const before = { main: hashOf(join(root, "src", "main.js")), greet: hashOf(join(root, "lib", "greet.js")) };
  try {
    // Seeded plan: without one, the loop verifies right after the first
    // tool round and the model never gets to answer (plan-driven loop).
    const { agentId, terminal, elapsedMs } = await runProductionAgent({
      rootPath: root,
      configJson: { context_packet_max_tokens: 0, context_packet_max_project_intel_tokens: 0 },
      objective: "Inspect this project and explain its architecture: the entry point, the library it depends on, and how data flows. Do NOT modify any files. Reply with a short architecture summary.",
      plan: [
        { id: "step-1", title: "Use fs_list / fs_read to inspect README.md, src/main.js and lib/greet.js" },
        { id: "step-2", title: "Write the architecture summary as your final answer (entry point, greet library, data flow)" },
      ],
    });
    assert.equal(terminal.kind, "completed", `terminal: ${JSON.stringify(terminal)}`);

    // Read path went through the real tool registry (any inspection tool).
    const inspections = ["fs_read", "fs_list", "inspect_project"].flatMap((t) => toolResults(agentId, t));
    assert.ok(inspections.length >= 1, "agent must have inspected the project with tools");
    assert.ok(inspections.some((r) => r.content && r.content.ok === true), "at least one ok inspection envelope");

    // The explanation names the real modules (in ANY assistant message).
    const allAssistant = messages(agentId).filter((m) => m.role === "assistant").map((m) => m.content).join("\n");
    assert.match(allAssistant, /main\.js/i, `summary must name the entry point, got: ${allAssistant.slice(0, 400)}`);
    assert.match(allAssistant, /greet/i, `summary must mention the greet library, got: ${allAssistant.slice(0, 400)}`);

    // NOTHING was modified.
    assert.equal(hashOf(join(root, "src", "main.js")), before.main, "src/main.js must be untouched");
    assert.equal(hashOf(join(root, "lib", "greet.js")), before.greet, "lib/greet.js must be untouched");
    assert.equal(toolResults(agentId, "fs_write").length, 0, "no fs_write calls in an inspect-only objective");

    // Persistence integrity on the REAL DB: terminal state + tokens.
    const row = core.pmGetAgent(profileId, agentId);
    assert.equal(row.state, STATES.COMPLETED);
    assert.ok(core.pmListRecentAgentRuns(profileId, 10).some((h) => h.id === agentId), "run appears in pmListRecentAgentRuns");
    console.log(`[live-prod] TEST A elapsed=${elapsedMs}ms`);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}));

// ---------------------------------------------------------------------------
// TEST B — small safe improvement: real failing test -> fix -> pass
// ---------------------------------------------------------------------------

test("LIVE TEST B: agent makes a small safe improvement — real failing test fixed and passing", { skip: SKIP, timeout: 480_000 }, withLive(async () => {
  spaceOut();
  const root = mkdtempSync(join(tmpdir(), "cf-live-prod-b-"));
  writeFixtureDevTask(root);
  const { execFileSync } = await import("node:child_process");
  let preFailed = false;
  try {
    execFileSync("node", ["calc.test.js"], { cwd: root, stdio: "pipe" });
  } catch {
    preFailed = true;
  }
  assert.equal(preFailed, true, "fixture must fail BEFORE the agent runs");

  try {
    const { agentId, terminal, elapsedMs } = await runProductionAgent({
      rootPath: root,
      configJson: { context_packet_max_tokens: 0, context_packet_max_project_intel_tokens: 0, test_command: "node calc.test.js" },
      objective: "Make `node calc.test.js` pass. The behavior spec is in README-spec.md. Read the spec, run the test with test_run, fix calc.js with fs_write, and run the test again until it passes. Do not modify calc.test.js.",
      plan: [
        { id: "step-1", title: "Read README-spec.md and calc.js, run node calc.test.js with test_run" },
        { id: "step-2", title: "Fix calc.js with fs_write so the spec is honored" },
        { id: "step-3", title: "Re-run node calc.test.js with test_run and confirm it passes" },
      ],
    });
    assert.equal(terminal.kind, "completed", `terminal: ${JSON.stringify(terminal)}`);

    // The agent edited the file; verification happened either through a
    // model-initiated test_run (fail → pass) or through the verify gate
    // itself (status 'verified' runs the real test_command subprocess).
    const runs = toolResults(agentId, "test_run");
    const writes = toolResults(agentId, "fs_write");
    assert.ok(writes.length >= 1, `agent must edit calc.js with fs_write, got tools: ${JSON.stringify(toolResults(agentId).map((r) => r.name))}`);
    if (runs.length >= 2) {
      const first = runs[0].content;
      const last = runs[runs.length - 1].content;
      assert.equal(first.ok === false || (first.result && (first.result.code !== 0 || first.result.passed === false)), true, "first model test_run shows the real failure");
      assert.equal(last.ok === true && last.result && (last.result.code === 0 || last.result.passed === true), true, `last model test_run passes: ${JSON.stringify(last).slice(0, 300)}`);
    } else {
      const statuses = messages(agentId).filter((m) => m.role === "status").map((m) => m.name);
      assert.ok(statuses.includes("verified"), `gate-mediated verification required when the model skips test_run, statuses: ${statuses.join(",")}`);
    }

    // The fix is on disk and is the SUM; the test file is untouched.
    const fixed = readFileSync(join(root, "calc.js"), "utf8");
    assert.match(fixed, /a \+ b|a\+b/, `calc.js must implement addition, got: ${fixed.slice(0, 200)}`);
    assert.match(readFileSync(join(root, "calc.test.js"), "utf8"), /assert\.equal\(add\(2, 3\), 5\)/, "calc.test.js untouched");
    const { stdout } = (() => { try { return { stdout: execFileSync("node", ["calc.test.js"], { cwd: root, stdio: "pipe" }).toString() }; } catch (e) { return { stdout: e.stdout ? e.stdout.toString() : String(e) }; } })();
    assert.match(stdout, /all tests passed/);

    // Persisted plan progress on the real DB. Steps are terminal (the
    // loop marks a step "failed" when ANY tool call in its batch failed,
    // even if the batch also contained the calls that did the work) —
    // the disk checks above are the authoritative outcome proof.
    const row = core.pmGetAgent(profileId, agentId);
    assert.equal(row.state, STATES.COMPLETED);
    const plan = JSON.parse(row.planJson);
    assert.ok(plan.steps.length >= 1, "plan persisted");
    for (const st of plan.steps) {
      assert.ok(["done", "failed"].includes(st.status), `step ${st.id} terminal, got ${st.status}`);
    }
    console.log(`[live-prod] TEST B elapsed=${elapsedMs}ms testRuns=${runs.length} writes=${writes.length}`);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}));

// ---------------------------------------------------------------------------
// TEST C — multi-step search -> read -> modify -> test
// ---------------------------------------------------------------------------

test("LIVE TEST C: multi-step task — search, read, implement the missing function, test passes", { skip: SKIP, timeout: 480_000 }, withLive(async () => {
  spaceOut();
  const root = mkdtempSync(join(tmpdir(), "cf-live-prod-c-"));
  writeFixtureMultiStep(root);
  const { execFileSync } = await import("node:child_process");
  let preFailed = false;
  try {
    execFileSync("node", ["index.test.js"], { cwd: root, stdio: "pipe" });
  } catch {
    preFailed = true;
  }
  assert.equal(preFailed, true, "fixture must fail BEFORE the agent runs");

  try {
    const { agentId, terminal, elapsedMs } = await runProductionAgent({
      rootPath: root,
      configJson: { context_packet_max_tokens: 0, context_packet_max_project_intel_tokens: 0, test_command: "node index.test.js" },
      objective: "The test suite (index.test.js) fails because src/format.js is missing a function. Use fs_search to find the marker string SLUGIFY-MARKER, read the relevant files, implement what is missing in src/format.js with fs_write, and make `node index.test.js` pass using test_run. Do not modify index.test.js.",
      plan: [
        { id: "step-1", title: "Search for SLUGIFY-MARKER with fs_search and read the failing test with fs_read" },
        { id: "step-2", title: "Implement slugify in src/format.js with fs_write" },
        { id: "step-3", title: "Run node index.test.js with test_run until it passes" },
      ],
    });
    assert.equal(terminal.kind, "completed", `terminal: ${JSON.stringify(terminal)}`);

    const searches = toolResults(agentId, "fs_search");
    assert.ok(searches.length >= 1, "agent used fs_search");
    const writes = toolResults(agentId, "fs_write");
    assert.ok(writes.length >= 1, "agent used fs_write");
    const runs = toolResults(agentId, "test_run");
    if (runs.length >= 1) {
      const last = runs[runs.length - 1].content;
      assert.equal(last.ok === true && last.result && (last.result.code === 0 || last.result.passed === true), true, `last model test_run passes: ${JSON.stringify(last).slice(0, 300)}`);
    } else {
      const statuses = messages(agentId).filter((m) => m.role === "status").map((m) => m.name);
      assert.ok(statuses.includes("verified"), `gate-mediated verification required when the model skips test_run, statuses: ${statuses.join(",")}`);
    }

    const fmt = readFileSync(join(root, "src", "format.js"), "utf8");
    assert.match(fmt, /slugify/i, "slugify implemented in src/format.js");
    assert.doesNotMatch(readFileSync(join(root, "index.test.js"), "utf8"), /module\.exports/, "index.test.js untouched");
    const { stdout } = (() => { try { return { stdout: execFileSync("node", ["index.test.js"], { cwd: root, stdio: "pipe" }).toString() }; } catch (e) { return { stdout: e.stdout ? e.stdout.toString() : String(e) }; } })();
    assert.match(stdout, /slugify tests passed/);

    const row = core.pmGetAgent(profileId, agentId);
    assert.equal(row.state, STATES.COMPLETED);
    assert.ok(core.pmGetChildren(profileId, agentId).length === 0, "no unexpected children");
    console.log(`[live-prod] TEST C elapsed=${elapsedMs}ms search=${searches.length} write=${writes.length} testRuns=${runs.length}`);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}));

// ---------------------------------------------------------------------------
// LIVE-1 — parent -> delegate_research -> child tools -> child result ->
//          parent final (all state verified in the REAL SQLite store)
// ---------------------------------------------------------------------------

function writeFixtureDelegate(root) {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "src", "release.js"), "export const RELEASE_MARKER = 'ORBIT-7741';\n");
  writeFileSync(join(root, "docs", "notes.md"), "# notes\nnothing relevant here\n");
}

test("LIVE-1: parent delegates to a real child agent; child uses tools; result reaches parent (real SQLite)", { skip: SKIP, timeout: 480_000 }, withLive(async () => {
  spaceOut();
  const root = mkdtempSync(join(tmpdir(), "cf-live-prod-d1-"));
  writeFixtureDelegate(root);
  try {
    const { agentId, terminal, elapsedMs } = await runProductionAgent({
      rootPath: root,
      configJson: { context_packet_max_tokens: 0, context_packet_max_project_intel_tokens: 0 },
      objective: "Use the delegate_research tool to spawn a researcher with objective 'Use fs_read to read src/release.js and report the exact value of RELEASE_MARKER. Reply with only the marker value.' for step 'step-1'. After the sub-agent returns, reply with the marker value it reported and nothing else.",
      plan: [
        { id: "step-1", title: "Delegate research: read src/release.js and report RELEASE_MARKER" },
        { id: "step-2", title: "Report the marker value from the researcher's result" },
      ],
    });
    assert.equal(terminal.kind, "completed", `terminal: ${JSON.stringify(terminal)}`);

    // REAL SQLite: the child row exists, is linked, ran tools, completed.
    const children = core.pmGetChildren(profileId, agentId);
    assert.ok(children.length >= 1, `child rows persisted: ${children.length}`);
    const child = children[0];
    assert.equal(child.parentAgentId, agentId, "parentAgentId persisted correctly");
    assert.equal(child.state, STATES.COMPLETED, `child persisted state: ${child.state}`);
    const childTools = messages(child.id)
      .filter((m) => m.role === "tool_result")
      .map((m) => ({ name: m.name, content: JSON.parse(m.content) }));
    assert.ok(childTools.some((t) => t.content && t.content.ok === true), "child used tools successfully");

    // The child result reached the parent through the persisted transcript.
    const delegateResults = toolResults(agentId, "delegate_research");
    assert.ok(delegateResults.length >= 1, "delegate_research tool result persisted for the parent");
    const dr = delegateResults[delegateResults.length - 1].content;
    assert.equal(dr.ok, true, `delegate envelope ok: ${JSON.stringify(dr).slice(0, 200)}`);
    assert.equal(dr.result.child_agent_id, child.id, "child id matches the persisted row");
    assert.equal(dr.result.state, STATES.COMPLETED);

    // The parent's final answer incorporates the child's finding.
    const allAssistant = messages(agentId).filter((m) => m.role === "assistant").map((m) => m.content).join("\n");
    assert.match(allAssistant, /ORBIT-7741/, `parent final must carry the child's finding, got: ${allAssistant.slice(0, 300)}`);

    // No orphans.
    const s = Date.now();
    while (getRun(child.id) !== null && Date.now() - s < 5000) await new Promise((r) => setTimeout(r, 10));
    assert.equal(getRun(child.id), null, "no zombie child run");
    console.log(`[live-prod] LIVE-1 elapsed=${elapsedMs}ms childId=${child.id} childTools=${childTools.length}`);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}));

// ---------------------------------------------------------------------------
// LIVE-2 — three children from one parent (controlled stress)
// ---------------------------------------------------------------------------

function writeFixtureThreeParts(root) {
  mkdirSync(join(root, "parts"), { recursive: true });
  writeFileSync(join(root, "parts", "alpha.txt"), "ALPHA-CODE-11\n");
  writeFileSync(join(root, "parts", "beta.txt"), "BETA-CODE-22\n");
  writeFileSync(join(root, "parts", "gamma.txt"), "GAMMA-CODE-33\n");
}

test("LIVE-2: one parent spawns three children; unique identities, correct results, no cross-contamination", { skip: SKIP, timeout: 600_000 }, withLive(async () => {
  spaceOut();
  const root = mkdtempSync(join(tmpdir(), "cf-live-prod-d2-"));
  writeFixtureThreeParts(root);
  try {
    const { agentId, terminal, elapsedMs } = await runProductionAgent({
      rootPath: root,
      configJson: { context_packet_max_tokens: 0, context_packet_max_project_intel_tokens: 0 },
      objective: "Investigate three independent parts of this project. Use delegate_research exactly three times for step 'step-1': (1) objective 'Use fs_read to read parts/alpha.txt and report the exact code it contains.', (2) objective 'Use fs_read to read parts/beta.txt and report the exact code it contains.', (3) objective 'Use fs_read to read parts/gamma.txt and report the exact code it contains.' After all three return, reply with all three codes.",
      plan: [
        { id: "step-1", title: "Delegate three researchers (alpha, beta, gamma)" },
        { id: "step-2", title: "Report all three codes from the researchers' results" },
      ],
    });
    assert.equal(terminal.kind, "completed", `terminal: ${JSON.stringify(terminal)}`);

    const children = core.pmGetChildren(profileId, agentId);
    assert.equal(children.length, 3, `three child rows persisted, got ${children.length}`);
    const ids = new Set(children.map((c) => c.id));
    assert.equal(ids.size, 3, "unique child identities");
    for (const c of children) {
      assert.equal(c.parentAgentId, agentId, "every child links to the parent");
      assert.equal(c.state, STATES.COMPLETED, `child ${c.id} completed`);
      const s = Date.now();
      while (getRun(c.id) !== null && Date.now() - s < 5000) await new Promise((r) => setTimeout(r, 10));
      assert.equal(getRun(c.id), null, "no zombie child run");
      const childToolResults = messages(c.id).filter((m) => m.role === "tool_result").map((m) => m.content);
      assert.ok(childToolResults.some((c2) => String(c2).includes('"ok":true')), `child ${c.id} produced ok tool results`);
    }

    const allAssistant = messages(agentId).filter((m) => m.role === "assistant").map((m) => m.content).join("\n");
    for (const code of ["ALPHA-CODE-11", "BETA-CODE-22", "GAMMA-CODE-33"]) {
      assert.match(allAssistant, new RegExp(code), `parent must incorporate ${code}`);
    }
    console.log(`[live-prod] LIVE-2 elapsed=${elapsedMs}ms children=${children.length}`);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}));

// ---------------------------------------------------------------------------
// LIVE-3 — long-running multi-step task ending in real verification
// (modification -> verify -> correction if verify fails -> verify again)
// ---------------------------------------------------------------------------

function writeFixtureTwoBugs(root) {
  // Two wrong functions; the test checks both. A model that fixes only
  // one will hit the verify gate, receive the fix-signal, and correct.
  // NOTE: assertions must match the SPEC (add = SUM, mul = PRODUCT) —
  // an unpassable fixture here was a Phase 13 run-2 harness bug.
  writeFileSync(join(root, "README-spec.md"), "# Spec\n\n`add(a, b)` must return the SUM.\n`mul(a, b)` must return the PRODUCT.\nBoth in `calc.js` (CommonJS). Run tests with: node calc.test.js\n");
  writeFileSync(join(root, "calc.js"), "function add(a, b) {\n  return a - b; // wrong\n}\nfunction mul(a, b) {\n  return a + b; // wrong\n}\n\nmodule.exports = { add, mul };\n");
  writeFileSync(join(root, "calc.test.js"), "const assert = require('assert');\nconst { add, mul } = require('./calc.js');\nassert.equal(add(2, 3), 5);\nassert.equal(add(-1, 1), 0);\nassert.equal(mul(2, 3), 6);\nassert.equal(mul(4, 5), 20);\nconsole.log('all tests passed');\n");
}

test("LIVE-3: multi-step code task -> modification -> verification -> (correction) -> verification passes", { skip: SKIP, timeout: 600_000 }, withLive(async () => {
  spaceOut();
  const root = mkdtempSync(join(tmpdir(), "cf-live-prod-d3-"));
  writeFixtureTwoBugs(root);
  const { execFileSync } = await import("node:child_process");
  let preFailed = false;
  try {
    execFileSync("node", ["calc.test.js"], { cwd: root, stdio: "pipe" });
  } catch {
    preFailed = true;
  }
  assert.equal(preFailed, true, "fixture must fail BEFORE the agent runs");
  try {
    const { agentId, terminal, elapsedMs } = await runProductionAgent({
      rootPath: root,
      configJson: { context_packet_max_tokens: 0, context_packet_max_project_intel_tokens: 0, test_command: "node calc.test.js" },
      objective: "Make `node calc.test.js` pass. The behavior spec is in README-spec.md. Read the spec and calc.js, run the test with test_run, fix BOTH functions in calc.js with fs_write per the spec, and keep running the test until it passes. Do not modify calc.test.js.",
      plan: [
        { id: "step-1", title: "Read README-spec.md and calc.js, run node calc.test.js with test_run" },
        { id: "step-2", title: "Fix BOTH add and mul in calc.js with fs_write per the spec" },
        { id: "step-3", title: "Run node calc.test.js with test_run until it passes" },
      ],
    });
    assert.equal(terminal.kind, "completed", `terminal: ${JSON.stringify(terminal)}`);

    // Outcome proof on disk: both functions per spec; test file untouched.
    const fixed = readFileSync(join(root, "calc.js"), "utf8");
    assert.match(fixed, /a \+ b/, `add must sum, got: ${fixed.slice(0, 300)}`);
    assert.match(fixed, /a \* b/, `mul must multiply, got: ${fixed.slice(0, 300)}`);
    assert.match(readFileSync(join(root, "calc.test.js"), "utf8"), /assert\.equal\(mul\(4, 5\), 20\)/, "calc.test.js untouched");
    const { stdout } = (() => { try { return { stdout: execFileSync("node", ["calc.test.js"], { cwd: root, stdio: "pipe" }).toString() }; } catch (e) { return { stdout: e.stdout ? e.stdout.toString() : String(e) }; } })();
    assert.match(stdout, /all tests passed/);

    const statuses = messages(agentId).filter((m) => m.role === "status").map((m) => m.name);
    assert.ok(statuses.includes("verified"), `gate verified: ${statuses.join(",")}`);
    const fixRetried = statuses.includes("fix-retrying");
    const row = core.pmGetAgent(profileId, agentId);
    assert.equal(row.state, STATES.COMPLETED);
    console.log(`[live-prod] LIVE-3 elapsed=${elapsedMs}ms statuses=${statuses.join(",")} fixRetried=${fixRetried}`);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}));

// ---------------------------------------------------------------------------
// LIVE-4 — cancellation mid-run persists CANCELLED on the REAL stack
// ---------------------------------------------------------------------------

test("LIVE-4: cancelling mid-run persists CANCELLED in real SQLite with no zombie run", { skip: SKIP, timeout: 300_000 }, withLive(async () => {
  spaceOut();
  const root = mkdtempSync(join(tmpdir(), "cf-live-prod-d4-"));
  writeFixtureThreeParts(root);
  try {
    projectSeq += 1;
    const projectId = core.pmCreateProject(profileId, `live-prod-${projectSeq}`, "cancellation fixture", root, JSON.stringify({ context_packet_max_tokens: 0 }));
    const agentId = core.pmCreateAgent(projectId, "Use fs_list and fs_read to inspect every file in this project in detail, then summarize each one at length.", null);
    const startRes = await startAgent({
      core, profileId, agentId, provider: liveProvider,
      startSubAgent: (childArgs) => startAgent({ ...childArgs, core, provider: liveProvider }),
    });
    assert.equal(startRes.ok, true);
    const terminalPromise = new Promise((resolve) => {
      const done = (kind) => () => resolve(kind);
      startRes.bus.on(AGENT_EVENTS.AGENT_COMPLETED, done("completed"));
      startRes.bus.on(AGENT_EVENTS.AGENT_FAILED, done("failed"));
      startRes.bus.on(AGENT_EVENTS.AGENT_CANCELLED, done("cancelled"));
    });
    await new Promise((r) => setTimeout(r, 2500));
    const cancelRes = cancelAgent(agentId);
    assert.equal(cancelRes.ok, true);
    const kind = await terminalPromise;
    assert.equal(kind, "cancelled", `expected cancelled, got ${kind}`);
    const row = core.pmGetAgent(profileId, agentId);
    assert.equal(row.state, STATES.CANCELLED, "CANCELLED persisted in real SQLite");
    const s = Date.now();
    while (getRun(agentId) !== null && Date.now() - s < 5000) await new Promise((r) => setTimeout(r, 10));
    assert.equal(getRun(agentId), null, "run slot cleared");
    console.log("[live-prod] LIVE-4 cancelled cleanly");
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}));

// ---------------------------------------------------------------------------
// LIVE-5 — final summary after tool messages (no-tools round is fixed)
// ---------------------------------------------------------------------------

test("LIVE-5: user-visible final summary is produced after tool messages (final round carries tools)", { skip: SKIP, timeout: 480_000 }, withLive(async () => {
  spaceOut();
  const root = mkdtempSync(join(tmpdir(), "cf-live-prod-d5-"));
  writeFixtureDelegate(root);
  try {
    const { agentId, terminal, elapsedMs } = await runProductionAgent({
      rootPath: root,
      configJson: { context_packet_max_tokens: 0, context_packet_max_project_intel_tokens: 0 },
      objective: "Read src/release.js and report the value of RELEASE_MARKER in your final answer.",
      plan: [
        { id: "step-1", title: "Use fs_read on src/release.js" },
        { id: "step-2", title: "Write the final answer naming the RELEASE_MARKER value" },
      ],
    });
    assert.equal(terminal.kind, "completed", `terminal: ${JSON.stringify(terminal)}`);
    // The LAST assistant message must be a real summary (not empty, not a
    // mid-task interjection) naming the marker — this is the D3 contract.
    const answer = lastAssistant(agentId);
    assert.ok(answer.trim().length > 0, "final summary is non-empty");
    assert.match(answer, /ORBIT-7741/, `final summary names the marker, got: ${answer.slice(0, 200)}`);
    console.log(`[live-prod] LIVE-5 elapsed=${elapsedMs}ms`);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}));

// Always-on honesty check (mirrors provider-live.test.js).
test("LIVE production-stack: skip gate is honest", () => {
  if (SKIP) {
    console.log(`[live-prod] SKIPPED: ${skipReason}`);
  } else {
    console.log("[live-prod] ENABLED — production stack live acceptance will run");
    assert.ok(CREDENTIAL, "credential present");
  }
  assert.ok(true);
});

// Teardown after all tests (node:test runs this in file order).
if (!SKIP) {
  test("LIVE production-stack: teardown", { timeout: 30_000 }, async () => {
    teardownOnce();
    assert.ok(true);
  });
}
