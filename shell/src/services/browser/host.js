// Progress Ledger-owned embedded browser host — the ONLY place a WebContentsView is
// created. Phase 1 of the approved D2-D6 plan.
//
// WHAT THIS IS. A `WebContentsView` added to the existing main BrowserWindow's
// `contentView`, owned and driven entirely by the main process. It is NOT a
// BrowserView (deprecated), NOT a `<webview>` tag (that would live inside the
// privileged app renderer), NOT an iframe, NOT a second window, and emphatically
// NOT a Donut/Wayfern window hosted as Progress Ledger content. Donut is not imported,
// referenced or required anywhere in this module: the embedded browser must work
// with Donut stopped, unavailable, unauthenticated or absent from the machine.
//
// WHAT THE RENDERER GETS. An opaque page id (`bp-N`) and sanitized metadata. The
// renderer declares a rectangle; main clamps it and decides. The renderer cannot
// name a partition, a path, a port, a token or a webContents.
//
// SCOPE: create / attach / show / hide / bounds / destroy, the security defaults
// approved in D3, the crash/teardown foundation, managed downloads (approved
// decision D - see services/browser/downloads.js), and the R2 navigation and
// permission policy (services/browser/navigation.js and permissions.js). No
// omnibox history, no permission prompts, no popup policy beyond a hard deny, no
// DevTools, no CDP, no session UI. Those are later phases of the plan.

/**
 * Every webContents the embedded browser has already governed. The gates are
 * installed in `wirePage` the moment a view is created — before anything is
 * loaded into it — so this set is complete for every browser page that exists.
 *
 * `isGovernedWebContents` is what lets `main.js`'s global
 * `web-contents-created` backstop (approved design D3-2, enforcement point 5)
 * cover a view that was created WITHOUT those gates, without it ever touching
 * the app's own privileged renderer.
 */
const governedWebContents = new WeakSet();

/** Has the embedded browser already installed its per-view gates here? */
export function isGovernedWebContents(webContents) {
  return governedWebContents.has(webContents);
}

import { WebContentsView } from "electron";
import { createBrowserRegistry, PAGE_STATES, REASONS } from "./registry.js";
import { clampRect, isAllowedUrl, schemeOf } from "./policy.js";
import {
  installNavigationGuards,
  decidePopup,
  POPUP_BUDGET_PER_LOAD,
} from "./navigation.js";
import { attachPermissionHandlers } from "./permissions.js";
import { createDownloadManager } from "./downloads.js";
import { EXTRACT_SCRIPT, applyExtractionCaps } from "../../browser-ts/dist/extraction.js";

/** A browser navigation must not remain in a false loading state forever. */
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * The strictest web preferences in the application. Every line is a decision
 * from the approved D3 security model; none of them is a default worth
 * inheriting.
 *
 * `preload` is ABSENT ON PURPOSE. A browser page gets no bridge at all, so there
 * is no `window.progressLedger`, no ipcRenderer and no Node surface for page content
 * to reach — the page sees the ordinary web platform and nothing else.
 */
function webPreferencesFor(partition) {
  return {
    partition,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
  };
}

/**
 * @param {object} deps
 * @param {() => any} deps.getWindow  the main BrowserWindow (or null)
 * @param {(event: object) => void} [deps.emit]  sanitized push to the renderer
 * @param {(spec: {id: string, partition: string}) => any} [deps.createView]
 *   Test seam: build the view. Defaults to a real WebContentsView.
 */
