// Project Mode — memory_recall tool tests.
//
// Pure node:test specs. No Electron, no IPC. We drive the tool via the
// `runTool` wrapper so we exercise the same path the IPC layer takes.
//
// Coverage:
//   - memory_recall is registered in PROJECT_TOOLS
//   - schema validation accepts valid input and rejects invalid kind
//   - execute returns a sorted list of memory entries (ranked by query)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  PROJECT_TOOLS,
  getTool,
  listTools,
} from "../src/services/project-tools/index.js";
import { runTool } from "../src/services/project-tools/_runtime.js";
import {
  Memory,
  _setUserDataDir,
  _closeAll,
} from "../src/services/memory/index.js";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "cf-mem-tool-test-"));
}

const baseCtx = (projectId) => ({
  projectRoot: null,
  profileId: 1,
  projectId,
  agentId: 1,
  isCancellable: () => false,
  nowMs: () => Date.now(),
});

// ---------------------------------------------------------------------------
// 1) registered in PROJECT_TOOLS
// ---------------------------------------------------------------------------

test("memory_recall is registered in PROJECT_TOOLS", () => {
  const t = getTool("memory_recall");
  assert.ok(t, "memory_recall must be registered");
  assert.equal(t.name, "memory_recall");
  assert.equal(t.permission, "READ");
  assert.equal(typeof t.execute, "function");
  assert.equal(typeof t.timeoutMs, "number");
  assert.ok(t.timeoutMs > 0);
  assert.ok(t.inputSchema && t.inputSchema.type === "object");
  assert.ok(t.description && t.description.length > 0);
});

test("memory_recall appears in listTools()", () => {
  const names = listTools().map((t) => t.name);
  assert.ok(names.includes("memory_recall"));
});

// ---------------------------------------------------------------------------
// 2) Input schema validates
// ---------------------------------------------------------------------------

import {
  validateInputAgainstSchema,
} from "../src/services/project-tools/security.js";

test("memory_recall input schema accepts an empty object", () => {
  const t = getTool("memory_recall");
  const r = validateInputAgainstSchema(t.inputSchema, {});
  assert.equal(r.ok, true);
});

test("memory_recall input schema accepts kind + keyPrefix + query", () => {
  const t = getTool("memory_recall");
  const r = validateInputAgainstSchema(t.inputSchema, {
    kind: "decision",
    keyPrefix: "use-",
    query: "auth login flow",
  });
  assert.equal(r.ok, true);
});

test("memory_recall input schema rejects wrong types", () => {
  const t = getTool("memory_recall");
  const r = validateInputAgainstSchema(t.inputSchema, {
    kind: 123, // should be string
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "invalid-input");
});

// ---------------------------------------------------------------------------
// 3) execute returns a sorted list of memory entries
// ---------------------------------------------------------------------------

test("memory_recall returns a sorted list of entries (ranked by query)", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  const ctx = baseCtx(1);
  try {
    // Seed memory with a mix of relevant and irrelevant entries.
    await Memory.projectSet(1, "decision", "use-better-sqlite3", "sidecar per project for memory");
    await Memory.projectSet(1, "preference", "indent-tabs", "use tabs for indentation");
    await Memory.projectSet(1, "finding", "sqlite-overlap-bug", "token overlap score was off");
    await Memory.projectSet(1, "architecture", "wal-mode", "WAL mode for concurrent reads");

    const res = await runTool(
      getTool("memory_recall"),
      { query: "improve sqlite token overlap" },
      ctx,
    );
    assert.equal(res.ok, true);
    assert.equal(typeof res.elapsedMs, "number");
    const r = res.result;
    assert.ok(Array.isArray(r.lines));
    assert.ok(Array.isArray(r.entries));
    assert.ok(Array.isArray(r.taskHistory));
    assert.equal(typeof r.count, "number");
    assert.ok(r.entries.length >= 1);

    // Top entry shares the most tokens with the query.
    const queryTokens = ["sqlite", "token", "overlap", "improve"];
    const top = r.entries[0];
    const topHay = `${top.kind} ${top.key} ${top.value}`.toLowerCase();
    let topHits = 0;
    for (const t of queryTokens) if (topHay.includes(t)) topHits++;
    for (const e of r.entries.slice(1)) {
      const hay = `${e.kind} ${e.key} ${e.value}`.toLowerCase();
      let hits = 0;
      for (const t of queryTokens) if (hay.includes(t)) hits++;
      assert.ok(topHits >= hits, `ranking violated: ${top.key} (${topHits}) >= ${e.key} (${hits})`);
    }

    // Lines array must start with the formatted entries.
    assert.match(r.lines[0], /^(decision|finding|preference|architecture|risk): /);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("memory_recall filters by kind when supplied", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  const ctx = baseCtx(1);
  try {
    await Memory.projectSet(1, "decision", "use-x", "x is fine");
    await Memory.projectSet(1, "decision", "use-y", "y is fine");
    await Memory.projectSet(1, "finding", "x-bug", "x had a bug");

    const res = await runTool(
      getTool("memory_recall"),
      { kind: "decision" },
      ctx,
    );
    assert.equal(res.ok, true);
    assert.equal(res.result.entries.length, 2);
    for (const e of res.result.entries) assert.equal(e.kind, "decision");
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("memory_recall refuses when projectId is missing from context", async () => {
  const ctx = baseCtx(null);
  // explicitly null out projectId
  ctx.projectId = null;
  const res = await runTool(getTool("memory_recall"), {}, ctx);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "invalid-input");
});

test("memory_recall includes recent task history in its output", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  const ctx = baseCtx(1);
  try {
    await Memory.taskAppend(1, 1, "ran the build", true);
    await Memory.taskAppend(1, 1, "ran the tests", false);

    const res = await runTool(getTool("memory_recall"), {}, ctx);
    assert.equal(res.ok, true);
    assert.ok(res.result.taskHistory.length >= 2);
    // Recent section appears in lines.
    const joined = res.result.lines.join("\n");
    assert.match(joined, /## recent runs/);
    assert.match(joined, /ran the build/);
    assert.match(joined, /ran the tests/);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});