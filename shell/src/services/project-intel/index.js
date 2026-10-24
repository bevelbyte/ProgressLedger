// Project Intelligence Layer — per-project file index + dependency graph.
//
// Provides SQLite sidecar persistence for:
//   <userData>/project-intel/<projectId>.sqlite
//
// Tables:
//   meta   — rootPath binding, indexedAt
//   files  — path, size, mtime, language, indexed_at
//   edges  — from_path, to_path (import dependency graph)
//
// All methods return { ok: true, result } or { ok: false, error: { code, message } }.

import path from "node:path";
import { existsSync, mkdirSync, statSync, readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Module State & Configuration
// ---------------------------------------------------------------------------

const dbCache = new Map();
let userDataDirOverride = null;

export function _setUserDataDir(dir) {
  userDataDirOverride = dir;
}

export function _closeAll() {
  for (const db of dbCache.values()) {
    try {
      db.close();
    } catch {}
  }
  dbCache.clear();
}

function defaultUserDataDir() {
  try {
    const electron = require("electron");
    const a = electron && electron.app;
    if (a && typeof a.getPath === "function") return a.getPath("userData");
  } catch {}
  return process.env.CAREERFLOW_USER_DATA || path.join(process.cwd(), ".userData");
}

export function _dbPathFor(projectId) {
  const base = userDataDirOverride || defaultUserDataDir();
  const dir = path.join(base, "project-intel");
  const safe = String(projectId).replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(dir, `${safe}.sqlite`);
}

// ---------------------------------------------------------------------------
// Database Connection & Fail-Closed Root Binding
// ---------------------------------------------------------------------------

function getDb(projectId, authorizedRoot, createIfMissing = false) {
  if (typeof authorizedRoot !== "string" || !authorizedRoot.trim()) {
    return {
      ok: false,
      error: { code: "root-required", message: "A valid root path is required" },
    };
  }

  const normalizedRoot = path.resolve(authorizedRoot.trim());
  const dbPath = _dbPathFor(projectId);

  if (!createIfMissing && !existsSync(dbPath)) {
    return {
      ok: false,
      error: { code: "not-initialized", message: "Project index does not exist" },
    };
  }

  let db = dbCache.get(projectId);
  if (!db) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, size INTEGER, mtime INTEGER, language TEXT, indexed_at INTEGER);
      CREATE TABLE IF NOT EXISTS edges (from_path TEXT, to_path TEXT, PRIMARY KEY(from_path, to_path));
      CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_path);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_path);
    `);
    dbCache.set(projectId, db);
  }

  const row = db.prepare("SELECT value FROM meta WHERE key = 'rootPath'").get();
  if (!row) {
    if (!createIfMissing) {
      return {
        ok: false,
        error: { code: "root-mismatch", message: "Project index root not recorded" },
      };
    }
  } else {
    const storedRoot = path.resolve(row.value);
    if (storedRoot !== normalizedRoot) {
      return {
        ok: false,
        error: {
          code: "root-mismatch",
          message: `Authorized root ${normalizedRoot} does not match stored root ${storedRoot}`,
        },
      };
    }
  }

  return { ok: true, db, root: normalizedRoot };
}

// ---------------------------------------------------------------------------
// Language & Filesystem Helpers
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".unlazy",
  "dist",
  "build",
  "target",
  ".next",
  ".svelte-kit",
  ".cache",
  ".turbo",
  "coverage",
  ".venv",
  "__pycache__",
]);

const EXT_TO_LANG = {
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
  ".cjs": "js",
  ".ts": "ts",
  ".tsx": "tsx",
  ".mts": "ts",
  ".cts": "ts",
  ".py": "py",
  ".md": "md",
  ".markdown": "md",
  ".json": "json",
  ".rs": "rs",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".sass": "sass",
  ".svelte": "svelte",
  ".vue": "vue",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".sql": "sql",
  ".sh": "sh",
  ".bash": "sh",
  ".bat": "bat",
  ".cmd": "bat",
  ".txt": "txt",
};

function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext] || "unknown";
}

function scanFiles(rootDir) {
  const results = [];

  function walk(current) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) {
          walk(path.join(current, ent.name));
        }
      } else if (ent.isFile()) {
        const full = path.join(current, ent.name);
        try {
          const st = statSync(full);
          const rel = path.relative(rootDir, full).split(path.sep).join("/");
          results.push({
            path: rel,
            size: st.size,
            mtime: Math.floor(st.mtimeMs),
            language: detectLanguage(ent.name),
          });
        } catch {}
      }
    }
  }

  walk(rootDir);
  return results;
}

function extractJsImports(fullPath, relPath, fileSet) {
  const ext = path.extname(relPath).toLowerCase();
  if (![".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".svelte", ".vue"].includes(ext)) {
    return [];
  }

  let content;
  try {
    content = readFileSync(fullPath, "utf8");
  } catch {
    return [];
  }

  const importRegex = /(?:import\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
  const edges = [];
  let m;

  while ((m = importRegex.exec(content)) !== null) {
    const spec = m[1] || m[2] || m[3];
    if (!spec || !spec.startsWith(".")) continue;

    const fromDir = path.dirname(relPath);
    let target = path.normalize(path.join(fromDir, spec)).split(path.sep).join("/");

    if (fileSet.has(target)) {
      edges.push(target);
      continue;
    }

    const candidateExts = [".js", ".ts", ".tsx", ".jsx", "/index.js", "/index.ts"];
    for (const ce of candidateExts) {
      const probe = target + ce;
      if (fileSet.has(probe)) {
        edges.push(probe);
        break;
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Public API Methods
// ---------------------------------------------------------------------------

export async function indexProject(profileId, projectId, rootPath) {
  const start = Date.now();
  const conn = getDb(projectId, rootPath, true);
  if (!conn.ok) return conn;
  const { db, root } = conn;

  const files = scanFiles(root);
  const fileSet = new Set(files.map((f) => f.path));

  const edges = [];
  for (const f of files) {
    const full = path.join(root, f.path.split("/").join(path.sep));
    const imports = extractJsImports(full, f.path, fileSet);
    for (const imp of imports) {
      edges.push({ from: f.path, to: imp });
    }
  }

  const insertMeta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  const insertFile = db.prepare(
    "INSERT INTO files (path, size, mtime, language, indexed_at) VALUES (?, ?, ?, ?, ?)"
  );
  const insertEdge = db.prepare("INSERT OR IGNORE INTO edges (from_path, to_path) VALUES (?, ?)");

  const tx = db.transaction(() => {
    insertMeta.run("rootPath", root);
    insertMeta.run("indexedAt", String(Date.now()));
    db.prepare("DELETE FROM files").run();
    db.prepare("DELETE FROM edges").run();

    const now = Date.now();
    for (const f of files) {
      insertFile.run(f.path, f.size, f.mtime, f.language, now);
    }
    for (const e of edges) {
      insertEdge.run(e.from, e.to);
    }
  });

  tx();

  return {
    ok: true,
    result: {
      files: files.length,
      edges: edges.length,
      elapsedMs: Date.now() - start,
    },
  };
}

export async function reindexDelta(profileId, projectId, rootPath) {
  const conn = getDb(projectId, rootPath, false);
  if (!conn.ok) return conn;
  const { db, root } = conn;

  const storedRows = db.prepare("SELECT path, size, mtime FROM files").all();
  const storedMap = new Map();
  for (const r of storedRows) {
    storedMap.set(r.path, { size: r.size, mtime: r.mtime });
  }

  const liveFiles = scanFiles(root);
  const liveMap = new Map();
  for (const f of liveFiles) {
    liveMap.set(f.path, f);
  }

  const added = [];
  const updated = [];
  const removed = [];

  for (const [p, live] of liveMap.entries()) {
    const stored = storedMap.get(p);
    if (!stored) {
      added.push(live);
    } else if (stored.mtime !== live.mtime || stored.size !== live.size) {
      updated.push(live);
    }
  }

  for (const p of storedMap.keys()) {
    if (!liveMap.has(p)) {
      removed.push(p);
    }
  }

  const insertFile = db.prepare(
    "INSERT OR REPLACE INTO files (path, size, mtime, language, indexed_at) VALUES (?, ?, ?, ?, ?)"
  );
  const deleteFile = db.prepare("DELETE FROM files WHERE path = ?");
  const deleteEdges = db.prepare("DELETE FROM edges WHERE from_path = ? OR to_path = ?");
  const insertEdge = db.prepare("INSERT OR IGNORE INTO edges (from_path, to_path) VALUES (?, ?)");

  const fileSet = new Set(liveMap.keys());

  const tx = db.transaction(() => {
    const now = Date.now();

    for (const p of removed) {
      deleteFile.run(p);
      deleteEdges.run(p, p);
    }

    for (const f of added) {
      insertFile.run(f.path, f.size, f.mtime, f.language, now);
      const full = path.join(root, f.path.split("/").join(path.sep));
      const edges = extractJsImports(full, f.path, fileSet);
      for (const imp of edges) {
        insertEdge.run(f.path, imp);
      }
    }

    for (const f of updated) {
      insertFile.run(f.path, f.size, f.mtime, f.language, now);
      deleteEdges.run(f.path, f.path);
      const full = path.join(root, f.path.split("/").join(path.sep));
      const edges = extractJsImports(full, f.path, fileSet);
      for (const imp of edges) {
        insertEdge.run(f.path, imp);
      }
    }

    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      "indexedAt",
      String(now)
    );
  });

  tx();

  return {
    ok: true,
    result: {
      added: added.length,
      removed: removed.length,
      updated: updated.length,
    },
  };
}

export async function getFileList(profileId, projectId, opts = {}, rootPath) {
  const conn = getDb(projectId, rootPath, false);
  if (!conn.ok) return conn;
  const { db } = conn;

  const max = typeof opts?.max === "number" ? opts.max : 1000;
  const conditions = [];
  const params = [];

  if (opts?.ext && typeof opts.ext === "string") {
    conditions.push("language = ?");
    params.push(opts.ext.replace(/^\./, ""));
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) as count FROM files ${whereClause}`).get(...params)?.count ?? 0;

  const rows = db
    .prepare(`SELECT path, size, mtime, language FROM files ${whereClause} ORDER BY path ASC LIMIT ?`)
    .all(...params, max);

  return {
    ok: true,
    result: {
      total,
      entries: rows,
    },
  };
}

