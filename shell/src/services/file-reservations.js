// File reservations — write-conflict protection for parallel coder agents.
//
// Sibling agents that both call `fs_write` on the same path would otherwise
// stomp on each other (last writer wins, silent data loss). This module is a
// minimal "lock manager" that records an in-flight reservation per
// (profile_id, project_id, file_path) tuple in a sidecar SQLite store.
//
// IMPORTANT: this is a SIDECAR database (`<userData>/file_reservations.sqlite`).
// It is opened by the main process only and NEVER touches the core `pm_*`
// schema. If you are looking for the canonical DB, that lives in
// `<workspace>/progress-ledger-v2.db` and is owned by the Rust NAPI core.
//
// Concurrency model: acquire() uses an immediate SQLite transaction. Two
// callers contending for the same path race, and exactly one wins. The other
// sees `{ ok: false, heldBy }` and is expected to re-plan.
//
// Lifecycle:
//
//   acquireReservation()  →  reservation with `released_at = NULL`
//   releaseReservation()  →  sets `released_at = CURRENT_TIMESTAMP`
//   releaseAllForAgent()  →  bulk release when the agent's run ends
//   startSweeper()        →  background task, every 60 s, auto-releases
//                            reservations older than 10 minutes. This is a
//                            deadlock guard: if an agent process crashed
//                            without calling releaseAllForAgent, the
//                            reservation cannot block siblings forever.
//
// API contract: every exported function returns `{ ok, ... }`. They NEVER
// throw. A throw here would silently lose the reservation, so we swallow
// SQLite errors and surface them as structured failures.

import path from "node:path";
import Database from "better-sqlite3";

// ---- tuning ---------------------------------------------------------------

/** How often the sweeper wakes up (ms). */
export const SWEEPER_INTERVAL_MS = 60_000;

/** Reservations older than this are auto-released (ms). */
export const RESERVATION_TTL_MS = 10 * 60_000;

// ---- module state ---------------------------------------------------------

let db = null;
let dbPath = null;
let sweeperHandle = null;

// Prepared statements are created lazily after init.
let stmts = null;

// ---- path normalization ----------------------------------------------------

/**
 * Normalize an absolute path to a canonical string form. We use
 * `path.resolve` to collapse `.` / `..` and double-separator quirks, and
 * `path.normalize` to remove trailing separators. We intentionally do NOT
 * case-fold — on POSIX paths are case-sensitive, and on Windows the OS
 * itself normalizes the underlying calls (Node's `fs` layer accepts either
 * case and treats them as equivalent for actual I/O).
 *
 * The reservation lookup is a string compare, so two callers writing
 * "C:\foo\bar.js" and "c:/foo/bar.js" might miss each other's reservation.
 * That's acceptable: the OS will treat them as the same file at write
 * time, and the second writer will overwrite the first regardless. The
 * reservation is a heuristic, not a perfect serialiser.
 */
export function normalizePath(p) {
  if (typeof p !== "string" || !p) return p;
  const resolved = path.resolve(p);
  return path.normalize(resolved);
}

// ---- store init -----------------------------------------------------------

/**
 * Open (or create) the sidecar SQLite file. Idempotent. Calling this twice
 * with the same path is a no-op; calling it twice with DIFFERENT paths
 * closes the first DB and opens the second.
 */
