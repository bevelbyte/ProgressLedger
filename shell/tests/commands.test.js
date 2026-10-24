// Commands — slash-command extension layer.
//
// Covers:
//   - register / unregister / list
//   - the 7 built-ins are present
//   - parseCommandLine happy path + edge cases
//   - /test returns { ok: true } with a stub test_run dispatcher
//   - /cancel returns { ok: true } with a stub cancelAgent
//   - /commit returns { ok: false, reason: "shell_git_status-failed" }
//     when shell_git_status itself fails (non-git dir / no approval token)

import test from "node:test";
import assert from "node:assert/strict";

import { Commands, parseCommandLine } from "../src/services/commands/index.js";

const SEVEN = ["plan", "review", "test", "explain", "fix", "commit", "cancel"];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fresh() {
  Commands._resetForTests();
  Commands.registerBuiltins();
  return Commands;
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

test("register / unregister / list", () => {
  const c = fresh();
  const before = c.list().length;
  c.register({
    id: "demo",
    name: "demo",
    description: "demo command",
    args: [],
    async run() { return { ok: true }; },
  });
  assert.equal(c.list().length, before + 1);
  assert.ok(c.list().find((x) => x.id === "demo"));

  assert.equal(c.unregister("demo"), true);
  assert.equal(c.list().length, before);
  // idempotent
  assert.equal(c.unregister("demo"), false);
});

// ---------------------------------------------------------------------------
// built-in set
// ---------------------------------------------------------------------------

test("all 7 built-in commands are present after registerBuiltins", () => {
  const c = fresh();
  const ids = c.list().map((x) => x.id);
  for (const want of SEVEN) {
    assert.ok(ids.includes(want), `missing built-in: ${want}`);
  }
  // exactly 7 (not more, not less) — guards against accidental drift
  assert.equal(c.list().length, 7);
});

test("built-in list() returns metadata only (no run function)", () => {
  const c = fresh();
  for (const cmd of c.list()) {
    assert.equal(typeof cmd.id, "string");
    assert.equal(typeof cmd.name, "string");
    assert.equal(typeof cmd.description, "string");
    assert.ok(Array.isArray(cmd.args));
    assert.equal(typeof cmd.run, "undefined", `id=${cmd.id} should not expose run`);
  }
});

// ---------------------------------------------------------------------------
// parseCommandLine
// ---------------------------------------------------------------------------

test("parseCommandLine: simple /cmd", () => {
  const r = parseCommandLine("/plan");
  assert.deepEqual(r, { name: "plan", args: [] });
});

test("parseCommandLine: /cmd arg1 arg2", () => {
  const r = parseCommandLine("/commit Add new feature");
  assert.deepEqual(r, { name: "commit", args: ["Add", "new", "feature"] });
});

test("parseCommandLine: lowercase normalisation", () => {
  const r = parseCommandLine("/TEST npm test");
  assert.deepEqual(r, { name: "test", args: ["npm", "test"] });
});

test("parseCommandLine: missing / prefix returns null", () => {
  assert.equal(parseCommandLine("plan"), null);
});

test("parseCommandLine: empty returns null", () => {
  assert.equal(parseCommandLine(""), null);
  assert.equal(parseCommandLine("   "), null);
  assert.equal(parseCommandLine("/"), null);
  assert.equal(parseCommandLine("/  "), null);
});

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

test("run: unknown command returns ok:false reason:unknown-command", async () => {
  const c = fresh();
  const r = await c.run(1, 1, "/nope", {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown-command");
});

test("run: invalid line returns ok:false reason:invalid-command-line", async () => {
  const c = fresh();
  const r = await c.run(1, 1, "no-slash", {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-command-line");
});

// ---------------------------------------------------------------------------
// /test with stub test_run dispatcher
// ---------------------------------------------------------------------------

test("/test returns { ok: true } when stub test_run succeeds", async () => {
  const c = fresh();
  const calls = [];
  c.configureCommands({
    invokeTool: async (toolName, input) => {
      calls.push({ toolName, input });
      return { ok: true, result: { stdout: "ok", stderr: "", code: 0, signal: null, timedOut: false } };
    },
  });
  const r = await c.run(1, 1, "/test npm test", { agentId: 42 });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, "test_run");
  assert.equal(calls[0].input.command, "npm");
  assert.deepEqual(calls[0].input.argv, ["test"]);
});

// ---------------------------------------------------------------------------
// /cancel with stub cancelAgent
// ---------------------------------------------------------------------------

test("/cancel returns { ok: true } with a stub cancelAgent", async () => {
  const c = fresh();
  c.configureCommands({
    cancelAgent: async (agentId) => ({ ok: true, agentId }),
  });
  const r = await c.run(1, 1, "/cancel", { agentId: 7 });
  assert.equal(r.ok, true);
});

test("/cancel returns ok:false when no active agent", async () => {
  const c = fresh();
  c.configureCommands({
    cancelAgent: async () => ({ ok: true }),
  });
  const r = await c.run(1, 1, "/cancel", {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-active-agent");
});

// ---------------------------------------------------------------------------
// /commit — must NOT bypass approval + must pre-check shell_git_status
// ---------------------------------------------------------------------------

test("/commit returns ok:false reason:shell_git_status-failed when git status fails", async () => {
  const c = fresh();
  const calls = [];
  c.configureCommands({
    invokeTool: async (toolName, input) => {
      calls.push({ toolName, input });
      if (toolName === "shell_git_status") {
        return { ok: false, error: { code: "tool-failed", message: "not a git repository" } };
      }
      return { ok: true, result: {} };
    },
  });
  const r = await c.run(1, 1, "/commit Initial commit", { agentId: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "shell_git_status-failed");
  // CRITICAL: exec_run must NOT have been called — the pre-check failed.
  const execCalls = calls.filter((x) => x.toolName === "exec_run");
  assert.equal(execCalls.length, 0, "exec_run must not be invoked when git status fails");
});

test("/commit requires exec_run approval (does not bypass APPROVAL_REQUIRED)", async () => {
  const c = fresh();
  c.configureCommands({
    invokeTool: async (toolName, input) => {
      if (toolName === "shell_git_status") {
        return { ok: true, result: { entries: [], branch: "main", clean: false } };
      }
      if (toolName === "exec_run") {
        // exec_run is APPROVAL_REQUIRED in security.js. The dispatcher
        // would normally return { requiresApproval } if no token was
        // supplied. We assert that path: the dispatcher does NOT mint
        // an approval token on its own.
        return { ok: false, requiresApproval: { tool: "exec_run", input } };
      }
      return { ok: true, result: {} };
    },
  });
  const r = await c.run(1, 1, "/commit Initial", { agentId: 1 });
  // The first exec_run (git add .) returns requiresApproval, so the
  // command dispatcher should surface that — not ok:true.
  assert.equal(r.ok, false);
});
