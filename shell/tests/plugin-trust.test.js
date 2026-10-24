// Plugin trust boundary tests.
//
// These tests verify the security invariants of the plugin/marketplace
// install + validation pipeline:
//   - Strict manifest validation (no smuggled fields, no path traversal).
//   - Safe plugin identifiers (no path-traversal via id).
//   - No silent overwrites (duplicates rejected).
//   - No plugin code executed at install time.
//   - On-disk manifests re-validated on reload (read-only boundary).
//   - Git source: graceful failures + rollback on validation failure.
//
// All disk activity is hermetic via per-test tmp dirs. No real network.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  cpSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  Plugins,
  configurePlugins,
  validateManifest,
  isValidPluginId,
} from "../src/services/plugins/index.js";
import {
  Marketplace,
  configureMarketplace,
} from "../src/services/marketplace/index.js";
import { installGit } from "../src/services/marketplace/git-install.js";

// Reset module-level state between tests.
test.beforeEach(() => {
  Plugins._resetForTests();
  Marketplace._resetForTests();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "cf-trust-"));
}

/**
 * Create a source plugin directory under <root>/src/<id>/ with the given
 * manifest, then return the path.
 */
function makeSource(root, id, manifest) {
  const dir = join(root, "src", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  return dir;
}

/**
 * Build an execFile stub that mimics `git clone --depth 1 ... <dest>` by
 * copying `fixtureDir` into the destination path, and `git rev-parse HEAD`
 * by returning a fake sha.
 */
function fakeExecFile({ fixtureDir, failClone = false }) {
  return (bin, args /* , opts */) =>
    new Promise((resolveP, rejectP) => {
      if (bin !== "git") return rejectP(new Error(`unexpected bin ${bin}`));
      const argv = args || [];
      if (argv[0] === "clone") {
        if (failClone) return rejectP(new Error("fatal: could not clone"));
        const dest = argv[argv.length - 1];
        try {
          mkdirSync(dest, { recursive: true });
          cpSync(fixtureDir, dest, { recursive: true, force: true });
        } catch (e) {
          return rejectP(e);
        }
        return resolveP({ stdout: "", stderr: "" });
      }
      if (argv[0] === "-C" && argv[2] === "rev-parse") {
        return resolveP({ stdout: "deadbeefcafef00ddeadbeefcafef00d\n", stderr: "" });
      }
      return rejectP(new Error(`unexpected git args: ${argv.join(" ")}`));
    });
}

// ---------------------------------------------------------------------------
// 1. Manifest with extra unknown field → rejected
// ---------------------------------------------------------------------------

test("validateManifest: rejects extra unknown fields (smuggling prevention)", () => {
  const v = validateManifest({
    name: "X",
    version: "1.0.0",
    evil: true,  // unknown field
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "invalid-manifest");
});

// ---------------------------------------------------------------------------
// 2. Manifest with entry: "../../etc/passwd" (path traversal) → rejected
// ---------------------------------------------------------------------------

test("validateManifest: rejects entry path-traversal payload", () => {
  const v = validateManifest({
    name: "X",
    version: "1.0.0",
    entry: "../../etc/passwd",  // smuggled field with path traversal
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "invalid-manifest");
});

// ---------------------------------------------------------------------------
// 3. Manifest with id: "" (empty) → rejected
// ---------------------------------------------------------------------------

test("validateManifest: rejects empty id", () => {
  const v = validateManifest({ name: "X", version: "1.0.0", id: "" });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "invalid-manifest");
});

// ---------------------------------------------------------------------------
// 4. Manifest with id: "plugin/with/slashes" → rejected
// ---------------------------------------------------------------------------

test("validateManifest: rejects id with path separators", () => {
  const v = validateManifest({
    name: "X",
    version: "1.0.0",
    id: "plugin/with/slashes",
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "invalid-manifest");
});

// ---------------------------------------------------------------------------
// 5. Manifest with id: "../escape" → rejected
// ---------------------------------------------------------------------------

test("validateManifest: rejects id with path traversal (..)", () => {
  const v = validateManifest({
    name: "X",
    version: "1.0.0",
    id: "../escape",
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "invalid-manifest");
});

// ---------------------------------------------------------------------------
// 6. Install with path-traversal id → rejected
// ---------------------------------------------------------------------------

test("Plugins.install: rejects path-traversal in explicit id parameter", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makeSource(root, "legit", { name: "Legit", version: "1.0.0" });
  // The id param is used directly as a path component under plugins/.
  // "../../escape" would resolve outside plugins/ — must be rejected.
  const r = Plugins.install({ id: "../../escape", source: src });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-id");
  // Nothing was written.
  assert.equal(existsSync(join(root, "plugins", "..", "escape")), false);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 7. Install to a path that already exists (duplicate) → rejected
// ---------------------------------------------------------------------------

test("Plugins.install: duplicate install is rejected (no silent overwrite)", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makeSource(root, "dup", { name: "Dup", version: "1.0.0" });
  // First install succeeds.
  const first = Plugins.install({ id: null, source: src });
  assert.equal(first.ok, true);
  assert.equal(first.id, "dup");
  // Second install to the same id is rejected.
  const second = Plugins.install({ id: null, source: src });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "duplicate");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 8. Plugin code is NOT executed at install time (no infinite loop)
// ---------------------------------------------------------------------------

test("Plugins.install: plugin code is not executed at install time", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });

  // Build a source dir whose JS file would hang the process IF executed.
  const src = join(root, "src", "noexec-test");
  mkdirSync(src, { recursive: true });
  writeFileSync(
    join(src, "plugin.json"),
    JSON.stringify({ name: "NoExec", version: "1.0.0", skills: [], tools: [], mcpServers: [] }),
    "utf8",
  );
  // If install ever imports/requires this file, the while(true) hangs
  // the test runner beyond its timeout.
  writeFileSync(join(src, "hang.js"), "while(true){}\n", "utf8");

  const start = Date.now();
  const r = Plugins.install({ id: null, source: src });
  const elapsed = Date.now() - start;

  assert.equal(r.ok, true, "install should succeed");
  assert.ok(elapsed < 3000, `install took ${elapsed}ms — plugin code may have been executed`);

  // The hang.js file exists on disk but was never run.
  assert.ok(existsSync(join(root, "plugins", "noexec-test", "hang.js")));
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 9. Tampered manifest on disk is rejected on reload (read-only boundary)
// ---------------------------------------------------------------------------

test("Plugins.reload: tampered manifest with smuggled field is rejected", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makeSource(root, "safe", { name: "Safe", version: "1.0.0" });
  Plugins.install({ id: null, source: src });

  // Tamper: inject a smuggled field into the on-disk manifest.
  const dest = join(root, "plugins", "safe", "plugin.json");
  writeFileSync(
    dest,
    JSON.stringify({
      name: "Safe",
      version: "1.0.0",
      entry: "../../etc/passwd",  // attacker-injected field
    }),
    "utf8",
  );

  // reload() re-reads and re-validates the on-disk manifest.
  const r = Plugins.reload("safe");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-manifest");
  // The in-memory record is preserved (not replaced with the bad one).
  assert.equal(Plugins.list().length, 1);
  assert.equal(Plugins.list()[0].name, "Safe");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 10. Git source with a non-existent repo → rejected gracefully
// ---------------------------------------------------------------------------

test("installGit: non-existent repo fails with clone-failed (no crash, no partial install)", async () => {
  const root = freshRoot();
  // execFile stub that simulates a failed clone (repo does not exist).
  const exec = () =>
    new Promise((_resolve, reject) =>
      reject(new Error("fatal: repository not found")),
    );
  const r = await installGit({
    url: "https://example.com/owner/nonexistent.git",
    userDataDir: root,
    execFile: exec,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "clone-failed");
  // No marketplace dir created, no leftover staging.
  assert.equal(existsSync(join(root, "marketplace", "nonexistent")), false);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 11. Git source with a manifest that fails validation → install is rolled back
// ---------------------------------------------------------------------------

test("installGit: invalid manifest in clone is rolled back (no half-installed plugin)", async () => {
  const root = freshRoot();
  // Fixture that "clones" successfully but has a manifest with an extra
  // smuggled field that fails strict validation.
  const fix = join(root, "fixture-bad-manifest");
  mkdirSync(fix, { recursive: true });
  writeFileSync(
    join(fix, "plugin.json"),
    JSON.stringify({ name: "Bad", version: "1.0.0", entry: "../../etc/passwd" }),
    "utf8",
  );
  const exec = fakeExecFile({ fixtureDir: fix });
  const r = await installGit({
    url: "https://example.com/owner/bad.git",
    userDataDir: root,
    execFile: exec,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-manifest");
  // Final install dir must not exist (rollback — no half-installed plugin).
  assert.equal(existsSync(join(root, "marketplace", "bad")), false);
  // The staging root dir is intentionally kept by the impl, but no
  // staging subdirectories should remain after rollback.
  const stagingRoot = join(root, "marketplace", "staging");
  assert.ok(
    !existsSync(stagingRoot) || readdirSync(stagingRoot).length === 0,
    "staging root should have no leftover clone subdirectories",
  );
  rmSync(root, { recursive: true, force: true });
});
