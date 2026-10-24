// Phase 5 — verification-before-completion gate.
//
// Covers: parseConfig robustness, no-test-command short-circuit,
// test-passed path, test-failed path, test-errored path, status message
// persistence shape.

import test from "node:test";
import assert from "node:assert/strict";
import { verifyCompletion, appendStatusMessage } from "../src/services/agent/verify.js";

// Stub core that captures pmAppendMessage calls without touching SQLite.
function makeCore() {
  const calls = [];
  return {
    calls,
    async pmGetProject(_profileId, _projectId) { return null; },  // not used in this test
    async pmAppendMessage(profileId, agentId, role, content, name, payloadJson) {
      const rec = { profileId, agentId, role, content, name, payloadJson };
      calls.push(rec);
      return calls.length;
    },
  };
}

function makeProject(configJson) {
  return { id: 99, name: "P", root_path: "/tmp/p", config_json: configJson };
}

test("verify: no test_command in config = trivially satisfied", async () => {
  const core = makeCore();
  const v = await verifyCompletion({ core, profileId: 1, project: makeProject("{}"), agentId: 10 });
  assert.equal(v.ok, true);
  assert.equal(v.reason, "no-test-command");
  assert.equal(v.elapsedMs, 0);
});

test("verify: malformed config_json does not throw and writes no status row", async () => {
  const core = makeCore();
  const v = await verifyCompletion({ core, profileId: 1, project: makeProject("not json {"), agentId: 10 });
  // malformed config falls through to no-test-command
  assert.equal(v.ok, true);
  assert.equal(v.reason, "no-test-command");
  assert.equal(v.elapsedMs, 0);
  assert.equal(typeof v.output, "string");
  // The contract: when there is no test_command the verify step
  // is a no-op and must not pretend a verification happened. No
  // status row may be appended (that would falsely advertise a
  // verified state to the renderer / audit log).
  assert.equal(
    core.calls.length,
    0,
    "verify must not append a status row when no test command is configured",
  );
});

test("appendStatusMessage: persists a structured status row", async () => {
  const core = makeCore();
  await appendStatusMessage(core, 1, 10, "verified", { reason: "test-passed", elapsedMs: 1234 });
  assert.equal(core.calls.length, 1);
  const rec = core.calls[0];
  assert.equal(rec.role, "status");
  assert.equal(rec.name, "verified");
  assert.equal(rec.profileId, 1);
  assert.equal(rec.agentId, 10);
  assert.equal(typeof rec.payloadJson, "string");
  const payload = JSON.parse(rec.payloadJson);
  assert.equal(payload.name, "verified");
  assert.equal(payload.reason, "test-passed");
  assert.equal(payload.elapsedMs, 1234);
  assert.ok(typeof payload.ts === "number");
});

test("verify: returns a structured envelope, never throws", async () => {
  // The verify function is expected to never throw. We use a
  // command that always fails (Windows `exit 1` runs the test_run
  // tool's child-process path and returns a non-zero exit code).
  const core = makeCore();
  const v = await verifyCompletion({ core, profileId: 1, project: makeProject(JSON.stringify({ test_command: "node -e \"process.exit(1)\"" })), agentId: 10 });
  assert.ok(v);
  assert.equal(typeof v.ok, "boolean");
  // The real test_run tool runs the command and reports a non-zero
  // exit, so we expect either test-failed or test-errored — but never
  // a thrown exception.
  assert.equal(v.ok, false);
  assert.ok(["test-failed", "test-errored"].includes(v.reason));
});

// ---------------------------------------------------------------------------
// Phase 11: test_command tokenization (live finding regression)
// ---------------------------------------------------------------------------

test("verify: tokenizeCommand splits full command strings for execFile", async () => {
  const { tokenizeCommand } = await import("../src/services/agent/verify.js");
  assert.deepEqual(tokenizeCommand("node calc.test.js"), ["node", "calc.test.js"]);
  assert.deepEqual(tokenizeCommand("npm test"), ["npm", "test"]);
  assert.deepEqual(tokenizeCommand("pytest -q --maxfail=1"), ["pytest", "-q", "--maxfail=1"]);
  assert.deepEqual(tokenizeCommand('node "my file.test.js"'), ["node", "my file.test.js"]);
  assert.deepEqual(tokenizeCommand("  node   -e  \"process.exit(0)\" "), ["node", "-e", "process.exit(0)"]);
  assert.deepEqual(tokenizeCommand(""), []);
  assert.deepEqual(tokenizeCommand(null), []);
});
