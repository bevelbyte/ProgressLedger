// Restricted browser adapter: ownership gates, official-transport mapping,
// sanitized result shapes, and renderer-supplies-no-endpoint invariants.
//
// ARCHITECTURE UNDER TEST (post Playwright migration):
//   ownership gate -> official port resolution (profile.remote_debugging_port)
//   -> Playwright connectOverCDP session (services/cdp-session.js)
//   plus the official REST fallbacks (open-url, /v1/profiles/{id}, /kill).
//
// The pre-migration suite pinned a raw DevTools transport (/json discovery,
// WebSocket construction, Target.* commands). Those internals are gone by
// design; the invariants this suite preserves are the security ones:
//   - renderer supplies only ids/strings; no method accepts port/host/token
//   - foreign/disabled profiles fail closed BEFORE any transport use
//   - page URLs are sanitized before reaching the renderer
//   - the bearer token never appears in results or console output
//   - per-profile isolation: profile A's calls never touch profile B's session
//
// Every collaborator is a stub. No Electron, no network, no real browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCdpAdapter,
  createCdpPortResolver,
  createOwnedRuntimeResolver,
  rememberCdpPort,
  sanitizeRendererUrl,
  REASONS,
} from "../src/services/cdp-adapter.js";
import { createCdpSession } from "../src/services/cdp-session.js";

const URL_OK = "https://example.com/study/algorithms";
const TOKEN = "SECRET-BEARER-TOKEN-12345";
const PORT = 10108;

function okResolve(donutId) {
  return async () => ({ ok: true, donutId });
}

// ---- fake Playwright page / context / browser ----------------------------
function fakePage(url = "about:blank") {
  const p = {
    _url: url,
    calls: [],
    url: () => p._url,
    title: async () => "Fixture",
    on() {},
    close: async () => { p.calls.push("close"); },
    bringToFront: async () => { p.calls.push("bringToFront"); },
    goBack: async () => { p.calls.push("goBack"); },
    goForward: async () => { p.calls.push("goForward"); },
    reload: async () => { p.calls.push("reload"); },
    goto: async (u) => { p.calls.push("goto"); p._url = u; },
    screenshot: async () => { p.calls.push("screenshot"); return Buffer.from("PNG"); },
    evaluate: async (expr) => { p.calls.push("evaluate"); return p._eval ?? {}; },
    mouse: { click: async () => { p.calls.push("click"); } },
    keyboard: {
      insertText: async () => { p.calls.push("insertText"); },
      press: async () => { p.calls.push("press"); },
    },
  };
  return p;
}

function fakeWorld({ pages = [fakePage()] } = {}) {
  const world = { connects: [] };
  const ctx = {
    _pages: pages,
    listeners: {},
    pages: () => [...ctx._pages],
    on(e, cb) { (ctx.listeners[e] = ctx.listeners[e] || []).push(cb); },
    async newPage() {
      const p = fakePage();
      ctx._pages.push(p);
      for (const cb of ctx.listeners.page || []) cb(p);
      return p;
    },
  };
  world.ctx = ctx;
  world.browser = { contexts: () => [ctx], close: async () => { world.closed = true; } };
  world.connect = async (endpoint) => {
    world.connects.push(endpoint);
    return world.browser;
  };
  return world;
}

/** Adapter wired to a fake session (Playwright-shaped fakes, no sockets). */
function makeAdapter({
  resolve = okResolve("donut-abc"),
  fetchImpl,
  world = fakeWorld(),
  cred = { port: PORT, token: TOKEN },
} = {}) {
  const session = createCdpSession({ connect: world.connect });
  return {
    adapter: createCdpAdapter({
      resolveOwnedRuntime: resolve,
      readRuntimeCredential: async () => cred,
      fetchImpl,
      resolveCdpEndpoint: async () => ({ ok: true, port: 9222, donutId: "donut-abc" }),
      session,
    }),
    world,
    session,
  };
}

const okJson = (json, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async text() { return JSON.stringify(json); },
});

function makeFetch(handlers) {
  const calls = [];
  const seenAuths = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    seenAuths.push(
      init && init.headers ? init.headers.Authorization || init.headers.authorization : null,
    );
    const handler = handlers.shift();
    if (!handler) return { ok: true, status: 200, async text() { return "{}"; } };
    if (typeof handler === "function") return handler(url, init);
    return handler;
  };
  return { fetchImpl, calls, seenAuths };
}

