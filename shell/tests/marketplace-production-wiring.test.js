// Marketplace PRODUCTION WIRING — end-to-end through the real startup path
// and the real IPC channel map.
//
// The reconciliation found that `configureMarketplace` had NO production
// caller: only unit tests called it. The secured marketplace service was
// therefore unreachable from the real application, every `marketplace:*` IPC
// operation answered `no-root`, and the centralized containment policy in
// services/marketplace/path-security.js was never exercised at runtime.
//
// These tests deliberately do NOT call configureMarketplace directly. They
// drive the same two entry points the app uses:
//
//   1. bootstrapMarketplace(rootDir)   — shell/src/services/marketplace/bootstrap.js
//                                         (called once from main.js whenReady)
//   2. registerMarketplaceChannels(handle, ctx)
//                                      — shell/src/ipc/marketplace-channels.js
//                                         (registered by shell/src/ipc/marketplace.js)
//
// and then invoke the captured channels by their production names.
//
// Coverage: startup -> list -> install -> update -> remove -> shutdown, plus
// the containment policy still being enforced on the production path.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapMarketplace, shutdownMarketplace } from "../src/services/marketplace/bootstrap.js";
import { Marketplace } from "../src/services/marketplace/index.js";
import { marketplaceHandlers } from "../src/ipc/marketplace-channels.js";
import { _resetActiveProjectRoots } from "../src/ipc/agent-root-registry.js";

/**
 * Invoke the REAL production handler functions by their production channel
 * names. `ipc/marketplace.js` registers exactly these function objects.
 */
function captureChannels() {
  const handlers = new Map(Object.entries(marketplaceHandlers));
  return {
    handlers,
    channels: [...handlers.keys()],
    call: (channel, payload) => {
      const h = handlers.get(channel);
      assert.ok(h, `${channel} must be a production handler`);
      return h({ sender: "test" }, payload);
    },
  };
}

function makeSourcePlugin(dir, { name = "Demo", version = "1.0.0", extra = {} } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "plugin.json"),
    JSON.stringify({ name, version, skills: [], tools: [], mcpServers: [], ...extra }, null, 2),
    "utf8",
  );
  return dir;
}

function freshWorkspace() {
  return mkdtempSync(join(tmpdir(), "cf-mkt-wiring-"));
}

/**
 * A source plugin at a CONTROLLABLE basename. The install id is derived from
 * `basename(source)`, so the folder name has to be pinned for assertions.
 */
function freshSource(id) {
  const parent = mkdtempSync(join(tmpdir(), "cf-mkt-src-"));
  const dir = join(parent, id);
  mkdirSync(dir, { recursive: true });
  return { dir, parent };
}

test.beforeEach(() => {
  Marketplace._resetForTests();
  _resetActiveProjectRoots();
});
test.afterEach(() => {
  Marketplace._resetForTests();
});

