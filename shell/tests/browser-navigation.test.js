// Browser navigation gates — R2 of the browser security plan.
//
// These tests are the ones that must be able to fail WITHOUT launching Electron.
// The gates decide whether a `javascript:` URL ever reaches a page, so they are
// asserted against the REFUSALS first (negative-first), then against the
// destinations that must keep working, and finally against the shape of the
// thing they are installed on.
//
// The `webContents` here is a duck-typed recorder: it captures every handler
// the installer registers and lets a test invoke it. `navigation.js` is
// electron-free for exactly this reason (see its header), so the whole
// enforcement matrix is a plain-Node test rather than a browser launch.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NAVIGATION_GATES,
  POPUP_BUDGET_PER_LOAD,
  decidePopup,
  installNavigationGuards,
  makeWillNavigateGuard,
} from "../src/services/browser/navigation.js";
import { isAllowedUrl } from "../src/services/browser/policy.js";

/**
 * A `webContents` stand-in that records what was installed on it. `fire(name)`
 * returns the handler so a test can drive it exactly as Electron would.
 */
function fakeWebContents() {
  const handlers = new Map();
  const windowOpenHandler = { fn: null };
  return {
    handlers,
    windowOpenHandler,
    on(name, fn) {
      handlers.set(name, fn);
      return this;
    },
    setWindowOpenHandler(fn) {
      windowOpenHandler.fn = fn;
      return this;
    },
    fire(name) {
      const fn = handlers.get(name);
      assert.ok(fn, `no ${name} handler was installed`);
      return fn;
    },
    has(name) {
      return handlers.has(name);
    },
  };
}

/** An event object shaped like the one Electron passes to a navigation gate. */
function cancellableEvent() {
  const calls = { prevented: 0 };
  return { calls, preventDefault: () => (calls.prevented += 1) };
}

test("every approved enforcement point is installed, by name", () => {
  const wc = fakeWebContents();
  const result = installNavigationGuards(wc, {});
  assert.deepEqual([...result.installed].sort(), [...NAVIGATION_GATES].sort());
  // The design's seven points: these five live here, the permission handler
  // lives in permissions.js, and the global backstop lives in main.js.
  assert.equal(wc.has("will-navigate"), true);
  assert.equal(wc.has("will-redirect"), true);
  assert.equal(wc.has("will-frame-navigate"), true);
  assert.equal(wc.has("will-attach-webview"), true);
  assert.equal(typeof wc.windowOpenHandler.fn, "function");
});

test("will-navigate refuses every forbidden scheme and cancels the navigation", () => {
  const wc = fakeWebContents();
  installNavigationGuards(wc, {});
  const denied = [
    "javascript:alert(1)",
    "file:///C:/Windows/win.ini",
    "data:text/html,<h1>x</h1>",
    "blob:https://example.com/abc",
    "view-source:https://example.com/",
    "mailto:someone@example.com",
    "tel:+15551234567",
    "progressledger-v2://app/index.html",
    "about:config",
  ];
  for (const url of denied) {
    const event = cancellableEvent();
    wc.fire("will-navigate")(event, url);
    assert.equal(event.calls.prevented, 1, `${url} must be cancelled`);
    assert.equal(isAllowedUrl(url).ok, false, `${url} must also fail the policy directly`);
  }
});

test("will-navigate allows the destinations that must keep working", () => {
  const wc = fakeWebContents();
  installNavigationGuards(wc, {});
  for (const url of ["https://example.com/a", "http://127.0.0.1:8080/x", "about:blank"]) {
    const event = cancellableEvent();
    wc.fire("will-navigate")(event, url);
    assert.equal(event.calls.prevented, 0, `${url} must load`);
  }
});

test("will-redirect is the same allowlist — a 302 to file: dies here, not at the next navigate", () => {
  const wc = fakeWebContents();
  installNavigationGuards(wc, {});
  for (const [url, prevented] of [
    ["file:///etc/shadow", 1],
    ["data:text/html,x", 1],
    ["javascript:void(0)", 1],
    ["https://example.com/redirected", 0],
  ]) {
    const event = cancellableEvent();
    wc.fire("will-redirect")(event, url);
    assert.equal(event.calls.prevented, prevented, `${url} under will-redirect`);
  }
});

