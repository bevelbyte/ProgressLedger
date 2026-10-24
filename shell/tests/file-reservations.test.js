// File reservations — write-conflict protection tests.
//
// Covers:
//   - acquire/list round trip
//   - cross-agent conflict (heldBy)
//   - self-hold is idempotent
//   - release then re-acquire as another agent succeeds
//   - cross-project same path is independent
//   - cross-profile same path is independent
//   - sweeper auto-releases reservations older than the TTL
//
// Tests use a per-test temp file so the store is fully hermetic. We
// drive the API directly (no Electron) — the store is a plain
// better-sqlite3 handle wrapped in a small module.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import Database from "better-sqlite3";
import {
  initReservationsStore,
  closeReservationsStore,
  acquireReservation,
  releaseReservation,
  releaseAllForAgent,
  listActiveReservations,
  startSweeper,
  stopSweeper,
  sweepOnce,
  normalizePath,
  RESERVATION_TTL_MS,
} from "../src/services/file-reservations.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeTempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "cf-fr-test-"));
  return join(dir, "file_reservations.sqlite");
}

function cleanup(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch {}
}

async function freshStore() {
  const dbPath = makeTempDbPath();
  const r = await initReservationsStore({ dbPath });
  assert.equal(r.ok, true, `initReservationsStore should succeed: ${JSON.stringify(r)}`);
  return dbPath;
}

/**
 * Insert a row directly with a fake acquired_at to test the sweeper.
 * Uses the live `Database` handle opened in `initReservationsStore`.
 */
