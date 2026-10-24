// Browser permission policy — R2 of the browser security plan (decision D3-5).
//
// DENY BY DEFAULT, decided in the main process. These tests are the ones that
// must be able to fail WITHOUT launching Electron: they pin the whole decision
// table (every named denial, the two narrow allows, and an invented permission
// name), the fact that BOTH handlers are installed, and the fail-closed paths.
//
// The `session` here is a duck-typed recorder, exactly like the webContents in
// browser-navigation.test.js: `permissions.js` is electron-free so the policy
// is assertable in plain Node.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PERMISSION_DECISIONS,
  attachPermissionHandlers,
  decidePermission,
} from "../src/services/browser/permissions.js";

/** An Electron-session stand-in that records the handlers installed on it. */
function fakeSession() {
  const request = { fn: null };
  const check = { fn: null };
  return {
    request,
    check,
    setPermissionRequestHandler(fn) {
      request.fn = fn;
      return this;
    },
    setPermissionCheckHandler(fn) {
      check.fn = fn;
      return this;
    },
  };
}

/** Drive a permission request the way Electron does: callback(allow). */
function ask(session, permission, context) {
  let answer = "never-answered";
  session.request.fn({}, permission, (allow) => {
    answer = allow;
  });
  return answer;
}

test("the allow-list is exactly the two narrow capabilities the design approves", () => {
  assert.deepEqual([...PERMISSION_DECISIONS.allow], ["clipboard-sanitized-write"]);
  assert.deepEqual([...PERMISSION_DECISIONS.focusedOnly], ["fullscreen"]);
});

test("clipboard-sanitized-write is allowed — and only that clipboard shape", () => {
  assert.equal(decidePermission("clipboard-sanitized-write", { isActiveFocusedPage: false }), true);
  // Reading is a different capability from writing, and it is NOT allowed.
  for (const denied of ["clipboard-read", "clipboard-sanitized-read"]) {
    assert.equal(decidePermission(denied, { isActiveFocusedPage: true }), false);
  }
});

test("fullscreen is allowed ONLY for the active, focused page", () => {
  assert.equal(decidePermission("fullscreen", { isActiveFocusedPage: true }), true);
  // A background page (a different tab, or an overlay on screen) is denied, so
  // a page the user is not looking at cannot seize the screen.
  assert.equal(decidePermission("fullscreen", { isActiveFocusedPage: false }), false);
  // A missing context is not a grant: the deny-by-default direction.
  assert.equal(decidePermission("fullscreen", {}), false);
  assert.equal(decidePermission("fullscreen"), false);
});

test("every named denial in the design table stays denied, even for the focused page", () => {
  const denied = [
    "notifications",
    "camera",
    "microphone",
    "geolocation",
    "midi",
    "midiSysex",
    "hid",
    "serial",
    "usb",
    "bluetooth",
    "display-capture",
    "clipboard-read",
    "pointerLock",
    "openExternal",
    "storage-access",
    "top-level-storage-access",
    "idle-detection",
    "speaker-selection",
  ];
  for (const permission of denied) {
    assert.equal(
      decidePermission(permission, { isActiveFocusedPage: true }),
      false,
      `${permission} must be denied`,
    );
  }
});

test("an UNKNOWN permission is denied — including one a page invented", () => {
  for (const invented of [
    "progressledger-super-power",
    "elevate",
    "filesystem",
    "background-sync",
    "payment-handler",
    "",
    "   ",
    "FULLSCREEN", // case matters: the table is exact, not liberal
    "full screen", // a space INSIDE the name is not the trimmed name
    "fullscreen-fake", // a SUFFIX is not the name
    " fullscreen-fake", // a PREFIX is not the name
    "fullscreen;", // punctuation is not the name
  ]) {
    assert.equal(
      decidePermission(invented, { isActiveFocusedPage: true }),
      false,
      `${JSON.stringify(invented)} must be denied`,
    );
  }
});

test("surrounding whitespace is normalised, and that is the whole of it", () => {
  // Pinned because it is the ONE way `"fullscreen "` could become `"fullscreen"`.
  // The string comes from Electron's own permission constants, never from page
  // text, so this reconciles whitespace and nothing else: an embedded tab or a
  // different capability still cannot match.
  assert.equal(decidePermission(" fullscreen ", { isActiveFocusedPage: true }), true);
  assert.equal(decidePermission(" fullscreen ", { isActiveFocusedPage: false }), false);
  assert.equal(decidePermission("\tclipboard-sanitized-write\n", {}), true);
  assert.equal(decidePermission("fullscreen\t", { isActiveFocusedPage: true }), true);
  assert.equal(decidePermission("fullscreen;", { isActiveFocusedPage: true }), false);
  assert.equal(decidePermission("full screen", { isActiveFocusedPage: true }), false);
});

test("non-string input degrades to deny and never throws", () => {
  for (const junk of [null, undefined, 42, {}, [], Symbol("x"), () => {}]) {
    assert.equal(decidePermission(junk, { isActiveFocusedPage: true }), false);
  }
});