test("will-frame-navigate gives SUBFRAMES the same allowlist", () => {
  // A subframe is how a page smuggles a data: frame past a main-frame-only
  // check, so this handler must exist at all and must refuse identically.
  const wc = fakeWebContents();
  installNavigationGuards(wc, {});
  const denied = ["data:text/html,<h1>smuggled</h1>", "javascript:alert(1)", "file:///x"];
  for (const url of denied) {
    const event = cancellableEvent();
    wc.fire("will-frame-navigate")(event, url);
    assert.equal(event.calls.prevented, 1, `subframe ${url} must be cancelled`);
  }
  const ok = cancellableEvent();
  wc.fire("will-frame-navigate")(ok, "https://example.com/frame");
  assert.equal(ok.calls.prevented, 0);
});

test("setWindowOpenHandler always denies, for every scheme", () => {
  const wc = fakeWebContents();
  const blocked = [];
  installNavigationGuards(wc, { onBlocked: (b) => blocked.push(b) });
  for (const url of [
    "https://example.com/popup",
    "javascript:alert(1)",
    "file:///x",
    "mailto:a@b.c",
  ]) {
    const verdict = wc.windowOpenHandler.fn({ url });
    assert.deepEqual(verdict, { action: "deny" }, `${url} must be denied`);
  }
  assert.equal(blocked.length, 4, "every popup attempt is reported");
});

test("will-attach-webview refuses and reports, whatever the target", () => {
  const wc = fakeWebContents();
  const blocked = [];
  installNavigationGuards(wc, { onBlocked: (b) => blocked.push(b) });
  const event = cancellableEvent();
  wc.fire("will-attach-webview")(event, { src: "https://example.com" });
  assert.equal(event.calls.prevented, 1);
  assert.equal(blocked.at(-1).at, "will-attach-webview");
});

test("every refusal is REPORTED with the scheme and the reason — never a silent drop", () => {
  const wc = fakeWebContents();
  const blocked = [];
  installNavigationGuards(wc, { onBlocked: (b) => blocked.push(b) });
  wc.fire("will-navigate")(cancellableEvent(), "javascript:alert(1)");
  assert.deepEqual(blocked.at(-1), {
    at: "will-navigate",
    url: "javascript:alert(1)",
    scheme: "javascript:",
    reason: "blocked-scheme",
  });
  wc.fire("will-navigate")(cancellableEvent(), "not a url at all");
  assert.deepEqual(blocked.at(-1), {
    at: "will-navigate",
    url: "not a url at all",
    scheme: "",
    reason: "invalid-url",
  });
});

test("a contents object that cannot cancel still reports the attempt", () => {
  const wc = fakeWebContents();
  const blocked = [];
  installNavigationGuards(wc, { onBlocked: (b) => blocked.push(b) });
  // No preventDefault at all: a guard must not throw, and the refusal must
  // still be observable.
  wc.fire("will-navigate")({}, "file:///x");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].scheme, "file:");
});

test("an observer that throws does not break the guard or the main process", () => {
  const wc = fakeWebContents();
  installNavigationGuards(wc, {
    onBlocked: () => {
      throw new Error("observer blew up");
    },
  });
  const event = cancellableEvent();
  wc.fire("will-navigate")(event, "javascript:alert(1)");
  assert.equal(event.calls.prevented, 1, "the navigation is still cancelled");
});

test("a bare contents object installs nothing and reports no gate", () => {
  const result = installNavigationGuards({}, {});
  assert.deepEqual(result.installed, []);
  // host.js pushes a `blocked` event when this happens, so an unwired page is
  // visible rather than silently ungoverned.
});

test("the global backstop guard is the same allowlist the per-view gates use", () => {
  // This is what main.js installs on a webContents nobody wired. It must not
  // be a second, weaker opinion about which URLs are acceptable.
  const blocked = [];
  const guard = makeWillNavigateGuard((b) => blocked.push(b));
  for (const url of [
    "file:///x",
    "javascript:alert(1)",
    "data:text/html,x",
    "blob:https://x/y",
    "view-source:https://x",
    "progressledger-v2://app/index.html",
  ]) {
    const event = cancellableEvent();
    guard(event, url);
    assert.equal(event.calls.prevented, 1, `backstop must refuse ${url}`);
  }
  for (const url of ["https://example.com/", "http://127.0.0.1:1/", "about:blank"]) {
    const event = cancellableEvent();
    guard(event, url);
    assert.equal(event.calls.prevented, 0, `backstop must allow ${url}`);
  }
  assert.equal(blocked.length, 6);
});

