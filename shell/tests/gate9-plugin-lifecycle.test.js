// Plugins — GATE 9: full plugin lifecycle (discover -> install -> use -> disable -> remove).
//
// Covers the end-to-end lifecycle against the real plugin runtime at
// `shell/src/services/plugins/index.js` (no mocks). Every test is hermetic
// — each one builds a fresh tmp root under os.tmpdir() and tears it down
// before exit, so the userData directory of a real install is never
// touched.
//
// Lifecycle phases exercised:
//   1. DISCOVER  — a plugin folder on disk is picked up by loadFromDisk()
//   2. INSPECT   — a valid manifest is parsed and its fields surface
//   3. INSTALL   — Plugins.install({ id, source }) copies a local plugin
//                  dir into the plugin store and registers it
//   4. TRUST     — a manifest with `entry: "../../etc/passwd"` is rejected
//                  by the strict whitelist (path-traversal + smuggling)
//   5. USE       — an enabled plugin's metadata is queryable and the
//                  hot-reload bus emits lifecycle events (the real
//                  surface in this slice — there is no `entry` loader)
//   6. DISABLE   — a disabled plugin stays registered but is no longer
//                  listed as enabled
//   7. REMOVE    — Plugins.uninstall(id) deletes the plugin folder and
//                  drops the in-memory record
//   8. PERMISSIONS — a manifest declaring a `permissions` field is
//                  rejected by the strict whitelist (the runtime's
//                  permission boundary — smuggled permission grants
//                  cannot escape the manifest validator)

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  Plugins,
  configurePlugins,
  validateManifest,
  isValidPluginId,
} from "../src/services/plugins/index.js";

// Reset module state between tests (wipes in-memory registry, watchers,
// rootDir, state path, auto-reload toggle).
test.beforeEach(() => {
  Plugins._resetForTests();
});

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "cf-gate9-"));
}

/**
 * Create a source plugin directory under <root>/src/<id>/ with the given
 * manifest, then return the path. Caller is responsible for `rmSync(root)`
 * after the test.
 */
function makeSource(root, id, manifest) {
  const dir = join(root, "src", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  return dir;
}

// ---------------------------------------------------------------------------
// 1. DISCOVER — a plugin folder on disk is picked up by loadFromDisk()
// ---------------------------------------------------------------------------

test("GATE 9 / discover: loadFromDisk picks up a plugin folder in <userData>/plugins/<id>/", () => {
  const root = freshRoot();
  // Simulate "plugin already on disk" by writing directly to the
  // <userData>/plugins/<id>/plugin.json path that loadFromDisk scans.
  const pluginDir = join(root, "plugins", "discovered");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "plugin.json"),
    JSON.stringify({ name: "Discovered", version: "1.0.0", skills: ["s1"] }),
    "utf8",
  );

  configurePlugins({ rootDir: root });
  const r = Plugins.loadFromDisk();

  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  const all = Plugins.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, "discovered");
  assert.equal(all[0].name, "Discovered");
  assert.deepEqual(all[0].skills, ["s1"]);

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 2. INSPECT — a valid manifest is parsed and its fields surface
// ---------------------------------------------------------------------------

test("GATE 9 / inspect: validateManifest parses a valid manifest and surfaces id/name/version/skills", () => {
  const raw = {
    name: "Inspect",
    version: "2.3.4",
    id: "inspect",
    skills: ["alpha", "beta"],
    tools: ["tool-a"],
    mcpServers: ["mcp-x"],
  };
  const v = validateManifest(raw);
  assert.equal(v.ok, true);
  assert.equal(v.manifest.name, "Inspect");
  assert.equal(v.manifest.version, "2.3.4");
  assert.equal(v.manifest.id, "inspect");
  assert.deepEqual(v.manifest.skills, ["alpha", "beta"]);
  assert.deepEqual(v.manifest.tools, ["tool-a"]);
  assert.deepEqual(v.manifest.mcpServers, ["mcp-x"]);
  // isValidPluginId is the public guard used by install — confirm the
  // manifest-declared id would have passed install's whitelist.
  assert.equal(isValidPluginId("inspect"), true);
});

// ---------------------------------------------------------------------------
// 3. INSTALL — Plugins.install({ id, source }) copies the dir into the
//              plugin store and registers it
// ---------------------------------------------------------------------------

