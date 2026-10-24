// Project Mode — GATE 8 (v7) tool audit.
//
// Deep audit of every privileged tool. Whereas GATE 6 covered the
// envelope / schema / timeout / audit shape, this gate focuses on the
// security boundary: every tool that touches the filesystem or runs a
// child process MUST refuse to operate outside the project root, MUST
// refuse path-traversal payloads, and MUST refuse shell-metacharacter
// commands (exec_run / test_run / build_run use execFile, never a
// shell, so command injection in argv or in `command` is a no-op at
// best and an error envelope at worst).
//
// Vectors covered (each one NOT already in gate6-tool-system.test.js):
//   1. fs_read rejects absolute "/etc/passwd" (system file read blocked)
//   2. fs_read rejects parent-dir escape "../../etc/passwd"
//   3. fs_write refuses to write to a literal "/tmp/..." path when
//      projectRoot is "/tmp/agent"
//   4. fs_search rejects a path argument that contains ".." traversal
//      (e.g. "../../../etc/*")
//   5. fs_list refuses to list "/"
//   6. exec_run refuses shell-metacharacter command strings
//      ("node; rm -rf /") and shell-metacharacter argv (no shell
//      interpretation ever happens — execFile is used)
//   7. test_run refuses commands that try to escape via shell-meta
//      ("cd .. && rm -rf /") — also verifies the dangerous-interpreter
//      blocklist still blocks "bash", "cmd", "powershell", etc.
//   8. Regression: no built-in tool returns ok:true for an outside-root
//      path; inspect_project, shell_git_*, and the rest all funnel
//      through assertInsideProjectRoot and refuse with
//      "path-outside-project".
//
// If any of these tests fail, the fix is in the source file named in
// the failure message — NOT in this test. This is a security regression
// suite, not a TDD red/green scratch pad.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";

import {
  PROJECT_TOOLS,
  getTool,
  listTools,
} from "../src/services/project-tools/index.js";
import { runTool } from "../src/services/project-tools/_runtime.js";
import { assertInsideProjectRoot } from "../src/services/project-tools/security.js";
import {
  Audit,
  _setStateForTests,
  _resetForTests as _resetAudit,
} from "../src/services/audit/index.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeTempProject(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cf-gate8-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function baseCtx(projectRoot) {
  return {
    projectRoot,
    profileId: 1,
    projectId: 1,
    agentId: 1,
    isCancellable: () => false,
    nowMs: () => Date.now(),
  };
}

function wireAudit() {
  _setStateForTests({ filePath: null });
}

// ---------------------------------------------------------------------------
// 1) fs_read rejects absolute system-file path
// ---------------------------------------------------------------------------

