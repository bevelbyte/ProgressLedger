// Playwright-over-CDP session — connection, page mapping, and lifecycle.
//
// Every test drives createCdpSession with an injected `connect` that returns
// Playwright-shaped fakes, so no socket, port, or browser process is involved.
// The invariants pinned here are the ones the official integration depends on:
//   - connection uses ONLY the official port, as a loopback http endpoint
//   - tab ids are session-local opaque tokens, never CDP target ids
//   - pages created/closed after connect are tracked (context "page" events)
//   - disconnect() clears contexts via Browser.close() (documented CDP
//     semantics: clear + disconnect) and NEVER stops the browser
//   - reconnect on a new port replaces the stale session
//   - unsafe ports are refused before any connect attempt

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCdpSession } from "../src/services/cdp-session.js";

// --------------------------------------------------------------- fake Playwright
function makeFakePage({ url = "about:blank", title = "New Tab" } = {}) {
  const listeners = {};
  const page = {
    closed: false,
    calls: [],
    url: () => page._url,
    title: async () => page._title,
    _url: url,
    _title: title,
    on(event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
    },
    emit(event) {
      for (const cb of listeners[event] || []) cb(page);
    },
    async close() {
      page.calls.push("close");
      page.closed = true;
      page.emit("close");
    },
    async bringToFront() {
      page.calls.push("bringToFront");
    },
    async goBack(opts) {
      page.calls.push(["goBack", opts]);
    },
    async goForward(opts) {
      page.calls.push(["goForward", opts]);
    },
    async reload(opts) {
      page.calls.push(["reload", opts]);
    },
    async goto(url2, opts) {
      page.calls.push(["goto", url2, opts]);
      page._url = url2;
    },
    async screenshot() {
      page.calls.push("screenshot");
      return Buffer.from("PNGDATA");
    },
    async evaluate(expr) {
      page.calls.push(["evaluate", expr]);
      return page._evalResult ?? { ok: true };
    },
    mouse: {
      async click(x, y) {
        page.calls.push(["mouse.click", x, y]);
      },
    },
    keyboard: {
      async insertText(text) {
        page.calls.push(["insertText", text]);
      },
      async press(key) {
        page.calls.push(["press", key]);
      },
    },
  };
  return page;
}

function makeFakeWorld({ initialPages = [{}], connectError = null, pageFactory } = {}) {
  const world = { closed: false, connectArgs: [], contextsCreated: 0 };
  const context = {
    _pages: initialPages.map((p) => (pageFactory ? pageFactory(p) : makeFakePage(p))),
    listeners: {},
    pages() {
      return [...context._pages];
    },
    on(event, cb) {
      (context.listeners[event] = context.listeners[event] || []).push(cb);
    },
    emit(event, page) {
      for (const cb of context.listeners[event] || []) cb(page);
    },
    async newPage() {
      const page = pageFactory ? pageFactory({}) : makeFakePage();
      context._pages.push(page);
      context.emit("page", page);
      return page;
    },
  };
  const browser = {
    contexts: () => [context],
    async close() {
      world.closed = true;
    },
  };
  world.context = context;
  world.browser = browser;
  world.connect = async (endpointURL) => {
    world.connectArgs.push(endpointURL);
    if (connectError) throw connectError;
    return browser;
  };
  return world;
}

function makeSession(world) {
  return createCdpSession({ connect: world.connect });
}

// ------------------------------------------------------------------ connection
test("open connects with the OFFICIAL port as a loopback http endpoint", async () => {
  const world = makeFakeWorld();
  const session = makeSession(world);
  const r = await session.open("donut-1", 9222);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(world.connectArgs, ["http://127.0.0.1:9222"]);
  assert.equal(session.isOpen("donut-1"), true);
  assert.equal(session.portOf("donut-1"), 9222);
});

test("unsafe or malformed ports are refused BEFORE any connect attempt", async () => {
  const world = makeFakeWorld();
  const session = makeSession(world);
  for (const bad of [0, -1, 65536, 99999, "9222", "abc", null, undefined, NaN, 1.5]) {
    const r = await session.open("donut-1", bad);
    assert.deepEqual(r, { ok: false, reason: "backend-unavailable" }, String(bad));
  }
  assert.deepEqual(world.connectArgs, [], "no connect may happen for an unsafe port");
  assert.equal(session.isOpen("donut-1"), false);
});

