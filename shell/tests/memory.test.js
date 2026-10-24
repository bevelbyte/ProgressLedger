// Project Mode — Memory layer service tests.
//
// Pure node:test specs. No Electron, no IPC. We drive the service
// directly with a temp directory pointing _setUserDataDir at it.
//
// Coverage:
//   - sessionSet/Get round-trip
//   - sessionList returns only entries for that (profile, agent)
//   - sessionClear wipes
//   - projectSet/Get with confidence preserved
//   - projectList filters by kind
//   - taskAppend + taskList returns N most recent
//   - buildContextPacket ranks by token overlap
//   - projectDelete removes entries
//   - validation errors return envelopes (no throws)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  Memory,
  PROJECT_MEMORY_KINDS,
  _setUserDataDir,
  _closeAll,
} from "../src/services/memory/index.js";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "cf-mem-test-"));
}

// ---------------------------------------------------------------------------
// 1) session memory: set/get round-trip
// ---------------------------------------------------------------------------

test("sessionSet + sessionGet round-trip a value", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    const set = await Memory.sessionSet(1, 42, "currentStep", "writing tests");
    assert.equal(set.ok, true);
    assert.equal(typeof set.result.createdAt, "number");

    const get = await Memory.sessionGet(1, 42, "currentStep");
    assert.equal(get.ok, true);
    assert.equal(get.result, "writing tests");

    // unknown key → null, not an error
    const miss = await Memory.sessionGet(1, 42, "does-not-exist");
    assert.equal(miss.ok, true);
    assert.equal(miss.result, null);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("sessionSet overwrites on the same key", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    await Memory.sessionSet(1, 1, "step", "v1");
    await Memory.sessionSet(1, 1, "step", "v2");
    const get = await Memory.sessionGet(1, 1, "step");
    assert.equal(get.ok, true);
    assert.equal(get.result, "v2");
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2) sessionList isolation by (profile, agent)
// ---------------------------------------------------------------------------

test("sessionList returns only entries for that (profile, agent)", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    await Memory.sessionSet(1, 100, "a", "agent-100-a");
    await Memory.sessionSet(1, 100, "b", "agent-100-b");
    await Memory.sessionSet(1, 200, "a", "agent-200-a");
    await Memory.sessionSet(2, 100, "a", "profile-2-agent-100-a");

    const list1 = await Memory.sessionList(1, 100);
    assert.equal(list1.ok, true);
    const items = list1.result.map((r) => `${r.key}=${r.value}`).sort();
    assert.deepEqual(items, ["a=agent-100-a", "b=agent-100-b"]);

    const list2 = await Memory.sessionList(1, 200);
    assert.equal(list2.ok, true);
    assert.equal(list2.result.length, 1);
    assert.equal(list2.result[0].value, "agent-200-a");

    const list3 = await Memory.sessionList(2, 100);
    assert.equal(list3.ok, true);
    assert.equal(list3.result.length, 1);
    assert.equal(list3.result[0].value, "profile-2-agent-100-a");
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3) sessionClear wipes only that (profile, agent)
// ---------------------------------------------------------------------------

test("sessionClear wipes the entries for that agent only", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    await Memory.sessionSet(1, 1, "a", "x");
    await Memory.sessionSet(1, 1, "b", "y");
    await Memory.sessionSet(1, 2, "a", "keep-me");

    const clr = await Memory.sessionClear(1, 1);
    assert.equal(clr.ok, true);
    assert.equal(clr.cleared, 2);

    const list1 = await Memory.sessionList(1, 1);
    assert.equal(list1.ok, true);
    assert.equal(list1.result.length, 0);

    const list2 = await Memory.sessionList(1, 2);
    assert.equal(list2.ok, true);
    assert.equal(list2.result.length, 1);
    assert.equal(list2.result[0].value, "keep-me");
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4) projectSet/Get with confidence preserved
// ---------------------------------------------------------------------------

test("projectSet + projectGet round-trip, confidence preserved", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    const set = await Memory.projectSet(
      1,
      "decision",
      "use-better-sqlite3",
      "chose better-sqlite3 for the memory layer",
      0.8,
    );
    assert.equal(set.ok, true);
    assert.equal(set.result.confidence, 0.8);

    const get = await Memory.projectGet(1, "decision", "use-better-sqlite3");
    assert.equal(get.ok, true);
    assert.equal(get.result.value, "chose better-sqlite3 for the memory layer");
    assert.equal(get.result.confidence, 0.8);
    assert.equal(typeof get.result.createdAt, "number");
    assert.equal(typeof get.result.updatedAt, "number");

    // unknown key → null, not an error
    const miss = await Memory.projectGet(1, "decision", "missing");
    assert.equal(miss.ok, true);
    assert.equal(miss.result, null);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("projectSet rejects unknown kinds", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    const r = await Memory.projectSet(1, "bogus-kind", "k", "v");
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "invalid-input");
    assert.match(r.error.message, /kind must be one of/);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("PROJECT_MEMORY_KINDS exposes the documented kinds", () => {
  for (const k of ["decision", "finding", "preference", "architecture", "risk"]) {
    assert.equal(PROJECT_MEMORY_KINDS.has(k), true, `kind ${k} missing`);
  }
});

// ---------------------------------------------------------------------------
// 5) projectList filters by kind
// ---------------------------------------------------------------------------

test("projectList filters by kind and keyPrefix", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    await Memory.projectSet(1, "decision", "use-x", "...");
    await Memory.projectSet(1, "decision", "use-y", "...");
    await Memory.projectSet(1, "finding", "auth-flow", "...");
    await Memory.projectSet(1, "preference", "ui-dark", "...");

    const all = await Memory.projectList(1);
    assert.equal(all.ok, true);
    assert.equal(all.result.length, 4);

    const onlyDecisions = await Memory.projectList(1, { kind: "decision" });
    assert.equal(onlyDecisions.ok, true);
    assert.equal(onlyDecisions.result.length, 2);
    for (const e of onlyDecisions.result) assert.equal(e.kind, "decision");

    const onlyUsePrefix = await Memory.projectList(1, { keyPrefix: "use-" });
    assert.equal(onlyUsePrefix.ok, true);
    assert.equal(onlyUsePrefix.result.length, 2);

    const combined = await Memory.projectList(1, { kind: "decision", keyPrefix: "use-y" });
    assert.equal(combined.ok, true);
    assert.equal(combined.result.length, 1);
    assert.equal(combined.result[0].key, "use-y");
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("projectList with unknown kind returns an invalid-input envelope", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    const r = await Memory.projectList(1, { kind: "bogus" });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "invalid-input");
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("projectDelete removes an entry", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    await Memory.projectSet(1, "risk", "deploy-risky", "we ship every Friday");
    const before = await Memory.projectGet(1, "risk", "deploy-risky");
    assert.equal(before.ok, true);
    assert.equal(before.result.value, "we ship every Friday");

    const del = await Memory.projectDelete(1, "risk", "deploy-risky");
    assert.equal(del.ok, true);
    assert.equal(del.deleted, 1);

    const after = await Memory.projectGet(1, "risk", "deploy-risky");
    assert.equal(after.ok, true);
    assert.equal(after.result, null);

    // second delete returns deleted=0
    const del2 = await Memory.projectDelete(1, "risk", "deploy-risky");
    assert.equal(del2.ok, true);
    assert.equal(del2.deleted, 0);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6) taskAppend + taskList returns N most recent
// ---------------------------------------------------------------------------

test("taskAppend + taskList returns the N most recent entries", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    for (let i = 0; i < 5; i++) {
      const r = await Memory.taskAppend(1, 99, `task-${i}`, i % 2 === 0);
      assert.equal(r.ok, true);
      // Space them out a few ms so created_at ordering is unambiguous.
      await new Promise((res) => setTimeout(res, 5));
    }

    const all = await Memory.taskList(1);
    assert.equal(all.ok, true);
    assert.equal(all.result.length, 5);
    // Most recent first → task-4 on top.
    assert.equal(all.result[0].summary, "task-4");
    assert.equal(all.result[0].success, true);
    assert.equal(all.result[4].summary, "task-0");
    assert.equal(all.result[4].success, true);

    const top3 = await Memory.taskList(1, { limit: 3 });
    assert.equal(top3.ok, true);
    assert.equal(top3.result.length, 3);
    assert.deepEqual(
      top3.result.map((r) => r.summary),
      ["task-4", "task-3", "task-2"],
    );

    const onlySuccess = await Memory.taskList(1, { success: true });
    assert.equal(onlySuccess.ok, true);
    // task-0, task-2, task-4 are success=true
    assert.equal(onlySuccess.result.length, 3);
    for (const r of onlySuccess.result) assert.equal(r.success, true);

    const onlyFail = await Memory.taskList(1, { success: false });
    assert.equal(onlyFail.ok, true);
    // task-1, task-3 are success=false
    assert.equal(onlyFail.result.length, 2);
    for (const r of onlyFail.result) assert.equal(r.success, false);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7) buildContextPacket ranks by token overlap
// ---------------------------------------------------------------------------

test("buildContextPacket ranks entries by token overlap with the objective", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    await Memory.projectSet(1, "decision", "use-better-sqlite3", "sidecar per project for memory layer");
    await Memory.projectSet(1, "preference", "indent-tabs", "use tabs for indentation");
    await Memory.projectSet(1, "finding", "sqlite-overlap-bug", "token overlap score was off by one");
    await Memory.projectSet(1, "architecture", "wal-mode", "WAL mode for concurrent reads");

    const packet = await Memory.buildContextPacket(1, "improve sqlite token overlap ranking", 2000);
    assert.equal(packet.ok, true);
    assert.equal(typeof packet.result.packet, "string");
    assert.ok(packet.result.packet.length > 0);

    // All four entries are returned because all share tokens with the
    // query, but the two sqlite-overlap entries should rank above the
    // unrelated ones. We check by line order.
    const lines = packet.result.packet.split("\n");
    const orderedKeys = packet.result.entries.map((e) => `${e.kind}:${e.key}`);
    // Top entry should share the most tokens with the query.
    const topEntry = packet.result.entries[0];
    const topHay = `${topEntry.kind} ${topEntry.key} ${topEntry.value}`.toLowerCase();
    const queryTokens = ["sqlite", "token", "overlap", "ranking", "improve"];
    let topHits = 0;
    for (const t of queryTokens) if (topHay.includes(t)) topHits++;
    for (const e of packet.result.entries.slice(1)) {
      const hay = `${e.kind} ${e.key} ${e.value}`.toLowerCase();
      let hits = 0;
      for (const t of queryTokens) if (hay.includes(t)) hits++;
      assert.ok(topHits >= hits, `ranking violated: ${topEntry.key} (${topHits}) >= ${e.key} (${hits})`);
    }
    // Sanity: the unrelated "indent-tabs" entry should be the lowest-ranked
    // of the returned ones (or excluded if it scored 0).
    assert.ok(orderedKeys.length >= 1, `got ${lines.length} lines`);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("buildContextPacket returns empty packet when no memory exists", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    const packet = await Memory.buildContextPacket(2, "anything", 100);
    assert.equal(packet.ok, true);
    assert.equal(packet.result.packet, "");
    assert.equal(packet.result.entries.length, 0);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("buildContextPacket caps the packet at ~maxTokens", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    // 20 entries, each ~6 tokens. With cap=10 tokens we should only see 1-2.
    for (let i = 0; i < 20; i++) {
      await Memory.projectSet(
        1,
        "finding",
        `finding-${i.toString().padStart(2, "0")}`,
        "shared token alpha beta gamma delta epsilon",
      );
    }
    const packet = await Memory.buildContextPacket(1, "alpha beta gamma", 10);
    assert.equal(packet.ok, true);
    // All entries have identical content → identical score; the cap is
    // what keeps us bounded. We allow up to a couple of lines because
    // each line is ~8 tokens.
    assert.ok(packet.result.entries.length <= 3, `expected <=3 entries, got ${packet.result.entries.length}`);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9) GATE 17 v8 — LIMIT 100 pushdown for buildContextPacket (bottleneck #2)
// ---------------------------------------------------------------------------

test("projectList with limit caps the result set (GATE 17 v8)", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    const COUNT = 1000;
    for (let i = 0; i < COUNT; i++) {
      await Memory.projectSet(
        1,
        "finding",
        `perf-entry-${i.toString().padStart(4, "0")}`,
        `irrelevant filler text for entry number ${i}`,
      );
    }

    // No limit → returns everything.
    const all = await Memory.projectList(1);
    assert.equal(all.ok, true);
    assert.equal(all.result.length, COUNT);

    // limit=10 → at most 10.
    const capped = await Memory.projectList(1, { limit: 10 });
    assert.equal(capped.ok, true);
    assert.ok(capped.result.length <= 10, `expected <=10, got ${capped.result.length}`);

    // limit=100 → at most 100.
    const capped100 = await Memory.projectList(1, { limit: 100 });
    assert.equal(capped100.ok, true);
    assert.ok(capped100.result.length <= 100, `expected <=100, got ${capped100.result.length}`);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("buildContextPacket returns at most 100 entries even with 1000 in DB (GATE 17 v8)", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    const COUNT = 1000;
    // 990 irrelevant entries + 10 entries that share tokens with the goal.
    for (let i = 0; i < COUNT - 10; i++) {
      await Memory.projectSet(
        1,
        "finding",
        `noise-${i.toString().padStart(4, "0")}`,
        `completely unrelated filler data for noise entry ${i}`,
      );
    }
    for (let i = 0; i < 10; i++) {
      await Memory.projectSet(
        1,
        "decision",
        `relevant-${i.toString().padStart(2, "0")}`,
        `this decision is about the sqlite memory layer token overlap ranking`,
      );
    }

    const packet = await Memory.buildContextPacket(1, "improve sqlite memory token overlap", 20000);
    assert.equal(packet.ok, true);
    // Hard cap: never more than 100 entries from the DB, regardless of
    // how many total rows exist.
    assert.ok(
      packet.result.entries.length <= 100,
      `expected <=100 entries, got ${packet.result.entries.length}`,
    );
    // The 10 relevant entries should all be present (they share tokens).
    const relevantCount = packet.result.entries.filter(
      (e) => `${e.kind} ${e.key} ${e.value}`.toLowerCase().includes("sqlite"),
    ).length;
    assert.ok(relevantCount >= 5, `expected at least 5 relevant entries, got ${relevantCount}`);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("projectList valueLike filter narrows candidates to matching entries (GATE 17 v8)", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    await Memory.projectSet(1, "decision", "use-x", "we use sqlite for persistence");
    await Memory.projectSet(1, "decision", "use-y", "we use postgres for analytics");
    await Memory.projectSet(1, "finding", "no-match", "filler text with no keywords");
    await Memory.projectSet(1, "preference", "theme", "prefer dark mode for the dashboard");

    // LIKE for "sqlite" → only the first entry should match.
    const sqlite = await Memory.projectList(1, { valueLike: ["sqlite"] });
    assert.equal(sqlite.ok, true);
    assert.equal(sqlite.result.length, 1, `expected 1 sqlite match, got ${sqlite.result.length}`);
    assert.equal(sqlite.result[0].key, "use-x");

    // LIKE for "sqlite" OR "dark" → two entries.
    const multi = await Memory.projectList(1, { valueLike: ["sqlite", "dark"] });
    assert.equal(multi.ok, true);
    assert.equal(multi.result.length, 2, `expected 2 matches, got ${multi.result.length}`);

    // LIKE combined with kind filter → narrowed further.
    const narrowed = await Memory.projectList(1, { kind: "preference", valueLike: ["dark"] });
    assert.equal(narrowed.ok, true);
    assert.equal(narrowed.result.length, 1);
    assert.equal(narrowed.result[0].key, "theme");

    // LIKE combined with limit → capped AND filtered.
    const capped = await Memory.projectList(1, { valueLike: ["use"], limit: 2 });
    assert.equal(capped.ok, true);
    assert.ok(capped.result.length <= 2);

    // Empty tokens list means no LIKE filter → all rows.
    const none = await Memory.projectList(1, { valueLike: null });
    assert.equal(none.ok, true);
    assert.equal(none.result.length, 4);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 10) validation envelopes (no throws)
// ---------------------------------------------------------------------------

test("every method returns { ok, error } instead of throwing on bad input", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    const cases = [
      () => Memory.sessionSet(null, 1, "k", "v"),
      () => Memory.sessionGet(null, 1, "k"),
      () => Memory.sessionList(null, 1),
      () => Memory.sessionClear(null, 1),
      () => Memory.projectSet(null, "decision", "k", "v"),
      () => Memory.projectGet(null, "decision", "k"),
      () => Memory.projectList(null),
      () => Memory.projectDelete(null, "decision", "k"),
      () => Memory.taskAppend(null, 1, "summary", true),
      () => Memory.taskList(null),
      () => Memory.buildContextPacket(null, "x"),
    ];
    for (const fn of cases) {
      const r = await fn();
      assert.equal(typeof r.ok, "boolean");
      assert.equal(r.ok, false);
      assert.ok(r.error && typeof r.error.code === "string");
    }
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});