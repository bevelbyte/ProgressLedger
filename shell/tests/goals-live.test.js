// Goal Mode — LIVE acceptance tests against the real b.ai provider.
//
// Env-gated: set PROGRESSLEDGER_V2_LIVE_TEST=1 to run. Otherwise the suite is
// skipped so this doesn't burn provider quota in CI.
//
// LIVE TEST A: Inspect-only goal
//   - create a "research" goal that does NOT require verification
//   - agent uses project intel + memory to inspect the fixture
//   - goal completes (agent terminal state + no verify required)
//
// LIVE TEST B: Coding goal
//   - create a "code_change" goal with verification
//   - agent uses fs_read, fs_write, test_run
//   - verify must pass before goal completes
//
// LIVE TEST C: Sub-agent goal
//   - parent agent delegates to a researcher
//   - parent continues and completes
//
// All tests use the proven Phase 13 provider:
//   base = https://api.b.ai/v1
//   model = deepseek-v4-flash

import { test, skip } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const requireCJS = createRequire(import.meta.url);
const core = requireCJS(path.join(REPO_ROOT, "core", "progress_ledger_core.win32-x64-msvc.node"));

const ENABLED = process.env.PROGRESSLEDGER_V2_LIVE_TEST === "1";

if (!ENABLED) {
  skip("Goal Mode LIVE tests skipped (set PROGRESSLEDGER_V2_LIVE_TEST=1 to enable)", () => {});
}