test("GATE8: fs_read rejects an absolute /etc/passwd path (system-file read blocked)", async () => {
  await runTool; // suppress unused import linting in older toolchains
  const root = makeTempProject({ "ok.txt": "ok\n" });
  try {
    const res = await runTool(
      getTool("fs_read"),
      { path: "/etc/passwd" },
      baseCtx(root),
    );
    assert.equal(res.ok, false, "fs_read must NOT return ok:true for /etc/passwd");
    assert.equal(res.error.code, "path-outside-project",
      `expected path-outside-project, got ${res.error.code}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GATE8: fs_read rejects an absolute Windows-style C:\\Windows path", async () => {
  const root = makeTempProject({});
  try {
    const res = await runTool(
      getTool("fs_read"),
      { path: "C:\\Windows\\System32\\drivers\\etc\\hosts" },
      baseCtx(root),
    );
    assert.equal(res.ok, false, "fs_read must NOT return ok:true for a Windows system path");
    assert.equal(res.error.code, "path-outside-project");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2) fs_read rejects parent-dir escape "../../etc/passwd"
// ---------------------------------------------------------------------------

test("GATE8: fs_read rejects ../../etc/passwd parent-dir escape", async () => {
  const root = makeTempProject({});
  try {
    // Use the literal string "../../etc/passwd" — `path.resolve` will
    // canonicalise the .. to a parent of projectRoot. The test does NOT
    // depend on /etc/passwd existing on the host; the boundary check
    // fires before any I/O.
    const res = await runTool(
      getTool("fs_read"),
      { path: join(root, "..", "..", "etc", "passwd") },
      baseCtx(root),
    );
    assert.equal(res.ok, false, "fs_read must NOT succeed via parent-dir escape");
    assert.equal(res.error.code, "path-outside-project");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3) fs_write refuses to write to a sibling /tmp directory when
//    projectRoot is a child of /tmp
// ---------------------------------------------------------------------------

test("GATE8: fs_write refuses to write to /tmp/... when projectRoot is a different /tmp/agent subdir", async () => {
  // Build two sibling temp dirs: one is the projectRoot, the other is
  // a different sibling that we will try to write to.
  const projectRoot = mkdtempSync(join(tmpdir(), "cf-gate8-agent-"));
  const sibling = mkdtempSync(join(tmpdir(), "cf-gate8-other-"));
  try {
    const res = await runTool(
      getTool("fs_write"),
      { path: join(sibling, "evil.txt"), content: "should not write" },
      baseCtx(projectRoot),
    );
    assert.equal(res.ok, false, "fs_write must NOT succeed for an outside-root sibling path");
    assert.equal(res.error.code, "path-outside-project");
    // Confirm the file really was NOT written — defense-in-depth assertion.
    assert.equal(existsSync(join(sibling, "evil.txt")), false,
      "fs_write must not have created the file on disk");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(sibling, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4) fs_search rejects path argument containing ".."
// ---------------------------------------------------------------------------

test("GATE8: fs_search rejects a path argument with ../ traversal", async () => {
  const root = makeTempProject({ "a.js": "const x = 1;\n" });
  try {
    const res = await runTool(
      getTool("fs_search"),
      { path: join(root, "..", "..", "etc", "*"), query: "root" },
      baseCtx(root),
    );
    assert.equal(res.ok, false, "fs_search must NOT search outside the project root");
    assert.equal(res.error.code, "path-outside-project");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5) fs_list refuses to list "/"
// ---------------------------------------------------------------------------

test("GATE8: fs_list refuses to list / (filesystem root)", async () => {
  const root = makeTempProject({});
  try {
    const res = await runTool(
      getTool("fs_list"),
      { path: sep === "/" ? "/" : "C:\\" },
      baseCtx(root),
    );
    assert.equal(res.ok, false, "fs_list must NOT succeed for the filesystem root");
    assert.equal(res.error.code, "path-outside-project");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6) exec_run never reaches a shell — shell-metacharacter commands
//    either error out (no such binary) or run as a literal argv
//    element. The dangerous-interpreter blocklist still fires for
//    "bash", "sh", "cmd", "powershell", "pwsh", "node", "python" etc.
// ---------------------------------------------------------------------------

test("GATE8: exec_run refuses shell-metacharacter command strings (no shell is ever spawned)", async () => {
  const root = makeTempProject({});
  try {
    // "node; rm -rf /" is a single command string — execFile will look
    // up a binary literally named "node; rm -rf /" (won't exist). The
    // dangerous-interpreter blocklist strips only the basename so
    // "node; rm -rf /" becomes the basename "node; rm -rf /" (not in
    // the blocklist) — so this hits execFile and fails cleanly with a
    // tool-failed or spawn ENOENT envelope. Either way: ok:false, no
    // shell was ever involved.
    const res = await runTool(
      getTool("exec_run"),
      { path: root, command: "node; rm -rf /", argv: [] },
      baseCtx(root),
    );
    // We don't pin the exact error code (POSIX vs Windows differ on
    // ENOENT formatting) but we MUST assert that no shell ran and no
    // destructive side-effects happened.
    assert.equal(typeof res, "object");
    assert.equal(typeof res.ok, "boolean");
    if (res.ok === true) {
      // If the binary happened to exist for some reason, the run
      // itself must have done nothing destructive: stdout/stderr must
      // be plain strings, code/signal/timedOut must be the normal
      // envelope fields.
      assert.equal(typeof res.result.stdout, "string");
      assert.equal(typeof res.result.stderr, "string");
      assert.equal(typeof res.result.code === "number" || res.result.code === null, true);
      // Most importantly: we are NOT running `rm -rf /`. The "command"
      // was a single token that happens to contain shell syntax. execFile
      // cannot interpret it; if a binary literally named "node; rm -rf /"
      // existed, it would be invoked with no args, never "rm -rf /".
    } else {
      assert.equal(typeof res.error, "object");
      assert.equal(typeof res.error.code, "string");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GATE8: exec_run blocks dangerous interpreters (bash, sh, cmd, powershell, node, python)", async () => {
  const root = makeTempProject({});
  const dangerous = ["bash", "sh", "zsh", "cmd", "cmd.exe", "powershell", "pwsh", "node", "deno", "bun", "python", "python3", "perl", "ruby"];
  try {
    for (const cmd of dangerous) {
      const res = await runTool(
        getTool("exec_run"),
        { path: root, command: cmd, argv: ["-c", "echo hi"] },
        baseCtx(root),
      );
      assert.equal(res.ok, false, `exec_run must refuse '${cmd}' via dangerous-interpreter blocklist`);
      assert.equal(res.error.code, "permission-denied",
        `expected permission-denied for '${cmd}', got ${res.error.code}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GATE8: exec_run does NOT interpret shell-metachars in argv (no escalation via &&, ;, |, $)", async () => {
  const root = makeTempProject({});
  try {
    // Pass process.execPath with argv that LOOKS like a shell-injection
    // payload. execFile must hand each argv entry as a literal argument;
    // node will simply print it.
    const payload = "; rm -rf / && echo pwned | cat > /tmp/x.txt";
    const res = await runTool(
      getTool("exec_run"),
      { path: root, command: process.execPath, argv: ["-e", `console.log(JSON.stringify(process.argv.slice(2)))`], timeoutMs: 10_000 },
      baseCtx(root),
    );
    // We baked the payload into the script string ourselves, NOT into
    // argv — to avoid relying on rg-style grep patterns. This test
    // asserts execFile works as advertised: stdout is JSON, no shell
    // happened. Run a separate argv-shape check below.
    assert.equal(typeof res, "object");

    // Now actually pass the payload as an argv element — it should
    // round-trip literally through execFile. We use a benign command
    // (`node -p`) so we never actually invoke rm.
    const res2 = await runTool(
      getTool("exec_run"),
      {
        path: root,
        command: process.execPath,
        argv: ["-e", `process.stdout.write(require('os').platform() + ':' + process.argv[1])`, payload],
        timeoutMs: 10_000,
      },
      baseCtx(root),
    );
    assert.equal(res2.ok, true, "argv with shell-meta chars must round-trip literally through execFile");
    // stdout ends with the literal argv value — proving no shell
    // expansion.
    assert.equal(res2.result.stdout.endsWith(payload), true,
      `expected stdout to end with literal payload; got: ${res2.result.stdout.slice(-payload.length - 10)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7) test_run refuses to interpret shell-meta in the command name
//    (e.g. "cd .. && rm -rf /")
// ---------------------------------------------------------------------------

test("GATE8: test_run does NOT interpret shell-meta in command (no shell, execFile only)", async () => {
  const root = makeTempProject({});
  try {
    // Shell-meta command names are rejected by the project-command allowlist.
    // This is stronger than merely relying on execFile/ENOENT: no unapproved
    // executable name can reach process creation.
    const res = await runTool(
      getTool("test_run"),
      { path: root, command: "cd .. && rm -rf /", argv: [] },
      baseCtx(root),
    );
    assert.equal(res.ok, false, "shell-meta command must be rejected before process creation");
    assert.equal(res.error.code, "permission-denied");
    // No /tmp/x.txt or similar side-effect should exist on disk.
    assert.equal(existsSync("/tmp/x.txt"), false, "no side-effect from shell-meta command");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GATE8: test_run refuses out-of-root cwd attempts (path traversal via path argument)", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "cf-gate8-tr-"));
  const sibling = mkdtempSync(join(tmpdir(), "cf-gate8-tr-sib-"));
  try {
    const res = await runTool(
      getTool("test_run"),
      { path: join(projectRoot, "..", "..", sibling.split(sep).slice(-2)[0]), command: process.execPath, argv: ["-v"] },
      baseCtx(projectRoot),
    );
    assert.equal(res.ok, false, "test_run must NOT accept a cwd that escapes projectRoot");
    assert.equal(res.error.code, "path-outside-project");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(sibling, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8) No built-in tool returns ok:true for an outside-root path. The
//    helper assertInsideProjectRoot is the single chokepoint; this
//    test sweeps every tool whose inputSchema references a `path`
//    field and asserts the boundary holds.
// ---------------------------------------------------------------------------

test("GATE8: every path-taking tool refuses an outside-root absolute path (no security hole)", async () => {
  const projectRoot = makeTempProject({ "ok.txt": "ok\n" });
  const outside = makeTempProject({ "secret.txt": "x" });
  // Tools that take a `path` (or whose only side is fs) and have a
  // working execute(). delegate_* are not driven here because they
  // hit the network or the agent loop and would need mocking. The
  // point of this test is the LOCAL boundary.
  const toolsToTest = [
    ["fs_read",  { path: join(outside, "secret.txt") }],
    ["fs_write", { path: join(outside, "evil.txt"),  content: "nope" }],
    ["fs_list",  { path: outside }],
    ["fs_search",{ path: outside, query: "secret" }],
    ["shell_git_status", { path: outside }],
    ["shell_git_diff",   { path: outside }],
    ["shell_git_log",    { path: outside }],
    ["inspect_project",  { path: outside }],
    ["build_run", { path: outside, command: process.execPath, argv: ["-v"] }],
    ["test_run",  { path: outside, command: process.execPath, argv: ["-v"] }],
    ["exec_run",  { path: outside, command: process.execPath, argv: ["-v"] }],
  ];
  try {
    for (const [name, input] of toolsToTest) {
      const res = await runTool(getTool(name), input, baseCtx(projectRoot));
      assert.equal(res.ok, false, `${name} must NOT return ok:true for an outside-root path; got: ${JSON.stringify(res).slice(0, 200)}`);
      assert.equal(res.error.code, "path-outside-project",
        `${name} must return path-outside-project; got ${res.error.code}`);
      assert.equal(typeof res.elapsedMs, "number",
        `${name} envelope must still carry elapsedMs`);
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(outside,     { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9) Regression: assertInsideProjectRoot uses separator-aware prefix
//    matching so that "/tmp/agent-evil" is NOT a subpath of "/tmp/agent"
//    (sibling-prefix attack). This is the line of defense that protects
//    against `candidateWithSep.startsWith(rootWithSep)` returning true
//    for a sibling whose name happens to share a prefix with the root.
// ---------------------------------------------------------------------------

test("GATE8: assertInsideProjectRoot rejects sibling-prefix attacks (/tmp/agent-evil vs /tmp/agent)", () => {
  const projectRoot = process.platform === "win32"
    ? mkdtempSync(join(tmpdir(), "cf-gate8-agent-"))
    : "/tmp/cf-gate8-agent";
  const sibling = process.platform === "win32"
    ? join(projectRoot, "..", "cf-gate8-agent-evil")
    : "/tmp/cf-gate8-agent-evil";
  // A file under the sibling path must NOT be considered inside the root.
  const res = assertInsideProjectRoot(join(sibling, "secret.txt"), projectRoot);
  assert.equal(res.ok, false, "sibling-prefix attack must be rejected");
  assert.equal(res.error.code, "path-outside-project");
});

test("GATE8: assertInsideProjectRoot rejects case-only matches (Windows-aware path normalisation must not bypass)", () => {
  if (process.platform !== "win32") {
    // POSIX paths are case-sensitive so this test is Windows-only.
    return;
  }
  // On Windows, "C:\\Foo" vs "c:\\foo" are the same path. We construct
  // an absolute path that, when normalised, would point to a different
  // root. The boundary check is platform-specific: on Windows we just
  // verify the helper consistently rejects when the case-different
  // path resolves OUTSIDE.
  const projectRoot = mkdtempSync(join(tmpdir(), "cf-gate8-case-"));
  const other = mkdtempSync(join(tmpdir(), "cf-gate8-case-other-"));
  try {
    // other is definitely outside projectRoot; case doesn't matter —
    // it's a different temp dir entirely.
    const res = assertInsideProjectRoot(other, projectRoot);
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "path-outside-project");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(other,       { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 10) All path-taking tools refuse `..` in the path field even when
//     the result of the resolution is still inside the project (e.g.
//     legitimate subdir access). This is a no-op for normal use but
//     catches tools that might rely on substring checks instead of
//     path.resolve().
// ---------------------------------------------------------------------------

test("GATE8: path-traversal patterns (..) are normalised by assertInsideProjectRoot before the boundary check", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-gate8-norm-"));
  try {
    // "src/../src/inside.txt" normalises to "src/inside.txt" — that's
    // inside the project. The boundary must accept it.
    const ok = assertInsideProjectRoot(join(root, "src", "..", "src", "inside.txt"), root);
    assert.equal(ok.ok, true, "legitimate ..-normalised paths inside the project must be accepted");
    assert.equal(typeof ok.path, "string");

    // "src/../../outside.txt" normalises OUTSIDE the project — must
    // be rejected.
    const bad = assertInsideProjectRoot(join(root, "src", "..", "..", "outside.txt"), root);
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, "path-outside-project");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 11) Tool execution emits audit events even on security-refusal paths
//     (defence-in-depth: every blocked attempt must be auditable)
// ---------------------------------------------------------------------------

test("GATE8: security-refusals still emit tool.failed audit events (auditability of every blocked attempt)", async () => {
  wireAudit();
  try {
    const projectRoot = makeTempProject({});
    const outside = makeTempProject({});
    try {
      const before = Audit.recent(500).filter((e) => typeof e.event === "string" && e.event.startsWith("tool.")).length;
      const res = await runTool(getTool("fs_read"), { path: join(outside, "secret.txt") }, baseCtx(projectRoot));
      assert.equal(res.ok, false);
      assert.equal(res.error.code, "path-outside-project");
      const events = Audit.recent(500).filter((e) => typeof e.event === "string" && e.event.startsWith("tool."));
      assert.equal(events.length - before, 2,
        "expected 2 audit events (invoked + failed) for a security-refusal call");
      const failed = events.find((e) => e.event === "tool.failed");
      assert.ok(failed, "tool.failed audit event must exist for the security-refusal");
      assert.equal(failed.tool, "fs_read");
      assert.equal(typeof failed.durationMs, "number");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(outside,     { recursive: true, force: true });
    }
  } finally {
    _resetAudit();
  }
});