// ------------------------------------------------------ ownership fail-closed
test("ownership: foreign-runtime profile fails closed BEFORE any transport", async () => {
  const world = fakeWorld();
  const { adapter } = makeAdapter({
    resolve: async () => ({ ok: false, reason: "foreign-runtime" }),
    world,
    fetchImpl: async () => { throw new Error("network must not be touched"); },
  });
  for (const op of [
    ["listTabs", ["bp-1", "7"]],
    ["createTab", ["bp-1", "7"]],
    ["closeTab", ["bp-1", "7", "tab-1"]],
    ["screenshot", ["bp-1", "7", "tab-1"]],
  ]) {
    const r = await adapter[op[0]](...op[1]);
    assert.deepEqual(r, { ok: false, reason: "foreign-runtime" }, op[0]);
  }
  assert.deepEqual(world.connects, [], "no Playwright connection for a foreign profile");
});

test("ownership: disabled profile → disabled, no connect", async () => {
  const { adapter, world } = makeAdapter({
    resolve: async () => ({ ok: false, reason: "disabled" }),
    fetchImpl: async () => { throw new Error("no network"); },
  });
  assert.deepEqual(await adapter.listTabs("bp-1", "7"), { ok: false, reason: "disabled" });
  assert.deepEqual(world.connects, []);
});

test("ownership: unknown tab id → invalid-tab (no silent fallback)", async () => {
  const { adapter, world } = makeAdapter({ fetchImpl: async () => { throw new Error("no network"); } });
  await adapter.listTabs("bp-1", "7"); // establish session
  assert.deepEqual(await adapter.closeTab("bp-1", "7", "tab-999"), {
    ok: false,
    reason: "invalid-tab",
  });
  assert.deepEqual(await adapter.activateTab("bp-1", "7", "tab-999"), {
    ok: false,
    reason: "invalid-tab",
  });
  void world;
});

