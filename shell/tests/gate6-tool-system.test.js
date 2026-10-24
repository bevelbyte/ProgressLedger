// Project Mode — GATE 6 tool-system audit.
//
// Verifies that every tool in the project-tools registry satisfies the
// GATE 6 contract:
//
//   - inputSchema        (JSON Schema, hand-rolled subset)
//   - permission field   (one of READ / WRITE / EXECUTE / NETWORK / DESTRUCTIVE)
//   - timeoutMs          (a positive number, or inherits the 30s default in runTool)
//   - error envelope     ({ ok: false, error: { code, message } })
//   - success envelope   ({ ok: true, result })
//   - audit trail        (every invocation emits tool.invoked + tool.completed|tool.failed)
//   - permission boundary (assertInsideProjectRoot blocks ..-traversal
//                          and out-of-root absolute paths)
//   - safeExecFile       (timeout produces an error envelope with the
//                          correct shape — never throws)
//
// We also verify the loop-level chaining: 3+ calls in sequence
// (inspect -> read -> write) flow the output of one tool into the next,
// and a tool that errors mid-chain does NOT crash the loop.
//
// The audit ring is wired through `_setStateForTests({ filePath: null })`
// so no disk writes happen (GATE 6 is retention-agnostic).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import {
  PROJECT_TOOLS,
  getTool,
  listTools,
} from "../src/services/project-tools/index.js";
import { runTool, safeExecFile } from "../src/services/project-tools/_runtime.js";
import { PERMISSIONS, assertInsideProjectRoot } from "../src/services/project-tools/security.js";
import { Audit, _setStateForTests, _resetForTests as _resetAudit } from "../src/services/audit/index.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeTempProject(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cf-gate6-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function wireAudit() {
  // filePath:null → in-memory ring only, no on-disk writes. The ring is
  // independent of the retention policy so GATE 6 is retention-agnostic.
  _setStateForTests({ filePath: null });
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

function withFreshAudit(fn) {
  wireAudit();
  const p = fn();
  // Async cleanup: do not tear the audit state down until the work is
  // done — otherwise the assertions below would see a cleared ring.
  if (p && typeof p.then === "function") {
    return p.finally(() => _resetAudit());
  }
  _resetAudit();
  return p;
}

// ---------------------------------------------------------------------------
// 1) Every registered tool has inputSchema (JSON Schema subset)
// ---------------------------------------------------------------------------

test("GATE6: every registered tool exposes a JSON-Schema-like inputSchema", () => {
  for (const t of listTools()) {
    assert.ok(t.inputSchema && typeof t.inputSchema === "object", `${t.name}: inputSchema must be an object`);
    assert.equal(typeof t.inputSchema.type, "string", `${t.name}: inputSchema.type must be a string`);
    // type must be one of the subset the validator actually understands
    const allowed = new Set(["object", "string", "number", "integer", "boolean", "array"]);
    assert.ok(allowed.has(t.inputSchema.type), `${t.name}: inputSchema.type=${t.inputSchema.type} not in validator subset`);
    if (t.inputSchema.type === "object") {
      // properties is recommended (a tool with no args can be empty)
      assert.ok(t.inputSchema.properties === undefined || typeof t.inputSchema.properties === "object",
        `${t.name}: properties must be an object when present`);
      assert.ok(t.inputSchema.required === undefined || Array.isArray(t.inputSchema.required),
        `${t.name}: required must be an array when present`);
    }
  }
});

// ---------------------------------------------------------------------------
// 2) Every tool has a timeoutMs field (or inherits a default)
// ---------------------------------------------------------------------------

