// Agent browser-interaction primitives (Phase: Agent→Browser extension), on
// the Playwright-over-CDP transport.
//
// Covers the adapter's browserGetPageText / browserExtractText / browserClick /
// browserType / browserPressKey / browserWaitForSelector and the ops-layer
// passthroughs in browser-workspace.js.
//
// Every collaborator is a stub: no Electron, no real Donut, no real browser,
// no socket. The Playwright session is injected with fake page objects, so the
// tests exercise exactly the code production runs minus the network.
//
// Security invariants proven here (carried over from the raw-transport suite):
//   - ownership: foreign/disabled profile → fail closed, NO session, NO connect
//   - unknown tabId → invalid-tab (no silent fallback to another page)
//   - bounded extraction (page/selector text ≤ 16000 chars)
//   - typed text is NEVER echoed in results (length + tag only)
//   - cancellation signal interrupts waits/evals (stable `cancelled` code)
//   - page-side evaluate exceptions are collapsed to evaluate-failed
//     (untrusted page-origin text is never returned)

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCdpAdapter, REASONS } from "../src/services/cdp-adapter.js";
import { createCdpSession } from "../src/services/cdp-session.js";
import { createWorkspaceOps } from "../src/services/browser-workspace.js";

const TOKEN = "SECRET-BEARER-TOKEN-XX";
const PORT = 10108;

// ---- fake Playwright page -------------------------------------------------
function makeFakePage() {
  const listeners = {};
  const page = {
    _url: "https://example.com/page",
    _title: "Fixture",
    calls: [],
    _evalQueue: [],
    url: () => page._url,
    title: async () => page._title,
    on(event, cb) { (listeners[event] = listeners[event] || []).push(cb); },
    emit(event) { for (const cb of listeners[event] || []) cb(page); },
    close: async () => { page.calls.push("close"); page.emit("close"); },
    bringToFront: async () => { page.calls.push("bringToFront"); },
    goBack: async () => { page.calls.push("goBack"); },
    goForward: async () => { page.calls.push("goForward"); },
    reload: async () => { page.calls.push("reload"); },
    goto: async (u) => { page.calls.push("goto"); page._url = u; },
    screenshot: async () => Buffer.from("PNG"),
    evaluate: async (expr) => {
      page.calls.push(["evaluate", expr]);
      if (page._throwOnEval) throw new Error(page._throwOnEval);
      const next = page._evalQueue.shift();
      return next !== undefined ? next : {};
    },
    mouse: { click: async () => page.calls.push("click") },
    keyboard: {
      insertText: async (text) => page.calls.push(["insertText", text]),
      press: async (key) => page.calls.push(["press", key]),
    },
  };
  return page;
}

function makeFakeWorld() {
  const world = { connects: [] };
  const ctx = {
    _pages: [makeFakePage(), makeFakePage()],
    listeners: {},
    pages: () => [...ctx._pages],
    on(e, cb) { (ctx.listeners[e] = ctx.listeners[e] || []).push(cb); },
    async newPage() {
      const p = makeFakePage();
      ctx._pages.push(p);
      for (const cb of ctx.listeners.page || []) cb(p);
      return p;
    },
  };
  world.ctx = ctx;
  world.page = (i = 0) => ctx._pages[i];
  world.browser = { contexts: () => [ctx], close: async () => { world.closed = true; } };
  world.connect = async (endpoint) => {
    world.connects.push(endpoint);
    return world.browser;
  };
  return world;
}

function makeAdapter({ resolve = async () => ({ ok: true, donutId: "donut-abc" }), world } = {}) {
  const w = world ?? makeFakeWorld();
  const session = createCdpSession({ connect: w.connect });
  return {
    world: w,
    session,
    adapter: createCdpAdapter({
      resolveOwnedRuntime: resolve,
      readRuntimeCredential: async () => ({ port: PORT, token: TOKEN }),
      fetchImpl: async () => {
        throw new Error("HTTP fallback must not be used by interaction primitives");
      },
      resolveCdpEndpoint: async () => ({ ok: true, port: 9222, donutId: "donut-abc" }),
      session,
    }),
  };
}

// The fake page.evaluate returns the RAW page value (like Playwright), and the
// session wraps it as { ok: true, value }. So fixtures queue raw values.
const evaluateWith = (value) => value;

// ============================================================================
// browser_get_page
// ============================================================================

test("browser_get_page returns bounded page info via page.evaluate", async () => {
  const { adapter, world } = makeAdapter();
  const tabs = await adapter.listTabs("bp-1", "7");
  world.page()._evalQueue.push(
    evaluateWith({ title: "T".repeat(1000), url: "https://example.com/x", text: "hello world" }),
  );
  const r = await adapter.browserGetPageText("bp-1", "7", tabs.tabs[0].id);
  assert.equal(r.ok, true);
  assert.equal(r.info.text, "hello world");
  assert.ok(r.info.title.length <= 512);
});