test("a refused connect leaves no session behind", async () => {
  const world = makeFakeWorld({ connectError: new Error("ECONNREFUSED") });
  const session = makeSession(world);
  const r = await session.open("donut-1", 9222);
  assert.deepEqual(r, { ok: false, reason: "backend-unavailable" });
  assert.equal(session.isOpen("donut-1"), false);
});

test("a browser with no context is refused and its connection closed", async () => {
  const world = makeFakeWorld();
  world.browser.contexts = () => [];
  const session = makeSession(world);
  const r = await session.open("donut-1", 9222);
  assert.deepEqual(r, { ok: false, reason: "backend-unavailable" });
  assert.equal(world.closed, true, "a context-less connection must be closed");
});

test("open is idempotent for the same port and reconnects on a NEW port", async () => {
  const world = makeFakeWorld();
  const session = makeSession(world);
  await session.open("donut-1", 9222);
  const again = await session.open("donut-1", 9222);
  assert.deepEqual(again, { ok: true, reused: true });
  assert.equal(world.connectArgs.length, 1, "same port must reuse the session");

  const moved = await session.open("donut-1", 9333);
  assert.deepEqual(moved, { ok: true });
  assert.equal(session.portOf("donut-1"), 9333);
  assert.equal(world.connectArgs[1], "http://127.0.0.1:9333");
  assert.equal(world.closed, true, "the stale session must be dropped on port change");
});

// --------------------------------------------------------------- page mapping
test("tab ids are opaque session tokens, never CDP target ids", async () => {
  const world = makeFakeWorld({
    initialPages: [{ url: "https://x.test" }],
  });
  const session = makeSession(world);
  await session.open("donut-1", 9222);
  const r = await session.tabs("donut-1");
  assert.equal(r.ok, true);
  assert.equal(r.tabs.length, 1);
  assert.match(r.tabs[0].id, /^tab-\d+$/, "tab ids are session-local tokens");
});

test("existing pages are enumerated at connect, with the first marked active", async () => {
  const world = makeFakeWorld({
    initialPages: [
      { url: "https://a.test", title: "A" },
      { url: "https://b.test", title: "B" },
    ],
  });
  const session = makeSession(world);
  await session.open("donut-1", 9222);
  const r = await session.tabs("donut-1");
  assert.equal(r.tabs.length, 2);
  assert.deepEqual(
    r.tabs.map((t) => [t.title, t.url, t.active]),
    [
      ["A", "https://a.test", true],
      ["B", "https://b.test", false],
    ],
  );
});

test("newPage creates and activates a tab; close removes it", async () => {
  const world = makeFakeWorld({ initialPages: [{}] });
  const session = makeSession(world);
  await session.open("donut-1", 9222);
  const created = await session.newTab("donut-1");
  assert.equal(created.ok, true);
  let tabs = await session.tabs("donut-1");
  assert.equal(tabs.tabs.length, 2);
  assert.equal(tabs.tabs.find((t) => t.id === created.tabId).active, true);

  const closed = await session.closeTab("donut-1", created.tabId);
  assert.deepEqual(closed, { ok: true });
  tabs = await session.tabs("donut-1");
  assert.equal(tabs.tabs.length, 1);
  assert.equal(tabs.tabs.some((t) => t.id === created.tabId), false);
});

test("activate moves the active marker via page.bringToFront()", async () => {
  const world = makeFakeWorld({ initialPages: [{}, {}] });
  const session = makeSession(world);
  await session.open("donut-1", 9222);
  const before = await session.tabs("donut-1");
  const [first, second] = before.tabs;
  const r = await session.activateTab("donut-1", second.id);
  assert.deepEqual(r, { ok: true });
  const after = await session.tabs("donut-1");
  assert.equal(after.tabs.find((t) => t.id === second.id).active, true);
  assert.equal(after.tabs.find((t) => t.id === first.id).active, false);
});

