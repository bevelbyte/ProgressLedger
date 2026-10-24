// GATE 12 (v7) — Secure plugin code access.
//
// The v6 capability matrix flagged: the plugin runtime had NO `entry` field —
// plugins declared metadata only, never code. GATE 12 implements a secure
// minimal path: the manifest validator now accepts and validates an `entry`
// field (a relative path to the plugin's main JS file), and Plugins.load(id)
// resolves that path with assertInsideProjectRoot() — read-only path access,
// NO eval/require/vm execution.
//
// Test invariants:
//   - validateManifest accepts entry: "index.js" (and other safe relative paths)
//   - validateManifest rejects .. traversal, absolute paths, backslashes
//   - Plugins.load(id) returns the resolved absolute entry path
//   - Plugins.load(id) returns path: null when the plugin has no entry
//   - Plugins.load(id) returns ok:false for unknown plugins
//   - All existing gate9 / plugin-trust invariants still hold (../etc/passwd
//     rejected by value validation, NOT by whitelisting)
//
// Hermetic: every test uses a fresh tmp root.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  Plugins,
  configurePlugins,
  validateManifest,
} from "../src/services/plugins/index.js";

test.beforeEach(() => {
  Plugins._resetForTests();
});

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "cf-gate12-"));
}

function makeSource(root, id, manifest) {
  const dir = join(root, "src", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  return dir;
}

// ---------------------------------------------------------------------------
// 1. Manifest with entry: "index.js" is accepted
// ---------------------------------------------------------------------------

test("GATE 12 / manifest: entry: 'index.js' is accepted and surfaces in the manifest", () => {
  const v = validateManifest({ name: "X", version: "1.0.0", entry: "index.js" });
  assert.equal(v.ok, true);
  assert.equal(v.manifest.entry, "index.js");
});

test("GATE 12 / manifest: entry with subdirectory path is accepted", () => {
  const v = validateManifest({ name: "X", version: "1.0.0", entry: "src/main.js" });
  assert.equal(v.ok, true);
  assert.equal(v.manifest.entry, "src/main.js");
});

test("GATE 12 / manifest: entry omitted is accepted (entry is null in manifest)", () => {
  const v = validateManifest({ name: "X", version: "1.0.0" });
  assert.equal(v.ok, true);
  assert.equal(v.manifest.entry, null);
});

// ---------------------------------------------------------------------------
// 2. Plugins.load(id) returns the resolved path of the entry
// ---------------------------------------------------------------------------

test("GATE 12 / load: returns the resolved absolute path of the entry", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makeSource(root, "with-entry", {
    name: "WE", version: "1.0.0", entry: "index.js",
  });
  // Drop the actual entry file so it exists on disk.
  writeFileSync(join(src, "index.js"), "// plugin code\n", "utf8");

  const ins = Plugins.install({ id: null, source: src });
  assert.equal(ins.ok, true);
  assert.equal(ins.id, "with-entry");

  const loaded = Plugins.load("with-entry");
  assert.equal(loaded.ok, true);
  assert.equal(typeof loaded.path, "string");
  // The resolved path must be inside <root>/plugins/<id>/.
  assert.ok(loaded.path.includes(join("plugins", "with-entry")));
  assert.ok(loaded.path.endsWith("index.js"));
  // And the file actually exists on disk.
  assert.equal(existsSync(loaded.path), true);

  rmSync(root, { recursive: true, force: true });
});