export function createBrowserHost(deps = {}) {
  const {
    getWindow,
    emit = () => {},
    createView = defaultCreateView,
    getDownloadsDir = () => null,
    ensureDownloadsDir = () => {},
    downloadsExists,
    navigationTimeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS,
  } = deps;

  const boundedNavigationTimeoutMs =
    Number.isFinite(navigationTimeoutMs) && navigationTimeoutMs > 0
      ? Math.min(300_000, Math.max(100, Math.floor(navigationTimeoutMs)))
      : DEFAULT_NAVIGATION_TIMEOUT_MS;
  const navigationTimers = new Map();

  /** Overlay counter collapsed to one flag: any open overlay hides every page. */
  let occluded = false;

  /**
   * Managed downloads (approved decision D). ONE manager for the whole host: it
   * de-duplicates per session internally, so two pages in one profile share one
   * concurrency budget and a page cannot get a second budget by opening a tab.
   * The directory is resolved LAZILY on every download, so switching workspace
   * moves downloads without the host having to be rebuilt.
   */
  const downloads = createDownloadManager({
    getDir: getDownloadsDir,
    ensureDir: ensureDownloadsDir,
    exists: downloadsExists,
    emit: (event) => push(event),
  });

  const registry = createBrowserRegistry({
    createView: (spec) => {
      const view = createView(spec);
      wirePage(spec.id, view);
      return view;
    },
    destroyView: (id, view) => destroyView(id, view),
  });

  function defaultCreateView({ partition }) {
    return new WebContentsView({ webPreferences: webPreferencesFor(partition) });
  }

  function push(event) {
    try {
      emit(event);
    } catch {
      // A push must never break a page operation: the renderer mirror is
      // disposable and re-syncs with browser:state.
    }
  }

  function clearNavigationTimer(pageId) {
    const timer = navigationTimers.get(pageId);
    if (timer !== undefined) clearTimeout(timer);
    navigationTimers.delete(pageId);
  }

  function armNavigationTimer(pageId) {
    clearNavigationTimer(pageId);
    const timer = setTimeout(() => {
      navigationTimers.delete(pageId);
      const record = registry.record(pageId);
      // A late timeout must not turn a closed page or a newer successful load
      // into a failure. The current state is main-process truth.
      if (!record || record.state !== PAGE_STATES.LOADING) return;
      try {
        record.view?.webContents?.stop?.();
      } catch {}
      const lastError = {
        code: -7,
        description: "Navigation timed out",
        reason: "navigation-timeout",
      };
      registry.update(pageId, { state: PAGE_STATES.FAILED, lastError });
      push({ kind: "failed", pageId, ...lastError });
    }, boundedNavigationTimeoutMs);
    navigationTimers.set(pageId, timer);
  }

  function observeLoadPromise(pageId, promise, reason) {
    // Electron reports navigation through events, but loadURL() also returns a
    // promise that rejects on failed/aborted loads. Observe it so a renderer
    // crash or timed-out request cannot become an unhandled main-process rejection.
    Promise.resolve(promise).catch((error) => {
      const record = registry.record(pageId);
      if (!record || record.state !== PAGE_STATES.LOADING) return;
      clearNavigationTimer(pageId);
      const lastError = {
        reason,
        description: String(error?.message ?? error ?? "Navigation failed").slice(0, 512),
      };
      registry.update(pageId, { state: PAGE_STATES.FAILED, lastError });
      push({ kind: "failed", pageId, ...lastError });
    });
  }

  /** The window, or null when it is gone (shutdown, test teardown). */
  function liveWindow() {
    try {
      const w = getWindow?.();
      return w && !w.isDestroyed?.() ? w : null;
    } catch {
      return null;
    }
  }

  function contentSize() {
    const w = liveWindow();
    if (!w) return { width: 0, height: 0 };
    try {
      const [width, height] = w.getContentSize();
      return { width, height };
    } catch {
      return { width: 0, height: 0 };
    }
  }

  /**
   * Create a page. This exists as a hoisted FUNCTION rather than a call to
   * `host.createPage` directly, for two reasons that are both load-bearing:
   *
   *  1. `wirePage` runs inside `registry.create` → `createView`, which happens
   *     DURING `host.createPage`. A bare `createPage(...)` reference there was a
   *     `ReferenceError` waiting for the first approved popup — the popup path
   *     was written but had never been executed, so nothing caught it.
   *  2. The window-open handler fires ASYNCHRONOUSLY (a page calling
   *     `window.open` after it loads), by which time `host` is fully
   *     initialized, so the delegation below is safe.
   */
  function createPage(spec) {
    return host.createPage(spec);
  }

  /**
   * Register the navigation, permission and lifecycle gates on a page's
   * webContents BEFORE anything is loaded into it, so the page can never
   * outrun the policy.
   */
  function wirePage(pageId, view) {
    const wc = view?.webContents;
    if (!wc) return;

    // From this moment on this webContents is governed, so the main.js global
    // backstop knows not to install a second, weaker copy of the policy on it.
    governedWebContents.add(wc);

    /**
     * Popups this page load has spent (approved decision D3-3). It lives with
     * the page, not with the session: the budget is per page LOAD, so a page
     * that navigates gets a fresh one, while a page that keeps calling
     * `window.open` does not.
     */
    let popupsThisLoad = 0;
    // The profile is read FRESH when a popup is approved, not captured here: a
    // record object can be replaced by `registry.update`, and the popup must be
    // created in the partition the page actually lives in.
    const profileIdOf = () => registry.record(pageId)?.profileId;

    // Managed downloads. The page's own partition session is watched from the
    // moment the page exists, so a download triggered by its very first load is
    // already governed. Attaching is idempotent per session, so N pages in one
    // profile still produce exactly one handler and one budget. A session that
    // cannot be watched is REPORTED rather than assumed: an unwatched session
    // would let a download bypass the managed directory entirely.
    if (downloads.attach(wc.session) === null) {
      push({ kind: "blocked", pageId, at: "downloads-attach" });
    }

    // Navigation policy (R2) and popups (R3, approved decision D3-3) share ONE
    // installer, so the per-view gates and the main.js global backstop cannot
    // disagree about which URLs are acceptable. The gates installed here are
    // will-navigate, will-redirect, will-frame-navigate, setWindowOpenHandler
    // (always deny) and will-attach-webview.
    //
    // `onWindowOpen` is where the popup budget lives: the handler itself still
    // returns `deny` unconditionally (no OS window, ever), and main re-decides
    // for itself.
    const { installed } = installNavigationGuards(wc, {
      onBlocked: ({ at, scheme, reason }) =>
        push({ kind: "blocked", pageId, at, scheme, reason }),
      onWindowOpen: ({ url } = {}) => {
        const verdict = decidePopup(url, popupsThisLoad);
        if (!verdict.ok) {
          push({
            kind: "blocked",
            pageId,
            at: "window-open",
            scheme: schemeOf(url),
            reason: verdict.reason,
          });
          return true;
        }

        // The budget is spent the MOMENT the decision is made, before the page
        // exists: if creating the page fails, the page still cannot retry its
        // way to more tabs. A failed creation is a refusal, not a retry loop.
        popupsThisLoad += 1;
        const created = createPage({ profileId: profileIdOf(), url: verdict.url });
        if (!created.ok) {
          push({
            kind: "blocked",
            pageId,
            at: "window-open",
            scheme: schemeOf(url),
            reason: created.reason ?? "popup-failed",
          });
          return true;
        }
        push({ kind: "popup", pageId, popupPageId: created.page.id, url: verdict.url });
        return true;
      },
    });
    if (installed.length === 0) {
      // A webContents that accepted no gate at all would load any URL it was
      // given. Report it rather than assume the page is governed.
      push({ kind: "blocked", pageId, at: "navigation-gates" });
    }

    // Permission policy (R2, approved decision D3-5): deny by default, decided
    // in main, on the page's OWN partition session. BOTH handlers are installed
    // — `check` is what some APIs consult without prompting, so a request
    // handler alone is a half-guard.
    //
    // `onDecision` resolves the page FROM the webContents rather than closing
    // over `pageId`: N pages of one profile share one session, so each
    // `attachPermissionHandlers` call replaces the session's handlers, and a
    // closure bound to the newest page would blame the wrong page for a
    // denial. The owner of the decision is a fact, not a capture.
    const permissionHandlers = attachPermissionHandlers(wc.session, {
      isActiveFocusedPage: (contents) => isActiveFocusedPage(contents),
      onDecision: ({ permission, allowed, webContents }) => {
        if (allowed) return;
        const owner = pageIdFor(webContents);
        if (owner === null) return;
        push({ kind: "permission-denied", pageId: owner, permission });
      },
    });
    if (permissionHandlers === null) {
      push({ kind: "blocked", pageId, at: "permission-handlers" });
    }

    wc.on?.("page-title-updated", (_e, title) => {
      registry.update(pageId, { title: typeof title === "string" ? title : "" });
      push({ kind: "title", pageId, title: registry.get(pageId)?.title ?? "" });
    });

    wc.on?.("did-start-loading", () => {
      if (!registry.record(pageId)) {
        clearNavigationTimer(pageId);
        return;
      }
      registry.update(pageId, { state: PAGE_STATES.LOADING, lastError: null });
      push({ kind: "loading", pageId, loading: true, page: registry.get(pageId) });
      armNavigationTimer(pageId);
    });

    wc.on?.("did-stop-loading", () => {
      clearNavigationTimer(pageId);
      const record = registry.record(pageId);
      if (record && record.state === PAGE_STATES.LOADING) {
        registry.update(pageId, { state: PAGE_STATES.READY });
      }
      push({ kind: "loading", pageId, loading: false, page: registry.get(pageId) });
    });

    wc.on?.("did-navigate", (_e, url) => {
      // A new document is a new page load, so the popup budget starts over. The
      // design's rule is "2 per page load, reset on navigation"; spending it on
      // navigation rather than on load keeps a page that follows a link chain
      // from being permanently popup-mute.
      popupsThisLoad = 0;
      registry.update(pageId, { url: typeof url === "string" ? url : "", lastUsed: Date.now() });
      push({ kind: "url", pageId, page: registry.get(pageId) });
    });

    wc.on?.("did-fail-load", (_e, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      // -3 is ABORTED: a redirect or a fast second load, not a failure.
      if (isMainFrame === false || errorCode === -3) return;
      clearNavigationTimer(pageId);
      registry.update(pageId, {
        state: PAGE_STATES.FAILED,
        lastError: { code: errorCode, description: String(errorDescription ?? ""), reason: "load-failed" },
      });
      push({
        kind: "failed",
        pageId,
        code: errorCode,
        description: String(errorDescription ?? ""),
        reason: "load-failed",
      });
    });

    wc.on?.("render-process-gone", (_e, details) => {
      clearNavigationTimer(pageId);
      registry.update(pageId, {
        state: PAGE_STATES.CRASHED,
        lastError: { reason: String(details?.reason ?? "unknown") },
      });
      push({ kind: "crashed", pageId, reason: String(details?.reason ?? "unknown") });
    });

    wc.on?.("unresponsive", () => push({ kind: "unresponsive", pageId }));
    wc.on?.("responsive", () => push({ kind: "responsive", pageId }));

    // Focus-from-native (Phase 2, workspace integration): a page is painted by
    // the OS above the renderer's DOM, so a click INSIDE it cannot reach the
    // shell — focus would move to a pane whose chrome never lights up. Main
    // owns the fix: it watches the webContents and reports the focus, and the
    // shell focuses the pane holding this page (`store.focusPaneOfPage`).
    wc.on?.("focus", () => reportPageFocus(pageId));
  }

  /**
   * Is `contents` the active, on-screen page of the focused pane?
   *
   * This is the ONLY context the permission policy accepts for a focused-only
   * capability (approved design D3-5: `fullscreen`). It is derived from facts
   * main already owns rather than from anything a page or the renderer can
   * assert:
   *
   *   * the page must be VISIBLE — the renderer declares `requestVisible` for
   *     the active tab and main records it, so a background page in another tab
   *     is `visible: false`;
   *   * and no overlay may own the screen (`occluded`), because while an overlay
   *     is up every page is taken off screen.
   *
   * Both conditions are exactly "this is the browser page the user is looking
   * at", which is the whole basis for letting anything take the screen. A page
   * that is merely loaded, or that lives in a background tab, is denied.
   *
   * Honest limitation, recorded rather than papered over: this is a proxy for
   * "focused pane". Progress Ledger's shell decides which PANE is focused, and it
   * does not report that to main today; what main can see is which page is on
   * screen. Since only the focused pane's active tab declares its page visible,
   * the two agree for every state the product can currently reach. If a later
   * phase adds a renderer→main pane-focus report, it belongs HERE, not in the
   * policy module.
   */
  function isActiveFocusedPage(contents) {
    if (!contents) return false;
    for (const record of allRecords()) {
      if (record.view?.webContents !== contents) continue;
      return record.visible === true && occluded === false;
    }
    return false;
  }

  /** The page id owning `contents`, or null when it is not a browser page. */
  function pageIdFor(contents) {
    for (const record of allRecords()) {
      if (record.view?.webContents === contents) return record.id;
    }
    return null;
  }

  /**
   * Tell the shell that `pageId` took focus. ONE place does this, so the live
   * webContents listener and the E2E seam cannot drift apart: the seam exists to
   * drive this exact report, because Chromium only delivers a `focus` event to a
   * window the OS actually considers focused, which an automated run cannot
   * guarantee.
   */
  function reportPageFocus(pageId) {
    push({ kind: "focus", pageId });
  }

  function destroyView(pageId, view) {
    const w = liveWindow();
    try {
      clearNavigationTimer(pageId);
      w?.contentView?.removeChildView?.(view);
    } catch {
      // The window may already be gone; the page is being torn down either way.
    }
    try {
      view?.webContents?.close?.();
    } catch {
      // A webContents that refuses to close must not keep the page in the table.
    }
    push({ kind: "destroyed", pageId });
  }

  /**
   * Show or hide a page according to (a) what the renderer asked for and (b)
   * whether an overlay currently owns the screen. One place decides, so the two
   * rules can never disagree.
   */
  function applyVisibility(record) {
    if (!record) return;
    const w = liveWindow();
    const shouldShow = record.requestVisible === true && !occluded && Boolean(w);
    if (!shouldShow) {
      if (record.attached) {
        try {
          w?.contentView?.removeChildView?.(record.view);
        } catch {}
        record.attached = false;
      }
      try {
        record.view?.setVisible?.(false);
      } catch {}
      record.visible = false;
      return;
    }
    if (!record.attached) {
      try {
        w.contentView.addChildView(record.view);
        record.attached = true;
      } catch {
        record.attached = false;
        record.visible = false;
        return;
      }
    }
    if (record.bounds) {
      try {
        record.view.setBounds(record.bounds);
      } catch {}
    }
    try {
      record.view.setVisible?.(true);
      record.visible = true;
    } catch {
      record.visible = false;
    }
  }

  const host = {
    reasons: REASONS,
    states: PAGE_STATES,

    /** Create one page in the browser partition belonging to `profileId`. */
    createPage({ profileId, url = "about:blank" } = {}) {
      const created = registry.create({ profileId, url });
      if (!created.ok) return created;
      const { id } = created.page;
      const record = registry.record(id);
      // Loading is kicked off here, after the gates exist and after the id is
      // in the table, so a fast page cannot emit for an unknown page.
      try {
        observeLoadPromise(id, record.view.webContents.loadURL(record.url), "load-failed");
      } catch {
        clearNavigationTimer(id);
        registry.update(id, {
          state: PAGE_STATES.FAILED,
          lastError: { reason: "load-failed", description: "Navigation could not be started" },
        });
      }
      push({ kind: "created", pageId: id, page: registry.get(id) });
      return { ok: true, page: registry.get(id) };
    },

    /** Navigate an existing page. The id is validated against the table first. */
    navigate(pageId, url) {
      const record = registry.record(pageId);
      if (!record) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
      const verdict = isAllowedUrl(url);
      if (!verdict.ok) return { ok: false, reason: REASONS.INVALID_URL, detail: verdict.reason };
      registry.update(pageId, { url: verdict.url, state: PAGE_STATES.LOADING, lastError: null });
      push({ kind: "loading", pageId, loading: true, page: registry.get(pageId) });
      try {
        observeLoadPromise(pageId, record.view.webContents.loadURL(verdict.url), "load-failed");
      } catch {
        clearNavigationTimer(pageId);
        registry.update(pageId, {
          state: PAGE_STATES.FAILED,
          lastError: { reason: "load-failed", description: "Navigation could not be started" },
        });
        push({ kind: "failed", pageId, reason: "load-failed", description: "Navigation could not be started" });
        return { ok: false, reason: "load-failed" };
      }
      return { ok: true, page: registry.get(pageId) };
    },

    reload(pageId) {
      const record = registry.record(pageId);
      if (!record) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
      // Reload from main's recorded URL, after reapplying the same URL policy
      // used by create/navigate. Do not ask Chromium to reload an implicit,
      // potentially stale current location after a crash or failed navigation.
      const verdict = isAllowedUrl(record.url);
      if (!verdict.ok) return { ok: false, reason: REASONS.INVALID_URL, detail: verdict.reason };
      clearNavigationTimer(pageId);
      registry.update(pageId, { url: verdict.url, state: PAGE_STATES.LOADING, lastError: null });
      push({ kind: "loading", pageId, loading: true, page: registry.get(pageId) });
      try {
        observeLoadPromise(pageId, record.view.webContents.loadURL(verdict.url), "reload-failed");
      } catch {
        registry.update(pageId, {
          state: PAGE_STATES.FAILED,
          lastError: { reason: "reload-failed", description: "Reload could not be started" },
        });
        push({ kind: "failed", pageId, reason: "reload-failed", description: "Reload could not be started" });
        return { ok: false, reason: "reload-failed" };
      }
      return { ok: true };
    },

    /**
     * Move one step in the page's own history (Chromium's navigation
     * history for this webContents). Added for the Phase 3 proof: the
     * browser had no back/forward path at all, so the proof's back and
     * forward checks could not pass. History is per-page, never shared
     * across pages or profiles, and a page with no history is refused
     * with a stated reason rather than silently doing nothing.
     */
    goBack(pageId) {
      const record = registry.record(pageId);
      if (!record) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
      const history = record.view?.webContents?.navigationHistory;
      if (typeof history?.canGoBack !== "function" || !history.canGoBack()) {
        return { ok: false, reason: "no-history" };
      }
      try {
        history.goBack();
      } catch {
        return { ok: false, reason: "history-failed" };
      }
      return { ok: true };
    },

    goForward(pageId) {
      const record = registry.record(pageId);
      if (!record) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
      const history = record.view?.webContents?.navigationHistory;
      if (typeof history?.canGoForward !== "function" || !history.canGoForward()) {
        return { ok: false, reason: "no-history" };
      }
      try {
        history.goForward();
      } catch {
        return { ok: false, reason: "history-failed" };
      }
      return { ok: true };
    },

    /** The history state the surface uses to enable its back/forward buttons. */
    navigationState(pageId) {
      const record = registry.record(pageId);
      if (!record) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
      const history = record.view?.webContents?.navigationHistory;
      let canGoBack = false;
      let canGoForward = false;
      try {
        canGoBack = history?.canGoBack?.() === true;
        canGoForward = history?.canGoForward?.() === true;
      } catch {
        canGoBack = false;
        canGoForward = false;
      }
      return { ok: true, canGoBack, canGoForward };
    },

    /**
     * Place the page on screen. `rect` is the renderer's layout declaration in
     * CSS pixels; it is clamped here and never trusted.
     */
    setBounds(pageId, rect) {
      const record = registry.record(pageId);
      if (!record) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
      const clamped = clampRect(rect, contentSize());
      if (!clamped.ok) return { ok: false, reason: clamped.reason };
      const bounds = {
        x: clamped.x,
        y: clamped.y,
        width: clamped.width,
        height: clamped.height,
      };
      registry.update(pageId, { bounds });
      if (record.visible) {
        try {
          record.view.setBounds(bounds);
        } catch {
          return { ok: false, reason: "bounds-failed" };
        }
      }
      return { ok: true, bounds };
    },

    /**
     * Wake a sleeping page: rebuild its view and reload its stored URL
     * through the same policy navigate uses. A stored blank page wakes
     * without a load; a stored URL that no longer passes policy fails
     * closed with a visible failure state, never a stuck loading spinner.
     */
    wakePage(pageId) {
      const record = registry.record(pageId);
      if (!record) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
      if (record.hibernated !== true) return { ok: true, page: registry.get(pageId) };
      const woken = registry.wake(pageId);
      if (!woken.ok) return woken;
      const stored = typeof record.url === "string" ? record.url : "";
      if (stored === "" || stored === "about:blank") {
        registry.update(pageId, { state: PAGE_STATES.READY });
        return { ok: true, page: registry.get(pageId) };
      }
      return host.navigate(pageId, stored);
    },

    /**
     * Ask for the page to be shown (true) or taken off screen (false). The
     * request is recorded even while an overlay hides everything, so closing the
     * overlay restores the page without the renderer having to re-ask.
     */
    setVisible(pageId, visible) {
      const record = registry.record(pageId);
      if (!record) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
      record.requestVisible = visible === true;
      if (visible === true && record.hibernated === true) {
        const woken = host.wakePage(pageId);
        if (!woken.ok) return woken;
      }
      applyVisibility(record);
      if (visible === true) registry.update(pageId, { lastUsed: Date.now() });
      return { ok: true, visible: record.visible === true };
    },

    /** Any open overlay hides every page: a native view cannot be z-covered. */
    setOccluded(value) {
      occluded = value === true;
      for (const record of [...allRecords()]) applyVisibility(record);
      return { ok: true, occluded };
    },

    /** Destroy one page (its view and its webContents). Idempotent. */
    closePage(pageId) {
      const record = registry.record(pageId);
      if (!record) return { ok: true, alreadyClosed: true };
      return { ok: registry.destroy(pageId) };
    },

    /** Tear every page down. Used on quit and by the E2E reset. */
    closeAll() {
      registry.destroyAll();
      downloads.dispose();
      occluded = false;
      return { ok: true };
    },

    /**
     * The sanitized download list for the renderer: opaque ids, the safe base
     * name, byte counts and a sanitized source URL. Never a path.
     */
    downloads() {
      return { ok: true, downloads: downloads.list() };
    },

    /** Cancel one managed download by its opaque id. */
    cancelDownload(downloadId) {
      return downloads.cancel(downloadId);
    },

    /** Sanitized state for the renderer. */
    state() {
      return { ok: true, pages: registry.list(), occluded };
    },

    /** Main-only source of truth for Research writes; never exposed in browser state IPC. */
    researchPage(pageId, profileId) {
      const record = registry.record(pageId);
      if (!record) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
      if (record.profileId !== Number(profileId)) return { ok: false, reason: "profile-mismatch" };
      if (!/^https?:\/\//i.test(record.url ?? "")) return { ok: false, reason: "invalid-url" };
      return { ok: true, page: { id: record.id, profileId: record.profileId, url: record.url, title: record.title || record.url } };
    },

    /**
     * Extract the live page for research capture (ported from the Progress
     * Ledger browser, Decision D-009 there). The frame — URL and title —
     * comes from this host's own registry record (main-process truth, the
     * same source `researchPage` attests); the page contributes only the
     * quotation via the compiled extraction script. Only http(s) pages
     * can be captured; a blank, crashed or destroyed page is refused
     * with a stated reason, never an empty capture.
     */
    async extractPage(pageId, wantSelection = false) {
      const record = registry.record(pageId);
      if (!record) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
      if (!/^https?:\/\//i.test(record.url ?? "")) {
        return { ok: false, reason: REASONS.INVALID_URL };
      }
      const wc = record.view?.webContents;
      if (!wc || wc.isDestroyed?.() === true) {
        return { ok: false, reason: "page-not-loaded" };
      }
      let raw;
      try {
        raw = await wc.executeJavaScript(EXTRACT_SCRIPT);
      } catch {
        return { ok: false, reason: "extraction-failed" };
      }
      const capped = applyExtractionCaps(raw ?? {});
      return {
        ok: true,
        page: {
          id: record.id,
          profileId: record.profileId,
          url: record.url,
          title: record.title || record.url,
        },
        extraction: {
          url: record.url,
          title: record.title || record.url,
          html: capped.html,
          text: capped.text,
          textTruncated: capped.textTruncated,
          selection: wantSelection === true ? capped.selection : "",
        },
      };
    },

    /**
     * INTERNAL diagnostics for real-Electron tests: attach state and the actual
     * view bounds, which are deliberately NOT part of `state()` because the
     * renderer has no business knowing pixel geometry main chose.
     * Exposed on globalThis only in E2E runs (see ipc/browser.js).
     */
    debugSnapshot() {
      return {
        occluded,
        pages: [...allRecords()].map((record) => ({
          id: record.id,
          url: record.url,
          state: record.state,
          lastError: record.lastError,
          // The creation time is what makes "a move is not a re-open" a testable
          // claim: a re-created page would carry a later stamp (Phase 2).
          createdAt: record.createdAt,
          attached: record.attached === true,
          visible: record.visible === true,
          requestVisible: record.requestVisible === true,
          focused: safeFocused(record.view),
          bounds: record.bounds,
          actualBounds: safeBounds(record.view),
          partition: record.partition,
        })),
      };
    },

    /**
     * E2E-ONLY seam (never an IPC channel): focus a page's webContents the way
     * a real user's click inside the native view would, so the specular
     * focus-from-native path — webContents "focus" → kind:"focus" → the
     * shell's pane focus — can be exercised without a synthetic pointer event
     * into an OS-painted surface. Installed on globalThis with the rest of the
     * E2E host (ipc/browser.js), never reachable from the renderer.
     */
    focusPage(pageId) {
      const record = registry.record(pageId);
      if (!record) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
      let nativeFocus = false;
      try {
        record.view.webContents.focus();
        nativeFocus = record.view.webContents.isFocused?.() === true;
      } catch {
        nativeFocus = false;
      }
      // The report is the contract under test (`reportPageFocus` is what the
      // live `focus` listener calls); `nativeFocus` says whether Chromium ALSO
      // took the focus, which a spec cannot demand from an unfocused window.
      reportPageFocus(pageId);
      return { ok: true, nativeFocus };
    },

    /** E2E-only caller: force the embedded page renderer to crash, not the app. */
    crashPage(pageId) {
      const record = registry.record(pageId);
      if (!record) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
      const crash = record.view?.webContents?.forcefullyCrashRenderer;
      if (typeof crash !== "function") return { ok: false, reason: "crash-mechanism-unavailable" };
      try {
        crash.call(record.view.webContents);
        return { ok: true };
      } catch {
        return { ok: false, reason: "crash-failed" };
      }
    },
  };

  function allRecords() {
    // The registry owns the table; enumerate through its sanitized list and map
    // back to records so this module never reaches into registry internals.
    return registry
      .list()
      .map((page) => registry.record(page.id))
      .filter(Boolean);
  }

  function safeFocused(view) {
    try {
      return view?.webContents?.isFocused?.() === true;
    } catch {
      return false;
    }
  }

  function safeBounds(view) {
    try {
      return view?.getBounds?.() ?? null;
    } catch {
      return null;
    }
  }

  return host;
}