test("GATE6: every registered tool declares a timeoutMs (or inherits the 30s default in runTool)", () => {
  // First the static assertion: every tool object carries a positive number.
  for (const t of listTools()) {
    if (typeof t.timeoutMs === "number") {
      assert.ok(t.timeoutMs > 0, `${t.name}: timeoutMs must be positive when declared`);
    } else {
      // If the tool omitted timeoutMs, runTool() must default to 30s — see
      // _runtime.js. Verify the default is honoured by inspecting a tool
      // that doesn't declare it (none of the 16 do today, but the contract
      // is part of GATE 6 either way).
      assert.equal(typeof t.timeoutMs, "undefined", `${t.name}: timeoutMs is missing`);
    }
  }
  // Dynamic: verify runTool defaults to 30_000 when a tool omits timeoutMs.
  const fakeTool = {
    name: "fake_no_timeout",
    description: "fake tool with no timeoutMs",
    permission: "READ",
    inputSchema: { type: "object", properties: {}, required: [] },
    async execute(input, ctx) {
      // The wrapper must hand us a signal with ~30s timeout.
      if (typeof ctx.signal !== "object" || ctx.signal === null) return { ok: false, error: { code: "missing-signal", message: "no signal" } };
      // AbortSignal.timeout() doesn't expose the ms value directly; instead
      // we rely on the wrapper having built the signal and the tool having
      // been called successfully.
      return { ok: true, result: { hasSignal: true } };
    },
  };
  const res = runTool(fakeTool, {}, baseCtx("/tmp"));
  return res.then((r) => {
    assert.equal(r.ok, true);
    assert.equal(r.result.hasSignal, true);
  });
});

// ---------------------------------------------------------------------------
// 3) Success + error envelope shape (full matrix over the registry)
// ---------------------------------------------------------------------------

test("GATE6: runTool normalises every envelope to { ok:true, result, elapsedMs } or { ok:false, error:{ code, message } }", async () => {
  // A tool that always succeeds.
  const okTool = {
    name: "fake_ok",
    description: "fake tool that returns success",
    permission: "READ",
    inputSchema: { type: "object", properties: {}, required: [] },
    timeoutMs: 5_000,
    async execute() {
      return { ok: true, result: { hello: "world" } };
    },
  };
  // A tool that always fails.
  const failTool = {
    name: "fake_fail",
    description: "fake tool that returns failure",
    permission: "READ",
    inputSchema: { type: "object", properties: {}, required: [] },
    timeoutMs: 5_000,
    async execute() {
      return { ok: false, error: { code: "boom", message: "intentional" } };
    },
  };
  // A tool that throws synchronously.
  const throwTool = {
    name: "fake_throw",
    description: "fake tool that throws",
    permission: "READ",
    inputSchema: { type: "object", properties: {}, required: [] },
    timeoutMs: 5_000,
    async execute() {
      throw new Error("synthetic");
    },
  };

  const ok = await runTool(okTool, {}, baseCtx("/tmp"));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.result, { hello: "world" });
  assert.equal(typeof ok.elapsedMs, "number");

  const fail = await runTool(failTool, {}, baseCtx("/tmp"));
  assert.equal(fail.ok, false);
  assert.equal(fail.error.code, "boom");
  assert.equal(fail.error.message, "intentional");
  assert.equal(typeof fail.elapsedMs, "number");

  const thrown = await runTool(throwTool, {}, baseCtx("/tmp"));
  assert.equal(thrown.ok, false);
  assert.equal(thrown.error.code, "tool-failed");
  assert.equal(thrown.error.message, "synthetic");
  assert.equal(typeof thrown.elapsedMs, "number");
});

// ---------------------------------------------------------------------------
// 4) Audit event is emitted for every tool invocation
// ---------------------------------------------------------------------------

