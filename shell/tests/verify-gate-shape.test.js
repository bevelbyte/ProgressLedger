// Verify-gate result-shape regression (Phase 12 live finding).
//
// The REAL test_run tool returns { stdout, stderr, code, signal,
// timedOut }. verify.js historically read only `passed` / `exitCode`
// — fields the real tool never produces — so every PASSING test was
// classified test-failed and the verification gate could never accept
// a real project's test command. Mock-level gate tests masked this by
// stubbing test_run with verify's expected shape.
//
// These tests pin BOTH directions using the REAL test_run tool running
// real node subprocesses in a temp project root.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { verifyCompletion, tokenizeCommand } from "../src/services/agent/verify.js";
import { _resetForTests as resetToolRegistry } from "../src/services/project-tools/index.js";

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "cf-verify-shape-"));
  // A "test" that passes: exits 0, prints to stdout.
  writeFileSync(join(root, "pass.test.js"), "console.log('all tests passed');\n");
  // A "test" that fails: exits 1, prints the failure to stderr.
  writeFileSync(join(root, "fail.test.js"), "console.error('AssertionError: boom');\nprocess.exit(1);\n");
  // Verification now permits only approved project commands. Use npm as the
  // approved launcher while keeping the real subprocess semantics under test.
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "cf-verify-shape",
    version: "1.0.0",
    scripts: { test: "node pass.test.js", "test-fail": "node fail.test.js", "test-warn": "node warn.test.js", "test-hang": "node hang.test.js" },
  }));
  return root;
}

function projectRow(root, testCommand) {
  return {
    id: 1,
    name: "verify-shape",
    root_path: root,
    config_json: JSON.stringify({ test_command: testCommand }),
  };
}

test("verify gate accepts the REAL test_run shape: code=0 with no passed/exitCode fields", async () => {
  resetToolRegistry();
  const root = makeFixture();
  try {
    const v = await verifyCompletion({
      core: { pmAppendMessage: async () => 1 },
      profileId: 1,
      project: projectRow(root, "npm.cmd test"),
      agentId: 1,
    });
    assert.equal(v.ok, true, `verify must PASS a real passing test, got: ${JSON.stringify(v).slice(0, 300)}`);
    assert.equal(v.reason, "test-passed");
    assert.match(v.output, /all tests passed/);
  } finally {
    resetToolRegistry();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify gate still fails a real failing test (code=1) and reports the exit code", async () => {
  resetToolRegistry();
  const root = makeFixture();
  try {
    const v = await verifyCompletion({
      core: { pmAppendMessage: async () => 1 },
      profileId: 1,
      project: projectRow(root, "npm.cmd run test-fail"),
      agentId: 1,
    });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "test-failed");
    assert.equal(v.exitCode, 1);
    assert.match(v.output, /boom/);
  } finally {
    resetToolRegistry();
    rmSync(root, { recursive: true, force: true });
  }
});

test("tokenizeCommand splits the test_command for execFile", () => {
  assert.deepEqual(tokenizeCommand("node calc.test.js"), ["node", "calc.test.js"]);
  assert.deepEqual(tokenizeCommand('npm "run test" -s'), ["npm", "run test", "-s"]);
  assert.deepEqual(tokenizeCommand(""), []);
});

// ---------------------------------------------------------------------------
// Phase 13 — verification lifecycle hardening
// ---------------------------------------------------------------------------

test("verify gate: malformed test_command is an explicit error; empty means no test configured", async () => {
  resetToolRegistry();
  const root = makeFixture();
  try {
    // "" (no test configured) is the documented trivially-verified case.
    const none = await verifyCompletion({
      core: { pmAppendMessage: async () => 1 },
      profileId: 1,
      project: projectRow(root, ""),
      agentId: 1,
    });
    assert.equal(none.ok, true);
    assert.equal(none.reason, "no-test-command");
    // Whitespace-only IS a configured command and must error, not pass.
    const bad = await verifyCompletion({
      core: { pmAppendMessage: async () => 1 },
      profileId: 1,
      project: projectRow(root, "   "),
      agentId: 1,
    });
    assert.equal(bad.ok, false, "whitespace-only test_command must not verify");
    assert.equal(bad.reason, "test-errored");
  } finally {
    resetToolRegistry();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify gate: stderr warnings with exit code 0 still PASS (stderr is not failure)", async () => {
  resetToolRegistry();
  const root = mkdtempSync(join(tmpdir(), "cf-verify-shape-"));
  writeFileSync(join(root, "warn.test.js"), "console.error('deprecation warning: legacy flag');\nconsole.log('ok');\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "cf-verify-warning",
    version: "1.0.0",
    scripts: { "test-warn": "node warn.test.js" },
  }));
  try {
    const v = await verifyCompletion({
      core: { pmAppendMessage: async () => 1 },
      profileId: 1,
      project: projectRow(root, "npm.cmd run test-warn"),
      agentId: 1,
    });
    assert.equal(v.ok, true, `exit 0 must pass despite stderr, got: ${JSON.stringify(v).slice(0, 200)}`);
    assert.equal(v.reason, "test-passed");
  } finally {
    resetToolRegistry();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        break;
      } catch (err) {
        if (attempt === 4) throw err;
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }
  }
});

test("verify gate: timeout is reported as test-errored, never as a pass", async () => {
  resetToolRegistry();
  const root = makeFixture();
  writeFileSync(join(root, "hang.test.js"), "setTimeout(() => {}, 60000);\n");
  try {
    const v = await verifyCompletion({
      core: { pmAppendMessage: async () => 1 },
      profileId: 1,
      project: {
        id: 1,
        name: "verify-shape",
        root_path: root,
        config_json: JSON.stringify({ test_command: "npm.cmd run test-hang", test_timeout_ms: 1500 }),
      },
      agentId: 1,
    });
    assert.equal(v.ok, false, "a hanging test must not pass");
    assert.ok(v.reason === "test-errored" || v.reason === "test-timeout" || v.reason === "test-failed", `reason: ${v.reason}`);
    assert.ok(v.elapsedMs >= 1000, `elapsed reflects the timeout window: ${v.elapsedMs}ms`);
  } finally {
    resetToolRegistry();

    // Cargo may release Windows file handles shortly after the timed-out
    // process tree has been terminated. Keep cleanup bounded but give the OS
    // enough time to release those exact test-owned artifacts; this does not
    // alter the verification assertion or timeout semantics under test.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        break;
      } catch (err) {
        if (attempt === 19) throw err;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
});