function insertStaleRow(dbPath, { profileId, projectId, agentId, filePath, ageMs }) {
  const raw = new Database(dbPath);
  try {
    // Stale: acquired_at older than ageMs.
    const isoAge = new Date(Date.now() - ageMs).toISOString().replace("T", " ").slice(0, 19);
    raw.prepare(
      `INSERT INTO reservations (profile_id, project_id, agent_id, file_path, mode, acquired_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(profileId, projectId, agentId, filePath, "write", isoAge);
  } finally {
    raw.close();
  }
}

// ---------------------------------------------------------------------------
// 1) acquire then list → 1 active
// ---------------------------------------------------------------------------

test("acquire then list shows 1 active reservation", async () => {
  const dbPath = await freshStore();
  try {
    const acq = await acquireReservation(1, 10, 100, "/tmp/foo.js", "write");
    assert.equal(acq.ok, true);
    assert.equal(typeof acq.reservationId, "number");

    const list = await listActiveReservations(1, 10);
    assert.equal(list.ok, true);
    assert.equal(list.reservations.length, 1);
    assert.equal(list.reservations[0].filePath, normalizePath("/tmp/foo.js"));
    assert.equal(list.reservations[0].mode, "write");
    assert.equal(list.reservations[0].agentId, 100);
  } finally {
    closeReservationsStore();
    cleanup(dbPath);
  }
});

// ---------------------------------------------------------------------------
// 2) two different agents → second returns heldBy
// ---------------------------------------------------------------------------

test("second agent acquiring the same path returns heldBy", async () => {
  const dbPath = await freshStore();
  try {
    const a = await acquireReservation(1, 10, 100, "/tmp/contested.js", "write");
    assert.equal(a.ok, true);

    const b = await acquireReservation(1, 10, 200, "/tmp/contested.js", "write");
    assert.equal(b.ok, false);
    assert.equal(b.heldBy.agentId, 100);
    assert.equal(b.heldBy.mode, "write");
    assert.equal(typeof b.heldBy.since, "string");
  } finally {
    closeReservationsStore();
    cleanup(dbPath);
  }
});

// ---------------------------------------------------------------------------
// 3) same agent acquires twice → self-hold, same id
// ---------------------------------------------------------------------------

test("same agent acquiring the same path twice returns the same reservation id", async () => {
  const dbPath = await freshStore();
  try {
    const a = await acquireReservation(1, 10, 100, "/tmp/self.js", "write");
    assert.equal(a.ok, true);
    const b = await acquireReservation(1, 10, 100, "/tmp/self.js", "write");
    assert.equal(b.ok, true);
    assert.equal(b.selfHold, true);
    assert.equal(b.reservationId, a.reservationId);

    // And the active list still shows just one row.
    const list = await listActiveReservations(1, 10);
    assert.equal(list.reservations.length, 1);
  } finally {
    closeReservationsStore();
    cleanup(dbPath);
  }
});

// ---------------------------------------------------------------------------
// 4) acquire, release, re-acquire as different agent → succeeds
// ---------------------------------------------------------------------------

test("after release a different agent can acquire the path", async () => {
  const dbPath = await freshStore();
  try {
    const a = await acquireReservation(1, 10, 100, "/tmp/rel.js", "write");
    assert.equal(a.ok, true);
    const rel = await releaseReservation(a.reservationId);
    assert.equal(rel.ok, true);

    const b = await acquireReservation(1, 10, 200, "/tmp/rel.js", "write");
    assert.equal(b.ok, true);
    assert.notEqual(b.reservationId, a.reservationId);

    const list = await listActiveReservations(1, 10);
    assert.equal(list.reservations.length, 1);
    assert.equal(list.reservations[0].agentId, 200);
  } finally {
    closeReservationsStore();
    cleanup(dbPath);
  }
});

// ---------------------------------------------------------------------------
// 5) cross-project same path → both succeed
// ---------------------------------------------------------------------------

test("different project_id but same path is independent", async () => {
  const dbPath = await freshStore();
  try {
    const a = await acquireReservation(1, 10, 100, "/tmp/cross.js", "write");
    assert.equal(a.ok, true);
    const b = await acquireReservation(1, 11, 100, "/tmp/cross.js", "write");
    assert.equal(b.ok, true);

    const listA = await listActiveReservations(1, 10);
    const listB = await listActiveReservations(1, 11);
    assert.equal(listA.reservations.length, 1);
    assert.equal(listB.reservations.length, 1);
  } finally {
    closeReservationsStore();
    cleanup(dbPath);
  }
});

// ---------------------------------------------------------------------------
// 6) cross-profile same path → both succeed
// ---------------------------------------------------------------------------

test("different profile_id but same path is independent", async () => {
  const dbPath = await freshStore();
  try {
    const a = await acquireReservation(1, 10, 100, "/tmp/cross2.js", "write");
    assert.equal(a.ok, true);
    const b = await acquireReservation(2, 10, 100, "/tmp/cross2.js", "write");
    assert.equal(b.ok, true);

    const listA = await listActiveReservations(1, 10);
    const listB = await listActiveReservations(2, 10);
    assert.equal(listA.reservations.length, 1);
    assert.equal(listB.reservations.length, 1);
  } finally {
    closeReservationsStore();
    cleanup(dbPath);
  }
});

// ---------------------------------------------------------------------------
// 7) sweeper releases reservations older than the TTL
// ---------------------------------------------------------------------------

test("sweeper releases reservations older than 10 minutes", async () => {
  const dbPath = await freshStore();
  try {
    // Insert a stale row directly with acquired_at > 10 min in the past.
    insertStaleRow(dbPath, {
      profileId: 1,
      projectId: 10,
      agentId: 999,
      filePath: "/tmp/stale.js",
      ageMs: RESERVATION_TTL_MS + 60_000, // older than the TTL
    });

    // And a fresh row via the public API.
    const fresh = await acquireReservation(1, 10, 100, "/tmp/fresh.js", "write");
    assert.equal(fresh.ok, true);

    // Sweeper must release the stale row but keep the fresh one.
    const r = sweepOnce({ ttlMs: RESERVATION_TTL_MS });
    assert.equal(r.ok, true);
    assert.equal(r.released, 1, `sweeper should release exactly 1 stale row; got ${r.released}`);

    const list = await listActiveReservations(1, 10);
    assert.equal(list.reservations.length, 1);
    assert.equal(list.reservations[0].filePath, normalizePath("/tmp/fresh.js"));
  } finally {
    closeReservationsStore();
    cleanup(dbPath);
  }
});

test("startSweeper / stopSweeper are idempotent and do not throw", async () => {
  const dbPath = await freshStore();
  try {
    const a = startSweeper({ intervalMs: 1_000_000, ttlMs: 10 * 60_000 });
    assert.equal(a.ok, true);
    const b = startSweeper({ intervalMs: 1_000_000, ttlMs: 10 * 60_000 });
    assert.equal(b.ok, true);
    assert.equal(b.alreadyRunning, true);
    const s = stopSweeper();
    assert.equal(s.ok, true);
    const s2 = stopSweeper();
    assert.equal(s2.ok, true);
    assert.equal(s2.alreadyStopped, true);
  } finally {
    closeReservationsStore();
    cleanup(dbPath);
  }
});

// ---------------------------------------------------------------------------
// 8) releaseAllForAgent — clears every reservation owned by an agent
// ---------------------------------------------------------------------------

test("releaseAllForAgent clears every reservation for an agent", async () => {
  const dbPath = await freshStore();
  try {
    const a1 = await acquireReservation(1, 10, 7, "/tmp/multi-a.js", "write");
    const a2 = await acquireReservation(1, 10, 7, "/tmp/multi-b.js", "write");
    const a3 = await acquireReservation(1, 10, 8, "/tmp/multi-c.js", "write");
    assert.equal(a1.ok, true);
    assert.equal(a2.ok, true);
    assert.equal(a3.ok, true);

    const r = await releaseAllForAgent(7);
    assert.equal(r.ok, true);
    assert.equal(r.released, 2);

    const list = await listActiveReservations(1, 10);
    assert.equal(list.reservations.length, 1);
    assert.equal(list.reservations[0].agentId, 8);
  } finally {
    closeReservationsStore();
    cleanup(dbPath);
  }
});

// ---------------------------------------------------------------------------
// 9) tool wrapper — fs_write refuses when path is reserved by a sibling
// ---------------------------------------------------------------------------

test("fs_write refuses with path-reserved-by-sibling when another agent holds the path", async () => {
  const { runTool } = await import("../src/services/project-tools/_runtime.js");
  const { getTool } = await import("../src/services/project-tools/index.js");
  const { mkdtempSync, writeFileSync, existsSync, readFileSync } = await import("node:fs");

  const dbPath = await freshStore();
  try {
    // Set up a tiny project root with a sibling already holding a path.
    const projectRoot = mkdtempSync(join(tmpdir(), "cf-fs-proj-"));
    const target = join(projectRoot, "x.js");
    writeFileSync(target, "before\n");

    const held = await acquireReservation(1, 10, 100, normalizePath(target), "write");
    assert.equal(held.ok, true);

    // Now another agent tries to write the same file.
    const ctx = {
      projectRoot,
      profileId: 1,
      projectId: 10,
      agentId: 200,
      isCancellable: () => false,
      nowMs: () => Date.now(),
    };
    const res = await runTool(
      getTool("fs_write"),
      { path: target, content: "after\n" },
      ctx,
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "path-reserved-by-sibling");
    // The file must NOT have been touched.
    assert.equal(readFileSync(target, "utf8"), "before\n");

    // After the held reservation is released, the write succeeds.
    await releaseReservation(held.reservationId);
    const res2 = await runTool(
      getTool("fs_write"),
      { path: target, content: "after\n" },
      ctx,
    );
    assert.equal(res2.ok, true);
    assert.equal(readFileSync(target, "utf8"), "after\n");

    rmSync(projectRoot, { recursive: true, force: true });
  } finally {
    closeReservationsStore();
    cleanup(dbPath);
  }
});