export async function initReservationsStore({ dbPath: target }) {
  if (!target || typeof target !== "string") {
    return { ok: false, error: { code: "invalid-input", message: "dbPath is required" } };
  }
  try {
    if (db && dbPath === target) {
      return { ok: true, dbPath, reused: true };
    }
    if (db) {
      stopSweeper();
      try { db.close(); } catch {}
      db = null;
      stmts = null;
    }
    dbPath = target;
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = OFF");
    db.exec(`
      CREATE TABLE IF NOT EXISTS reservations (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id   INTEGER NOT NULL,
        project_id   INTEGER NOT NULL,
        agent_id     INTEGER NOT NULL,
        file_path    TEXT    NOT NULL,
        mode         TEXT    NOT NULL,
        acquired_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        released_at  DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_reservations_active
        ON reservations(file_path, profile_id) WHERE released_at IS NULL;
    `);
    stmts = {
      findActive: db.prepare(
        `SELECT id, profile_id, project_id, agent_id, file_path, mode, acquired_at
           FROM reservations
          WHERE released_at IS NULL
            AND profile_id = ?
            AND project_id = ?
            AND file_path = ?
          LIMIT 1`,
      ),
      insert: db.prepare(
        `INSERT INTO reservations (profile_id, project_id, agent_id, file_path, mode)
         VALUES (?, ?, ?, ?, ?)`,
      ),
      release: db.prepare(
        `UPDATE reservations SET released_at = CURRENT_TIMESTAMP
          WHERE id = ? AND released_at IS NULL`,
      ),
      releaseByAgent: db.prepare(
        `UPDATE reservations SET released_at = CURRENT_TIMESTAMP
          WHERE agent_id = ? AND released_at IS NULL`,
      ),
      listActive: db.prepare(
        `SELECT id, profile_id, project_id, agent_id, file_path, mode, acquired_at
           FROM reservations
          WHERE released_at IS NULL
            AND profile_id = ?
            AND project_id = ?
          ORDER BY acquired_at ASC`,
      ),
      sweepExpired: db.prepare(
        `UPDATE reservations SET released_at = CURRENT_TIMESTAMP
          WHERE released_at IS NULL
            AND (strftime('%s','now') - strftime('%s', acquired_at)) * 1000 > ?`,
      ),
    };
    return { ok: true, dbPath };
  } catch (e) {
    db = null;
    stmts = null;
    return { ok: false, error: { code: "init-failed", message: String(e && e.message || e) } };
  }
}

/** Close the store. Mostly for tests. */
export function closeReservationsStore() {
  stopSweeper();
  if (db) {
    try { db.close(); } catch {}
  }
  db = null;
  stmts = null;
  dbPath = null;
}

function ensureReady() {
  if (!db || !stmts) {
    return { ok: false, error: { code: "not-initialized", message: "reservations store is not initialized" } };
  }
  return { ok: true };
}

// ---- acquire / release ----------------------------------------------------

/**
 * Acquire a reservation. Returns:
 *   { ok: true, reservationId }
 *     — no holder OR the caller already holds it (idempotent self-hold;
 *       returns the existing reservation id).
 *   { ok: false, heldBy: { agentId, mode, since } }
 *     — another agent holds this path.
 *   { ok: false, reason: 'self-hold' }     ← not used externally; reserved.
 *   { ok: false, error: { code, message } } — store not ready / SQL error.
 *
 * Self-hold is idempotent: if the same agent already has an active
 * reservation for the same path, we return that reservation id. This
 * makes recursive tool calls (e.g. an agent that calls fs_write on the
 * same path twice) safe.
 */
export async function acquireReservation(profileId, projectId, agentId, filePath, mode) {
  const ready = ensureReady();
  if (!ready.ok) return ready;
  if (mode !== "read" && mode !== "write") {
    return { ok: false, error: { code: "invalid-input", message: "mode must be 'read' or 'write'" } };
  }
  const normalized = normalizePath(filePath);
  if (!normalized) {
    return { ok: false, error: { code: "invalid-input", message: "filePath is required" } };
  }
  try {
    // Serialize all acquire/release activity on this single connection.
    // better-sqlite3 is synchronous so we just run the steps in order; a
    // transaction guarantees the SELECT-then-INSERT is atomic.
    const tx = db.transaction(() => {
      const existing = stmts.findActive.get(profileId, projectId, normalized);
      if (existing) {
        if (existing.agent_id === agentId) {
          return { ok: true, reservationId: existing.id, selfHold: true };
        }
        return {
          ok: false,
          heldBy: {
            agentId: existing.agent_id,
            mode: existing.mode,
            since: existing.acquired_at,
          },
        };
      }
      const info = stmts.insert.run(profileId, projectId, agentId, normalized, mode);
      return { ok: true, reservationId: info.lastInsertRowid };
    });
    return tx();
  } catch (e) {
    return { ok: false, error: { code: "acquire-failed", message: String(e && e.message || e) } };
  }
}