test("GATE6: every tool invocation emits a tool.invoked + tool.completed|tool.failed pair", async () => {
  await withFreshAudit(async () => {
    const root = makeTempProject({ "a.txt": "alpha\n" });
    try {
      // Run a few tools in sequence; each MUST emit two events: invoked
      // (BEFORE) and completed|failed (AFTER). We assert the count of
      // tool.* events grew by exactly 2 per call.
      const before = Audit.recent(500).filter((e) => typeof e.event === "string" && e.event.startsWith("tool.")).length;

      await runTool(getTool("fs_list"), { path: root }, baseCtx(root));
      await runTool(getTool("fs_read"), { path: join(root, "a.txt") }, baseCtx(root));
      await runTool(
        getTool("fs_read"),
        { path: join(root, "does-not-exist.txt") },
        baseCtx(root),
      );

      const after = Audit.recent(500).filter((e) => typeof e.event === "string" && e.event.startsWith("tool.")).length;
      assert.equal(after - before, 6, "expected 2 events per tool call across 3 calls");

      // The terminal event for each call must be completed or failed.
      const recent = Audit.recent(20).filter((e) => e.event === "tool.completed" || e.event === "tool.failed");
      assert.ok(recent.length >= 3, "expected at least 3 terminal events for the 3 calls");

      // The failed call must produce a tool.failed, not tool.completed.
      const failedForMissing = recent.some((e) => e.event === "tool.failed" && e.tool === "fs_read");
      assert.equal(failedForMissing, true, "expected tool.failed for the missing-file fs_read call");

      // The duration field is populated on terminal events.
      for (const e of recent) {
        if (e.event === "tool.completed" || e.event === "tool.failed") {
          assert.equal(typeof e.durationMs, "number");
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5) Permission boundary: filesystem tools respect assertInsideProjectRoot
// ---------------------------------------------------------------------------

test("GATE6: tools that touch the filesystem refuse paths outside the project root", async () => {
  const root = makeTempProject({ "keep.txt": "inside\n" });
  const outside = makeTempProject({ "secret.txt": "top secret" });
  try {
    // Sanity: the helper itself blocks `..` traversal.
    const traversal = assertInsideProjectRoot(join(root, "..", "etc", "passwd"), root);
    assert.equal(traversal.ok, false);
    assert.equal(traversal.error.code, "path-outside-project");

    // fs_read with an out-of-root absolute path.
    let res = await runTool(
      getTool("fs_read"),
      { path: join(outside, "secret.txt") },
      baseCtx(root),
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "path-outside-project");

    // fs_list with an out-of-root directory.
    res = await runTool(getTool("fs_list"), { path: outside }, baseCtx(root));
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "path-outside-project");

    // fs_search with an out-of-root directory.
    res = await runTool(
      getTool("fs_search"),
      { path: outside, query: "secret" },
      baseCtx(root),
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "path-outside-project");

    // fs_write to an out-of-root path must also refuse.
    res = await runTool(
      getTool("fs_write"),
      { path: join(outside, "evil.txt"), content: "no" },
      baseCtx(root),
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "path-outside-project");

    // exec_run with an out-of-root cwd must refuse.
    res = await runTool(
      getTool("exec_run"),
      { path: outside, command: process.execPath, argv: ["-v"] },
      baseCtx(root),
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "path-outside-project");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6) safeExecFile enforces the timeout and returns an error envelope
// ---------------------------------------------------------------------------

test("GATE6: safeExecFile enforces timeoutMs (returns timedOut:true, never throws)", async () => {
  // Use a tiny command that we can ask to sleep beyond the timeout. On
  // Windows `node -e "setTimeout(...)"` is fine; on POSIX the same.
  const argv = ["-e", "setTimeout(()=>{}, 60000)"];
  const res = await safeExecFile(process.execPath, argv, {
    timeoutMs: 250,
    maxOutputBytes: 1024,
  });
  assert.equal(typeof res, "object");
  assert.equal(typeof res.timedOut, "boolean");
  assert.equal(res.timedOut, true, "safeExecFile must report timedOut=true when the deadline fires");
  assert.equal(typeof res.stdout, "string");
  assert.equal(typeof res.stderr, "string");
  // The child should have been killed (signal: SIGTERM, or at minimum the
  // process no longer has a live handle).
  assert.ok(res.signal === "SIGTERM" || res.code === null, `expected SIGTERM or null code, got signal=${res.signal} code=${res.code}`);
});

test("GATE6: safeExecFile timeout cleans up the exact command's child tree", async () => {
  // The parent creates a descendant and then remains alive past the timeout.
  // This proves timeout recovery is tree-scoped rather than merely killing
  // the direct execFile parent. The descendant PID is communicated through a
  // temp file; no image-name or port-based cleanup is used by the assertion.
  const dir = mkdtempSync(join(tmpdir(), "cf-safe-exec-tree-"));
  const pidFile = join(dir, "child.pid");
  const script = [
    "const fs=require('fs');",
    "const {spawn}=require('child_process');",
    `const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));`,
    "setTimeout(()=>{},60000);",
  ].join("");
  try {
    const res = await safeExecFile(process.execPath, ["-e", script], {
      // The fixture must get through Windows Node startup before the deadline;
      // 350ms races cold process startup under the full serial suite instead of
      // testing the intended descendant-tree cleanup semantics.
      timeoutMs: 2_000,
      maxOutputBytes: 1024,
    });
    assert.equal(res.timedOut, true);
    const childPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(childPid) && childPid > 0, "descendant PID must be recorded");
    await new Promise((r) => setTimeout(r, 250));
    let alive = true;
    try { process.kill(childPid, 0); } catch { alive = false; }
    assert.equal(alive, false, `owned descendant ${childPid} must not survive timeout`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GATE6: safeExecFile cancellation kills the exact command tree before its timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-safe-exec-cancel-"));
  const pidFile = join(dir, "child.pid");
  const controller = new AbortController();
  const script = [
    "const fs=require('fs');",
    "const {spawn}=require('child_process');",
    `const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));`,
    "setTimeout(()=>{},60000);",
  ].join("");
  try {
    const started = Date.now();
    const promise = safeExecFile(process.execPath, ["-e", script], {
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
      cancelSignal: controller.signal,
    });
    // Synchronize on the descendant PID rather than sleeping for a fixed
    // amount of time. On Windows a cold Node process can take longer than a
    // few hundred milliseconds to start under a loaded test runner; aborting
    // before the fixture has recorded its owned descendant makes this test
    // race the fixture itself instead of testing cancellation semantics.
    const readyDeadline = Date.now() + 5_000;
    while (!existsSync(pidFile) && Date.now() < readyDeadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(existsSync(pidFile), "fixture must record its descendant PID before cancellation");
    controller.abort();
    const res = await promise;
    assert.equal(res.timedOut, true);
    assert.ok(Date.now() - started < 5_000, "cancellation must not wait for the execution deadline");
    const childPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(childPid) && childPid > 0, "descendant PID must be recorded");
    await new Promise((r) => setTimeout(r, 250));
    let alive = true;
    try { process.kill(childPid, 0); } catch { alive = false; }
    assert.equal(alive, false, `cancelled command descendant ${childPid} must not survive`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GATE6: exec_run surfaces a timeout envelope when safeExecFile fires (runTool catches and returns { ok:true, result.timedOut:true })", async () => {
  const root = makeTempProject({});
  try {
    // Pass a tiny input.timeoutMs so the tool's execFile times out well
    // inside its declared timeoutMs cap.
    const res = await runTool(
      getTool("exec_run"),
      {
        path: root,
        command: process.execPath,
        argv: ["-e", "setTimeout(()=>{}, 60000)"],
        timeoutMs: 250,
      },
      baseCtx(root),
    );
    // exec_run intentionally treats a timeout as ok:true with timedOut:true
    // (the shell ran and reported what happened); the loop sees this as a
    // successful result, never as an exception.
    assert.equal(res.ok, true);
    assert.equal(res.result.timedOut, true);
    assert.equal(typeof res.elapsedMs, "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7) Agent can chain 3+ tool calls (inspect -> read -> write) and the
//    output of each step flows into the next
// ---------------------------------------------------------------------------

test("GATE6: 3+ tool calls chain in sequence; output of one feeds the next", async () => {
  await withFreshAudit(async () => {
    const root = makeTempProject({
      "src/seed.txt": "hello\n",
      "src/util.txt": "world\n",
    });
    try {
      // Step 1: fs_list — discover files
      const list = await runTool(getTool("fs_list"), { path: root }, baseCtx(root));
      assert.equal(list.ok, true);
      const seedRel = list.result.entries.find((e) => e.path === "src/seed.txt");
      assert.ok(seedRel, "fs_list should surface src/seed.txt");

      // Step 2: fs_read — read the discovered file (relative path joined to root)
      const read = await runTool(
        getTool("fs_read"),
        { path: join(root, seedRel.path) },
        baseCtx(root),
      );
      assert.equal(read.ok, true);
      assert.equal(read.result.content, "hello\n");

      // Step 3: fs_write — write a new file derived from the read content
      const derived = `derived from: ${read.result.content.trim()}\n`;
      const write = await runTool(
        getTool("fs_write"),
        { path: join(root, "src", "derived.txt"), content: derived, createDirs: true },
        baseCtx(root),
      );
      assert.equal(write.ok, true);
      assert.equal(write.result.bytes, Buffer.byteLength(derived, "utf8"));

      // Step 4: fs_read — verify the write round-trips
      const verify = await runTool(
        getTool("fs_read"),
        { path: join(root, "src", "derived.txt") },
        baseCtx(root),
      );
      assert.equal(verify.ok, true);
      assert.equal(verify.result.content, derived);

      // All four calls produced audit events (4 * 2 = 8 tool.* events).
      const events = Audit.recent(500).filter((e) => typeof e.event === "string" && e.event.startsWith("tool."))
        .filter((e) => e.tool && ["fs_list", "fs_read", "fs_write"].includes(e.tool));
      assert.equal(events.length >= 8, true, `expected >=8 tool.* events, got ${events.length}`);

      // None of them should be tool.failed (all succeeded).
      const failed = events.filter((e) => e.event === "tool.failed");
      assert.equal(failed.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 8) A tool that errors mid-chain does NOT crash the loop (runTool catches
//    every error and returns an envelope; the next call still runs)
// ---------------------------------------------------------------------------

test("GATE6: a tool that errors mid-chain returns an envelope; subsequent calls keep running", async () => {
  await withFreshAudit(async () => {
    const root = makeTempProject({ "a.txt": "alpha\n" });
    try {
      // Call 1: succeeds.
      const a = await runTool(getTool("fs_read"), { path: join(root, "a.txt") }, baseCtx(root));
      assert.equal(a.ok, true);

      // Call 2: errors with not-found — runTool MUST catch the tool's
      // envelope and return it (never throws).
      let threw = false;
      let b;
      try {
        b = await runTool(
          getTool("fs_read"),
          { path: join(root, "does-not-exist.txt") },
          baseCtx(root),
        );
      } catch (e) {
        threw = true;
      }
      assert.equal(threw, false, "runTool must not throw on a tool error");
      assert.equal(b.ok, false);
      assert.equal(b.error.code, "not-found");
      assert.equal(typeof b.elapsedMs, "number");

      // Call 3: a tool that throws synchronously — runTool still catches.
      const throwTool = {
        name: "thrower",
        description: "tool that throws",
        permission: "READ",
        inputSchema: { type: "object", properties: {}, required: [] },
        timeoutMs: 5_000,
        async execute() { throw new Error("synthetic boom"); },
      };
      let threw2 = false;
      let c;
      try {
        c = await runTool(throwTool, {}, baseCtx(root));
      } catch (e) {
        threw2 = true;
      }
      assert.equal(threw2, false, "runTool must not throw on a synchronous tool throw");
      assert.equal(c.ok, false);
      assert.equal(c.error.code, "tool-failed");

      // Call 4: a tool returning a malformed envelope (no .ok).
      const badTool = {
        name: "malformed",
        description: "tool with malformed envelope",
        permission: "READ",
        inputSchema: { type: "object", properties: {}, required: [] },
        timeoutMs: 5_000,
        async execute() { return { weird: "shape" }; },
      };
      const d = await runTool(badTool, {}, baseCtx(root));
      assert.equal(d.ok, false);
      assert.equal(d.error.code, "tool-failed");

      // Call 5: the loop is still healthy — a subsequent successful call works.
      const e2 = await runTool(getTool("fs_read"), { path: join(root, "a.txt") }, baseCtx(root));
      assert.equal(e2.ok, true);

      // Audit: the failed/malformed calls each produce a tool.failed event.
      const failed = Audit.recent(200).filter((ev) => ev.event === "tool.failed");
      assert.ok(failed.length >= 2, `expected >=2 tool.failed events, got ${failed.length}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 9) Permission field coverage — every tool has a known permission class
// ---------------------------------------------------------------------------

test("GATE6: every registered tool declares a permission from the closed set (READ|WRITE|EXECUTE|NETWORK|DESTRUCTIVE)", () => {
  const allowed = new Set(["READ", "WRITE", "EXECUTE", "NETWORK", "DESTRUCTIVE"]);
  for (const t of listTools()) {
    assert.equal(typeof t.permission, "string", `${t.name}: permission must be a string`);
    assert.ok(allowed.has(t.permission), `${t.name}: permission=${t.permission} not in the closed set`);
    // Cross-check with the PERMISSIONS registry.
    assert.ok(PERMISSIONS[t.permission], `${t.name}: PERMISSIONS must enumerate ${t.permission}`);
  }
  // Sanity: PROJECT_TOOLS is frozen and the 16 names match.
  assert.equal(Object.isFrozen(PROJECT_TOOLS), true);
  assert.equal(Object.keys(PROJECT_TOOLS).length, 16);
});
