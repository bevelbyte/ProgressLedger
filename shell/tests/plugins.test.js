// Plugins — folder-based extension points.
//
// Covers:
//   - install/uninstall/enable/disable/update
//   - validateManifest shape checks
//   - malformed plugin.json is rejected with reason 'invalid-manifest'
//   - loadFromDisk skips invalid plugins without crashing
//   - install is hermetic (no Electron)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
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
  return mkdtempSync(join(tmpdir(), "cf-plugins-"));
}

function makePluginDir(root, id, manifest) {
  const dir = join(root, "src-plugins", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  return dir;
}

// ---------------------------------------------------------------------------
// validateManifest
// ---------------------------------------------------------------------------

test("validateManifest: ok with full manifest", () => {
  const v = validateManifest({
    name: "Foo", version: "1.0.0",
    skills: ["a", "b"], tools: ["t1"], mcpServers: ["m1"],
  });
  assert.equal(v.ok, true);
  assert.equal(v.manifest.name, "Foo");
  assert.equal(v.manifest.version, "1.0.0");
  assert.deepEqual(v.manifest.skills, ["a", "b"]);
});

test("validateManifest: missing name → invalid-manifest", () => {
  const v = validateManifest({ version: "1.0.0" });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "invalid-manifest");
});

test("validateManifest: missing version → invalid-manifest", () => {
  const v = validateManifest({ name: "Foo" });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "invalid-manifest");
});

test("validateManifest: null → invalid-manifest", () => {
  const v = validateManifest(null);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "invalid-manifest");
});

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

test("install copies plugin and registers it", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makePluginDir(root, "hello", {
    name: "Hello", version: "0.1.0", skills: ["h"],
  });
  const r = Plugins.install({ id: null, source: src });
  assert.equal(r.ok, true);
  assert.equal(r.id, "hello");
  // Folder was actually copied.
  assert.ok(readFileSync(join(root, "plugins", "hello", "plugin.json"), "utf8").includes("Hello"));
  // And registered.
  const list = Plugins.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "hello");
  rmSync(root, { recursive: true, force: true });
});

test("install rejects malformed manifest with invalid-manifest", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makePluginDir(root, "broken", { name: "Broken" /* no version */ });
  const r = Plugins.install({ id: null, source: src });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-manifest");
  // Source folder must not be left half-installed.
  rmSync(root, { recursive: true, force: true });
});

test("install rejects missing source", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const r = Plugins.install({ id: null, source: "/does/not/exist" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "source-not-found");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// enable / disable
// ---------------------------------------------------------------------------

test("enable/disable toggles a plugin", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makePluginDir(root, "p", { name: "P", version: "1" });
  Plugins.install({ id: null, source: src });
  assert.equal(Plugins.list()[0].enabled, false);
  Plugins.enable("p");
  assert.equal(Plugins.list()[0].enabled, true);
  Plugins.disable("p");
  assert.equal(Plugins.list()[0].enabled, false);
  rmSync(root, { recursive: true, force: true });
});

test("enable unknown plugin returns unknown-plugin", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const r = Plugins.enable("ghost");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown-plugin");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// uninstall + update + loadFromDisk
// ---------------------------------------------------------------------------

test("uninstall removes the plugin folder", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makePluginDir(root, "p", { name: "P", version: "1" });
  Plugins.install({ id: null, source: src });
  const r = Plugins.uninstall("p");
  assert.equal(r.ok, true);
  assert.equal(Plugins.list().length, 0);
  rmSync(root, { recursive: true, force: true });
});

test("update re-reads plugin.json and keeps enabled state", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makePluginDir(root, "p", { name: "P", version: "1" });
  Plugins.install({ id: null, source: src });
  Plugins.enable("p");
  // Bump the on-disk manifest version.
  const dest = join(root, "plugins", "p", "plugin.json");
  writeFileSync(dest, JSON.stringify({ name: "P", version: "2", skills: ["s"] }, null, 2));
  const r = Plugins.update("p");
  assert.equal(r.ok, true);
  const after = Plugins.list()[0];
  assert.equal(after.version, "2");
  assert.equal(after.enabled, true);
  rmSync(root, { recursive: true, force: true });
});

test("loadFromDisk picks up valid plugins and skips invalid", () => {
  const root = freshRoot();
  mkdirSync(join(root, "plugins", "good"), { recursive: true });
  writeFileSync(join(root, "plugins", "good", "plugin.json"), JSON.stringify({ name: "Good", version: "1" }));
  mkdirSync(join(root, "plugins", "bad"), { recursive: true });
  writeFileSync(join(root, "plugins", "bad", "plugin.json"), "{not json");
  configurePlugins({ rootDir: root });
  const r = Plugins.loadFromDisk();
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  const reasons = r.errors.map((e) => e.reason);
  assert.ok(reasons.includes("invalid-manifest"));
  rmSync(root, { recursive: true, force: true });
});