// PROJECT INTELLIGENCE — durable index recovery across an application restart.
//
// THE DEFECT THIS LOCKS OUT
// The project-intel index is durable: a per-project SQLite sidecar under
// `<userData>/project-intel/<projectId>.sqlite`, with a `meta.rootPath` row
// recording the root it was built against, plus `files` / `edges` / `meta`
// tables. Only the OPEN HANDLE was cached, in a module-scoped `dbCache` Map.
//
// A fresh process therefore started with an empty cache and every read
// answered `not-initialized`. The persisted index was unreachable, and because
// no renderer surface calls `project:intel:index`, the user had no way to
// rebuild it either — Project Intelligence was empty after every application
// restart even though the data was sitting on disk.
//
// THE FIX, AND WHY IT IS NOT A WEAKENING OF SF-2
// A cold read now reopens the persisted sidecar. The fail-closed root binding
// is preserved and in fact strengthened: the `meta.rootPath` row is compared
// against the authorized root, so a recovered index is validated against the
// root it was actually built for. A project with no index on disk opens an
// empty database with no `rootPath` row and is refused `root-mismatch`.
//
// WHAT IS ASSERTED HERE
//   1. An index built in "process 1" is readable in "process 2" after the
//      handle cache is dropped (the restart), with its content intact.
//   2. The recovered read is still refused when the authorized root DIFFERS
//      from the root the index was built against  -> `root-mismatch`.
//   3. The recovered read is still refused when NO root is supplied
//      -> `root-required`.
//   4. A project that was never indexed is still refused, not served empty.
//   5. Blank / whitespace / non-string roots are still refused.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  _setUserDataDir,
  _closeAll,
  _dbPathFor,
  indexProject,
  getFileList,
  getStats,
} from "../src/services/project-intel/index.js";

function makeTree(root) {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "alpha.js"), "import './beta.js';\nexport const a = 1;\n", "utf8");
  writeFileSync(join(root, "src", "beta.js"), "export const b = 2;\n", "utf8");
  writeFileSync(join(root, "README.md"), "# fixture\n", "utf8");
  return root;
}

test("a persisted index is readable again after the handle cache is dropped (restart)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cf-pintel-data-"));
  const root = makeTree(mkdtempSync(join(tmpdir(), "cf-pintel-root-")));
  const projectId = 4242;
  try {
    _setUserDataDir(dataDir);
    _closeAll();

    // ---- process 1: build the index --------------------------------------
    const built = await indexProject(1, projectId, root);
    assert.equal(built.ok, true, `indexProject: ${JSON.stringify(built)}`);

    const hot = await getFileList(1, projectId, {}, root);
    assert.equal(hot.ok, true);
    const hotJson = JSON.stringify(hot);
    assert.ok(hotJson.includes("alpha.js"), "the fresh index must list the source files");
    assert.ok(hotJson.includes("beta.js"));

    // The sidecar really is on disk — this is what makes recovery possible.
    const sidecar = _dbPathFor(projectId);
    assert.ok(sidecar.startsWith(dataDir), "the sidecar must live under the app's userData");

    // ---- process 2: the handle cache is gone, the DATA is not -------------
    // `_closeAll()` is exactly what `will-quit` does, and a fresh module
    // registry is exactly what a new process gets.
    _closeAll();

    const cold = await getFileList(1, projectId, {}, root);
    assert.equal(
      cold.ok,
      true,
      `the persisted index must be recoverable after a restart: ${JSON.stringify(cold)}`
    );
    const coldJson = JSON.stringify(cold);
    assert.ok(coldJson.includes("alpha.js"), "the recovered index must still list the source files");
    assert.ok(coldJson.includes("beta.js"));

    // And the derived reads recover too, not just the file list.
    const stats = await getStats(1, projectId, root);
    assert.equal(stats.ok, true, `getStats after restart: ${JSON.stringify(stats)}`);
    assert.ok(Number(stats.result?.totalFiles ?? 0) > 0, "recovered stats must count real files");
    assert.ok(Number(stats.result?.indexedAt ?? 0) > 0, "recovered stats must carry the original index time");
    assert.ok(stats.result?.byLanguage && Object.keys(stats.result.byLanguage).length > 0);
  } finally {
    _closeAll();
    _setUserDataDir(null);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery does NOT weaken the fail-closed root binding", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cf-pintel-bind-"));
  const root = makeTree(mkdtempSync(join(tmpdir(), "cf-pintel-root-")));
  const otherRoot = mkdtempSync(join(tmpdir(), "cf-pintel-other-"));
  const projectId = 4343;
  try {
    _setUserDataDir(dataDir);
    _closeAll();
    assert.equal((await indexProject(1, projectId, root)).ok, true);

    // Restart: handles gone, data on disk.
    _closeAll();

    // (a) A DIFFERENT authorized root must be refused, even though the index
    //     is perfectly readable. This is the whole point of the trust anchor.
    const mismatched = await getFileList(1, projectId, {}, otherRoot);
    assert.equal(mismatched.ok, false, "a recovered index must still be bound to its root");
    assert.equal(mismatched.error.code, "root-mismatch");
    assert.ok(
      !JSON.stringify(mismatched).includes("alpha.js"),
      "a refused read must not leak any indexed path"
    );

    // (b) No root at all must be refused.
    const noRoot = await getFileList(1, projectId, {});
    assert.equal(noRoot.ok, false);
    assert.equal(noRoot.error.code, "root-required");

    // (c) Blank / whitespace / non-string roots must be refused.
    for (const bad of ["", "   ", "\t\n", null, undefined, 42, {}, []]) {
      const res = await getFileList(1, projectId, {}, bad);
      assert.equal(res.ok, false, `root ${JSON.stringify(bad)} must be refused`);
      assert.equal(res.error.code, "root-required");
    }

    // (d) The correct root still works, so the refusals above are meaningful.
    const correct = await getFileList(1, projectId, {}, root);
    assert.equal(correct.ok, true);
    assert.ok(JSON.stringify(correct).includes("alpha.js"));
  } finally {
    _closeAll();
    _setUserDataDir(null);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
  }
});

test("a project that was never indexed is still refused, not served empty", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cf-pintel-none-"));
  const root = makeTree(mkdtempSync(join(tmpdir(), "cf-pintel-root-")));
  try {
    _setUserDataDir(dataDir);
    _closeAll();

    const res = await getFileList(1, 999999, {}, root);
    assert.equal(res.ok, false, "an unindexed project must not answer with an empty list");
    assert.ok(
      ["root-mismatch", "not-initialized"].includes(res.error.code),
      `unexpected code: ${JSON.stringify(res.error)}`
    );
  } finally {
    _closeAll();
    _setUserDataDir(null);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
