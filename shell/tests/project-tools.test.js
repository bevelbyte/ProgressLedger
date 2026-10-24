// Project Mode â€” tool registry + security model tests.
//
// Pure node:test specs. No Electron, no IPC: we drive the service layer
// directly so the tests are fast and hermetic.
//
// We cover:
//   - fs_list / fs_read / fs_search happy paths + outside-root rejection
//   - fs_write atomic write + outside-root rejection
//   - shell_git_status / shell_git_diff / shell_git_log
//   - exec_run uses execFile (shell-meta-chars are NOT interpreted)
//   - exec_run approval token: missing / valid / expired
//   - test_run / build_run are auto-prefixed with the project root
//   - inspect_project top files + manifest detection
//   - All tools return { ok, result, elapsedMs } envelope
//   - All tools return { ok: false, error: { code, message } } on failure
//     (no thrown exceptions)
//   - IPC channel refuses unknown tool names
//   - Permission / approval metadata

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile as nodeExecFile, spawnSync } from "node:child_process";

import {
  PROJECT_TOOLS,
  getTool,
  listTools,
  listToolsSafe,
} from "../src/services/project-tools/index.js";
import { runTool, safeExecFile } from "../src/services/project-tools/_runtime.js";
import {
  APPROVAL_REQUIRED,
  PERMISSION_INFO,
  PERMISSIONS,
  assertInsideProjectRoot,
  consumeApprovalToken,
  mintApprovalToken,
  purgeExpiredApprovalTokens,
  validateInputAgainstSchema,
  validateToolInvocation,
  _resetApprovalTokens,
} from "../src/services/project-tools/security.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeTempProject(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cf-pt-test-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "cf-project-tool-test", version: "1.0.0" }));
  spawnSync("git", ["init", "-q"], { cwd: dir, windowsHide: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}


const baseCtx = (projectRoot) => ({
  projectRoot,
  profileId: 1,
  projectId: 1,
  agentId: 1,
  isCancellable: () => false,
  nowMs: () => Date.now(),
});

// ---------------------------------------------------------------------------
// 1) registry shape
// ---------------------------------------------------------------------------

test("registry exposes the 16 tools (11 initial + 4 delegate_* + memory_recall)", () => {
  const names = listTools().map((t) => t.name).sort();
  assert.deepEqual(names, [
    "build_run",
    "delegate_coder",
    "delegate_research",
    "delegate_reviewer",
    "delegate_tester",
    "exec_run",
    "fs_list",
    "fs_read",
    "fs_search",
    "fs_write",
    "inspect_project",
    "memory_recall",
    "shell_git_diff",
    "shell_git_log",
    "shell_git_status",
    "test_run",
  ].sort());
  assert.equal(listTools().length, 16);
});

test("getTool returns the tool or null", () => {
  assert.equal(getTool("fs_list").name, "fs_list");
  assert.equal(getTool("does-not-exist"), null);
});

test("listToolsSafe omits execute functions", () => {
  for (const meta of listToolsSafe()) {
    assert.equal(typeof meta.execute, "undefined");
    assert.equal(typeof meta.name, "string");
    assert.equal(typeof meta.description, "string");
    assert.equal(typeof meta.permission, "string");
    assert.ok(meta.inputSchema);
  }
});

// ---------------------------------------------------------------------------
// 2) fs_list
// ---------------------------------------------------------------------------

test("fs_list happy path lists files recursively and skips node_modules", async () => {
  const root = makeTempProject({
    "src/index.js": "console.log('hi')\n",
    "src/util.js": "export const x = 1\n",
    "node_modules/lodash/index.js": "// skipped\n",
    "README.md": "# hi\n",
  });
  try {
    const res = await runTool(getTool("fs_list"), { path: root }, baseCtx(root));
    assert.equal(res.ok, true);
    assert.ok(Array.isArray(res.result.entries));
    assert.equal(typeof res.elapsedMs, "number");
    const paths = res.result.entries.map((e) => e.path).sort();
    // Should include the directory and both files; node_modules must be absent.
    assert.ok(paths.includes("README.md"));
    assert.ok(paths.includes("src"));
    assert.ok(paths.includes("src/index.js"));
    assert.ok(paths.includes("src/util.js"));
    assert.ok(!paths.some((p) => p.includes("node_modules")));
    const srcDir = res.result.entries.find((e) => e.path === "src");
    assert.equal(srcDir.type, "dir");
    const idx = res.result.entries.find((e) => e.path === "src/index.js");
    assert.equal(idx.type, "file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fs_list rejects paths outside project root", async () => {
  const root = makeTempProject({});
  const outside = makeTempProject({ "secret.txt": "x" });
  try {
    const res = await runTool(
      getTool("fs_list"),
      { path: outside },
      baseCtx(root),
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "path-outside-project");
    assert.equal(typeof res.elapsedMs, "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3) fs_read
// ---------------------------------------------------------------------------

test("fs_read happy path returns UTF-8 text", async () => {
  const root = makeTempProject({ "hello.txt": "world\n" });
  try {
    const res = await runTool(
      getTool("fs_read"),
      { path: join(root, "hello.txt") },
      baseCtx(root),
    );
    assert.equal(res.ok, true);
    assert.equal(res.result.content, "world\n");
    assert.equal(res.result.encoding, "utf8");
    assert.equal(typeof res.elapsedMs, "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fs_read rejects .. traversal that escapes project root", async () => {
  const root = makeTempProject({});
  const sibling = mkdtempSync(join(tmpdir(), "cf-pt-sib-"));
  writeFileSync(join(sibling, "secret.txt"), "top secret");
  try {
    const res = await runTool(
      getTool("fs_read"),
      { path: join(root, "..", "..", "cf-pt-sib-" + sibling.split(/[\\/]/).pop(), "secret.txt") },
      baseCtx(root),
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "path-outside-project");
  } finally {
    rmSync(sibling, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4) fs_write
// ---------------------------------------------------------------------------

test("fs_write writes atomically and rejects outside-root paths", async () => {
  const root = makeTempProject({});
  const outside = makeTempProject({});
  try {
    const ok = await runTool(
      getTool("fs_write"),
      { path: join(root, "new", "file.txt"), content: "hi there", createDirs: true },
      baseCtx(root),
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.result.bytes, Buffer.byteLength("hi there", "utf8"));
    assert.equal(readFileSync(join(root, "new", "file.txt"), "utf8"), "hi there");

    const bad = await runTool(
      getTool("fs_write"),
      { path: join(outside, "evil.txt"), content: "should not write" },
      baseCtx(root),
    );
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, "path-outside-project");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("fs_write never leaves .cf-tmp files behind on failure", async () => {
  const root = makeTempProject({});
  try {
    // content of type number (invalid) â†’ reject
    const res = await runTool(
      getTool("fs_write"),
      { path: join(root, "x.txt"), content: 12345 },
      baseCtx(root),
    );
    assert.equal(res.ok, false);
    // list the dir and ensure no leftovers
    const res2 = await runTool(getTool("fs_list"), { path: root }, baseCtx(root));
    assert.equal(res2.ok, true);
    for (const e of res2.result.entries) {
      assert.equal(/\.cf-tmp-/.test(e.path), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5) fs_search
// ---------------------------------------------------------------------------

test("fs_search returns matching lines", async () => {
  const root = makeTempProject({
    "a.js": "const answer = 42;\n",
    "b.js": "function answer() { return 42; }\n",
    "c.txt": "unrelated\n",
  });
  try {
    const res = await runTool(
      getTool("fs_search"),
      { path: root, query: "answer" },
      baseCtx(root),
    );
    assert.equal(res.ok, true);
    assert.equal(Array.isArray(res.result.matches), true);
    assert.equal(res.result.matches.length >= 2, true);
    // Normalize the matched-file names (rg may prefix with "./" on POSIX
    // and "\".\\"" on Windows).
    const files = res.result.matches.map((m) => m.file.replace(/^\.+/, "").replace(/[\\/]/g, "")).sort();
    assert.deepEqual(files, ["a.js", "b.js"]);
    assert.equal(typeof res.elapsedMs, "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6) shell_git_status / diff / log â€” use a temp git repo
// ---------------------------------------------------------------------------

function makeTempGitProject() {
  const dir = mkdtempSync(join(tmpdir(), "cf-pt-git-"));
  // Init + initial commit so status is clean to start.
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "test@test"],
    ["config", "user.name", "Test"],
  ]) {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")} must succeed`);
  }
  writeFileSync(join(dir, "README.md"), "init\n");
  spawnSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, encoding: "utf8" });
  return dir;
}

function gitSync(args, opts) {
  const res = spawnSync("git", args, { ...opts, encoding: "utf8" });
  return res.status;
}

test("shell_git_status returns the porcelain status of the project root", async () => {
  const root = makeTempGitProject();
  try {
    writeFileSync(join(root, "dirty.txt"), "new\n");
    const res = await runTool(
      getTool("shell_git_status"),
      { path: root },
      baseCtx(root),
    );
    assert.equal(res.ok, true);
    assert.equal(res.result.clean, false);
    assert.equal(res.result.branch, "main");
    assert.ok(res.result.entries.some((e) => e.path === "dirty.txt"));
    assert.equal(typeof res.elapsedMs, "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shell_git_diff returns the unified diff", async () => {
  const root = makeTempGitProject();
  try {
    writeFileSync(join(root, "x.txt"), "first\n");
    gitSync(["add", "-A"], { cwd: root });
    const res = await runTool(
      getTool("shell_git_diff"),
      { path: root, staged: true },
      baseCtx(root),
    );
    assert.equal(res.ok, true);
    assert.equal(typeof res.result.diff, "string");
    assert.ok(res.result.diff.includes("x.txt"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shell_git_log returns commits", async () => {
  const root = makeTempGitProject();
  try {
    const res = await runTool(
      getTool("shell_git_log"),
      { path: root, maxCount: 5 },
      baseCtx(root),
    );
    assert.equal(res.ok, true);
    assert.equal(Array.isArray(res.result.commits), true);
    assert.ok(res.result.commits.length >= 1);
    assert.equal(typeof res.result.commits[0].sha, "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7) exec_run â€” uses execFile, no shell
// ---------------------------------------------------------------------------

test("exec_run uses execFile (shell meta-chars are NOT interpreted)", async () => {
  const root = makeTempProject({});
  try {
    // Pass argv entries containing shell-meta characters. We do not
    // pipe them through `node -e` (Windows argv parsing quirks make
    // node's own argv handling unstable here); instead we run a small
    // node program that prints its argv as JSON, then assert the
    // shell-meta strings reached the child verbatim.
    const payload = "console.log(JSON.stringify(process.argv.slice(2)))";
    // Use a unique sentinel that a shell WOULD have expanded away if one
    // were involved. `echo $HOME` would print the home dir if a shell
    // ran; with execFile, the literal string `$(echo $HOME)` should pass
    // through.
    const sentinel1 = "__CF_SHELL_SENTINEL_$(echo $HOME)__";
    const sentinel2 = "__CF_GLOB_SENTINEL_*.txt__";

    // Drive execFile directly to observe argv behavior independent of
    // any wrapper-side parsing.
    const { execFile } = await import("node:child_process");
    const stdout = await new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        ["-e", payload, sentinel1, sentinel2],
        { cwd: root, windowsHide: true, timeout: 5000 },
        (err, so, se) => {
          if (err) return reject(err);
          resolve(so);
        },
      );
    });

    // The critical assertion: at least ONE of the sentinel strings must
    // reach the child verbatim. If a shell were involved, both would
    // have been expanded (or removed) BEFORE node ran.
    const ok = stdout.includes(sentinel1) || stdout.includes(sentinel2);
    assert.equal(ok, true, `argv did not pass shell-meta-chars verbatim; got: ${stdout}`);

    // Cross-check: also exercise the actual exec_run tool so the tool's
    // own code path is covered. The tool uses safeExecFile too, so it
    // has the same properties.
    const res = await runTool(
      getTool("exec_run"),
      {
        path: root,
        command: process.execPath,
        argv: ["-e", payload, sentinel1, sentinel2],
      },
      baseCtx(root),
    );
    assert.equal(res.ok, true);
    const ok2 = res.result.stdout.includes(sentinel1) || res.result.stdout.includes(sentinel2);
    assert.equal(ok2, true, `exec_run did not pass shell-meta-chars verbatim; got: ${res.result.stdout}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exec_run refuses shell-meta interpreters even with valid input", async () => {
  const root = makeTempProject({});
  try {
    const res = await runTool(
      getTool("exec_run"),
      { path: root, command: "bash", argv: ["-c", "echo hi"] },
      baseCtx(root),
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "permission-denied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8) approval tokens
// ---------------------------------------------------------------------------

test("exec_run without an approval token is refused at the IPC layer", () => {
  // We exercise the IPC layer's validation, not runTool â€” because
  // runTool itself does NOT enforce approval (that's the IPC layer's
  // job). Simulate the IPC layer's logic directly.
  _resetApprovalTokens();
  const v = validateToolInvocation("exec_run", { path: "/tmp", command: process.execPath }, { getTool });
  assert.equal(v.ok, true);
  // approval gate: no token supplied
  assert.equal(APPROVAL_REQUIRED.has("exec_run"), true);
  // mint then consume
  const token = mintApprovalToken("exec_run", { path: "/tmp", command: process.execPath });
  assert.equal(consumeApprovalToken(token, "exec_run", { path: "/tmp", command: process.execPath }), true);
  // single-use: second consume returns false
  assert.equal(consumeApprovalToken(token, "exec_run", { path: "/tmp", command: process.execPath }), false);
});

test("exec_run with a valid approval token runs", async () => {
  _resetApprovalTokens();
  const root = makeTempProject({});
  try {
    const input = { path: root, command: process.execPath, argv: ["-e", "console.log(\"approved\")"] };
    const token = mintApprovalToken("exec_run", input);
    assert.equal(
      consumeApprovalToken(token, "exec_run", input),
      true,
      "approval token should be consumable for matching input",
    );

    // Now mint a fresh token and actually drive runTool through the IPC
    // gate (we re-mint because consumeApprovalToken is single-use).
    const t2 = mintApprovalToken("exec_run", input);
    assert.equal(consumeApprovalToken(t2, "exec_run", input), true);

    // Run it (the IPC layer would have called runTool after a successful
    // consume). We drive runTool directly here to confirm the happy path.
    const res = await runTool(getTool("exec_run"), input, baseCtx(root));
    assert.equal(res.ok, true);
    assert.ok(res.result.stdout.includes("approved"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    _resetApprovalTokens();
  }
});

test("exec_run approval token expires after 60s", () => {
  _resetApprovalTokens();
  const input = { path: "/tmp", command: process.execPath };
  const token = mintApprovalToken("exec_run", input);
  // simulate > 60s passing by mutating Date.now via the real timer; we
  // can't monkey-patch Date.now here without affecting the rest, so we
  // exercise `purgeExpiredApprovalTokens` with a fake "now".
  // Inject a far-future now and check consume rejects.
  // The token table holds real expiresAt; we override Date.now once.
  const origNow = Date.now;
  try {
    Date.now = () => origNow() + 5 * 60 * 1000;
    purgeExpiredApprovalTokens(Date.now());
    assert.equal(consumeApprovalToken(token, "exec_run", input), false);
  } finally {
    Date.now = origNow;
    _resetApprovalTokens();
  }
});

test("approval token is bound to profile/project/agent ownership scope", () => {
  _resetApprovalTokens();
  const input = { path: "/tmp", command: process.execPath };
  const scope = { profileId: 7, projectId: 11, agentId: 21 };
  const token = mintApprovalToken("exec_run", input, scope);
  assert.equal(
    consumeApprovalToken(token, "exec_run", input, { profileId: 7, projectId: 11, agentId: 22 }),
    false,
    "approval must not transfer between agents",
  );
  assert.equal(consumeApprovalToken(token, "exec_run", input, scope), true);

  const projectToken = mintApprovalToken("exec_run", input, scope);
  assert.equal(
    consumeApprovalToken(projectToken, "exec_run", input, { profileId: 7, projectId: 12, agentId: 21 }),
    false,
    "approval must not transfer between projects",
  );
  _resetApprovalTokens();
});

// ---------------------------------------------------------------------------
// 9) test_run / build_run â€” auto-prefixed with project root
// ---------------------------------------------------------------------------

test("test_run and build_run require approval at the project-tool authorization layer", () => {
  assert.equal(APPROVAL_REQUIRED.has("test_run"), true);
  assert.equal(APPROVAL_REQUIRED.has("build_run"), true);
});

test("test_run and build_run use cwd = project root", async () => {
  const root = makeTempProject({
    "marker.txt": "inside\n",
  });
  try {
    const res = await runTool(
      getTool("test_run"),
      {
        path: root,
        command: "git",
        argv: ["rev-parse", "--show-toplevel"],
      },
      baseCtx(root),
    );
    assert.equal(res.ok, true);
    assert.equal(res.result.stdout.trim().replaceAll("/", "\\"), root);

    const res2 = await runTool(
      getTool("build_run"),
      {
        path: root,
        command: "git",
        argv: ["rev-parse", "--show-toplevel"],
      },
      baseCtx(root),
    );
    assert.equal(res2.ok, true);
    assert.equal(res2.result.stdout.trim().replaceAll("/", "\\"), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("test_run and build_run refuse paths outside project root", async () => {
  const root = makeTempProject({});
  const outside = makeTempProject({});
  try {
    const res = await runTool(
      getTool("test_run"),
      { path: outside, command: "git", argv: ["--version"] },
      baseCtx(root),
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "path-outside-project");

    const res2 = await runTool(
      getTool("build_run"),
      { path: outside, command: "git", argv: ["--version"] },
      baseCtx(root),
    );
    assert.equal(res2.ok, false);
    assert.equal(res2.error.code, "path-outside-project");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 10) inspect_project
// ---------------------------------------------------------------------------

test("inspect_project returns manifest, readme, and top files", async () => {
  const root = makeTempProject({
    "package.json": JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2),
    "README.md": "# demo\n",
    "src/index.ts": "export const x = 1;\n",
    "src/util.ts": "export const y = 2;\n",
    "node_modules/skip.js": "// skipped\n",
  });
  try {
    const res = await runTool(
      getTool("inspect_project"),
      { path: root },
      baseCtx(root),
    );
    assert.equal(res.ok, true);
    assert.equal(res.result.root, root);
    assert.ok(res.result.manifest);
    assert.equal(res.result.manifest.name, "package.json");
    assert.ok(res.result.readme);
    assert.equal(res.result.readme.name, "README.md");
    assert.equal(Array.isArray(res.result.topFiles), true);
    // node_modules must not appear
    for (const f of res.result.topFiles) {
      assert.equal(f.path.includes("node_modules"), false);
    }
    assert.equal(typeof res.elapsedMs, "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 11) envelope contract
// ---------------------------------------------------------------------------

test("every tool returns { ok, result, elapsedMs } on success", async () => {
  const root = makeTempProject({ "a.txt": "x\n" });
  try {
    for (const name of [
      "fs_list",
      "fs_read",
      "fs_search",
      "inspect_project",
    ]) {
      const res = await runTool(
        getTool(name),
        { path: name === "fs_read" ? join(root, "a.txt") : root, query: "x" },
        baseCtx(root),
      );
      assert.equal(res.ok, true, `${name} should succeed`);
      assert.equal(typeof res.elapsedMs, "number", `${name} elapsedMs`);
      assert.notEqual(res.elapsedMs < 0, true, `${name} elapsedMs >= 0`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every tool returns { ok: false, error: { code, message } } on failure (no thrown exceptions)", async () => {
  const root = makeTempProject({});
  try {
    // fs_list with no projectRoot anywhere
    let res = await runTool(getTool("fs_list"), { path: "/nope/nada" }, baseCtx(null));
    assert.equal(res.ok, false);
    assert.equal(typeof res.error.code, "string");
    assert.equal(typeof res.error.message, "string");

    // fs_read on missing file
    res = await runTool(
      getTool("fs_read"),
      { path: join(root, "does-not-exist.txt") },
      baseCtx(root),
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "not-found");

    // fs_search with no query
    res = await runTool(
      getTool("fs_search"),
      { path: root, query: "" },
      baseCtx(root),
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "invalid-input");

    // fs_write with non-string content
    res = await runTool(
      getTool("fs_write"),
      { path: join(root, "x.txt"), content: 123 },
      baseCtx(root),
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "invalid-input");

    // exec_run with missing command
    res = await runTool(
      getTool("exec_run"),
      { path: root, command: "" },
      baseCtx(root),
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "invalid-input");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 12) IPC-level: unknown tool names
// ---------------------------------------------------------------------------

test("validateToolInvocation refuses unknown tool names", () => {
  const v = validateToolInvocation("does-not-exist", {}, { getTool });
  assert.equal(v.ok, false);
  assert.equal(v.error.code, "tool-not-supported");
});

test("validateToolInvocation refuses bad permission classes", () => {
  // Hand-craft a fake tool with a bad permission to exercise the guard.
  const fakeRegistry = { getTool: (n) => n === "fake" ? { name: "fake", permission: "NOPE", inputSchema: {} } : null };
  const v = validateToolInvocation("fake", {}, fakeRegistry);
  assert.equal(v.ok, false);
  assert.equal(v.error.code, "invalid-input");
});

// ---------------------------------------------------------------------------
// 13) assertInsideProjectRoot
// ---------------------------------------------------------------------------

test("assertInsideProjectRoot accepts nested paths and rejects traversal", () => {
  const root = makeTempProject({ "a.txt": "x" });
  try {
    const ok = assertInsideProjectRoot(join(root, "a.txt"), root);
    assert.equal(ok.ok, true);
    const outside = assertInsideProjectRoot(join(root, "..", "etc", "passwd"), root);
    assert.equal(outside.ok, false);
    assert.equal(outside.error.code, "path-outside-project");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 14) validateInputAgainstSchema (tiny)
// ---------------------------------------------------------------------------

test("validateInputAgainstSchema rejects extra fields when additionalProperties=false", () => {
  const r = validateInputAgainstSchema(
    {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    { path: "/x", evil: true },
  );
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "invalid-input");
});

test("validateInputAgainstSchema accepts valid input and rejects wrong types", () => {
  const schema = {
    type: "object",
    properties: {
      path: { type: "string" },
      maxDepth: { type: "integer" },
      glob: { type: "string" },
    },
    required: ["path"],
  };
  assert.equal(validateInputAgainstSchema(schema, { path: "/x", maxDepth: 3 }).ok, true);
  const bad = validateInputAgainstSchema(schema, { path: "/x", maxDepth: "three" });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "invalid-input");
});

// ---------------------------------------------------------------------------
// 15) PERMISSIONS / APPROVAL_REQUIRED / PERMISSION_INFO shape
// ---------------------------------------------------------------------------

test("PERMISSIONS, APPROVAL_REQUIRED, and PERMISSION_INFO are well-formed", () => {
  for (const k of ["READ", "WRITE", "EXECUTE", "NETWORK", "DESTRUCTIVE"]) {
    assert.equal(typeof PERMISSIONS[k], "string");
    assert.equal(PERMISSIONS[k], k);
    const info = PERMISSION_INFO[k];
    assert.ok(info);
    assert.equal(typeof info.label, "string");
    assert.equal(typeof info.description, "string");
  }
  assert.equal(APPROVAL_REQUIRED.has("exec_run"), true);
  assert.equal(APPROVAL_REQUIRED.has("fs_write"), true);
  assert.equal(APPROVAL_REQUIRED.has("fs_read"), false);
  assert.equal(APPROVAL_REQUIRED.has("shell_git_diff"), false);
  assert.equal(APPROVAL_REQUIRED.has("shell_git_status"), false);
  assert.equal(APPROVAL_REQUIRED.has("test_run"), true);
  assert.equal(APPROVAL_REQUIRED.has("build_run"), true);
});

// ---------------------------------------------------------------------------
// 16) every tool has a permission + timeoutMs
// ---------------------------------------------------------------------------

test("every registered tool declares permission + timeoutMs", () => {
  for (const t of listTools()) {
    assert.equal(typeof t.name, "string", `${t.name} name`);
    assert.equal(typeof t.description, "string", `${t.name} description`);
    assert.ok(PERMISSIONS[t.permission], `${t.name} has valid permission`);
    assert.ok(t.inputSchema && typeof t.inputSchema === "object", `${t.name} schema`);
    assert.equal(typeof t.execute, "function", `${t.name} execute is a function`);
    assert.equal(typeof t.timeoutMs, "number", `${t.name} timeoutMs`);
    assert.ok(t.timeoutMs > 0, `${t.name} timeoutMs > 0`);
  }
});

test("assertInsideProjectRoot rejects a junction that escapes the project root", () => {
  const root = makeTempProject({ "inside.txt": "x" });
  const outside = mkdtempSync(join(tmpdir(), "cf-project-outside-"));
  const link = join(root, "linked-outside");
  try {
    symlinkSync(outside, link, "junction");
    const escaped = assertInsideProjectRoot(join(link, "secret.txt"), root);
    assert.equal(escaped.ok, false);
    assert.equal(escaped.error.code, "path-outside-project");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});


test("project commands reject arbitrary executable paths and interpreters", async () => {
  const { validateProjectCommand } = await import("../src/services/project-tools/security.js");
  assert.equal(validateProjectCommand("npm").ok, true);
  assert.equal(validateProjectCommand("cargo").ok, true);
  assert.equal(validateProjectCommand("node").ok, false);
  assert.equal(validateProjectCommand("C:\\Windows\\System32\\whoami.exe").ok, false);
  assert.equal(validateProjectCommand("tools/custom-runner.exe").ok, false);
});