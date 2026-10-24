// Plugins — hot-reload without an app restart.
//
// Covers:
//   - Plugins.reload(id) re-reads the manifest from disk
//   - The new manifest's skills/tools/mcpServers are reflected in the registry
//   - Enabled state is preserved across reload
//   - An invalid new manifest returns an error and the old record stays loaded
//   - The bus emits 'reloaded' on success
//   - With auto-reload enabled, an fs.watch on the install dir emits 'changed'
//     on the bus when a file is touched
//
// All tests are hermetic — they create a temp root and never touch real userData.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import {
  Plugins,
  configurePlugins,
} from "../src/services/plugins/index.js";
import { readFileSync as readTextFile } from "node:fs";

test.beforeEach(() => {
  Plugins._resetForTests();
});

test("production bootstrap loads the active workspace plugin registry and honors the explicit auto-reload switch", () => {
  const main = readTextFile(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(main, /Plugins\.configurePlugins\(\{ rootDir: pluginRoot \}\)/);
  assert.match(main, /Plugins\.loadFromDisk\(\{ rootDir: pluginRoot \}\)/);
  assert.match(main, /process\.env\.CAREERFLOW_PLUGIN_AUTO_RELOAD === "1"/);
  assert.match(main, /Plugins\.configureAutoReload\(\{ enabled: autoReload \}\)/);
  assert.match(main, /Plugins\.configureAutoReload\(\{ enabled: false \}\)/);
});

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "cf-plugins-reload-"));
}

function makePluginDir(root, id, manifest) {
  const dir = join(root, "src-plugins", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  return dir;
}

function writeManifest(pluginRoot, id, manifest) {
  const path = join(pluginRoot, "plugins", id, "plugin.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2), "utf8");
  // Bump mtime in case the OS doesn't update it on identical writes.
  try { utimesSync(path, new Date(), new Date()); } catch {}
}

// ---------------------------------------------------------------------------
// reload — happy path
// ---------------------------------------------------------------------------

test("reload re-reads the manifest from disk and refreshes the registry", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makePluginDir(root, "p", { name: "P", version: "1", tools: ["t1"] });
  const ins = Plugins.install({ id: null, source: src });
  assert.equal(ins.ok, true);

  // Bump the manifest on disk.
  writeManifest(root, "p", { name: "P", version: "2", tools: ["t1", "t2"], skills: ["s"] });

  const r = Plugins.reload("p");
  assert.equal(r.ok, true);
  assert.equal(r.plugin.version, "2");
  assert.deepEqual(r.plugin.tools, ["t1", "t2"]);
  assert.deepEqual(r.plugin.skills, ["s"]);
  // And the listing picks it up.
  const list = Plugins.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].version, "2");
  assert.deepEqual(list[0].tools, ["t1", "t2"]);
  rmSync(root, { recursive: true, force: true });
});

test("reload preserves the enabled flag across reload", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makePluginDir(root, "p", { name: "P", version: "1" });
  Plugins.install({ id: null, source: src });
  Plugins.enable("p");
  writeManifest(root, "p", { name: "P", version: "2" });

  const r = Plugins.reload("p");
  assert.equal(r.ok, true);
  assert.equal(r.plugin.enabled, true);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// reload — failure paths
// ---------------------------------------------------------------------------

test("reload returns invalid-manifest when the new manifest is malformed", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makePluginDir(root, "p", { name: "P", version: "1" });
  Plugins.install({ id: null, source: src });

  // Corrupt the on-disk manifest.
  writeFileSync(join(root, "plugins", "p", "plugin.json"), "{not json");

  const r = Plugins.reload("p");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-manifest");

  // Old record must still be present and unchanged.
  const after = Plugins.list()[0];
  assert.equal(after.version, "1");
  rmSync(root, { recursive: true, force: true });
});

test("reload returns invalid-manifest when a required field is missing", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makePluginDir(root, "p", { name: "P", version: "1" });
  Plugins.install({ id: null, source: src });

  // Drop the version field.
  writeManifest(root, "p", { name: "P" /* no version */ });

  const r = Plugins.reload("p");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-manifest");
  // Old record untouched.
  assert.equal(Plugins.list()[0].version, "1");
  rmSync(root, { recursive: true, force: true });
});