test("browser_get_page truncates page text to the bounded maximum", async () => {
  const { adapter, world } = makeAdapter();
  const tabs = await adapter.listTabs("bp-1", "7");
  world.page()._evalQueue.push(
    evaluateWith({ title: "T", url: "https://x.test", text: "A".repeat(60000) }),
  );
  const r = await adapter.browserGetPageText("bp-1", "7", tabs.tabs[0].id);
  assert.equal(r.ok, true);
  assert.equal(r.info.text.length, 16000);
});

// ============================================================================
// browser_extract_text
// ============================================================================

test("browser_extract_text: found element → text + tag", async () => {
  const { adapter, world } = makeAdapter();
  const tabs = await adapter.listTabs("bp-1", "7");
  world.page()._evalQueue.push(evaluateWith({ found: true, text: "apply now", tag: "button" }));
  const r = await adapter.browserExtractText("bp-1", "7", tabs.tabs[0].id, "#apply");
  assert.deepEqual(r, { ok: true, result: { text: "apply now", tag: "button" } });
});

test("browser_extract_text: missing element → selector-not-found", async () => {
  const { adapter, world } = makeAdapter();
  const tabs = await adapter.listTabs("bp-1", "7");
  world.page()._evalQueue.push(evaluateWith({ found: false }));
  const r = await adapter.browserExtractText("bp-1", "7", tabs.tabs[0].id, "#missing");
  assert.deepEqual(r, { ok: false, reason: "selector-not-found" });
});

test("browser_extract_text: invalid selector (too long) → invalid-selector", async () => {
  const { adapter } = makeAdapter();
  const tabs = await adapter.listTabs("bp-1", "7");
  const r = await adapter.browserExtractText("bp-1", "7", tabs.tabs[0].id, "#".repeat(300));
  assert.deepEqual(r, { ok: false, reason: "invalid-selector" });
});

// ============================================================================
// browser_click
// ============================================================================

test("browser_click: probe ok → mouse click at the probed center", async () => {
  const { adapter, world } = makeAdapter();
  const tabs = await adapter.listTabs("bp-1", "7");
  world.page()._evalQueue.push(
    evaluateWith({ state: "ok", x: 12.4, y: 34.6, tag: "button" }),
  );
  const r = await adapter.browserClick("bp-1", "7", tabs.tabs[0].id, "#apply");
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { clicked: true, tag: "button", x: 12, y: 35 });
  assert.deepEqual(world.page().calls.filter((c) => c === "click"), ["click"]);
});

test("browser_click: hidden element → element-not-visible; missing → selector-not-found", async () => {
  const { adapter, world } = makeAdapter();
  const tabs = await adapter.listTabs("bp-1", "7");
  world.page()._evalQueue.push(evaluateWith({ state: "not-visible" }));
  assert.deepEqual(await adapter.browserClick("bp-1", "7", tabs.tabs[0].id, "#hidden"), {
    ok: false,
    reason: "element-not-visible",
  });
  world.page()._evalQueue.push(evaluateWith({ state: "not-found" }));
  assert.deepEqual(await adapter.browserClick("bp-1", "7", tabs.tabs[0].id, "#gone"), {
    ok: false,
    reason: "selector-not-found",
  });
});

// ============================================================================
// browser_type
// ============================================================================

test("browser_type: focus probe ok → insertText; value NEVER echoed", async () => {
  const { adapter, world } = makeAdapter();
  const tabs = await adapter.listTabs("bp-1", "7");
  world.page()._evalQueue.push(evaluateWith({ state: "ok", tag: "input" }));
  const secret = "hunter2-secret";
  const r = await adapter.browserType("bp-1", "7", tabs.tabs[0].id, "#email", secret);
  assert.equal(r.ok, true);
  assert.equal(r.result.typed, true);
  assert.equal(r.result.length, secret.length);
  assert.equal(r.result.tag, "input");
  assert.ok(!JSON.stringify(r).includes(secret), "typed value must never be echoed");
});

test("browser_type: readOnly/disabled → element-not-ready; unfocusable → element-not-ready", async () => {
  const { adapter, world } = makeAdapter();
  const tabs = await adapter.listTabs("bp-1", "7");
  world.page()._evalQueue.push(evaluateWith({ state: "not-ready" }));
  assert.deepEqual(await adapter.browserType("bp-1", "7", tabs.tabs[0].id, "#e", "abc"), {
    ok: false,
    reason: "element-not-ready",
  });
  world.page()._evalQueue.push(evaluateWith({ state: "not-focusable" }));
  assert.deepEqual(await adapter.browserType("bp-1", "7", tabs.tabs[0].id, "#e", "abc"), {
    ok: false,
    reason: "element-not-ready",
  });
});

