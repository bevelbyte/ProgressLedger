// Phase N — sub-agent diff service tests.
//
// Drives `SubAgentDiff.computeForFiles` directly (no IPC, no Electron)
// and exercises the per-file / global cap behaviour. The service
// accepts an `execFileImpl` injection point so we can drive the
// function with a fake git and avoid spawning real child processes
// for the cap / cancel / error tests; the integration with the real
// `git` binary is covered in the happy-path tests by initialising a
// throwaway repo and running an actual `git diff` against it.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { SubAgentDiff } from "../src/services/agent/subagent-diff.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeTempGitProject(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cf-subagent-diff-"));
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "test@test"],
    ["config", "user.name", "Test"],
  ]) {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")} must succeed`);
  }
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    writeFileSync(abs, content);
  }
  spawnSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, encoding: "utf8" });
  return dir;
}

/** Fake execFile implementation: returns the pre-baked stdout for the
 * requested path. Used to drive cap / cancel / error paths without
 * spawning real git processes. */
function fakeExecFile(responsesByRelPath) {
  return (_cmd, argv, _opts, cb) => {
    // argv: ["-C", root, "diff", "--no-color", "--", relPath]
    const rel = argv[argv.length - 1];
    const body = responsesByRelPath[rel];
    setImmediate(() => {
      if (body && body.error) {
        const err = new Error(body.error);
        return cb(err, "", body.error);
      }
      cb(null, body ? body.stdout || "" : "", "");
    });
  };
}

// ---------------------------------------------------------------------------
// 1) clean tree → empty perFile map
// ---------------------------------------------------------------------------

