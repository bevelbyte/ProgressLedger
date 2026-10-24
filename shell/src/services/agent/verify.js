// Verification-before-completion.
//
// The Iron Law: an agent may not transition to `completed` until it has
// actually verified its work. The "verify" step runs after the plan is
// complete and the agent would otherwise have stopped.
//
// What "verify" means here:
//   1. If pm_projects.config_json.test_command is set, run it via
//      test_run (the existing tool). Pass = exit 0 within timeout.
//   2. If no test command is configured, verification is trivially
//      satisfied (the project has nothing to run).
//   3. On pass: append a `status` message with `name='verified'` so the
//      renderer can show "agent has been verified" + the test summary.
//   4. On fail: append a `status` message with `name='verify-failed'` and
//      the test output, then transition to FAILED. The parent agent (or
//      the user) can re-dispatch a fix.

import { getTool } from "../project-tools/index.js";

/**
 * Run the project's verification. Returns one of:
 *   { ok: true,  reason: 'no-test-command' }                  — no test configured
 *   { ok: true,  reason: 'test-passed',     elapsedMs, output }
 *   { ok: false, reason: 'test-failed',     elapsedMs, output, exitCode }
 *   { ok: false, reason: 'test-errored',    error }
 *   { ok: false, reason: 'test-timeout',    error }
 *
 * Never throws. The test_run tool itself returns the structured { ok, result, elapsedMs }.
 */
export async function verifyCompletion({ core, profileId, project, agentId }) {
  const config = parseConfig(project.config_json);
  if (!config.test_command) {
    return { ok: true, reason: "no-test-command", elapsedMs: 0, output: "" };
  }
  const tool = getTool("test_run");
  if (!tool) return { ok: false, reason: "test-errored", error: "test_run tool not registered" };

  // Phase 11 live finding: config.test_command is a full command string
  // ("node calc.test.js", "npm test", "pytest -q") in real projects.
  // test_run is execFile-based, so the string must be split into an
  // executable + argv. Passing the whole string as the executable made
  // execFile spawn a REPL / print usage and hang until the timeout.
  const [cmd, ...cmdArgv] = tokenizeCommand(config.test_command);
  if (!cmd) return { ok: false, reason: "test-errored", error: "test_command is empty" };

  const startedAt = Date.now();
  const result = await tool.execute(
    { command: cmd, argv: cmdArgv, timeoutMs: config.test_timeout_ms || 120_000 },
    {
      projectRoot: project.root_path,
      isCancellable: () => false,
      nowMs: () => Date.now(),
    }
  );
  const elapsedMs = Date.now() - startedAt;
  if (!result || result.ok === false) {
    return {
      ok: false,
      reason: "test-errored",
      elapsedMs,
      error: result && result.error ? (result.error.message || JSON.stringify(result.error)) : "unknown",
    };
  }
  const r = result.result || {};
  // Phase 12 live finding: the REAL test_run tool returns
  // { stdout, stderr, code, signal, timedOut } — no `passed`, no
  // `exitCode`. Reading only `passed`/`exitCode` made EVERY passing test
  // classify as test-failed (exitCode fell back to 1), so the verify
  // gate could never pass a real project's test command. Accept the
  // real `code` field first; keep `passed`/`exitCode` for stubs.
  const exitCode = typeof r.code === "number"
    ? r.code
    : typeof r.exitCode === "number"
      ? r.exitCode
      : null;
  if (r.passed === true || exitCode === 0) {
    return { ok: true, reason: "test-passed", elapsedMs, output: tail(r.stdout, 2000) };
  }
  return {
    ok: false,
    reason: "test-failed",
    elapsedMs,
    output: tail(r.stderr || r.stdout, 4000),
    exitCode: exitCode == null ? 1 : exitCode,
  };
}

/**
 * Persist a `status` message in the transcript. This is what the
 * verification gate emits when it runs, so a resumption can see whether
 * verification already happened.
 */
export async function appendStatusMessage(core, profileId, agentId, name, payload) {
  await core.pmAppendMessage(
    profileId,
    agentId,
    "status",
    name,
    name,
    JSON.stringify({ name, ...payload, ts: Date.now() })
  );
}

function parseConfig(s) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

/**
 * Split a test_command string into [executable, ...argv]. Whitespace
 * splits by default; double-quoted segments stay together. No shell
 * interpretation — this only feeds execFile, and `test_run` still
 * enforces its own safeExecFile rules downstream.
 */
export function tokenizeCommand(s) {
  const out = [];
  const str = String(s || "").trim();
  if (!str) return out;
  let cur = "";
  let inQuotes = false;
  for (const ch of str) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (cur.length > 0) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function tail(s, n) {
  s = String(s || "");
  return s.length > n ? "…" + s.slice(s.length - n) : s;
}