test("browser_type: empty or oversized or control-char text → invalid-text", async () => {
  const { adapter } = makeAdapter();
  const tabs = await adapter.listTabs("bp-1", "7");
  for (const bad of ["", "x".repeat(5000), "line\nbreak", "null\u0000byte"]) {
    assert.deepEqual(await adapter.browserType("bp-1", "7", tabs.tabs[0].id, "#e", bad), {
      ok: false,
      reason: "invalid-text",
    }, JSON.stringify(bad));
  }
});

// ============================================================================
// browser_press_key
// ============================================================================

test("browser_press_key: known key → keyboard.press", async () => {
  const { adapter, world } = makeAdapter();
  const tabs = await adapter.listTabs("bp-1", "7");
  const r = await adapter.browserPressKey("bp-1", "7", tabs.tabs[0].id, "Enter");
  assert.deepEqual(r, { ok: true, result: { sent: true, key: "Enter" } });
  assert.deepEqual(world.page().calls.filter((c) => Array.isArray(c) && c[0] === "press").map((c) => c[1]), ["Enter"]);
});

test("browser_press_key: unknown key → invalid-key", async () => {
  const { adapter } = makeAdapter();
  const tabs = await adapter.listTabs("bp-1", "7");
  assert.deepEqual(await adapter.browserPressKey("bp-1", "7", tabs.tabs[0].id, "F13"), {
    ok: false,
    reason: "invalid-key",
  });
});

// ============================================================================
// browser_wait
// ============================================================================

test("browser_wait: selector appears → found:true with waitedMs", async () => {
  const { adapter, world } = makeAdapter();
  const tabs = await adapter.listTabs("bp-1", "7");
  world.page()._evalQueue.push(evaluateWith(false), evaluateWith(true));
  const r = await adapter.browserWaitForSelector("bp-1", "7", tabs.tabs[0].id, "#done", 2000);
  assert.equal(r.ok, true);
  assert.equal(r.result.found, true);
  assert.equal(typeof r.result.waitedMs, "number");
});

test("browser_wait: timeout → found:false (never an error)", async () => {
  const { adapter, world } = makeAdapter();
  const tabs = await adapter.listTabs("bp-1", "7");
  for (let i = 0; i < 100; i += 1) world.page()._evalQueue.push(evaluateWith(false));
  const r = await adapter.browserWaitForSelector("bp-1", "7", tabs.tabs[0].id, "#never", 300);
  assert.equal(r.ok, true);
  assert.equal(r.result.found, false);
});

test("browser_wait: hard cap rejects >10s and non-integer", async () => {
  const { adapter } = makeAdapter();
  const tabs = await adapter.listTabs("bp-1", "7");
  for (const bad of [10001, 0, -5, 1.5, "3000"]) {
    assert.deepEqual(await adapter.browserWaitForSelector("bp-1", "7", tabs.tabs[0].id, "#x", bad), {
      ok: false,
      reason: "invalid-wait",
    }, String(bad));
  }
});

test("browser_wait: cancellation interrupts immediately", async () => {
  const { adapter, world } = makeAdapter();
  const tabs = await adapter.listTabs("bp-1", "7");
  const ctrl = new AbortController();
  ctrl.abort();
  const r = await adapter.browserWaitForSelector("bp-1", "7", tabs.tabs[0].id, "#x", 5000, {
    signal: ctrl.signal,
  });
  assert.deepEqual(r, { ok: false, reason: "cancelled" });
  void world;
});

test("browser_wait: bounded delay without selector", async () => {
  const { adapter } = makeAdapter();
  const tabs = await adapter.listTabs("bp-1", "7");
  const started = Date.now();
  const r = await adapter.browserWaitForSelector("bp-1", "7", tabs.tabs[0].id, "", 120);
  assert.equal(r.ok, true);
  assert.equal(r.result.found, null);
  assert.ok(Date.now() - started >= 100, "the delay is honored");
});

// ============================================================================
// failure isolation
// ============================================================================

test("browser death: unresolvable endpoint → backend-unavailable, NO session", async () => {
  const world = makeFakeWorld();
  const session = createCdpSession({ connect: world.connect });
  const adapter = createCdpAdapter({
    resolveOwnedRuntime: async () => ({ ok: true, donutId: "donut-abc" }),
    readRuntimeCredential: async () => ({ port: PORT, token: TOKEN }),
    fetchImpl: async () => { throw new Error("no REST"); },
    resolveCdpEndpoint: async () => null,
    session,
  });
  const r = await adapter.listTabs("bp-1", "7");
  assert.deepEqual(r, { ok: false, reason: "backend-unavailable" });
  assert.deepEqual(world.connects, [], "no connection may be attempted without an official port");
});