test("the popup budget is a small positive number, not an accident", () => {
  assert.equal(Number.isInteger(POPUP_BUDGET_PER_LOAD), true);
  assert.ok(POPUP_BUDGET_PER_LOAD >= 1 && POPUP_BUDGET_PER_LOAD <= 5,
    "a budget of 0 disables popups outright; a large one is a spray vector");
});

test("decidePopup allows a NEW http(s) URL while budget remains", () => {
  assert.deepEqual(decidePopup("https://example.com/popup", 0), {
    ok: true,
    url: "https://example.com/popup",
  });
  // Loopback http is on the allow-list too, which is what the E2E fixture uses.
  assert.equal(decidePopup("http://127.0.0.1:8080/x", 0).ok, true);
  assert.equal(decidePopup("about:blank", 0).ok, true);
});

test("decidePopup refuses EVERY forbidden scheme regardless of budget", () => {
  // The R2 allowlist is the only answer: a popup cannot be a way around it.
  for (const url of [
    "javascript:alert(1)",
    "file:///C:/Windows/win.ini",
    "data:text/html,<h1>x</h1>",
    "blob:https://example.com/abc",
    "view-source:https://example.com/",
    "mailto:someone@example.invalid",
    "tel:+15551234567",
    "progressledger-v2://app/index.html",
    "not-a-url",
  ]) {
    const out = decidePopup(url, 0);
    assert.equal(out.ok, false, `${url} must be refused even with a full budget`);
    assert.ok(out.reason, `${url} states why`);
  }
});

test("decidePopup enforces the budget and refuses the overflow", () => {
  assert.equal(decidePopup("https://example.com/a", 0).ok, true);
  assert.equal(decidePopup("https://example.com/b", POPUP_BUDGET_PER_LOAD - 1).ok, true);
  const over = decidePopup("https://example.com/c", POPUP_BUDGET_PER_LOAD);
  assert.equal(over.ok, false);
  assert.equal(over.reason, "popup-budget");
  // A budget count that has somehow gone NEGATIVE is still a refusal.
  assert.equal(decidePopup("https://example.com/d", -1).ok, false);
});

test("the window-open hook runs on top of an UNCONDITIONAL denial", () => {
  // The security property is that `action` is always `deny`. The hook only lets
  // main decide what ELSE to do (create a Progress Ledger page); it can never turn
  // the answer into an allowed OS window.
  const wc = fakeWebContents();
  installNavigationGuards(wc, {
    onWindowOpen: () => {
      /* a hook that does nothing at all */
    },
  });
  for (const url of ["https://example.com/", "file:///x", "javascript:alert(1)"]) {
    const verdict = wc.windowOpenHandler.fn({ url });
    assert.deepEqual(verdict, { action: "deny" }, `${url}`);
  }
});

test("a window-open hook that throws still leaves the denial in place", () => {
  const wc = fakeWebContents();
  const blocked = [];
  installNavigationGuards(wc, {
    onBlocked: (b) => blocked.push(b),
    onWindowOpen: () => {
      throw new Error("popup decision blew up");
    },
  });
  const verdict = wc.windowOpenHandler.fn({ url: "https://example.com/" });
  assert.deepEqual(verdict, { action: "deny" });
  // The refusal is still REPORTED, so a broken hook cannot make a popup silent.
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].at, "window-open");
  assert.equal(blocked[0].scheme, "https:");
});

test("without a hook, every popup is reported as denied including an allowed scheme", () => {
  // The default (main.js's backstop, and any other caller) is the R2 behaviour:
  // report and deny, with no re-decision.
  const wc = fakeWebContents();
  const blocked = [];
  installNavigationGuards(wc, { onBlocked: (b) => blocked.push(b) });
  const verdict = wc.windowOpenHandler.fn({ url: "https://example.com/popup" });
  assert.deepEqual(verdict, { action: "deny" });
  assert.deepEqual(blocked.at(-1), {
    at: "window-open",
    url: "https://example.com/popup",
    scheme: "https:",
    reason: "popup-denied",
  });
});