export async function getNeighbors(profileId, projectId, filePath, depth = 1, rootPath) {
  const conn = getDb(projectId, rootPath, false);
  if (!conn.ok) return conn;
  const { db } = conn;

  const normPath = filePath.split(path.sep).join("/");
  const importsRows = db.prepare("SELECT to_path FROM edges WHERE from_path = ? ORDER BY to_path ASC").all(normPath);
  const importedByRows = db.prepare("SELECT from_path FROM edges WHERE to_path = ? ORDER BY from_path ASC").all(normPath);

  return {
    ok: true,
    result: {
      file: { path: normPath },
      imports: importsRows.map((r) => r.to_path),
      importedBy: importedByRows.map((r) => r.from_path),
    },
  };
}

export async function relevantFiles(profileId, projectId, query, max = 20, rootPath) {
  const conn = getDb(projectId, rootPath, false);
  if (!conn.ok) return conn;
  const db = conn.db;

  const tokens = String(query || "")
    .toLowerCase()
    .match(/[a-z0-9_-]{2,}/g) || [];

  if (tokens.length === 0) {
    return { ok: true, result: { matches: [] } };
  }

  // Pushdown query bounded at SQLite layer (max 200 rows)
  const SQL_LIMIT = 200;
  const conditions = tokens.map(() => "lower(path) LIKE ?").join(" OR ");
  const params = tokens.map((t) => `%${t}%`);

  const candidates = db
    .prepare(`SELECT path, size, mtime, language FROM files WHERE (${conditions}) LIMIT ${SQL_LIMIT}`)
    .all(...params);

  const scored = [];
  for (const c of candidates) {
    const pLower = c.path.toLowerCase();
    const baseLower = path.basename(c.path).toLowerCase();
    let score = 0;
    let matchCount = 0;

    for (const t of tokens) {
      if (pLower.includes(t)) {
        matchCount++;
        score += 10;
        if (baseLower.includes(t)) {
          score += 15;
        }
      }
    }

    if (matchCount === tokens.length) {
      score += 50; // Bonus for full token overlap
    }

    scored.push({
      path: c.path,
      score,
      size: c.size,
      mtime: c.mtime,
      language: c.language,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const limitCap = Math.min(typeof max === "number" && max > 0 ? max : 20, SQL_LIMIT);
  const matches = scored.slice(0, limitCap);

  return {
    ok: true,
    result: {
      matches,
    },
  };
}

export async function getStats(profileId, projectId, rootPath) {
  const conn = getDb(projectId, rootPath, false);
  if (!conn.ok) return conn;
  const { db } = conn;

  const totalRow = db.prepare("SELECT COUNT(*) as count, SUM(size) as bytes FROM files").get();
  const langRows = db.prepare("SELECT language, COUNT(*) as count FROM files GROUP BY language").all();
  const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'indexedAt'").get();

  const byLanguage = {};
  for (const r of langRows) {
    if (r.language && r.language !== "unknown") {
      byLanguage[r.language] = r.count;
    }
  }

  return {
    ok: true,
    result: {
      totalFiles: totalRow?.count ?? 0,
      totalBytes: totalRow?.bytes ?? 0,
      byLanguage,
      indexedAt: metaRow ? Number(metaRow.value) : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Combined Exports
// ---------------------------------------------------------------------------

export const ProjectIntel = {
  indexProject,
  reindexDelta,
  getFileList,
  getNeighbors,
  relevantFiles,
  getStats,
  _dbPathFor,
  _setUserDataDir,
  _closeAll,
};

export default ProjectIntel;