test("GATE 12 / load: resolves entry in a subdirectory", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makeSource(root, "with-subdir", {
    name: "WS", version: "1.0.0", entry: "src/handler.js",
  });
  mkdirSync(join(src, "src"), { recursive: true });
  writeFileSync(join(src, "src", "handler.js"), "// handler\n", "utf8");

  Plugins.install({ id: null, source: src });

  const loaded = Plugins.load("with-subdir");
  assert.equal(loaded.ok, true);
  assert.ok(loaded.path.includes(join("plugins", "with-subdir")));
  assert.ok(loaded.path.endsWith(join("src", "handler.js")));

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 3. An entry with `..` path traversal is rejected (manifest-level)
// ---------------------------------------------------------------------------

test("GATE 12 / trust: entry with .. path traversal is rejected by manifest validator", () => {
  const v = validateManifest({
    name: "X", version: "1.0.0", entry: "../../etc/passwd",
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "invalid-manifest");
});

test("GATE 12 / trust: entry with .. in a subdirectory is rejected", () => {
  const v = validateManifest({
    name: "X", version: "1.0.0", entry: "src/../../etc/passwd",
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "invalid-manifest");
});

test("GATE 12 / trust: install rejects a plugin whose manifest has .. traversal entry", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makeSource(root, "evil", {
    name: "Evil", version: "1.0.0", entry: "../../etc/passwd",
  });
  const r = Plugins.install({ id: null, source: src });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-manifest");
  // No on-disk artifact left behind (rollback).
  assert.equal(existsSync(join(root, "plugins", "evil")), false);
  // Nothing registered.
  assert.equal(Plugins.list().length, 0);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 4. An entry pointing outside the plugin dir is rejected
// ---------------------------------------------------------------------------

test("GATE 12 / security: absolute entry path is rejected by manifest validator", () => {
  const v = validateManifest({
    name: "X", version: "1.0.0", entry: "/etc/passwd",
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "invalid-manifest");
});

test("GATE 12 / security: entry with backslash is rejected (POSIX-only paths)", () => {
  const v = validateManifest({
    name: "X", version: "1.0.0", entry: "windows\\system32\\config",
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "invalid-manifest");
});

test("GATE 12 / security: Plugins.load returns ok:true for a safe entry (assertInsideProjectRoot gate passes)", () => {
  // This exercises the defense-in-depth assertInsideProjectRoot call in
  // Plugins.load — a valid entry must pass the gate and resolve to a path
  // inside the plugin directory.
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makeSource(root, "safe", { name: "S", version: "1.0.0", entry: "index.js" });
  writeFileSync(join(src, "index.js"), "// safe\n", "utf8");
  Plugins.install({ id: null, source: src });

  const loaded = Plugins.load("safe");
  assert.equal(loaded.ok, true);
  // Verify the resolved path is inside <root>/plugins/safe
  const pluginDir = join(root, "plugins", "safe");
  assert.ok(loaded.path.startsWith(pluginDir));

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 5. Loading a plugin with no entry returns null (graceful)
// ---------------------------------------------------------------------------

test("GATE 12 / graceful: Plugins.load returns path:null for a plugin with no entry", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makeSource(root, "no-entry", { name: "NE", version: "1.0.0" /* no entry */ });
  Plugins.install({ id: null, source: src });

  const loaded = Plugins.load("no-entry");
  assert.equal(loaded.ok, true);
  assert.equal(loaded.path, null);

  rmSync(root, { recursive: true, force: true });
});

test("GATE 12 / graceful: Plugins.load returns unknown-plugin for an uninstalled id", () => {
  configurePlugins({ rootDir: freshRoot() });
  const loaded = Plugins.load("does-not-exist");
  assert.equal(loaded.ok, false);
  assert.equal(loaded.reason, "unknown-plugin");
});

// ---------------------------------------------------------------------------
// 6. Entry field survives reload / list
// ---------------------------------------------------------------------------

test("GATE 12 / lifecycle: entry is preserved across reload and visible in list()", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makeSource(root, "persisted", {
    name: "P", version: "1.0.0", entry: "index.js", skills: ["s"],
  });
  writeFileSync(join(src, "index.js"), "// v1\n", "utf8");
  Plugins.install({ id: null, source: src });
  Plugins.enable("persisted");

  // list() surfaces the entry.
  const listed = Plugins.list().find((p) => p.id === "persisted");
  assert.equal(listed.entry, "index.js");
  assert.equal(listed.enabled, true);

  // Change the on-disk manifest entry — reload reflects it.
  writeFileSync(
    join(root, "plugins", "persisted", "plugin.json"),
    JSON.stringify({ name: "P", version: "2.0.0", entry: "main.js" }),
    "utf8",
  );
  const r = Plugins.reload("persisted");
  assert.equal(r.ok, true);
  assert.equal(r.plugin.entry, "main.js");

  // load() now points at the new entry path.
  const loaded = Plugins.load("persisted");
  assert.equal(loaded.ok, true);
  assert.ok(loaded.path.endsWith("main.js"));

  rmSync(root, { recursive: true, force: true });
});
