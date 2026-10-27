// Browser navigation gates — PURE, no electron import.
//
// R2 of the browser security plan. This module is the ONE place the embedded
// browser's navigation policy is enforced, and it is deliberately electron-free
// so a reviewer can assert the whole refusal matrix in plain Node — the same
// doctrine as `browser/policy.js` and `ui/src/shell/workspace/model.js`.
//
// WHY THIS MODULE EXISTS. `browser/host.js` imports electron, so its guards
// could only ever be exercised by launching the real app. The approved design
// already names this file as the home of the gates; extracting them means the
// guards that decide whether a `javascript:` URL reaches a page are testable
// without a browser, and that `host.js` and `main.js` share one implementation
// instead of two hand-written copies that can drift.
//
// THE POLICY IS NOT DECIDED HERE. Every verdict comes from
// `policy.js:isAllowedUrl`, which is the same function the address bar and the
// IPC `browser:navigate` path consult. There is deliberately no second opinion
// about which URLs are acceptable.
//
// ENFORCEMENT POINTS (approved design D3-2, all in the main process):
//   1. `will-navigate`        — main-frame navigation (address bar, link, JS).
//   2. `will-redirect`        — a server 302 to `file:` must die here.
//   3. `will-frame-navigate`  — subframes get the same allowlist.
//   4. `setWindowOpenHandler` — always deny; main decides afterwards.
//   5. `app.on('web-contents-created')` global backstop (see main.js).
//   6. `will-attach-webview`  — refuse, belt-and-braces with `webviewTag:false`.
//   7. the permission handler — `openExternal` and friends denied
//      (see services/browser/permissions.js).

import { isAllowedFrameUrl, isAllowedUrl, schemeOf } from "./policy.js";

/** Every gate this module installs, in one place so a test can assert the set. */
export const NAVIGATION_GATES = Object.freeze([
  "will-navigate",
  "will-redirect",
  "will-frame-navigate",
  "set-window-open-handler",
  "will-attach-webview",
]);

/**
 * Turn a `webContents`-shaped object into something this module can drive.
 *
 * The guards only ever call `wc.on(event, handler)` and
 * `wc.setWindowOpenHandler(handler)`, both of which are optional-chainable in
 * the real Electron object. Accepting a duck-typed object is what makes these
 * tests possible without Electron, and it costs nothing in production.
 *
 * @param {any} wc
 * @param {{onBlocked?: Function, onWindowOpen?: (details: object) => boolean}} [deps]
 *   `onWindowOpen` is an OPTIONAL decision hook that runs on top of the
 *   unconditional denial. The embedded browser uses it to re-decide an http(s)
 *   popup inside budget into a new unfocused Progress Ledger page. It returns TRUE
 *   when it has reported the outcome itself — including when REFUSING it — so
 *   that its own, more specific reason reaches the UI. Anything else (a hook
 *   that returned nothing, or one that THREW) leaves this module to report the
 *   plain `popup-denied` refusal: the action is `deny` either way.
 * @returns {{installed: string[], on: Function, denyWindowOpen: Function}}
 */
export function installNavigationGuards(wc, { onBlocked, onWindowOpen } = {}) {
  const installed = [];

  /** Refuse `url` for a cancellable navigation event; report why when refused. */
  const guard = (at) => (event, url) => {
    const verdict = at === "will-frame-navigate" ? isAllowedFrameUrl(url) : isAllowedUrl(url);
    if (verdict.ok) return;
    try {
      event?.preventDefault?.();
    } catch {
      // An event object that cannot be cancelled has already navigated; the
      // report below still states what was attempted.
    }
    report(onBlocked, at, url, verdict.reason);
  };

  if (wc && typeof wc.on === "function") {
    for (const at of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
      wc.on(at, guard(at));
      installed.push(at);
    }
    // A page may not embed a <webview>. Belt and braces with `webviewTag:false`
    // in the view's webPreferences (approved decision D3-6): a tag is the one
    // way page content could otherwise get a second, differently-configured
    // renderer of its own.
    wc.on("will-attach-webview", (event) => {
      try {
        event?.preventDefault?.();
      } catch {
        /* nothing further can be done about it */
      }
      report(onBlocked, "will-attach-webview", "", "webview-tag-refused");
    });
    installed.push("will-attach-webview");
  }

  if (wc && typeof wc.setWindowOpenHandler === "function") {
    wc.setWindowOpenHandler((details = {}) => {
      // ALWAYS denied here (approved decision D3-3): no OS window is ever
      // created from page content. Honouring the request directly is never
      // safe, because Electron's handler has no user-gesture flag, so a
      // scripted `window.open` is indistinguishable from a click.
      //
      // The caller may supply its own decision on top of that denial — the
      // embedded browser does, to re-decide an http(s) URL inside budget into a
      // new unfocused Progress Ledger page. It returns TRUE when it has reported the
      // outcome itself; anything else (including a hook that THREW) means this
      // module reports the refusal, because a refusal nobody can see is
      // indistinguishable from a hang.
      let handled = false;
      if (typeof onWindowOpen === "function") {
        try {
          handled = onWindowOpen(details) === true;
        } catch {
          handled = false;
        }
      }
      if (!handled) report(onBlocked, "window-open", details.url, "popup-denied");
      return { action: "deny" };
    });
    installed.push("set-window-open-handler");
  }

  return { installed };
}

