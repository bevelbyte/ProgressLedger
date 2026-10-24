// Project Intelligence ownership boundary. The exported resolver is the
// same helper used by every project:intel IPC handler before cache/filesystem
// access. Renderer rootPath is intentionally absent from the trusted context.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";

import { resolveProjectIntelContext } from "../src/security/project-intel-auth.js";
import { ProjectIntel, _setUserDataDir, _closeAll } from "../src/services/project-intel/index.js";

function project(id, profileId, rootPath) {
  return { id, profile_id: profileId, profileId, root_path: rootPath, rootPath };
}

test("Project Intel IPC authorizes the Project Mode row before every cache/filesystem call", () => {
  const source = readFileSync(new URL("../src/ipc/project-intel.js", import.meta.url), "utf8");
  const handlers = [
    ["project:intel:index", /indexProject|reindexDelta/],
    ["project:intel:files", /getFileList/],
    ["project:intel:neighbors", /getNeighbors/],
    ["project:intel:relevant", /relevantFiles/],
    ["project:intel:stats", /getStats/],
  ];
  for (const [channel, serviceCall] of handlers) {
    const start = source.indexOf(`safeHandle("${channel}"`);
    assert.ok(start >= 0, `${channel} missing`);
    const end = source.indexOf("safeHandle(", start + 12);
    const body = source.slice(start, end < 0 ? source.length : end);
    assert.ok(body.indexOf("authorized(payload)") < body.search(serviceCall), `${channel} must authorize first`);
  }
  const preload = readFileSync(new URL("../src/preload.cjs", import.meta.url), "utf8");
  assert.doesNotMatch(preload, /project:intel:index[\s\S]{0,300}rootPath/);
});

test("Project Intel resolves the stored root for the requested profile/project", async () => {
  const root = mkdtempSync(join(tmpdir(), "cf-pi-owned-"));
  const core = { pmGetProject: async (profileId, projectId) => project(7, profileId, root) };
  const resolved = await resolveProjectIntelContext(core, { profileId: 3, projectId: 7, rootPath: "C:\\foreign" });
  assert.deepEqual(resolved, { ok: true, profileId: 3, projectId: 7, rootPath: root });
  rmSync(root, { recursive: true, force: true });
});

test("Project Intel rejects foreign profile, foreign project, and stale context", async () => {
  const root = mkdtempSync(join(tmpdir(), "cf-pi-foreign-"));
  const owned = project(7, 3, root);
  const core = {
    pmGetProject: async (profileId, projectId) =>
      profileId === owned.profile_id && projectId === owned.id ? owned : null,
  };
  for (const payload of [
    { profileId: 4, projectId: 7 },
    { profileId: 3, projectId: 8 },
    { profileId: 3, projectId: 999 },
  ]) {
    const resolved = await resolveProjectIntelContext(core, payload);
    assert.equal(resolved.ok, false);
    assert.equal(resolved.error, "project-not-owned");
  }
  rmSync(root, { recursive: true, force: true });
});

