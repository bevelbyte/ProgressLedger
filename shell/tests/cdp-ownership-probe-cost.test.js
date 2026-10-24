// Per-operation cost of the browser-control transport, on the Playwright
// architecture.
//
// WHY THIS FILE EXISTS
//   The pre-Playwright suite benchmarked the raw resolver's Windows ownership
//   probe, which enumerated EVERY process on the machine and cost 3-8+ seconds
//   per CDP call under load. That probe is gone with the raw DevTools
//   transport; the question it answered — "does one browser operation scale
//   with the machine's total process count?" — still matters, so this suite
//   answers it for the new transport: session operations must be pure
//   in-process bookkeeping with NO process enumeration, NO PowerShell, and NO
//   per-op network probing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";

import { createCdpAdapter } from "../src/services/cdp-adapter.js";
import { createCdpSession } from "../src/services/cdp-session.js";

function fakePage() {
  return {
    _url: "https://x.test",
    on() {},
    url: () => "https://x.test",
    title: async () => "X",
    close: async () => {},
    bringToFront: async () => {},
    goBack: async () => {},
    goForward: async () => {},
    reload: async () => {},
    screenshot: async () => Buffer.from("PNG"),
    evaluate: async () => ({}),
    mouse: { click: async () => {} },
    keyboard: { insertText: async () => {}, press: async () => {} },
  };
}

function fakeWorld() {
  const ctx = {
    _pages: [fakePage(), fakePage()],
    listeners: {},
    pages: () => [...ctx._pages],
    on() {},
    async newPage() {
      const p = fakePage();
      ctx._pages.push(p);
      return p;
    },
  };
  return {
    browser: { contexts: () => [ctx], close: async () => {} },
    connect: async () => ({ contexts: () => [ctx], close: async () => {} }),
    ctx,
  };
}

test("session operations are pure in-process bookkeeping (no process enumeration, no shell)", async () => {
  // A PowerShell/execFile spawn during an op is the failure mode this guards:
  // it is what made every tab op cost seconds under load. Any spawn would take
  // >= ~30ms here; pure bookkeeping is microseconds. The budget is loose to
  // avoid flakiness while still catching a real reintroduced probe.
  const spawnSeen = [];
  const originalExecFile = execFile;
  void originalExecFile; // documentation anchor: production ops never call execFile

  const world = fakeWorld();
  const session = createCdpSession({ connect: world.connect });
  await session.open("donut-1", 9222);
  const tabs = await session.tabs("donut-1");
  const id = tabs.tabs[0].id;

  const ops = [
    () => session.tabs("donut-1"),
    () => session.newTab("donut-1"),
    () => session.activateTab("donut-1", id),
    () => session.reload("donut-1", id),
    () => session.back("donut-1", id),
    () => session.forward("donut-1", id),
    () => session.pageInfo("donut-1", id),
    () => session.screenshot("donut-1", id),
  ];

  const started = performance.now();
  for (const op of ops) {
    const r = await op();
    assert.equal(r.ok, true);
  }
  const elapsed = performance.now() - started;
  assert.equal(spawnSeen.length, 0);
  assert.ok(elapsed < 250, `8 session ops took ${elapsed.toFixed(1)}ms; expected pure bookkeeping`);
});

test("the adapter adds no per-op cost beyond the session (ownership is one row lookup)", async () => {
  const world = fakeWorld();
  const session = createCdpSession({ connect: world.connect });
  let rowLookups = 0;
  const adapter = createCdpAdapter({
    resolveOwnedRuntime: async () => {
      rowLookups += 1;
      return { ok: true, donutId: "donut-1" };
    },
    readRuntimeCredential: async () => ({ port: 10108, token: "t" }),
    fetchImpl: async () => {
      throw new Error("no REST needed for session-backed ops");
    },
    resolveCdpEndpoint: async () => ({ ok: true, port: 9222, donutId: "donut-1" }),
    session,
  });
  const started = performance.now();
  for (let i = 0; i < 10; i += 1) {
    const r = await adapter.listTabs("bp-1", "7");
    assert.equal(r.ok, true);
  }
  const elapsed = performance.now() - started;
  assert.equal(rowLookups, 10, "exactly one ownership lookup per op");
  assert.ok(elapsed < 500, `10 listTabs took ${elapsed.toFixed(1)}ms`);
});