test("production startup wires the marketplace so no operation answers no-root", () => {
  const workspace = freshWorkspace();
  try {
    // Before startup the service is inert — this is exactly the bug.
    const cold = captureChannels();
    assert.equal(cold.call("marketplace:install-local", { path: workspace }).reason, "no-root");

    // The production startup path.
    const booted = bootstrapMarketplace(workspace);
    assert.equal(booted.ok, true, `bootstrapMarketplace must succeed: ${JSON.stringify(booted)}`);
    assert.equal(booted.root, workspace);
    assert.equal(booted.count, 0);

    // All eight production channels are present.
    assert.deepEqual(cold.channels.slice().sort(), [
      "marketplace:disable",
      "marketplace:enable",
      "marketplace:get",
      "marketplace:install-git",
      "marketplace:install-local",
      "marketplace:list",
      "marketplace:uninstall",
      "marketplace:update",
    ]);

    // And the service is now live — no-root is gone.
    const warm = captureChannels();
    assert.deepEqual(warm.call("marketplace:list"), { ok: true, items: [] });
  } finally {
    shutdownMarketplace();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("production path: startup -> list -> install -> update -> remove", async () => {
  const workspace = freshWorkspace();
  const { dir: source, parent: sourceParent } = freshSource("demo-plugin");
  try {
    const booted = bootstrapMarketplace(workspace);
    assert.equal(booted.ok, true);

    const ipc = captureChannels();
    const dest = join(workspace, "marketplace", "demo-plugin");

    // --- list: empty -------------------------------------------------------
    assert.deepEqual(ipc.call("marketplace:list"), { ok: true, items: [] });

    // --- install -----------------------------------------------------------
    makeSourcePlugin(source, { name: "Demo Plugin", version: "1.0.0" });
    const installed = await ipc.call("marketplace:install-local", { path: source });
    assert.equal(installed.ok, true, `install must succeed: ${JSON.stringify(installed)}`);
    assert.equal(installed.id, "demo-plugin");
    assert.ok(existsSync(join(dest, "plugin.json")), "the install must land under the marketplace root");

    // --- list: one item ----------------------------------------------------
    const listed = ipc.call("marketplace:list");
    assert.equal(listed.ok, true);
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].id, "demo-plugin");
    assert.equal(listed.items[0].name, "Demo Plugin");
    assert.equal(listed.items[0].enabled, false, "a fresh install must be disabled by default");

    // --- get / enable / disable -------------------------------------------
    const got = ipc.call("marketplace:get", { id: "demo-plugin" });
    assert.equal(got.ok, true);
    assert.equal(got.item.version, "1.0.0");
    assert.equal(ipc.call("marketplace:enable", { id: "demo-plugin" }).ok, true);
    assert.equal(ipc.call("marketplace:get", { id: "demo-plugin" }).item.enabled, true);
    assert.equal(ipc.call("marketplace:disable", { id: "demo-plugin" }).ok, true);
    assert.equal(ipc.call("marketplace:get", { id: "demo-plugin" }).item.enabled, false);

    // --- update: re-read the on-disk manifest ------------------------------
    writeFileSync(
      join(dest, "plugin.json"),
      JSON.stringify({ name: "Demo Plugin", version: "2.0.0", skills: [], tools: [], mcpServers: [] }, null, 2),
      "utf8",
    );
    assert.equal(ipc.call("marketplace:update", { id: "demo-plugin" }).ok, true);
    assert.equal(ipc.call("marketplace:get", { id: "demo-plugin" }).item.version, "2.0.0");

    // --- remove ------------------------------------------------------------
    assert.equal(ipc.call("marketplace:uninstall", { id: "demo-plugin" }).ok, true);
    assert.equal(existsSync(dest), false, "uninstall must remove the on-disk folder");
    assert.deepEqual(ipc.call("marketplace:list"), { ok: true, items: [] });
  } finally {
    shutdownMarketplace();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(sourceParent, { recursive: true, force: true });
  }
});

test("production path: state survives a stop/start cycle (shutdown flushes the sidecar)", () => {
  const workspace = freshWorkspace();
  const { dir: source, parent: sourceParent } = freshSource("persisted");
  try {
    assert.equal(bootstrapMarketplace(workspace).ok, true);
    const ipc = captureChannels();
    makeSourcePlugin(source, { name: "Persisted", version: "3.1.4" });
    assert.equal(ipc.call("marketplace:install-local", { path: source }).ok, true);
    assert.equal(ipc.call("marketplace:enable", { id: "persisted" }).ok, true);

    // shutdown flushes the sidecar, then a fresh boot reloads from disk.
    assert.equal(shutdownMarketplace().ok, true);
    assert.ok(existsSync(join(workspace, "marketplace-state.json")), "stop must flush the sidecar");

    Marketplace._resetForTests();
    const rebooted = bootstrapMarketplace(workspace);
    assert.equal(rebooted.ok, true);
    assert.equal(rebooted.count, 1, "the installed item must be rediscovered on the next boot");

    const ipc2 = captureChannels();
    const item = ipc2.call("marketplace:get", { id: "persisted" });
    assert.equal(item.ok, true);
    assert.equal(item.item.name, "Persisted");
    assert.equal(item.item.version, "3.1.4");
    assert.equal(item.item.enabled, true, "the enabled flag must survive the restart");
  } finally {
    shutdownMarketplace();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(sourceParent, { recursive: true, force: true });
  }
});

test("production path still enforces the centralized containment policy", () => {
  const workspace = freshWorkspace();
  try {
    assert.equal(bootstrapMarketplace(workspace).ok, true);
    const ipc = captureChannels();

    // Traversal / absolute / drive / UNC / reserved ids.
    const badIds = [
      "..", "../escape", "..\\escape", "a/b", "a\\b",
      "C:\\Windows", "C:", "\\\\server\\share\\x", "con", "nul.txt", "trailing.", "trailing ",
    ];

    // `uninstall` and `update` resolve an on-disk destination, so a hostile id
    // must be refused by the shared path-security policy as `invalid-id`.
    for (const id of badIds) {
      for (const channel of ["marketplace:uninstall", "marketplace:update"]) {
        const res = ipc.call(channel, { id });
        assert.equal(res.ok, false, `${channel} must refuse id ${JSON.stringify(id)}`);
        assert.equal(res.reason, "invalid-id", `${channel} must refuse id ${JSON.stringify(id)} as invalid-id`);
      }
    }

    // `get` / `enable` / `disable` answer from the in-memory registry and never
    // touch the filesystem, so `unknown-item` is the correct refusal — but it
    // must still be a refusal, never a success.
    for (const id of badIds) {
      for (const channel of ["marketplace:get", "marketplace:enable", "marketplace:disable"]) {
        const res = ipc.call(channel, { id });
        assert.equal(res.ok, false, `${channel} must refuse id ${JSON.stringify(id)}`);
        assert.ok(
          res.reason === "unknown-item" || res.reason === "invalid-id",
          `${channel} must refuse id ${JSON.stringify(id)}; got ${JSON.stringify(res)}`,
        );
      }
    }
  } finally {
    shutdownMarketplace();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("production path refuses an invalid local source without touching the root", () => {
  const workspace = freshWorkspace();
  try {
    assert.equal(bootstrapMarketplace(workspace).ok, true);
    const ipc = captureChannels();
    const before = existsSync(join(workspace, "marketplace"));

    for (const [payload, reason] of [
      [{ path: "" }, "invalid-source"],
      [{ path: 42 }, "invalid-source"],
      [{}, "invalid-source"],
      [{ path: join(workspace, "does-not-exist") }, "source-not-found"],
    ]) {
      const res = ipc.call("marketplace:install-local", payload);
      assert.equal(res.ok, false);
      assert.equal(res.reason, reason, `payload ${JSON.stringify(payload)}`);
    }
    assert.equal(existsSync(join(workspace, "marketplace")), before,
      "a refused install must not create the marketplace root");
  } finally {
    shutdownMarketplace();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("main.js wires the marketplace exactly once, and shuts it down on quit", () => {
  const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  const callSites = main.match(/bootstrapMarketplace\(/g) || [];
  assert.equal(callSites.length, 1, `expected exactly one startup call site, got ${callSites.length}`);
  assert.match(
    main,
    /import \{ bootstrapMarketplace, shutdownMarketplace \} from "\.\/services\/marketplace\/bootstrap\.js"/,
    "main.js must import the marketplace lifecycle helpers",
  );
  assert.match(main, /bootstrapMarketplace\(marketplaceRoot\)/,
    "the startup call must pass the resolved workspace root");
  assert.match(main, /const marketplaceRoot = resolveMarketplaceDir\(\)/,
    "the root must come from the workspace resolver, not a hardcoded path");
  assert.match(main, /shutdownMarketplace\(\)/, "will-quit must shut the marketplace down");
});

test("ipc/marketplace.js registers every tested handler with a literal safeHandle call", () => {
  const ipc = readFileSync(new URL("../src/ipc/marketplace.js", import.meta.url), "utf8");
  const registered = [...ipc.matchAll(/safeHandle\(\s*"(marketplace:[^"]+)"\s*,\s*marketplaceHandlers\["\1"\]\s*\)/g)]
    .map((m) => m[1]);
  // The literal form is what scripts/check-ipc.mjs can see; a loop would blind it.
  assert.deepEqual(registered.slice().sort(), Object.keys(marketplaceHandlers).sort(),
    "every tested handler must be registered with a literal safeHandle(\"channel\", ...) call");
  assert.doesNotMatch(ipc.replace(/safeHandle\([^)]*\)/g, ""), /for\s*\(\s*const\s+\[?\w+\]?\s*(of|in)\s/,
    "the registrations must not be collapsed into a loop (check-ipc cannot see it)");

  // And the registration is complete: preload's channels are all present.
  const preload = readFileSync(new URL("../src/preload.cjs", import.meta.url), "utf8");
  for (const m of preload.matchAll(/ipcRenderer\.invoke\(\s*"(marketplace:[^"]+)"/g)) {
    assert.ok(registered.includes(m[1]), `${m[1]} is invoked by preload but not registered`);
  }
});