test("full index uses the trusted stored root, not renderer rootPath", async () => {
  const userData = mkdtempSync(join(tmpdir(), "cf-pi-ud-"));
  const owned = mkdtempSync(join(tmpdir(), "cf-pi-owned-root-"));
  const foreign = mkdtempSync(join(tmpdir(), "cf-pi-foreign-root-"));
  mkdirSync(join(owned, "src"), { recursive: true });
  mkdirSync(join(foreign, "src"), { recursive: true });
  writeFileSync(join(owned, "src", "owned.js"), "export const owned = 1;");
  writeFileSync(join(foreign, "src", "foreign.js"), "export const foreign = 1;");
  _setUserDataDir(userData);
  try {
    const core = { pmGetProject: async (profileId, projectId) =>
      profileId === 1 && projectId === 10 ? project(10, 1, owned) : null,
    };
    const resolved = await resolveProjectIntelContext(core, {
      profileId: 1,
      projectId: 10,
      rootPath: foreign,
    });
    assert.equal(resolved.ok, true);
    const indexed = await ProjectIntel.indexProject(resolved.profileId, resolved.projectId, resolved.rootPath);
    assert.equal(indexed.ok, true);
    const files = await ProjectIntel.getFileList(1, 10, {}, resolved.rootPath);
    assert.equal(files.ok, true);
    assert.equal(files.result.entries.some((f) => f.path.includes("owned.js")), true);
    assert.equal(files.result.entries.some((f) => f.path.includes("foreign.js")), false);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
    rmSync(owned, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  }
});

test("delta indexing rejects a cached root that differs from the trusted project root", async () => {
  const userData = mkdtempSync(join(tmpdir(), "cf-pi-delta-ud-"));
  const owned = mkdtempSync(join(tmpdir(), "cf-pi-delta-owned-"));
  const foreign = mkdtempSync(join(tmpdir(), "cf-pi-delta-foreign-"));
  writeFileSync(join(owned, "owned.js"), "export const owned = 1;");
  writeFileSync(join(foreign, "foreign.js"), "export const foreign = 1;");
  _setUserDataDir(userData);
  try {
    assert.equal((await ProjectIntel.indexProject(1, 11, foreign)).ok, true);
    const staleRead = await ProjectIntel.getFileList(1, 11, {}, owned);
    assert.equal(staleRead.ok, false);
    assert.equal(staleRead.error.code, "root-mismatch");
    const delta = await ProjectIntel.reindexDelta(1, 11, owned);
    assert.equal(delta.ok, false);
    assert.equal(delta.error.code, "root-mismatch");
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
    rmSync(owned, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SF-2 — fail-closed root binding. A missing trusted root is a REJECTION, not
// an implicit "trust whatever the cache says" fallback.
// ---------------------------------------------------------------------------

test("SF-2: cached reads fail closed when the trusted root is missing", async () => {
  const userData = mkdtempSync(join(tmpdir(), "cf-pi-sf2-ud-"));
  const owned = mkdtempSync(join(tmpdir(), "cf-pi-sf2-owned-"));
  writeFileSync(join(owned, "secret.js"), "export const secret = 1;");
  _setUserDataDir(userData);
  try {
    // Build a real, trusted cache for project 12.
    const indexed = await ProjectIntel.indexProject(1, 12, owned);
    assert.equal(indexed.ok, true);

    // Every cached read entry point must refuse to serve the cache when the
    // caller did not supply an authorized Project Mode root.
    const reads = [
      ["getFileList", () => ProjectIntel.getFileList(1, 12, {})],
      ["getNeighbors", () => ProjectIntel.getNeighbors(1, 12, "secret.js", 1)],
      ["relevantFiles", () => ProjectIntel.relevantFiles(1, 12, "secret", 10)],
      ["getStats", () => ProjectIntel.getStats(1, 12)],
    ];
    for (const [name, call] of reads) {
      const res = await call();
      assert.equal(res.ok, false, `${name} must not serve the cache without a trusted root`);
      assert.equal(res.error.code, "root-required", `${name} must report root-required`);
    }

    // Explicitly-undefined / empty / non-string roots are equally rejected.
    for (const bogus of [undefined, null, "", "   ", 42, {}, []]) {
      const res = await ProjectIntel.getFileList(1, 12, {}, bogus);
      assert.equal(res.ok, false, `root ${JSON.stringify(bogus)} must be rejected`);
      assert.equal(res.error.code, "root-required");
    }

    // The authorized root still works — this is a fail-closed gate, not a
    // blanket denial.
    const good = await ProjectIntel.getFileList(1, 12, {}, owned);
    assert.equal(good.ok, true, `authorized root must still read: ${JSON.stringify(good)}`);
    assert.equal(good.result.entries.some((f) => f.path === "secret.js"), true);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
    rmSync(owned, { recursive: true, force: true });
  }
});

test("SF-2: the IPC layer always threads the authorized root into cached reads", () => {
  const source = readFileSync(new URL("../src/ipc/project-intel.js", import.meta.url), "utf8");
  for (const [channel, serviceCall] of [
    ["project:intel:files", "getFileList"],
    ["project:intel:neighbors", "getNeighbors"],
    ["project:intel:relevant", "relevantFiles"],
    ["project:intel:stats", "getStats"],
  ]) {
    const start = source.indexOf(`safeHandle("${channel}"`);
    assert.ok(start >= 0, `${channel} missing`);
    const end = source.indexOf("safeHandle(", start + 12);
    const body = source.slice(start, end < 0 ? source.length : end);
    const call = body.indexOf(`${serviceCall}(`);
    assert.ok(call >= 0, `${channel} must call ${serviceCall}`);
    const args = body.slice(call, body.indexOf(");", call));
    assert.ok(
      args.includes("context.rootPath"),
      `${channel} must pass context.rootPath to ${serviceCall} (fail-closed root binding)`,
    );
  }
});

test("SF-2: a cache row with no recorded root is never treated as matching", async () => {
  const userData = mkdtempSync(join(tmpdir(), "cf-pi-sf2-noroot-ud-"));
  const owned = mkdtempSync(join(tmpdir(), "cf-pi-sf2-noroot-owned-"));
  writeFileSync(join(owned, "a.js"), "export const a = 1;");
  _setUserDataDir(userData);
  try {
    assert.equal((await ProjectIntel.indexProject(1, 13, owned)).ok, true);
    // Wipe the recorded root directly, simulating a partially-built cache.
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(ProjectIntel._dbPathFor(13));
    try {
      db.prepare(`DELETE FROM meta WHERE key = 'rootPath'`).run();
    } finally {
      db.close();
    }
    const res = await ProjectIntel.getFileList(1, 13, {}, owned);
    assert.equal(res.ok, false, "a cache with no recorded root must not be readable");
    assert.equal(res.error.code, "root-mismatch");
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
    rmSync(owned, { recursive: true, force: true });
  }
});