async function newWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "goals-live-"));
  const dbPath = path.join(tmpDir, "test.db");
  await core.initDb(dbPath);
  const a = await core.addProfile("Live Goals", `live-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const profileId = a.id;
  // Create a fixture project inside tmpDir so the agent has files to inspect.
  const fixtureRoot = path.join(tmpDir, "fixture");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, "README.md"), "# Fixture\nThis is a tiny fixture project used by Goal Mode LIVE tests.\nIt has two files and one module.");
  fs.mkdirSync(path.join(fixtureRoot, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureRoot, "src", "math.js"),
    "export function add(a, b) { return a + b; }\nexport function sub(a, b) { return a - b; }\n"
  );
  const projectId = await core.pmCreateProject(
    profileId,
    "Fixture Project",
    "Tiny fixture for Goal Mode live tests.",
    fixtureRoot,
    JSON.stringify({ defaultProvider: "openai-compatible", testCommand: "node test.js" })
  );
  // Write a passing test so verification has something to validate.
  fs.writeFileSync(path.join(fixtureRoot, "test.js"), 'import { add, sub } from "./src/math.js";\nconst assert = await import("node:assert");\nassert.strictEqual(add(1, 2), 3);\nassert.strictEqual(sub(5, 3), 2);\nconsole.log("ok");\n');
  return { profileId, projectId, fixtureRoot, tmpDir };
}

// Each LIVE test creates a fresh DB so we don't pollute the global pool.
async function withFreshWorkspace(fn) {
  const ws = await newWorkspace();
  try {
    return await fn(ws);
  } finally {
    try { fs.rmSync(ws.tmpDir, { recursive: true, force: true }); } catch (_e) {}
  }
}

async function waitForGoalState(core, profileId, goalId, target, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const g = await core.pmGetGoal(profileId, goalId);
    if (g && g.state === target) return g;
    if (g && (g.state === "failed" || g.state === "cancelled")) {
      return g;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`goal did not reach ${target} in ${timeoutMs}ms`);
}

async function getProviderKey(core, profileId, projectId) {
  const r = await core.pmGetDefaultProvider(profileId, projectId);
  // Provider credentials are stored under shell's credentials store, not
  // the NAPI. The live test harness (test/nightly provider tests) reads
  // from `process.env.PROGRESSLEDGER_V2_PROVIDER_KEY`. We can't go through the
  // credentials store here without booting Electron, so we just expect
  // the env var.
  return process.env.PROGRESSLEDGER_V2_PROVIDER_KEY || "";
}

test("LIVE-A: research goal (no verify) completes against live provider", async (t) => {
  if (!ENABLED) return t.skip();
  await withFreshWorkspace(async ({ profileId, projectId }) => {
    // Persist a provider key + endpoint in the project's config_json
    // so the agent loop's `resolveDefaultProvider` picks it up.
    const key = await getProviderKey(core, profileId, projectId);
    if (!key) {
      t.skip("PROGRESSLEDGER_V2_PROVIDER_KEY not set; skipping LIVE-A");
      return;
    }
    // Use the credentials store via NAPI: pm_set_default_provider only
    // accepts openai-compatible or mock; we need the api key too. For
    // the live test, we pass the key through the env-var path that
    // provider.js honors in test mode.
    process.env.PROGRESSLEDGER_V2_LIVE_TEST_BASE = "https://api.b.ai/v1";
    process.env.PROGRESSLEDGER_V2_LIVE_TEST_MODEL = "deepseek-v4-flash";
    process.env.PROGRESSLEDGER_V2_LIVE_TEST_KEY = key;

    const goalId = await core.pmCreateGoal(
      profileId,
      projectId,
      "Inspect fixture",
      "Inspect the fixture project at the project root and provide a one-paragraph summary of its structure. Do not modify any files.",
      "research",
      "normal",
      false // requireVerification
    );
    // Drive the agent loop directly (skip the engine for the live test
    // so we don't have to wire credentials through Electron).
    const { startAgent } = await import("../src/services/agent/loop.js");
    const agentId = await core.pmCreateAgent(projectId, "Inspect this fixture and describe its structure. Do not modify any files.");
    await core.pmLinkGoalAgent(profileId, goalId, agentId);
    await core.pmTransitionGoal(profileId, goalId, "starting", null, null);
    const r = await startAgent({ core, profileId, agentId });
    assert.equal(r.ok, true, `agent start failed: ${JSON.stringify(r)}`);
    await core.pmTransitionGoal(profileId, goalId, "running", null, null);

    const final = await waitForGoalState(core, profileId, goalId, "completed", 120_000);
    assert.equal(final.state, "completed", `expected completed, got ${final.state}; reason=${final.failureReason}`);
    assert.ok(final.completedAt, "completedAt must be set");
  });
});

test("LIVE-B: code_change goal with verification completes against live provider", async (t) => {
  if (!ENABLED) return t.skip();
  await withFreshWorkspace(async ({ profileId, projectId }) => {
    const key = await getProviderKey(core, profileId, projectId);
    if (!key) {
      t.skip("PROGRESSLEDGER_V2_PROVIDER_KEY not set; skipping LIVE-B");
      return;
    }
    process.env.PROGRESSLEDGER_V2_LIVE_TEST_BASE = "https://api.b.ai/v1";
    process.env.PROGRESSLEDGER_V2_LIVE_TEST_MODEL = "deepseek-v4-flash";
    process.env.PROGRESSLEDGER_V2_LIVE_TEST_KEY = key;

    const goalId = await core.pmCreateGoal(
      profileId,
      projectId,
      "Add subtract test",
      "Read src/math.js and add a new function multiply(a, b). Update test.js to assert that multiply(2, 3) === 6. Run the test and ensure it passes.",
      "code_change",
      "normal",
      true // requireVerification
    );
    const { startAgent } = await import("../src/services/agent/loop.js");
    const agentId = await core.pmCreateAgent(projectId, "Read src/math.js and add a multiply function. Update test.js. Run the test and ensure it passes.");
    await core.pmLinkGoalAgent(profileId, goalId, agentId);
    await core.pmTransitionGoal(profileId, goalId, "starting", null, null);
    const r = await startAgent({ core, profileId, agentId });
    assert.equal(r.ok, true, `agent start failed: ${JSON.stringify(r)}`);
    await core.pmTransitionGoal(profileId, goalId, "running", null, null);

    const final = await waitForGoalState(core, profileId, goalId, "completed", 180_000);
    assert.equal(final.state, "completed", `expected completed, got ${final.state}; reason=${final.failureReason}`);
  });
});

test("LIVE-C: parent + delegated researcher completes against live provider", async (t) => {
  if (!ENABLED) return t.skip();
  await withFreshWorkspace(async ({ profileId, projectId }) => {
    const key = await getProviderKey(core, profileId, projectId);
    if (!key) {
      t.skip("PROGRESSLEDGER_V2_PROVIDER_KEY not set; skipping LIVE-C");
      return;
    }
    process.env.PROGRESSLEDGER_V2_LIVE_TEST_BASE = "https://api.b.ai/v1";
    process.env.PROGRESSLEDGER_V2_LIVE_TEST_MODEL = "deepseek-v4-flash";
    process.env.PROGRESSLEDGER_V2_LIVE_TEST_KEY = key;

    const goalId = await core.pmCreateGoal(
      profileId,
      projectId,
      "Research + summarize",
      "Delegate to a researcher sub-agent to summarize this fixture. The parent should incorporate the result and finish with a single summary line.",
      "research",
      "normal",
      false
    );
    const { startAgent } = await import("../src/services/agent/loop.js");
    const agentId = await core.pmCreateAgent(projectId, "Delegate to delegate_research to summarize the fixture project, then write a single sentence summary.");
    await core.pmLinkGoalAgent(profileId, goalId, agentId);
    await core.pmTransitionGoal(profileId, goalId, "starting", null, null);
    const r = await startAgent({ core, profileId, agentId });
    assert.equal(r.ok, true);
    await core.pmTransitionGoal(profileId, goalId, "running", null, null);

    const final = await waitForGoalState(core, profileId, goalId, "completed", 180_000);
    assert.equal(final.state, "completed", `expected completed, got ${final.state}; reason=${final.failureReason}`);
  });
});