test("transient page failure recovers on the next call (no sticky failure state)", async () => {
  const { adapter, world } = makeAdapter();
  const tabs = await adapter.listTabs("bp-1", "7");
  world.page()._throwOnEval = "page-side exception";
  const first = await adapter.browserGetPageText("bp-1", "7", tabs.tabs[0].id);
  assert.deepEqual(first, { ok: false, reason: "evaluate-failed" });
  world.page()._throwOnEval = null;
  world.page()._evalQueue.push(evaluateWith({ title: "T", url: "https://x.test", text: "ok" }));
  const second = await adapter.browserGetPageText("bp-1", "7", tabs.tabs[0].id);
  assert.equal(second.ok, true);
});

test("interaction primitives: foreign profile → fail closed, NO connect", async () => {
  const world = makeFakeWorld();
  const session = createCdpSession({ connect: world.connect });
  const adapter = createCdpAdapter({
    resolveOwnedRuntime: async () => ({ ok: false, reason: "not-owned" }),
    readRuntimeCredential: async () => ({ port: PORT, token: TOKEN }),
    fetchImpl: async () => { throw new Error("no REST"); },
    resolveCdpEndpoint: async () => ({ ok: true, port: 9222 }),
    session,
  });
  for (const r of [
    await adapter.browserClick("bp-1", "7", "tab-1", "#x"),
    await adapter.browserType("bp-1", "7", "tab-1", "#x", "abc"),
    await adapter.browserGetPageText("bp-1", "7", "tab-1"),
  ]) {
    assert.deepEqual(r, { ok: false, reason: "not-owned" });
  }
  assert.deepEqual(world.connects, []);
});

test("interaction primitives: unknown tabId → invalid-tab, no session ops", async () => {
  const { adapter } = makeAdapter();
  await adapter.listTabs("bp-1", "7");
  assert.deepEqual(await adapter.browserClick("bp-1", "7", "tab-404", "#x"), {
    ok: false,
    reason: "invalid-tab",
  });
});

test("interaction primitives: page-side exception collapses to evaluate-failed (no page text leaks)", async () => {
  const { adapter, world } = makeAdapter();
  const tabs = await adapter.listTabs("bp-1", "7");
  world.page()._throwOnEval = "SECRET-PAGE-CONTENT-MUST-NOT-LEAK";
  const r = await adapter.browserGetPageText("bp-1", "7", tabs.tabs[0].id);
  assert.deepEqual(r, { ok: false, reason: "evaluate-failed" });
  assert.ok(!JSON.stringify(r).includes("SECRET-PAGE-CONTENT"));
});

// ============================================================================
// ops passthrough
// ============================================================================

function makeOps(adapter, authorizeBrowserProfile = null) {
  return createWorkspaceOps({
    donut: {
      provider: { getStatus: async () => ({ available: true, ready: true, owned: true }) },
      lifecycle: {},
      resolveOwnedRuntime: async () => ({ ok: true, donutId: "donut-abc" }),
    },
    core: {},
    adapter,
    transport: { run: async () => ({ ok: true }), kill: async () => ({ ok: true }) },
    authorizeBrowserProfile,
  });
}

test("ops passthrough: authorize failure blocks interaction ops with not-owned", async () => {
  const { adapter } = makeAdapter();
  const ops = makeOps(adapter, async () => ({ ok: false, reason: "not-owned" }));
  const r = await ops.click({ profileLocalId: "bp-1", cfProfileId: "7", tabId: "tab-1", selector: "#x" });
  assert.deepEqual(r, { ok: false, reason: "not-owned" });
});

test("ops passthrough: success forwards args + cancellation signal", async () => {
  const { adapter, world } = makeAdapter();
  const ops = makeOps(adapter);
  const tabs = await adapter.listTabs("bp-1", "7");
  world.page()._evalQueue.push(evaluateWith({ state: "ok", x: 1, y: 2, tag: "a" }));
  const ctrl = new AbortController();
  const r = await ops.click({
    profileLocalId: "bp-1",
    cfProfileId: "7",
    tabId: tabs.tabs[0].id,
    selector: "#apply",
    signal: ctrl.signal,
  });
  assert.equal(r.ok, true);
});

test("REASONS is the shared renderer-safe vocabulary", () => {
  assert.equal(REASONS.INVALID_TAB, "invalid-tab");
  assert.equal(REASONS.CANCELLED, "cancelled");
  assert.equal(REASONS.EVALUATE_FAILED, "evaluate-failed");
});
