// Project Intelligence Layer — per-project file index + dependency graph.
//
// Pure node:test specs. No Electron, no IPC: we drive the service
// directly with a temp directory pointing _setUserDataDir at it.
//
// Coverage:
//   - indexProject happy path: 5 files → 5 rows
//   - skip dirs honored
//   - language detection
//   - JS import graph: 2 files, one import → 1 edge
//   - reindexDelta: no-op on a clean re-run; new file → 1 insert
//   - relevantFiles token-overlap ranking
//   - getNeighbors 1-level BFS

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";

import {
  ProjectIntel,
  _setUserDataDir,
  _closeAll,
} from "../src/services/project-intel/index.js";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "cf-pi-test-"));
}

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
}

/**
 * Force a file's mtime forward by N ms so reindexDelta treats it as
 * unchanged-by-mtime-but-changed-by-content isn't an issue — we just
 * set the file's mtime to "now" after writing. Two writes in quick
 * succession can collide on sub-second resolution on some FSes, so we
 * also bump utimes explicitly.
 */
function touchAt(absPath, whenMs) {
  const t = (whenMs / 1000);
  utimesSync(absPath, t, t);
}

/**
 * Open the sidecar SQLite directly (the project-intel module keeps its
 * own handle; tests need an independent read so we can compare the
 * stored mtime/size to the live FS values).
 */
function _openAndReadFiles(profileId, projectId) {
  const safe = String(projectId).replace(/[^A-Za-z0-9_.-]/g, "_");
  // userDataDir was set via _setUserDataDir; we can read it back from the
  // module's exported dbPathFor via the underscore helper.
  const dbPath = ProjectIntel._dbPathFor(projectId);
  const raw = new Database(dbPath, { readonly: true });
  try {
    const rows = raw.prepare(`SELECT path, size, mtime FROM files`).all();
    const out = new Map();
    for (const r of rows) out.set(r.path, { size: r.size, mtime: r.mtime });
    return out;
  } finally {
    raw.close();
  }
}

// ---------------------------------------------------------------------------
// 1) indexProject happy path — 5 files, skip-dirs honored, language hint
// ---------------------------------------------------------------------------