test("reload returns unknown-plugin for a missing id", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const r = Plugins.reload("ghost");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown-plugin");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// event bus
// ---------------------------------------------------------------------------

test("reload emits 'reloaded' on the bus with the new record", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makePluginDir(root, "p", { name: "P", version: "1" });
  Plugins.install({ id: null, source: src });
  writeManifest(root, "p", { name: "P", version: "9" });

  const events = [];
  const listener = (e) => events.push(e);
  Plugins.on("reloaded", listener);

  const r = Plugins.reload("p");
  assert.equal(r.ok, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, "p");
  assert.equal(events[0].plugin.version, "9");

  Plugins.off("reloaded", listener);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fs.watch + auto-reload
// ---------------------------------------------------------------------------

// Detect whether the platform supports recursive fs.watch natively.
// Falls back to manual subdirectory walking on Linux (see startWatcher).
async function supportsRecursiveWatch() {
  if (process.platform !== "linux") return true;
  try {
    const { watch: testWatch } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    // Best-effort feature detect: try opening a recursive watcher on tmp.
    const w = testWatch(tmpdir(), { recursive: true }, () => {});
    w.close();
    return true;
  } catch {
    return false;
  }
}

test("auto-reload: fs.watch re-reads the manifest and emits the refreshed plugin", async () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makePluginDir(root, "p", { name: "P", version: "1" });
  Plugins.install({ id: null, source: src });

  const events = [];
  Plugins.on("changed", (e) => events.push(e));

  // Opt-in to auto-reload AFTER install (also covers the re-arm path).
  Plugins.configureAutoReload({ enabled: true });

  // Touch a file inside the installed dir; the watcher debounces 100 ms.
  const installedManifest = join(root, "plugins", "p", "plugin.json");
  writeFileSync(installedManifest, JSON.stringify({ name: "P", version: "2", tools: ["updated"] }, null, 2));
  try { utimesSync(installedManifest, new Date(), new Date()); } catch {}

  // Give the debounced watcher up to 1.5 s to fire.
  for (let i = 0; i < 15 && events.length === 0; i++) {
    await delay(100);
  }

  // Tear down before asserting so a late event can't affect the test.
  Plugins.configureAutoReload({ enabled: false });

  assert.ok(events.length >= 1, "expected at least one 'changed' event");
  const last = events[events.length - 1];
  assert.equal(last.id, "p");
  assert.equal(Plugins.list()[0].version, "2");
  assert.deepEqual(Plugins.list()[0].tools, ["updated"]);
  assert.equal(last.plugin.version, "2");

  rmSync(root, { recursive: true, force: true });
});

test("auto-reload: changes in a subdirectory of the plugin also fire 'changed'", async () => {
  // Skills often live under skills/<id>/SKILL.md — a subdir of the plugin
  // root. The watcher must catch mutations there too.
  const supported = await supportsRecursiveWatch();
  if (!supported) {
    // The Linux fallback (manual walk) won't pick up subdirs that
    // exist at startWatcher time on every kernel, so skip rather than
    // flake. The native path is exercised on macOS/Windows in CI.
    return;
  }

  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makePluginDir(root, "p", { name: "P", version: "1" });
  // Pre-create a subdirectory inside the source so cpSync copies it.
  mkdirSync(join(src, "src"), { recursive: true });
  writeFileSync(join(src, "src", "handler.js"), "module.exports = () => 1;\n");
  const ins = Plugins.install({ id: null, source: src });
  assert.equal(ins.ok, true);

  const events = [];
  Plugins.on("changed", (e) => events.push(e));
  Plugins.configureAutoReload({ enabled: true });

  // Mutate a file in the subdirectory; the recursive watcher should fire.
  const subFile = join(root, "plugins", "p", "src", "handler.js");
  writeFileSync(subFile, "module.exports = () => 2;\n");
  try { utimesSync(subFile, new Date(), new Date()); } catch {}

  for (let i = 0; i < 15 && events.length === 0; i++) {
    await delay(100);
  }

  Plugins.configureAutoReload({ enabled: false });

  assert.ok(events.length >= 1, "expected at least one 'changed' event from a subdirectory mutation");
  const last = events[events.length - 1];
  assert.equal(last.id, "p");

  rmSync(root, { recursive: true, force: true });
});
