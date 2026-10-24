/**
 * Renderer mirror of the main process's browser state — Phase 1 of the approved
 * D2-D6 plan.
 *
 * THIS STORE HOLDS NO TRUTH. The live browser lives in the main process
 * (`shell/src/services/browser/*`); everything here is a disposable mirror used
 * to render chrome, refreshed by pushed events and re-syncable at any time with
 * `refresh()`. That is why a renderer reload cannot corrupt a page: it either
 * re-syncs or the page is torn down by main, and neither path can half-own a
 * view.
 *
 * The renderer never sees a partition, a port or a path, and never sees a URL
 * main has not sanitized. It sees an opaque id (`bp-N`) and display strings.
 */

const bridge = () => (typeof window === "undefined" ? null : window.progressLedger?.browser ?? null);

/** `{ [pageId]: page }` — sanitized metadata only. */
export const browser = $state({
  pages: {},
  occluded: false,
  lastError: null,
  /** The page whose webContents most recently took focus, and a version counter
   *  so repeated focus on the SAME page still re-triggers consumers (the App
   *  effect that focuses the pane holding the page). Phase 2 of the D2-D6 plan. */
  lastFocusedPage: null,
  focusTick: 0,
  /**
   * The newest page MAIN created on a website's behalf — an approved popup
   * (R3, approved decision D3-3) — plus a counter so two popups still re-trigger
   * the consumer. The shell turns it into an UNFOCUSED workspace tab: a page
   * must not be able to take over the pane the user is reading.
   */
  lastPopupPage: null,
  popupTick: 0,
});

function bridgeUnavailable() {
  return { ok: false, reason: "bridge-unavailable" };
}

function put(page) {
  if (!page || typeof page.id !== "string") return;
  browser.pages[page.id] = page;
}

/** Ids in creation order (main mints `bp-N`, so ordering is by numeric part). */
export function pageIds() {
  return Object.keys(browser.pages).sort(
    (a, b) => Number(a.replace(/^\D+/, "")) - Number(b.replace(/^\D+/, "")),
  );
}

export function pageFor(pageId) {
  if (!pageId) return null;
  return browser.pages[String(pageId)] ?? null;
}

/** True while any live page exists — used by tests and the console readout. */
export function livePageCount() {
  return Object.keys(browser.pages).length;
}

/** Apply one sanitized push from main. Exported so a test can drive it directly. */
export function applyBrowserEvent(event) {
  if (!event || typeof event !== "object") return;
  const id = typeof event.pageId === "string" ? event.pageId : null;
  switch (event.kind) {
    case "created":
      put(event.page);
      break;
    case "popup":
      // Main approved a popup and created the page itself (R3, D3-3). The page
      // is ALREADY in the `created` push that precedes this one; this event only
      // tells the shell to give it a tab, and to keep that tab in the
      // background. It carries no new state, so an unknown id is harmless.
      //
      // NOTE the id: `pageId` on this event is the OPENER (the page that called
      // `window.open`), and `popupPageId` is the page main minted for the popup.
      // Reading the opener here would look for a tab that already exists and
      // add nothing — which is exactly the bug the E2E spec caught.
      if (typeof event.popupPageId === "string" && event.popupPageId) {
        browser.lastPopupPage = event.popupPageId;
        browser.popupTick += 1;
      }
      break;
    case "title":
      if (id && browser.pages[id]) browser.pages[id] = { ...browser.pages[id], title: event.title ?? "" };
      break;
    case "url":
      if (event.page) put(event.page);
      break;
    case "loading":
      if (id && browser.pages[id]) {
        if (event.page) put(event.page);
        else browser.pages[id] = { ...browser.pages[id], loading: event.loading === true };
      }
      break;
    case "failed":
      if (id && browser.pages[id]) {
        browser.pages[id] = {
          ...browser.pages[id],
          state: "failed",
          loading: false,
          lastError: {
            code: event.code,
            description: event.description ?? "",
            ...(event.reason ? { reason: event.reason } : {}),
          },
        };
      }
      break;
    case "crashed":
      if (id && browser.pages[id]) {
        browser.pages[id] = {
          ...browser.pages[id],
          state: "crashed",
          loading: false,
          crashed: true,
          lastError: { reason: event.reason ?? "unknown" },
        };
      }
      break;
    case "destroyed":
      if (id) delete browser.pages[id];
      break;
    case "focus":
      if (id) {
        browser.lastFocusedPage = id;
        browser.focusTick += 1;
      }
      break;
    default:
      // Unhandled kinds are ignored on purpose: a mirror that throws on a new
      // event kind would break the whole shell for a cosmetic addition.
      break;
  }
}

/** Subscribe to main's pushes. Returns an unsubscribe function. */
export function subscribe() {
  const b = bridge();
  if (!b?.onEvent) return () => {};
  return b.onEvent((event) => applyBrowserEvent(event));
}

/** Re-read the whole sanitized state from main. */
export async function refresh() {
  const b = bridge();
  if (!b?.state) return bridgeUnavailable();
  const res = await b.state();
  if (!res?.ok) return res ?? bridgeUnavailable();
  browser.pages = {};
  for (const page of res.pages ?? []) put(page);
  browser.occluded = res.occluded === true;
  return res;
}

/** Create a page in the browser partition of `profileId`. */
export async function openPage({ profileId, url }) {
  const b = bridge();
  if (!b?.createPage) return bridgeUnavailable();
  const res = await b.createPage(profileId, url);
  if (res?.ok) {
    put(res.page);
    browser.lastError = null;
  } else {
    browser.lastError = res?.reason ?? "create-failed";
  }
  return res ?? bridgeUnavailable();
}

export async function navigate(pageId, url) {
  const b = bridge();
  if (!b?.navigate) return bridgeUnavailable();
  const res = await b.navigate(pageId, url);
  if (!res?.ok) browser.lastError = res?.reason ?? "navigate-failed";
  return res ?? bridgeUnavailable();
}

export async function reload(pageId) {
  const b = bridge();
  if (!b?.reload) return bridgeUnavailable();
  return (await b.reload(pageId)) ?? bridgeUnavailable();
}

export async function closePage(pageId) {
  const b = bridge();
  if (!b?.closePage) return bridgeUnavailable();
  const res = await b.closePage(pageId);
  delete browser.pages[String(pageId)];
  return res ?? bridgeUnavailable();
}

/** The renderer's layout declaration. Main clamps it; this is a request only. */
export async function setBounds(pageId, rect) {
  const b = bridge();
  if (!b?.setBounds) return bridgeUnavailable();
  return (await b.setBounds(pageId, rect)) ?? bridgeUnavailable();
}

export async function setVisible(pageId, visible) {
  const b = bridge();
  if (!b?.setVisible) return bridgeUnavailable();
  const res = await b.setVisible(pageId, visible);
  if (pageId && browser.pages[String(pageId)]) {
    browser.pages[String(pageId)] = { ...browser.pages[String(pageId)], visible: visible === true };
  }
  return res ?? bridgeUnavailable();
}

/** Any open overlay hides every native view (a WebContentsView is not z-orderable). */
export async function setOccluded(occluded) {
  const b = bridge();
  if (!b?.setOccluded) return bridgeUnavailable();
  browser.occluded = occluded === true;
  return (await b.setOccluded(occluded === true)) ?? bridgeUnavailable();
}

/** Test hook — mirrors `__resetWorkspace`. */
export function __resetBrowserForTests() {
  browser.pages = {};
  browser.occluded = false;
  browser.lastError = null;
  browser.lastFocusedPage = null;
  browser.focusTick = 0;
  browser.lastPopupPage = null;
  browser.popupTick = 0;
}