test("indexProject records 5 files, skips node_modules, and detects languages", async () => {
  const root = makeTempDir();
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    writeTree(root, {
      "src/index.js": "console.log('hi')\n",
      "src/util.ts": "export const y = 2;\n",
      "README.md": "# hi\n",
      "package.json": "{}\n",
      "src/extra.py": "print('hi')\n",
      "node_modules/skipme.js": "// skipped\n",
    });
    const res = await ProjectIntel.indexProject(1, 100, root);
    assert.equal(res.ok, true, `indexProject should succeed: ${JSON.stringify(res)}`);
    assert.equal(res.result.files, 5);
    assert.equal(typeof res.result.elapsedMs, "number");

    const list = await ProjectIntel.getFileList(1, 100, { max: 1000 }, root);
    assert.equal(list.ok, true);
    const paths = list.result.entries.map((e) => e.path).sort();
    // All 5 source files indexed.
    assert.ok(paths.includes("README.md"));
    assert.ok(paths.includes("package.json"));
    assert.ok(paths.includes("src/index.js"));
    assert.ok(paths.includes("src/util.ts"));
    assert.ok(paths.includes(join("src", "util.ts").split(sep).join("/")) ||
              paths.includes("src/util.ts"));
    // node_modules must NOT appear.
    for (const p of paths) {
      assert.equal(p.includes("node_modules"), false, `${p} leaked from node_modules`);
    }

    const byPath = new Map(list.result.entries.map((e) => [e.path, e]));
    assert.equal(byPath.get("src/index.js").language, "js");
    assert.equal(byPath.get("src/util.ts").language, "ts");
    assert.equal(byPath.get("README.md").language, "md");
    assert.equal(byPath.get("package.json").language, "json");
  } finally {
    _closeAll();
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2) indexProject — JS import graph (2 files, 1 edge)
// ---------------------------------------------------------------------------

test("indexProject extracts one import edge from a relative require", async () => {
  const root = makeTempDir();
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    writeTree(root, {
      "a.js": "const x = require('./b.js');\n",
      "b.js": "module.exports = 1;\n",
      "c.txt": "unrelated\n",
    });
    const res = await ProjectIntel.indexProject(1, 200, root);
    assert.equal(res.ok, true);
    assert.equal(res.result.files, 3);
    assert.equal(res.result.edges, 1, `expected 1 edge, got ${res.result.edges}`);

    const nb = await ProjectIntel.getNeighbors(1, 200, "a.js", 1, root);
    assert.equal(nb.ok, true);
    assert.equal(nb.result.file.path, "a.js");
    assert.deepEqual(nb.result.imports, ["b.js"]);
    assert.deepEqual(nb.result.importedBy, []);
  } finally {
    _closeAll();
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3) reindexDelta — clean second call → no inserts; new file → 1 insert
// ---------------------------------------------------------------------------

test("reindexDelta after no changes makes zero updates", async () => {
  const root = makeTempDir();
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    writeTree(root, {
      "x.js": "x = 1;\n",
      "y.js": "y = 2;\n",
    });
    let r = await ProjectIntel.indexProject(1, 300, root);
    assert.equal(r.ok, true);

    // Pin both files' mtime to the EXACT integer ms we just recorded,
    // so reindexDelta sees the same mtime/size and detects no change.
    // We round-trip via Database (read back what was stored) so we are
    // comparing apples to apples.
    const stored = _openAndReadFiles(1, 300);
    for (const [rel, info] of stored) {
      touchAt(join(root, rel), info.mtime);
    }

    r = await ProjectIntel.reindexDelta(1, 300, root);
    assert.equal(r.ok, true);
    assert.equal(r.result.added, 0);
    assert.equal(r.result.removed, 0);
    assert.equal(r.result.updated, 0);
  } finally {
    _closeAll();
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

test("reindexDelta inserts exactly one new file", async () => {
  const root = makeTempDir();
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    writeTree(root, {
      "x.js": "x = 1;\n",
    });
    let r = await ProjectIntel.indexProject(1, 400, root);
    assert.equal(r.ok, true);
    assert.equal(r.result.files, 1);

    // Add a brand-new file.
    writeFileSync(join(root, "z.js"), "z = 3;\n");

    r = await ProjectIntel.reindexDelta(1, 400, root);
    assert.equal(r.ok, true);
    assert.equal(r.result.added, 1);
    assert.equal(r.result.removed, 0);
    assert.equal(r.result.updated, 0);

    const list = await ProjectIntel.getFileList(1, 400, { max: 100 }, root);
    assert.equal(list.ok, true);
    assert.equal(list.result.total, 2);
  } finally {
    _closeAll();
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4) relevantFiles — token-overlap ranking
// ---------------------------------------------------------------------------

test("relevantFiles ranks 'auth login' so the auth file comes first", async () => {
  const root = makeTempDir();
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    writeTree(root, {
      "src/auth/login.js": "// login flow\n",
      "src/auth/session.js": "// session\n",
      "src/random/notes.txt": "nope\n",
      "src/api/login-handler.js": "// handler\n",
    });
    const r = await ProjectIntel.indexProject(1, 500, root);
    assert.equal(r.ok, true);

    const rel = await ProjectIntel.relevantFiles(1, 500, "auth login", 10, root);
    assert.equal(rel.ok, true);
    assert.ok(rel.result.matches.length >= 1);
    // The first match should contain both "auth" and "login".
    const top = rel.result.matches[0];
    assert.equal(top.path.includes("auth") && top.path.includes("login"), true,
      `top match ${top.path} should contain both tokens`);
    // And the random notes file must NOT be in the matches.
    for (const m of rel.result.matches) {
      assert.equal(m.path.includes("random"), false);
    }
  } finally {
    _closeAll();
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5) getNeighbors — 1-level BFS
// ---------------------------------------------------------------------------

test("getNeighbors returns imports + importedBy at depth 1", async () => {
  const root = makeTempDir();
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    writeTree(root, {
      "a.js": "require('./b.js'); require('./c.js');\n",
      "b.js": "require('./c.js');\n",
      "c.js": "// leaf\n",
    });
    const r = await ProjectIntel.indexProject(1, 600, root);
    assert.equal(r.ok, true);

    const nbA = await ProjectIntel.getNeighbors(1, 600, "a.js", 1, root);
    assert.equal(nbA.ok, true);
    assert.deepEqual(new Set(nbA.result.imports), new Set(["b.js", "c.js"]));
    assert.deepEqual(nbA.result.importedBy, []);

    const nbC = await ProjectIntel.getNeighbors(1, 600, "c.js", 1, root);
    assert.equal(nbC.ok, true);
    assert.deepEqual(new Set(nbC.result.importedBy), new Set(["a.js", "b.js"]));
    assert.deepEqual(nbC.result.imports, []);
  } finally {
    _closeAll();
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6) getStats shape
// ---------------------------------------------------------------------------

test("getStats returns totalFiles, totalBytes, byLanguage, indexedAt", async () => {
  const root = makeTempDir();
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    writeTree(root, {
      "a.js": "x = 1;\n",
      "b.ts": "y = 2;\n",
    });
    const r = await ProjectIntel.indexProject(1, 700, root);
    assert.equal(r.ok, true);

    const stats = await ProjectIntel.getStats(1, 700, root);
    assert.equal(stats.ok, true);
    assert.equal(stats.result.totalFiles, 2);
    assert.equal(stats.result.totalBytes > 0, true);
    assert.equal(typeof stats.result.byLanguage, "object");
    assert.equal(stats.result.byLanguage.js, 1);
    assert.equal(stats.result.byLanguage.ts, 1);
    assert.equal(typeof stats.result.indexedAt, "number");
    assert.ok(stats.result.indexedAt > 0);
  } finally {
    _closeAll();
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7) relevantFiles — SQL LIMIT pushdown (GATE 17 v8 perf fix #1)
//    The old code did `SELECT path FROM files` (full table scan) and ranked
//    in JS. For a 50K-file project that transferred 50K rows per agent run.
//    The fix pushes a LIKE pre-filter + ORDER BY hits DESC + LIMIT 200 into
//    SQL, so the result set is bounded at the SQLite layer.
// ---------------------------------------------------------------------------

/** Build a fixture of `count` files all matching the same query token. */
function makeMatchingFiles(count, dir, name) {
  const files = {};
  for (let i = 0; i < count; i++) {
    files[`${dir}/${name}-${i}.js`] = `// ${name} match\nexport const x = ${i};\n`;
  }
  return files;
}

test("relevantFiles SQL LIMIT pushdown: 1000-file fixture returns at most 200 rows", async () => {
  const root = makeTempDir();
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    // 1000 files, every one containing the "loop" token in its path.
    writeTree(root, makeMatchingFiles(1000, "src", "loop"));

    const r = await ProjectIntel.indexProject(1, 800, root);
    assert.equal(r.ok, true, `indexProject failed: ${JSON.stringify(r)}`);
    assert.equal(r.result.files, 1000);

    // max well above the SQL bound so the SQL LIMIT — not the JS `max`
    // slice — is the binding constraint. On the old (no-LIMIT) code this
    // would have returned all 1000 rows.
    const rel = await ProjectIntel.relevantFiles(1, 800, "loop", 1000, root);
    assert.equal(rel.ok, true, `relevantFiles failed: ${JSON.stringify(rel)}`);
    assert.ok(
      rel.result.matches.length <= 200,
      `SQL LIMIT must bound results to <= 200 rows; got ${rel.result.matches.length}`,
    );
    assert.ok(
      rel.result.matches.length < 1000,
      `must not return all 1000 matches (proves an intermediate LIMIT exists); got ${rel.result.matches.length}`,
    );
    // No row that failed to match the token should leak through.
    for (const m of rel.result.matches) {
      assert.equal(m.path.toLowerCase().includes("loop"), true);
    }
  } finally {
    _closeAll();
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

test("relevantFiles honors max when max is below the SQL bound (public API preserved)", async () => {
  const root = makeTempDir();
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    writeTree(root, makeMatchingFiles(500, "src", "loop"));
    await ProjectIntel.indexProject(1, 810, root);

    const rel = await ProjectIntel.relevantFiles(1, 810, "loop", 7, root);
    assert.equal(rel.ok, true);
    assert.equal(rel.result.matches.length, 7, "max must still cap the result count");
    for (const m of rel.result.matches) {
      assert.equal(m.path.toLowerCase().includes("loop"), true);
      // Score shape preserved: { path, score } with a numeric score.
      assert.equal(typeof m.score, "number");
    }
  } finally {
    _closeAll();
    rmSync(root, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});