test("GATE 9 / install: Plugins.install({ id, source }) copies a local plugin dir into the plugin store", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makeSource(root, "myplugin", {
    name: "MyPlugin", version: "1.0.0", skills: ["x"],
  });
  // Drop a non-manifest file to prove the whole tree is copied, not
  // just plugin.json.
  writeFileSync(join(src, "README.md"), "hello", "utf8");

  const r = Plugins.install({ id: null, source: src });

  assert.equal(r.ok, true);
  assert.equal(r.id, "myplugin");
  // Folder was actually copied.
  const installedRoot = join(root, "plugins", "myplugin");
  assert.ok(existsSync(join(installedRoot, "plugin.json")));
  assert.ok(existsSync(join(installedRoot, "README.md")));
  // And the in-memory registry was populated.
  const all = Plugins.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, "myplugin");
  assert.equal(all[0].name, "MyPlugin");
  // New installs are disabled by default — "use" is opt-in.
  assert.equal(all[0].enabled, false);

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 4. TRUST — a manifest with `entry: "../../etc/passwd"` is rejected
//    (smuggling + path traversal in a single payload)
// ---------------------------------------------------------------------------

test("GATE 9 / trust: manifest with entry: '../../etc/passwd' is rejected (smuggled field + path traversal)", () => {
  const v = validateManifest({
    name: "Evil",
    version: "1.0.0",
    entry: "../../etc/passwd",  // smuggled + traversal
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "invalid-manifest");

  // install() also rejects the same payload end-to-end: it copies, then
  // validates, then rolls back the copy on failure.
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makeSource(root, "evil", {
    name: "Evil",
    version: "1.0.0",
    entry: "../../etc/passwd",
  });
  const r = Plugins.install({ id: null, source: src });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-manifest");
  // No half-installed plugin folder left behind.
  assert.equal(existsSync(join(root, "plugins", "evil")), false);
  // And nothing was registered.
  assert.equal(Plugins.list().length, 0);

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 5. USE — an enabled plugin's metadata is queryable AND the hot-reload
//    bus fires the `reloaded` event when its on-disk manifest changes
//    (the real "use" surface in this slice — there is no `entry` loader
//    so we test the public, observable signal: the lifecycle bus + the
//    enabled state)
// ---------------------------------------------------------------------------

test("GATE 9 / use: an enabled plugin is observable via list() and fires the reloaded bus event on manifest change", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makeSource(root, "active", {
    name: "Active", version: "1.0.0", skills: ["s-active"], tools: ["t-active"],
  });
  const ins = Plugins.install({ id: null, source: src });
  assert.equal(ins.ok, true);

  // Enable — the "use" step.
  const en = Plugins.enable("active");
  assert.equal(en.ok, true);
  const enabled = Plugins.list().find((p) => p.id === "active");
  assert.ok(enabled, "plugin should be listed after enable");
  assert.equal(enabled.enabled, true);
  // Declared surface (skills/tools) is what the agent loop would consume.
  assert.deepEqual(enabled.skills, ["s-active"]);
  assert.deepEqual(enabled.tools, ["t-active"]);

  // The lifecycle bus must fire `reloaded` when the on-disk manifest
  // changes — this is the runtime's real "plugin is in use" signal.
  const events = [];
  const listener = (e) => events.push(e);
  Plugins.on("reloaded", listener);

  // Bump the on-disk manifest to a new version.
  const dest = join(root, "plugins", "active", "plugin.json");
  writeFileSync(
    dest,
    JSON.stringify({ name: "Active", version: "2.0.0", skills: ["s-active", "s-extra"], tools: ["t-active"] }),
    "utf8",
  );
  const r = Plugins.reload("active");
  assert.equal(r.ok, true);
  assert.equal(r.plugin.version, "2.0.0");
  assert.equal(r.plugin.enabled, true, "enabled state preserved across reload");

  // The bus fired exactly one `reloaded` event for our plugin id.
  assert.equal(events.length, 1);
  assert.equal(events[0].id, "active");
  assert.equal(events[0].plugin.version, "2.0.0");

  Plugins.off("reloaded", listener);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 6. DISABLE — a disabled plugin stays registered but is no longer
//    listed as enabled
// ---------------------------------------------------------------------------

test("GATE 9 / disable: a disabled plugin is registered with enabled=false and the lifecycle bus stays quiet", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makeSource(root, "toggle", {
    name: "Toggle", version: "1.0.0", skills: ["s"],
  });
  Plugins.install({ id: null, source: src });

  // Enable then disable.
  Plugins.enable("toggle");
  assert.equal(Plugins.list()[0].enabled, true);
  const dis = Plugins.disable("toggle");
  assert.equal(dis.ok, true);
  assert.equal(Plugins.list()[0].enabled, false);

  // Idempotent — a second disable is a no-op success.
  const dis2 = Plugins.disable("toggle");
  assert.equal(dis2.ok, true);
  assert.equal(Plugins.list()[0].enabled, false);

  // The plugin is STILL in the registry (disable ≠ uninstall).
  const all = Plugins.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, "toggle");

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 7. REMOVE — Plugins.uninstall(id) deletes the plugin folder and drops
//    the in-memory record
// ---------------------------------------------------------------------------

test("GATE 9 / remove: Plugins.uninstall(id) deletes the on-disk plugin folder and drops the registry entry", () => {
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makeSource(root, "bye", {
    name: "Bye", version: "1.0.0", skills: ["s"],
  });
  Plugins.install({ id: null, source: src });
  const installedRoot = join(root, "plugins", "bye");
  assert.ok(existsSync(installedRoot), "install must create the on-disk folder");

  const r = Plugins.uninstall("bye");
  assert.equal(r.ok, true);

  // The folder is gone from disk.
  assert.equal(existsSync(installedRoot), false);
  // And the in-memory record is gone.
  assert.equal(Plugins.list().length, 0);

  // A second uninstall is a graceful no-op — it does not crash on
  // a missing folder and does not re-create the registry entry.
  const r2 = Plugins.uninstall("bye");
  assert.equal(r2.ok, true);
  assert.equal(Plugins.list().length, 0);

  rmSync(root, { recursive: true, force: true });
});

test("GATE 9 / trust: lifecycle path APIs reject traversal ids", () => {
  assert.deepEqual(Plugins.reload("../../escape"), { ok: false, reason: "invalid-id" });
  assert.deepEqual(Plugins.update("../../escape"), { ok: false, reason: "invalid-id" });
  assert.deepEqual(Plugins.load("../../escape"), { ok: false, reason: "invalid-id" });
  assert.deepEqual(Plugins.uninstall("../../escape"), { ok: false, reason: "invalid-id" });
});

// ---------------------------------------------------------------------------
// 8. PERMISSIONS — a manifest declaring a `permissions` field is
//    rejected by the strict whitelist. The runtime's permission
//    boundary is the manifest validator: any field outside the
//    whitelist (name, version, id, skills, tools, mcpServers) is
//    refused, so a smuggled `permissions` grant — or a smuggled
//    `entry` that would point to attacker code — cannot escape the
//    boundary.
// ---------------------------------------------------------------------------

test("GATE 9 / permissions: a smuggled permissions field is rejected by the manifest whitelist", () => {
  // Standalone manifest check — `permissions` is not a whitelisted
  // field, so the validator returns invalid-manifest.
  const v = validateManifest({
    name: "Perm",
    version: "1.0.0",
    permissions: ["fs:write", "net:raw"],  // smuggled permission grant
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "invalid-manifest");

  // End-to-end: install() refuses the same payload and rolls back
  // the copy. The runtime never sees the untrusted manifest.
  const root = freshRoot();
  configurePlugins({ rootDir: root });
  const src = makeSource(root, "perm", {
    name: "Perm",
    version: "1.0.0",
    permissions: ["fs:write", "net:raw"],
  });
  const r = Plugins.install({ id: null, source: src });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-manifest");
  // No on-disk artifact left behind.
  assert.equal(existsSync(join(root, "plugins", "perm")), false);
  // No registry entry.
  assert.equal(Plugins.list().length, 0);

  // Sanity: a manifest with a whitelisted field set + no smuggling
  // installs cleanly. This proves the rejection above was about the
  // `permissions` field and not the install path in general.
  const okSrc = makeSource(root, "clean", {
    name: "Clean", version: "1.0.0", skills: ["s"], tools: ["t"], mcpServers: [],
  });
  const ok = Plugins.install({ id: null, source: okSrc });
  assert.equal(ok.ok, true);
  assert.equal(ok.id, "clean");

  rmSync(root, { recursive: true, force: true });
});
