// Project Mode — Memory layer.
//
// Three memory scopes, persisted in a per-project sidecar SQLite file:
//   <userData>/project-memory/<projectId>.sqlite
//
// 1. session_memory  — per-agent-run transient notes. Cleared at the end
//    of the run unless the user opts in. Scoped by (profile, agent).
// 2. project_memory  — persistent: decisions, findings, preferences,
//    architecture notes, risks. Lives until explicitly deleted. Scoped
//    by (profile, project, kind, key).
// 3. task_history    — append-only one-line summary per agent run, so the
//    user can see what previous agents did in this project.
//
// Retrieval: `buildContextPacket` ranks project_memory entries by
// token-overlap with the current objective so the agent loop can prepend
// the most relevant prior knowledge to the next model call.
//
// API contract: every method returns `{ ok, result? , error? }`. Nothing
// here throws — SQLite errors are surfaced as `error.code / error.message`
// so callers can keep their own try/catch surface thin.
//
// `userDataDir` is injected so unit tests can point the cache at a temp
// directory. Production callers (the IPC layer) set it from the electron
// user-data directory.

import path from "node:path";
import { mkdirSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// module state
// ---------------------------------------------------------------------------

/** In-process cache of open better-sqlite3 handles, keyed by projectId. */
const dbCache = new Map();

/** Per-project storage dir override (used by tests). */
let userDataDirOverride = null;

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function dbPathFor(projectId) {
  const base = userDataDirOverride || defaultUserDataDir();
  const dir = path.join(base, "project-memory");
  const safe = String(projectId).replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(dir, `${safe}.sqlite`);
}

function defaultUserDataDir() {
  try {
    const electron = require("electron");
    const a = electron && electron.app;
    if (a && typeof a.getPath === "function") return a.getPath("userData");
  } catch {
    // not running under Electron
  }
  return process.cwd();
}

function openDb(projectId) {
  if (dbCache.has(projectId)) return dbCache.get(projectId);
  const filePath = dbPathFor(projectId);
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    // ignore — better-sqlite3 will surface a clean error if needed.
  }
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = OFF");
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_memory (
      project_id  TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (project_id, agent_id, key)
    );
    CREATE TABLE IF NOT EXISTS project_memory (
      project_id   TEXT NOT NULL,
      kind         TEXT NOT NULL,
      key          TEXT NOT NULL,
      value        TEXT NOT NULL,
      confidence   REAL NOT NULL DEFAULT 1.0,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (project_id, kind, key)
    );
    CREATE INDEX IF NOT EXISTS idx_project_memory_kind
      ON project_memory(project_id, kind);
    CREATE TABLE IF NOT EXISTS task_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      summary     TEXT NOT NULL,
      success     INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_history_project
      ON task_history(project_id, created_at DESC);
  `);
  dbCache.set(projectId, db);
  return db;
}

function getDb(projectId) {
  if (!projectId) {
    return { ok: false, error: { code: "invalid-input", message: "projectId is required" } };
  }
  const db = dbCache.get(projectId);
  if (!db) {
    // Restart continuity: the per-project sqlite file persists on disk
    // across application restarts. If the cache is cold but the file
    // exists (previous run wrote memory), reopen it — otherwise reads
    // after a restart would report `not-initialized` and every
    // project's durable memory would silently vanish from the app's
    // point of view. No file => genuinely no storage yet; keep the
    // `not-initialized` contract for fresh projects/tests.
    const filePath = dbPathFor(projectId);
    let exists = false;
    try { exists = statSync(filePath).isFile(); } catch { exists = false; }
    if (!exists) {
      return { ok: false, error: { code: "not-initialized", message: "memory: no writes yet for this project" } };
    }
    const reopened = openDb(projectId);
    // The file may carry a hot WAL from a previous process (crash or
    // SIGKILL). Force a passive checkpoint on the reopen path so the
    // first read sees all committed frames — a stale -shm from the
    // dead process can otherwise make the first read miss WAL frames
    // until a later open. PASSIVE never blocks concurrent access.
    try { reopened.pragma("wal_checkpoint(PASSIVE)"); } catch { /* best-effort */ }
    // Contract: getDb returns { ok, db }, NOT the raw Database object —
    // callers do `if (!ready.ok) ... ; ready.db.prepare(...)`. Returning
    // the raw object here made ready.ok falsy and every first read
    // silently return an empty list (while later reads hit the warm
    // cache and worked — a nasty intermittent shape).
    return { ok: true, db: reopened };
  }
  return { ok: true, db };
}

function err(code, message) {
  return { ok: false, error: { code, message: String(message ?? code) } };
}

// ---------------------------------------------------------------------------
// Session memory (transient)
// ---------------------------------------------------------------------------

export async function sessionSet(profileId, agentId, key, value) {
  if (!projectIdOk(profileId)) return err("invalid-input", "profileId is required");
  if (!agentIdOk(agentId)) return err("invalid-input", "agentId is required");
  if (typeof key !== "string" || !key) return err("invalid-input", "key is required");
  if (typeof value !== "string") return err("invalid-input", "value must be a string");
  const projectId = String(profileId);
  const db = openDb(projectId);
  const now = Date.now();
  try {
    db.prepare(
      `INSERT INTO session_memory (project_id, agent_id, key, value, created_at)
         VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(project_id, agent_id, key) DO UPDATE SET
             value = excluded.value,
             created_at = excluded.created_at`,
    ).run(projectId, String(agentId), key, value, now);
    return { ok: true, result: { createdAt: now } };
  } catch (e) {
    return err("session-set-failed", e && e.message || String(e));
  }
}

export async function sessionGet(profileId, agentId, key) {
  if (!projectIdOk(profileId)) return err("invalid-input", "profileId is required");
  if (!agentIdOk(agentId)) return err("invalid-input", "agentId is required");
  if (typeof key !== "string" || !key) return err("invalid-input", "key is required");
  const ready = getDb(String(profileId));
  if (!ready.ok) return { ok: true, result: null };
  try {
    const row = ready.db
      .prepare(
        `SELECT value, created_at FROM session_memory
          WHERE project_id = ? AND agent_id = ? AND key = ?`,
      )
      .get(String(profileId), String(agentId), key);
    if (!row) return { ok: true, result: null };
    return { ok: true, result: row.value, meta: { createdAt: row.created_at } };
  } catch (e) {
    return err("session-get-failed", e && e.message || String(e));
  }
}

export async function sessionList(profileId, agentId) {
  if (!projectIdOk(profileId)) return err("invalid-input", "profileId is required");
  if (!agentIdOk(agentId)) return err("invalid-input", "agentId is required");
  const ready = getDb(String(profileId));
  if (!ready.ok) return { ok: true, result: [] };
  try {
    const rows = ready.db
      .prepare(
        `SELECT key, value, created_at FROM session_memory
          WHERE project_id = ? AND agent_id = ?
          ORDER BY created_at ASC`,
      )
      .all(String(profileId), String(agentId));
    return {
      ok: true,
      result: rows.map((r) => ({ key: r.key, value: r.value, createdAt: r.created_at })),
    };
  } catch (e) {
    return err("session-list-failed", e && e.message || String(e));
  }
}

export async function sessionClear(profileId, agentId) {
  if (!projectIdOk(profileId)) return err("invalid-input", "profileId is required");
  if (!agentIdOk(agentId)) return err("invalid-input", "agentId is required");
  const ready = getDb(String(profileId));
  if (!ready.ok) return { ok: true, cleared: 0 };
  try {
    const info = ready.db
      .prepare(`DELETE FROM session_memory WHERE project_id = ? AND agent_id = ?`)
      .run(String(profileId), String(agentId));
    return { ok: true, cleared: info.changes };
  } catch (e) {
    return err("session-clear-failed", e && e.message || String(e));
  }
}

// ---------------------------------------------------------------------------
// Project memory (persistent)
// ---------------------------------------------------------------------------

const PROJECT_KINDS = new Set(["decision", "finding", "preference", "architecture", "risk"]);

export async function projectSet(profileId, kind, key, value, confidence = 1.0) {
  if (!projectIdOk(profileId)) return err("invalid-input", "profileId is required");
  if (typeof kind !== "string" || !PROJECT_KINDS.has(kind)) {
    return err("invalid-input", `kind must be one of: ${[...PROJECT_KINDS].join(", ")}`);
  }
  if (typeof key !== "string" || !key) return err("invalid-input", "key is required");
  if (typeof value !== "string") return err("invalid-input", "value must be a string");
  let conf = Number(confidence);
  if (!Number.isFinite(conf)) conf = 1.0;
  if (conf < 0) conf = 0;
  if (conf > 1) conf = 1;

  const projectId = String(profileId);
  const db = openDb(projectId);
  const now = Date.now();
  try {
    db.prepare(
      `INSERT INTO project_memory (project_id, kind, key, value, confidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, kind, key) DO UPDATE SET
             value = excluded.value,
             confidence = excluded.confidence,
             updated_at = excluded.updated_at`,
    ).run(projectId, kind, key, value, conf, now, now);
    return { ok: true, result: { createdAt: now, updatedAt: now, confidence: conf } };
  } catch (e) {
    return err("project-set-failed", e && e.message || String(e));
  }
}

export async function projectGet(profileId, kind, key) {
  if (!projectIdOk(profileId)) return err("invalid-input", "profileId is required");
  if (typeof kind !== "string" || !PROJECT_KINDS.has(kind)) {
    return err("invalid-input", `kind must be one of: ${[...PROJECT_KINDS].join(", ")}`);
  }
  if (typeof key !== "string" || !key) return err("invalid-input", "key is required");
  const ready = getDb(String(profileId));
  if (!ready.ok) return { ok: true, result: null };
  try {
    const row = ready.db
      .prepare(
        `SELECT value, confidence, created_at, updated_at FROM project_memory
          WHERE project_id = ? AND kind = ? AND key = ?`,
      )
      .get(String(profileId), kind, key);
    if (!row) return { ok: true, result: null };
    return {
      ok: true,
      result: {
        value: row.value,
        confidence: row.confidence,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    };
  } catch (e) {
    return err("project-get-failed", e && e.message || String(e));
  }
}

export async function projectList(profileId, opts = {}) {
  if (!projectIdOk(profileId)) return err("invalid-input", "profileId is required");
  const { kind = null, keyPrefix = null, limit = null, valueLike = null } = opts || {};
  if (kind !== null && (typeof kind !== "string" || !PROJECT_KINDS.has(kind))) {
    return err("invalid-input", `kind must be one of: ${[...PROJECT_KINDS].join(", ")}`);
  }
  if (keyPrefix !== null && typeof keyPrefix !== "string") {
    return err("invalid-input", "keyPrefix must be a string");
  }
  if (valueLike !== null && (!Array.isArray(valueLike) || valueLike.length === 0)) {
    return err("invalid-input", "valueLike must be a non-empty array");
  }
  const ready = getDb(String(profileId));
  if (!ready.ok) return { ok: true, result: [] };

  const where = ["project_id = ?"];
  const args = [String(profileId)];
  if (kind) {
    where.push("kind = ?");
    args.push(kind);
  }
  if (keyPrefix) {
    where.push("key LIKE ?");
    args.push(`${keyPrefix}%`);
  }
  // LIKE pushdown: narrow candidates to entries whose value contains at
  // least one of the goal tokens. This bounds the worst-case rows for
  // the JS ranker in buildContextPacket (bottleneck #2 fix).
  if (valueLike && valueLike.length > 0) {
    const likeClauses = valueLike.map(() => "value LIKE ?").join(" OR ");
    where.push(`(${likeClauses})`);
    valueLike.forEach((t) => args.push(`%${String(t)}%`));
  }
  let sql = `SELECT kind, key, value, confidence, created_at, updated_at
               FROM project_memory
              WHERE ${where.join(" AND ")}
              ORDER BY kind ASC, key ASC`;
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
    sql += ` LIMIT ${Math.floor(limit)}`;
  }
  try {
    const rows = ready.db.prepare(sql).all(...args);
    return {
      ok: true,
      result: rows.map((r) => ({
        kind: r.kind,
        key: r.key,
        value: r.value,
        confidence: r.confidence,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    };
  } catch (e) {
    return err("project-list-failed", e && e.message || String(e));
  }
}

export async function projectDelete(profileId, kind, key) {
  if (!projectIdOk(profileId)) return err("invalid-input", "profileId is required");
  if (typeof kind !== "string" || !PROJECT_KINDS.has(kind)) {
    return err("invalid-input", `kind must be one of: ${[...PROJECT_KINDS].join(", ")}`);
  }
  if (typeof key !== "string" || !key) return err("invalid-input", "key is required");
  const ready = getDb(String(profileId));
  if (!ready.ok) return { ok: true, deleted: 0 };
  try {
    const info = ready.db
      .prepare(`DELETE FROM project_memory WHERE project_id = ? AND kind = ? AND key = ?`)
      .run(String(profileId), kind, key);
    return { ok: true, deleted: info.changes };
  } catch (e) {
    return err("project-delete-failed", e && e.message || String(e));
  }
}

// ---------------------------------------------------------------------------
// Task history (append-only)
// ---------------------------------------------------------------------------

export async function taskAppend(profileId, agentId, summary, success) {
  if (!projectIdOk(profileId)) return err("invalid-input", "profileId is required");
  if (!agentIdOk(agentId)) return err("invalid-input", "agentId is required");
  if (typeof summary !== "string" || !summary) {
    return err("invalid-input", "summary is required");
  }
  const projectId = String(profileId);
  const db = openDb(projectId);
  const now = Date.now();
  const ok = success === true || success === 1 || success === "1" ? 1 : 0;
  try {
    const info = db
      .prepare(
        `INSERT INTO task_history (project_id, agent_id, summary, success, created_at)
           VALUES (?, ?, ?, ?, ?)`,
      )
      .run(projectId, String(agentId), summary, ok, now);
    return { ok: true, result: { id: Number(info.lastInsertRowid), createdAt: now } };
  } catch (e) {
    return err("task-append-failed", e && e.message || String(e));
  }
}

export async function taskList(profileId, opts = {}) {
  if (!projectIdOk(profileId)) return err("invalid-input", "profileId is required");
  const { limit = 20, success = null } = opts || {};
  const cap = Math.max(1, Math.floor(Number.isFinite(limit) && limit > 0 ? limit : 20));
  const ready = getDb(String(profileId));
  if (!ready.ok) return { ok: true, result: [] };
  const where = ["project_id = ?"];
  const args = [String(profileId)];
  if (success === true || success === 1 || success === "1") {
    where.push("success = 1");
  } else if (success === false || success === 0 || success === "0") {
    where.push("success = 0");
  }
  const sql = `SELECT id, agent_id, summary, success, created_at
                 FROM task_history
                WHERE ${where.join(" AND ")}
                ORDER BY created_at DESC, id DESC
                LIMIT ${cap}`;
  try {
    const rows = ready.db.prepare(sql).all(...args);
    return {
      ok: true,
      result: rows.map((r) => ({
        id: Number(r.id),
        agentId: r.agent_id,
        summary: r.summary,
        success: r.success === 1,
        createdAt: r.created_at,
      })),
    };
  } catch (e) {
    return err("task-list-failed", e && e.message || String(e));
  }
}

// ---------------------------------------------------------------------------
// Context packet (retrieval-based context selection)
// ---------------------------------------------------------------------------

/**
 * Build a formatted context packet from project memory, ranked by
 * token-overlap with the current objective. Each line is "<kind>: <key>
 * = <value>". The packet is capped at ~`maxTokens` tokens (counted
 * whitespace-split on the rendered output).
 *
 * Returns `{ ok: true, packet }` on success, even when the project has no
 * memory entries yet (packet = "").
 */
export async function buildContextPacket(profileId, currentObjective, maxTokens = 2000) {
  if (!projectIdOk(profileId)) return err("invalid-input", "profileId is required");
  const cap = Math.max(1, Math.floor(Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 2000));

  // Tokenize the objective up front so we can push the LIKE filter into
  // the SQL query. This bounds projectList to at most 100 rows (the
  // worst-case candidate pool for the JS ranker) instead of returning
  // every project_memory row. See bottleneck #2 in PERF-AUDIT-V6.
  const tokens = tokenize(typeof currentObjective === "string" ? currentObjective : "");

  const list = await projectList(profileId, { limit: 100, valueLike: tokens.length > 0 ? tokens : null });
  if (!list.ok) return list;
  if (!list.result || list.result.length === 0) {
    return { ok: true, result: { packet: "", entries: [] } };
  }

  if (tokens.length === 0) {
    // No objective to rank against — emit everything in stable order,
    // until we hit the cap.
    const out = [];
    let used = 0;
    const included = [];
    for (const e of list.result) {
      const line = formatLine(e);
      const cost = tokenCount(line);
      if (used + cost > cap && included.length > 0) break;
      out.push(line);
      used += cost;
      included.push(e);
      if (used >= cap) break;
    }
    return { ok: true, result: { packet: out.join("\n"), entries: included } };
  }

  const scored = list.result.map((e) => {
    const hay = `${e.kind} ${e.key} ${e.value}`.toLowerCase();
    let hits = 0;
    for (const t of tokens) {
      if (hay.includes(t)) hits++;
    }
    // Tie-break: higher confidence, then more recent updatedAt.
    return {
      e,
      score: hits + (hits === tokens.length ? 0.25 : 0),
    };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.e.confidence !== a.e.confidence) return b.e.confidence - a.e.confidence;
    return (b.e.updatedAt || 0) - (a.e.updatedAt || 0);
  });

  const out = [];
  const included = [];
  let used = 0;
  for (const s of scored) {
    if (s.score <= 0) break;
    const line = formatLine(s.e);
    const cost = tokenCount(line);
    if (used + cost > cap && included.length > 0) break;
    out.push(line);
    used += cost;
    included.push(s.e);
    if (used >= cap) break;
  }
  return { ok: true, result: { packet: out.join("\n"), entries: included } };
}

function formatLine(e) {
  return `${e.kind}: ${e.key} = ${e.value}`;
}

function tokenCount(text) {
  if (!text) return 0;
  // Cheap whitespace-split token approximation — same heuristic the
  // ranker uses, so the cap is consistent with the score.
  return text.split(/\s+/).filter(Boolean).length;
}

function tokenize(text) {
  if (typeof text !== "string" || !text) return [];
  const STOP = new Set([
    "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "with",
    "is", "are", "be", "this", "that", "it", "as", "at", "by", "from",
  ]);
  return text.toLowerCase().split(/[^a-z0-9_]+/i).filter((t) => t && !STOP.has(t));
}

// ---------------------------------------------------------------------------
// test helpers + module exports
// ---------------------------------------------------------------------------

function projectIdOk(v) {
  return v !== null && v !== undefined && v !== "";
}

function agentIdOk(v) {
  return v !== null && v !== undefined && v !== "";
}

/**
 * Override the userDataDir used to locate sidecar DBs. Pass null to
 * revert to the Electron default. Intended for tests.
 */
export function _setUserDataDir(dir) {
  userDataDirOverride = dir || null;
}

/** Close every cached connection. Idempotent. */
export function _closeAll() {
  for (const db of dbCache.values()) {
    try { db.close(); } catch {}
  }
  dbCache.clear();
}

/** Resolve the sidecar DB path for diagnostics + tests. */
export function _dbPathFor(projectId) {
  return dbPathFor(projectId);
}

/** Expose the kind set for tests / docs. */
export const PROJECT_MEMORY_KINDS = PROJECT_KINDS;

export const Memory = {
  // session
  sessionSet,
  sessionGet,
  sessionList,
  sessionClear,
  // project (persistent)
  projectSet,
  projectGet,
  projectList,
  projectDelete,
  // task history
  taskAppend,
  taskList,
  // retrieval
  buildContextPacket,
  // test hooks
  _closeAll,
  _dbPathFor,
  _setUserDataDir,
};