test("a decision that throws degrades to deny — for the capability that needs the question", () => {
  // A context object whose getter explodes must not become an allow. Note the
  // asymmetry, which is the point: `clipboard-sanitized-write` NEVER reads the
  // context, so a hostile context is irrelevant to it and it stays allowed;
  // `fullscreen` reads it, cannot get an answer, and is denied.
  const hostile = {
    get isActiveFocusedPage() {
      throw new Error("hostile context");
    },
  };
  assert.equal(decidePermission("fullscreen", hostile), false);
  assert.equal(decidePermission("clipboard-sanitized-write", hostile), true);
  assert.equal(decidePermission("camera", hostile), false);
  // The installed handlers therefore also answer `false` rather than throwing
  // out of the main process.
  const session = fakeSession();
  attachPermissionHandlers(session, {
    isActiveFocusedPage: () => {
      throw new Error("hostile probe");
    },
  });
  assert.equal(ask(session, "fullscreen"), false);
  assert.equal(session.check.fn({}, "fullscreen"), false);
});

test("BOTH the request handler and the check handler are installed", () => {
  // `check` is what some APIs consult WITHOUT prompting, so a request handler
  // alone is a half-guard.
  const session = fakeSession();
  const result = attachPermissionHandlers(session, {
    isActiveFocusedPage: () => true,
  });
  assert.ok(result, "handlers were installed");
  assert.equal(typeof session.request.fn, "function");
  assert.equal(typeof session.check.fn, "function");
});

test("the installed request handler answers the policy, and only once", () => {
  const session = fakeSession();
  attachPermissionHandlers(session, { isActiveFocusedPage: () => true });
  let answers = 0;
  session.request.fn({}, "fullscreen", () => (answers += 1));
  assert.equal(answers, 1, "exactly one callback");
  assert.equal(ask(session, "fullscreen"), true);
  assert.equal(ask(session, "geolocation"), false);
  assert.equal(ask(session, "invented-permission"), false);
});

test("the installed CHECK handler returns the answer directly", () => {
  const session = fakeSession();
  attachPermissionHandlers(session, { isActiveFocusedPage: () => true });
  assert.equal(session.check.fn({}, "clipboard-sanitized-write"), true);
  assert.equal(session.check.fn({}, "camera"), false);
  assert.equal(session.check.fn({}, "nope"), false);
});

test("the focused-only allow is scoped BY CONTENTS, so one session governs many pages correctly", () => {
  // N pages of one profile share ONE session, and each attach replaces that
  // session's handlers. The scoping must therefore be computed per call from
  // the webContents, not captured once.
  const session = fakeSession();
  const focused = { page: "on-screen" };
  const background = { page: "hidden" };
  attachPermissionHandlers(session, {
    isActiveFocusedPage: (wc) => wc === focused,
  });
  assert.equal(denyVia(session, focused), true, "the page on screen may take the screen");
  assert.equal(denyVia(session, background), false, "a hidden page may not");
});

/** Ask through the installed request handler with a specific webContents. */
function denyVia(session, webContents) {
  let answer = null;
  session.request.fn(webContents, "fullscreen", (allow) => {
    answer = allow;
  });
  return answer;
}

test("a session with no request-handler capability is REPORTED, not assumed governed", () => {
  // host.js pushes a `blocked` event when this returns null, so an unwatched
  // session is visible rather than silently ungoverned.
  const result = attachPermissionHandlers({}, {});
  assert.equal(result, null);
  assert.equal(attachPermissionHandlers(null), null);
  const halfSession = { setPermissionCheckHandler() {} };
  assert.equal(attachPermissionHandlers(halfSession, {}), null);
});

test("a session whose handler setter throws does not break installation of the other", () => {
  const session = {
    setPermissionRequestHandler() {
      throw new Error("nope");
    },
    setPermissionCheckHandler() {},
  };
  assert.equal(attachPermissionHandlers(session, {}), null);
  // A session that can take the CHECK handler but not the REQUEST handler is
  // still reported as ungoverned: the request handler is the load-bearing one.
});

test("every decision is announced to the observer, with the contents that asked", () => {
  const session = fakeSession();
  const decisions = [];
  attachPermissionHandlers(session, {
    isActiveFocusedPage: () => true,
    onDecision: (d) => decisions.push(d),
  });
  const wc = { id: "bp-1" };
  let answer = null;
  session.request.fn(wc, "camera", (a) => {
    answer = a;
  });
  assert.equal(answer, false);
  assert.equal(decisions.length, 1);
  assert.deepEqual(decisions[0], {
    permission: "camera",
    allowed: false,
    webContents: wc,
  });
  // The check handler announces too, so a denial cannot pass silently through
  // the no-prompt path.
  session.check.fn(wc, "geolocation");
  assert.equal(decisions.length, 2);
  assert.equal(decisions[1].allowed, false);
});

test("an observer that throws never changes the answer", () => {
  const session = fakeSession();
  attachPermissionHandlers(session, {
    isActiveFocusedPage: () => true,
    onDecision: () => {
      throw new Error("observer blew up");
    },
  });
  assert.equal(ask(session, "fullscreen"), true);
  assert.equal(ask(session, "camera"), false);
});