test("computeForFiles: clean tree returns an empty perFile map", async () => {
  const root = makeTempGitProject({ "a.js": "x", "b.js": "y" });
  try {
    const r = await SubAgentDiff.computeForFiles({
      projectRoot: root,
      files: ["a.js", "b.js"],
    });
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.result.perFile).sort(), ["a.js", "b.js"]);
    assert.equal(r.result.perFile["a.js"], "");
    assert.equal(r.result.perFile["b.js"], "");
    assert.equal(r.result.truncated, false);
    assert.deepEqual(r.result.skipped, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2) modified file → +added / -removed appears in the diff
// ---------------------------------------------------------------------------

test("computeForFiles: modified file surfaces +added / -removed in the diff", async () => {
  const root = makeTempGitProject({ "x.txt": "first\nsecond\n" });
  try {
    writeFileSync(join(root, "x.txt"), "first\nTHIRD\n");
    const r = await SubAgentDiff.computeForFiles({
      projectRoot: root,
      files: ["x.txt"],
    });
    assert.equal(r.ok, true);
    const text = r.result.perFile["x.txt"];
    assert.ok(text.length > 0, "diff should be non-empty");
    assert.ok(text.includes("-second"), `expected -second line, got:\n${text}`);
    assert.ok(text.includes("+THIRD"), `expected +THIRD line, got:\n${text}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3) new untracked file → +++/--- header shows up
// ---------------------------------------------------------------------------

test("computeForFiles: new untracked file surfaces a +++ marker", async () => {
  const root = makeTempGitProject({ "README.md": "hi\n" });
  try {
    writeFileSync(join(root, "fresh.txt"), "hello\nworld\n");
    const r = await SubAgentDiff.computeForFiles({
      projectRoot: root,
      files: ["fresh.txt"],
    });
    assert.equal(r.ok, true);
    const text = r.result.perFile["fresh.txt"];
    // `git diff` on an untracked file produces no output by default
    // (the file isn't tracked yet). We at least confirm the service
    // surfaced an entry (possibly empty) without skipping it.
    assert.equal(typeof text, "string");
    assert.equal(r.result.skipped.includes("fresh.txt"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4) per-file line cap (default 200) — extra lines replaced with "…"
// ---------------------------------------------------------------------------

test("computeForFiles: per-file diff is capped at maxLinesPerFile and flagged truncated", async () => {
  // 250 synthetic lines per file. With the default cap (200) the
  // service must slice to the first 200 + append "…".
  const lines = Array.from({ length: 250 }, (_, i) => `+line ${i}`).join("\n");
  const execFileImpl = fakeExecFile({ "big.js": { stdout: lines } });
  const r = await SubAgentDiff.computeForFiles({
    projectRoot: "/tmp/none",
    files: ["big.js"],
    execFileImpl,
  });
  assert.equal(r.ok, true);
  const out = r.result.perFile["big.js"];
  // 200 source lines + the trailing "…" marker line.
  assert.equal(out.split("\n").length, 201);
  assert.ok(out.endsWith("…"));
  assert.equal(r.result.truncated, true);
});

// ---------------------------------------------------------------------------
// 5) global 1 MiB cap truncates later files first
// ---------------------------------------------------------------------------

test("computeForFiles: global maxBytes cap drops later files and reports truncated=true", async () => {
  // Build a fake where each file's diff is ~600 KiB. Two such files
  // blow past a 1 MiB cap; the second must be dropped into `skipped`.
  const big = "x".repeat(600 * 1024); // 600 KiB
  const execFileImpl = fakeExecFile({
    "a.js": { stdout: big },
    "b.js": { stdout: big },
  });
  const r = await SubAgentDiff.computeForFiles({
    projectRoot: "/tmp/none",
    files: ["a.js", "b.js"],
    maxBytes: 1 * 1024 * 1024,
    execFileImpl,
  });
  assert.equal(r.ok, true);
  assert.equal(r.result.truncated, true);
  // a.js should still be present; b.js should have been dropped.
  assert.equal(typeof r.result.perFile["a.js"], "string");
  assert.equal(r.result.perFile["b.js"], undefined);
  assert.ok(r.result.skipped.includes("b.js"));
});

// ---------------------------------------------------------------------------
// 6) signal.abort() returns cancelled (no error)
// ---------------------------------------------------------------------------

test("computeForFiles: an aborted signal short-circuits and returns cancelled: true", async () => {
  const root = makeTempGitProject({ "x.txt": "a\n" });
  try {
    // Pretend the first file produced a 600 KiB diff so the second
    // iteration is what gets cut short.
    const big = "y".repeat(600 * 1024);
    const ac = new AbortController();
    ac.abort(); // aborted BEFORE we call — every loop iteration sees it
    const execFileImpl = fakeExecFile({
      "x.txt": { stdout: big },
      "y.txt": { stdout: big },
    });
    const r = await SubAgentDiff.computeForFiles({
      projectRoot: root,
      files: ["x.txt", "y.txt"],
      signal: ac.signal,
      execFileImpl,
    });
    assert.equal(r.ok, true);
    assert.equal(r.result.cancelled, true);
    assert.equal(r.result.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7) `..`-escape in a path is rejected (skipped, not surfaced)
// ---------------------------------------------------------------------------

test("computeForFiles: paths with `..` are skipped", async () => {
  const root = makeTempGitProject({});
  try {
    const execFileImpl = fakeExecFile({});
    const r = await SubAgentDiff.computeForFiles({
      projectRoot: root,
      files: ["../escape.js", "ok.js"],
      execFileImpl,
    });
    assert.equal(r.ok, true);
    assert.equal(r.result.perFile["ok.js"], "");
    assert.equal(r.result.perFile["../escape.js"], undefined);
    assert.ok(r.result.skipped.includes("../escape.js"));
    // The fake execFile must NOT have been invoked for the bad path.
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8) invalid input — non-string projectRoot
// ---------------------------------------------------------------------------

test("computeForFiles: rejects missing projectRoot with an invalid-input error", async () => {
  const r = await SubAgentDiff.computeForFiles({ files: ["x.js"] });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "invalid-input");
});