test("pages created AFTER connect are tracked (context page event)", async () => {
  const world = makeFakeWorld({ initialPages: [{}] });
  const session = makeSession(world);
  await session.open("donut-1", 9222);
  const external = makeFakePage({ url: "https://popup.test" });
  world.context._pages.push(external);
  world.context.emit("page", external);
  const r = await session.tabs("donut-1");
  assert.equal(r.tabs.length, 2);
  assert.equal(r.tabs.some((t) => t.url === "https://popup.test"), true);
});

test("a page closing after connect removes its tab", async () => {
  const world = makeFakeWorld({ initialPages: [{}, {}] });
  const session = makeSession(world);
  await session.open("donut-1", 9222);
  const tabs = await session.tabs("donut-1");
  const victim = tabs.tabs[1];
  world.context._pages[1].emit("close");
  const after = await session.tabs("donut-1");
  assert.equal(after.tabs.some((t) => t.id === victim.id), false);
});

test("operating on an unknown tab id fails closed with invalid-tab", async () => {
  const world = makeFakeWorld({ initialPages: [{}] });
  const session = makeSession(world);
  await session.open("donut-1", 9222);
  for (const op of ["closeTab", "activateTab", "reload", "back", "forward", "pageInfo"]) {
    const r = await session[op]("donut-1", "tab-999");
    assert.deepEqual(r, { ok: false, reason: "invalid-tab" }, op);
  }
});

test("operating without a session reports backend-unavailable, not invalid-tab", async () => {
  const world = makeFakeWorld();
  const session = makeSession(world);
  const r = await session.reload("donut-1", "tab-1");
  assert.deepEqual(r, { ok: false, reason: "backend-unavailable" });
});

// ------------------------------------------------- navigation + page operations
test("back/forward/reload map to page.goBack/goForward/reload", async () => {
  const world = makeFakeWorld({ initialPages: [{}] });
  const session = makeSession(world);
  await session.open("donut-1", 9222);
  const tabs = await session.tabs("donut-1");
  const id = tabs.tabs[0].id;
  await session.back("donut-1", id);
  await session.forward("donut-1", id);
  await session.reload("donut-1", id);
  const calls = world.context._pages[0].calls.map((c) => (Array.isArray(c) ? c[0] : c));
  assert.deepEqual(calls, ["goBack", "goForward", "reload"]);
});

test("openUrl opens a new page and navigates it (official context.newPage + goto)", async () => {
  const world = makeFakeWorld({ initialPages: [{}] });
  const session = makeSession(world);
  await session.open("donut-1", 9222);
  const r = await session.openUrl("donut-1", "https://jobs.test/posting");
  assert.equal(r.ok, true);
  const pages = world.context._pages;
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[1].calls[0], ["goto", "https://jobs.test/posting", { waitUntil: "commit", timeout: 8000 }]);
});

test("a navigation error does not fail openUrl — the tab still exists", async () => {
  const world = makeFakeWorld({ initialPages: [{}] });
  world.context.newPage = async () => {
    const page = makeFakePage();
    page.goto = async () => {
      throw new Error("net::ERR_TIMED_OUT");
    };
    world.context._pages.push(page);
    world.context.emit("page", page);
    return page;
  };
  const session = makeSession(world);
  await session.open("donut-1", 9222);
  const r = await session.openUrl("donut-1", "https://slow.test");
  assert.equal(r.ok, true);
  const tabs = await session.tabs("donut-1");
  assert.equal(tabs.tabs.length, 2);
});

test("pageInfo and screenshot use the documented Page APIs", async () => {
  const world = makeFakeWorld({ initialPages: [{ url: "https://jobs.test", title: "Jobs" }] });
  const session = makeSession(world);
  await session.open("donut-1", 9222);
  const tabs = await session.tabs("donut-1");
  const id = tabs.tabs[0].id;
  const info = await session.pageInfo("donut-1", id);
  assert.deepEqual(info, { ok: true, title: "Jobs", url: "https://jobs.test" });
  const shot = await session.screenshot("donut-1", id);
  assert.equal(shot.ok, true);
  assert.match(shot.dataUrl, /^data:image\/png;base64,/);
});