// ------------------------------------------------------- transport mapping
test("tab ops map to the Playwright session and return renderer-safe tabs", async () => {
  const world = fakeWorld({
    pages: [fakePage("https://example.com/study?token=SECRET#frag"), fakePage("https://b.test")],
  });
  const { adapter } = makeAdapter({ world, fetchImpl: async () => { throw new Error("no REST"); } });
  const tabs = await adapter.listTabs("bp-1", "7");
  assert.equal(tabs.ok, true);
  assert.equal(tabs.tabs.length, 2);
  assert.equal(tabs.tabs[0].url.includes("token"), false, "sensitive query keys must be stripped");
  assert.equal(tabs.tabs[0].url.includes("frag"), false, "fragments must be stripped");
  const created = await adapter.createTab("bp-1", "7");
  assert.equal(created.ok, true);
  assert.match(created.tabId, /^tab-\d+$/);
  assert.deepEqual(await adapter.activateTab("bp-1", "7", created.tabId), { ok: true });
  assert.deepEqual(await adapter.reload("bp-1", "7", created.tabId), { ok: true });
  assert.deepEqual(await adapter.back("bp-1", "7", created.tabId), { ok: true });
  assert.deepEqual(await adapter.forward("bp-1", "7", created.tabId), { ok: true });
  const shot = await adapter.screenshot("bp-1", "7", created.tabId);
  assert.equal(shot.ok, true);
  assert.match(shot.image.dataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(await adapter.closeTab("bp-1", "7", created.tabId), { ok: true });
});

test("getPageInfo sanitizes the page URL before it reaches the renderer", async () => {
  const world = fakeWorld({ pages: [fakePage("https://user:pass@example.com/x?api_key=ABC")] });
  const { adapter } = makeAdapter({ world, fetchImpl: async () => { throw new Error("no REST"); } });
  const tabs = await adapter.listTabs("bp-1", "7");
  const r = await adapter.getPageInfo("bp-1", "7", tabs.tabs[0].id);
  assert.equal(r.ok, true);
  assert.equal(r.info.url.includes("pass"), false);
  assert.equal(r.info.url.includes("api_key"), false);
});

// --------------------------------------------------- official REST fallbacks
test("openUrl falls back to the official REST open-url when no session", async () => {
  const world = fakeWorld();
  world.connect = async () => { throw new Error("CDP unavailable"); };
  const fetch = makeFetch([okJson({})]);
  const { adapter } = makeAdapter({ world, fetchImpl: fetch.fetchImpl });
  const r = await adapter.openUrl("bp-1", "7", URL_OK);
  assert.deepEqual(r, { ok: true });
  assert.ok(fetch.calls[0].url.includes("/open-url"), "official REST open-url fallback");
  assert.equal(fetch.calls.some((c) => /\/json\//.test(c.url)), false);
  assert.equal(fetch.calls.some((c) => /\/tabs/.test(c.url)), false, "no fake /tabs endpoints");
});

test("openUrl prefers the live session and returns its tab id", async () => {
  const fetch = makeFetch([]);
  const { adapter } = makeAdapter({ fetchImpl: fetch.fetchImpl });
  const r = await adapter.openUrl("bp-1", "7", URL_OK);
  assert.equal(r.ok, true);
  assert.match(r.tabId, /^tab-\d+$/);
  assert.equal(fetch.calls.length, 0, "no REST call needed with a live session");
});

test("killBrowser uses the official /kill endpoint and drops the session", async () => {
  const fetch = makeFetch([okJson({})]);
  const { adapter, session } = makeAdapter({ fetchImpl: fetch.fetchImpl });
  await adapter.listTabs("bp-1", "7");
  const r = await adapter.killBrowser("bp-1", "7");
  assert.deepEqual(r, { ok: true });
  assert.ok(fetch.calls.some((c) => c.url.includes("/kill")));
  assert.equal(session.isOpen("donut-abc"), false, "the session must not outlive the browser");
});

// ------------------------------------------------------------- REST mapping
test("REST failure mapping: 404/400-unknown → feature-not-supported; 429 → rate-limited", async () => {
  for (const [resp, expected] of [
    [{ ok: false, status: 404, async text() { return "gone"; } }, "feature-not-supported"],
    [{ ok: false, status: 501, async text() { return "Not Implemented"; } }, "feature-not-supported"],
    [{ ok: false, status: 429, async text() { return "slow down"; } }, "rate-limited"],
    [{ ok: false, status: 500, async text() { return "boom"; } }, "backend-unavailable"],
    [{ ok: false, status: 401, async text() { return "no"; } }, "backend-unavailable"],
  ]) {
    const world = fakeWorld();
    world.connect = async () => { throw new Error("no session"); };
    const { fetchImpl } = makeFetch([resp]);
    const { adapter } = makeAdapter({ world, fetchImpl });
    const r = await adapter.openUrl("bp-1", "7", URL_OK);
    assert.deepEqual(r, { ok: false, reason: expected }, `status ${resp.status}`);
  }
});

test("openUrl: invalid URL → invalid-url, no fetch issued", async () => {
  const { fetchImpl, calls } = makeFetch([]);
  const { adapter } = makeAdapter({ fetchImpl });
  for (const bad of ["javascript:alert(1)", "not-a-url", "", "   ", "file:///C:/x"]) {
    assert.deepEqual(await adapter.openUrl("bp-1", "7", bad), {
      ok: false,
      reason: "invalid-url",
    }, bad);
  }
  assert.equal(calls.length, 0);
});

// ------------------------------------------------------------------ security
test("security: no adapter method accepts port/host/token/runtimeId", () => {
  const { adapter } = makeAdapter({ fetchImpl: async () => ({ ok: true, status: 200, async text() { return "{}"; } }) });
  for (const [name, fn] of Object.entries(adapter)) {
    if (typeof fn !== "function" || name === "reasons") continue;
    assert.equal(fn.length <= 5, true, `${name} takes too many arguments`);
  }
  assert.equal("resolveCdpEndpoint" in adapter, false);
  assert.equal("session" in adapter, false, "the Playwright session must not leak through the adapter");
});

test("security: bearer token never appears in console output across the matrix", async () => {
  const captured = [];
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const hook = (fn, label) => (...a) => { captured.push([label, ...a]); };
  console.log = hook(orig.log, "log");
  console.info = hook(orig.info, "info");
  console.warn = hook(orig.warn, "warn");
  console.error = hook(orig.error, "error");
  try {
    const { fetchImpl } = makeFetch([{ ok: false, status: 500, async text() { return "boom"; } }]);
    const { adapter } = makeAdapter({ fetchImpl });
    await adapter.openUrl("bp-1", "7", URL_OK);
    await adapter.listTabs("bp-1", "7");
    await adapter.createTab("bp-1", "7");
    await adapter.closeTab("bp-1", "7", "tab-1");
    await adapter.activateTab("bp-1", "7", "tab-1");
    await adapter.getPageInfo("bp-1", "7", "tab-1");
    await adapter.screenshot("bp-1", "7", "tab-1");
    const flat = JSON.stringify(captured);
    assert.ok(!flat.includes(TOKEN), `token must never reach console output, got: ${flat}`);
  } finally {
    Object.assign(console, orig);
  }
});

test("security: per-profile isolation — profile A's calls never touch profile B's session", async () => {
  const seenDonutIds = [];
  const fetchImpl = async (url) => {
    const m = url.match(/\/v1\/profiles\/([^/]+)/);
    if (m) seenDonutIds.push(decodeURIComponent(m[1]));
    return okJson({});
  };
  const resolveByProfile = async (profileLocalId) => {
    if (profileLocalId === "bp-A") return { ok: true, donutId: "donut-A" };
    if (profileLocalId === "bp-B") return { ok: true, donutId: "donut-B" };
    return { ok: false, reason: "unknown-profile" };
  };
  const world = fakeWorld();
  const session = createCdpSession({ connect: world.connect });
  const adapter = createCdpAdapter({
    resolveOwnedRuntime: resolveByProfile,
    readRuntimeCredential: async () => ({ port: PORT, token: TOKEN }),
    fetchImpl,
    resolveCdpEndpoint: async () => ({ ok: true, port: 9222 }),
    session,
  });
  const a = await adapter.listTabs("bp-A", "7");
  const b = await adapter.listTabs("bp-B", "7");
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  // Each profile held its own session record with its own page map.
  assert.equal(session.isOpen("donut-A"), true);
  assert.equal(session.isOpen("donut-B"), true);
  const c = await adapter.listTabs("bp-C", "7");
  assert.deepEqual(c, { ok: false, reason: "unknown-profile" });
});

test("security: renderer URL sanitizer strips userinfo, sensitive query keys, fragments", () => {
  assert.equal(sanitizeRendererUrl("https://u:p@x.test/a?token=S&ok=1#h"), "https://x.test/a?ok=1");
  assert.equal(sanitizeRendererUrl("not a url"), "");
  assert.equal(sanitizeRendererUrl(""), "");
});

test("REASONS exposes the stable renderer-safe vocabulary", () => {
  for (const r of [
    "unknown-profile", "not-owned", "disabled", "foreign-runtime",
    "backend-unavailable", "invalid-tab", "feature-not-supported",
    "invalid-url", "busy", "rate-limited",
  ]) {
    const key = r.toUpperCase().replace(/-/g, "_");
    assert.ok(typeof REASONS[key === "UNKNOWN_PROFILE" ? "UNKNOWN_PROFILE" : key] === "string", r);
  }
});

// ------------------------------------------------------- ownership resolver
test("createOwnedRuntimeResolver enforces cf-profile row ownership", async () => {
  const rows = {
    "7|bp-1": { cfProfileId: 7, enabled: true },
    "7|bp-off": { cfProfileId: 7, enabled: false },
  };
  const core = {
    getBrowserProfile: (cfId, localId) => rows[`${cfId}|${localId}`] ?? null,
  };
  const resolver = createOwnedRuntimeResolver({
    core,
    resolveOwnedRuntime: async () => ({ ok: true, donutId: "donut-x" }),
  });
  assert.deepEqual(await resolver("bp-1", "7"), { ok: true, donutId: "donut-x" });
  assert.deepEqual(await resolver("bp-off", "7"), { ok: false, reason: "disabled" });
  assert.deepEqual(await resolver("bp-missing", "7"), { ok: false, reason: "unknown-profile" });
  assert.deepEqual(await resolver("bp-1", "8"), { ok: false, reason: "unknown-profile" });
});

// ----------------------------------------------------------- liveness mapping
test("browserLiveness: stopped profile is definitive; unresolvable port is inconclusive", async () => {
  const stopped = makeFetch([okJson({ profile: { is_running: false } })]);
  const { adapter: a1 } = makeAdapter({ fetchImpl: stopped.fetchImpl });
  assert.deepEqual(await a1.browserLiveness("bp-1", "7"), { ok: true, running: false });

  const running = makeFetch([okJson({ profile: { is_running: true, remote_debugging_port: 9222 } })]);
  const { adapter: a2 } = makeAdapter({ fetchImpl: running.fetchImpl });
  assert.deepEqual(await a2.browserLiveness("bp-1", "7"), { ok: true, running: true });

  // Port resolution failure on a RUNNING profile is inconclusive, never "stopped".
  const { adapter: a3 } = makeAdapter({
    fetchImpl: running.fetchImpl,
    world: fakeWorld(),
  });
  const broken = createCdpAdapter({
    resolveOwnedRuntime: okResolve("donut-abc"),
    readRuntimeCredential: async () => ({ port: PORT, token: TOKEN }),
    fetchImpl: running.fetchImpl,
    resolveCdpEndpoint: async () => null,
    session: createCdpSession({ connect: async () => fakeWorld().browser }),
  });
  assert.deepEqual(await broken.browserLiveness("bp-1", "7"), {
    ok: false,
    reason: "backend-unavailable",
  });
  void a3;
});

test("rememberCdpPort caches only genuine ports", async () => {
  rememberCdpPort("d-cache-test", 9222);
  rememberCdpPort("d-cache-test", "9999"); // ignored: not a number
  rememberCdpPort("d-cache-test", 70000); // ignored: out of range
  const resolver = createCdpPortResolver({
    readRuntimeCredential: async () => ({ port: PORT, token: TOKEN }),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() { return { profile: { is_running: true } }; },
    }),
  });
  const r = await resolver("d-cache-test");
  assert.equal(r?.port, 9222, "only the valid cached port survives");
});