/* ------------------------------------------------------------------
 * Popups (approved decision D3-3)
 * ------------------------------------------------------------------
 *
 * `setWindowOpenHandler` ALWAYS returns `{ action: "deny" }`. That is the whole
 * point: Electron's handler is the only thing standing between page content and
 * an OS-level `BrowserWindow`, and it has no user-gesture flag, so a scripted
 * `window.open` is indistinguishable from a click. Honouring the request
 * directly is therefore never safe.
 *
 * What main does INSTEAD is decide for itself, and this pure function is that
 * decision: an http(s) URL, within a per-page-load budget, is re-decided into a
 * NEW Progress Ledger browser tab (created by the caller, unfocused). Everything else
 * is refused.
 *
 * The budget is consumed whether or not anyone looks at the result, because a
 * page that can be ignored cannot be a free channel. The threat model records
 * the residual risk: a determined page can still open up to `POPUP_BUDGET_PER_LOAD`
 * tabs per navigation.
 *
 * Keeping the decision pure (no electron import, no mutable state) means the
 * budget rule is assertable in plain Node, and `host.js` — which owns the
 * per-page counter — has exactly one thing to consult.
 */

/** How many popups one page load may turn into Progress Ledger tabs. */
export const POPUP_BUDGET_PER_LOAD = 2;

/**
 * @param {unknown} url         the URL `window.open` asked for
 * @param {number}  budgetUsed  how many popups this page load already spent
 * @returns {{ok: true, url: string} | {ok: false, reason: string}}
 */
export function decidePopup(url, budgetUsed = 0) {
  // The R2 allowlist is the ONLY answer to "may this URL be shown at all".
  // There is deliberately no second opinion here.
  const verdict = isAllowedUrl(url);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  if (!(Number(budgetUsed) >= 0) || Number(budgetUsed) >= POPUP_BUDGET_PER_LOAD) {
    return { ok: false, reason: "popup-budget" };
  }
  return { ok: true, url: verdict.url };
}

/**
 * The `will-navigate` guard on its own, for `app.on('web-contents-created')` in
 * main.js. That global handler is the BACKSTOP the approved design asks for:
 * the embedded browser's own per-view gates are installed in
 * `services/browser/host.js`, so anything that reaches this path is a
 * webContents nobody wired — and it gets the same allowlist anyway.
 *
 * It is narrow ON PURPOSE. It must never see the app's own renderer, which is
 * privileged and navigates to `file:`/`progressLedger:` app surfaces by design.
 * main.js excludes those explicitly before installing this.
 */
export function makeWillNavigateGuard(onBlocked) {
  return (event, url) => {
    const verdict = isAllowedUrl(url);
    if (verdict.ok) return;
    try {
      event?.preventDefault?.();
    } catch {
      /* see installNavigationGuards */
    }
    report(onBlocked, "will-navigate", url, verdict.reason);
  };
}

/** One reporting path for every gate: a refusal is never a silent drop. */
function report(onBlocked, at, url, reason) {
  if (typeof onBlocked !== "function") return;
  try {
    onBlocked({ at, url: typeof url === "string" ? url : "", scheme: schemeOf(url), reason });
  } catch {
    // A broken observer must not turn a refusal into an unhandled exception in
    // the main process, which would take the window with it.
  }
}