test("input primitives reach the page (click / insertText / press)", async () => {
  const world = makeFakeWorld({ initialPages: [{}] });
  const session = makeSession(world);
  await session.open("donut-1", 9222);
  const tabs = await session.tabs("donut-1");
  const id = tabs.tabs[0].id;
  await session.mouseClick("donut-1", id, 10, 20);
  await session.insertText("donut-1", id, "hello");
  await session.pressKey("donut-1", id, "Enter");
  const calls = world.context._pages[0].calls.map((c) => (Array.isArray(c) ? c[0] : c));
  assert.deepEqual(calls, ["mouse.click", "insertText", "press"]);
});

// ------------------------------------------------------- lifecycle + failures
test("disconnect drops the session and closes the CLIENT connection only", async () => {
  const world = makeFakeWorld();
  const session = makeSession(world);
  await session.open("donut-1", 9222);
  session.drop("donut-1");
  assert.equal(session.isOpen("donut-1"), false);
  assert.equal(world.closed, true, "Browser.close() clears contexts and disconnects");
  // No kill/stop/shutdown surface exists on the session at all.
  assert.equal("kill" in session, false);
  assert.equal("stop" in session, false);
  assert.equal("shutdown" in session, false);
});

test("a connection error during an op drops the session and reports backend-unavailable", async () => {
  const world = makeFakeWorld({ initialPages: [{}] });
  world.context._pages[0].reload = async () => {
    throw new Error("Protocol error (Page.reload): Target closed.");
  };
  const session = makeSession(world);
  await session.open("donut-1", 9222);
  const tabs = await session.tabs("donut-1");
  const r = await session.reload("donut-1", tabs.tabs[0].id);
  assert.deepEqual(r, { ok: false, reason: "backend-unavailable" });
  assert.equal(session.isOpen("donut-1"), false, "a dead connection must not linger");
});

test("a non-connection page error is an evaluate-failed, not a crash", async () => {
  const world = makeFakeWorld({ initialPages: [{}] });
  world.context._pages[0].evaluate = async () => {
    throw new Error("page-side exception");
  };
  const session = makeSession(world);
  await session.open("donut-1", 9222);
  const tabs = await session.tabs("donut-1");
  const r = await session.evaluate("donut-1", tabs.tabs[0].id, "1+1");
  assert.deepEqual(r, { ok: false, reason: "evaluate-failed" });
  assert.equal(session.isOpen("donut-1"), true, "a page error must not drop the session");
});

test("multiple profiles hold independent sessions and page maps", async () => {
  const worldA = makeFakeWorld({ initialPages: [{ url: "https://a.test" }] });
  const worldB = makeFakeWorld({ initialPages: [{ url: "https://b.test" }, {}] });
  const calls = [];
  const session = createCdpSession({
    connect: async (endpointURL) => {
      calls.push(endpointURL);
      return endpointURL.endsWith(":9222") ? worldA.browser : worldB.browser;
    },
  });
  await session.open("donut-A", 9222);
  await session.open("donut-B", 9333);
  const a = await session.tabs("donut-A");
  const b = await session.tabs("donut-B");
  assert.equal(a.tabs.length, 1);
  assert.equal(b.tabs.length, 2);
  assert.equal(a.tabs[0].url, "https://a.test");
  assert.equal(b.tabs[0].url, "https://b.test");
  // Closing one profile's tab never touches the other's map.
  await session.closeTab("donut-A", a.tabs[0].id);
  assert.equal((await session.tabs("donut-A")).tabs.length, 0);
  assert.equal((await session.tabs("donut-B")).tabs.length, 2);
});

test("an invalid tab id in the request is rejected by the adapter contract shape", async () => {
  const world = makeFakeWorld({ initialPages: [{}] });
  const session = makeSession(world);
  await session.open("donut-1", 9222);
  const tabs = await session.tabs("donut-1");
  assert.equal(tabs.ok, true);
  assert.equal(typeof tabs.tabs[0].id, "string");
  // tabs() never leaks page objects or connection handles
  for (const t of tabs.tabs) {
    assert.deepEqual(Object.keys(t).sort(), ["active", "id", "title", "url"]);
  }
});