/**
 * Release a reservation by id. No-op if already released or unknown.
 */
export async function releaseReservation(reservationId) {
  const ready = ensureReady();
  if (!ready.ok) return ready;
  if (typeof reservationId !== "number" && typeof reservationId !== "bigint") {
    return { ok: false, error: { code: "invalid-input", message: "reservationId is required" } };
  }
  try {
    stmts.release.run(reservationId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: { code: "release-failed", message: String(e && e.message || e) } };
  }
}

/**
 * Bulk release all reservations held by an agent. Called when the agent's
 * run ends (success, failure, or cancellation) so the path is freed for
 * the next caller.
 */
export async function releaseAllForAgent(agentId) {
  const ready = ensureReady();
  if (!ready.ok) return ready;
  if (typeof agentId !== "number" && typeof agentId !== "string") {
    return { ok: false, error: { code: "invalid-input", message: "agentId is required" } };
  }
  try {
    const info = stmts.releaseByAgent.run(agentId);
    return { ok: true, released: info.changes };
  } catch (e) {
    return { ok: false, error: { code: "release-failed", message: String(e && e.message || e) } };
  }
}

/**
 * List active reservations for a (profile_id, project_id) tuple.
 * Returns an array of plain objects (no SQLite row objects).
 */
export async function listActiveReservations(profileId, projectId) {
  const ready = ensureReady();
  if (!ready.ok) return ready;
  try {
    const rows = stmts.listActive.all(profileId, projectId);
    const out = rows.map((r) => ({
      id: Number(r.id),
      profileId: r.profile_id,
      projectId: r.project_id,
      agentId: r.agent_id,
      filePath: r.file_path,
      mode: r.mode,
      acquiredAt: r.acquired_at,
    }));
    return { ok: true, reservations: out };
  } catch (e) {
    return { ok: false, error: { code: "list-failed", message: String(e && e.message || e) } };
  }
}

// ---- sweeper --------------------------------------------------------------
//
// The sweeper exists for ONE reason: a sibling agent could crash without
// calling releaseAllForAgent, leaving a stale reservation that blocks
// every future writer on that path. We release any reservation older
// than RESERVATION_TTL_MS every SWEEPER_INTERVAL_MS.

/**
 * Start the background sweeper. Idempotent.
 *
 * Returns { ok, intervalMs, ttlMs } on success or { ok: false, error }
 * if the store is not initialized.
 */
export function startSweeper({ intervalMs = SWEEPER_INTERVAL_MS, ttlMs = RESERVATION_TTL_MS } = {}) {
  const ready = ensureReady();
  if (!ready.ok) return ready;
  if (sweeperHandle) return { ok: true, alreadyRunning: true, intervalMs, ttlMs };
  sweeperHandle = setInterval(() => {
    try {
      stmts.sweepExpired.run(ttlMs);
    } catch {
      // Best-effort. Sweeper failures must not bubble up; the next tick
      // will try again, and the caller of `startSweeper` did not ask
      // for a Promise.
    }
  }, intervalMs);
  // Allow the process to exit even if the sweeper is running (tests
  // rely on this — the test runner exits as soon as the suite ends).
  if (typeof sweeperHandle.unref === "function") sweeperHandle.unref();
  return { ok: true, intervalMs, ttlMs };
}

/** Stop the background sweeper. Idempotent. */
export function stopSweeper() {
  if (sweeperHandle) {
    try { clearInterval(sweeperHandle); } catch {}
    sweeperHandle = null;
    return { ok: true };
  }
  return { ok: true, alreadyStopped: true };
}

/**
 * Run a single sweep pass synchronously. Exposed for tests that do not
 * want to wait on the timer.
 */
export function sweepOnce({ ttlMs = RESERVATION_TTL_MS } = {}) {
  const ready = ensureReady();
  if (!ready.ok) return ready;
  try {
    const info = stmts.sweepExpired.run(ttlMs);
    return { ok: true, released: info.changes, ttlMs };
  } catch (e) {
    return { ok: false, error: { code: "sweep-failed", message: String(e && e.message || e) } };
  }
}