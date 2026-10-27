// Phase 1 of the approved D2-D6 browser plan — the renderer half.
//
// Two things are proven here, and only these two: the MIRROR (main is the truth;
// the renderer's copy is disposable and re-syncable) and the SURFACE (chrome,
// states, and the fact that it declares a rectangle instead of trusting one).
//
// The native half cannot be seen from jsdom at all — no WebContentsView, no
// real hit testing, no compositing. Layout and attach behaviour are proven in
// e2e/browser-page.spec.js, which is why this file never claims to test them.

import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import BrowserSurface from "../src/features/browser/components/BrowserSurface.svelte";
import {
  browser,
  applyBrowserEvent,
  openPage,
  closePage,
  refresh,
  setVisible,
  setOccluded,
  subscribe,
  pageFor,
  __resetBrowserForTests,
} from "../src/shared/stores/browser.svelte.js";

/** A page as main would report it — sanitized, with an opaque id. */
function pageFrame(overrides = {}) {
  return {
    id: "bp-1",
    url: "https://example.com/",
    title: "Example",
    state: "ready",
    loading: false,
    insecure: false,
    visible: false,
    attached: false,
    crashed: false,
    lastError: null,
    createdAt: 1,
    ...overrides,
  };
}

function makeBrowserBridge(overrides = {}) {
  const base = {
    createPage: vi.fn(async (options) => ({ ok: true, page: pageFrame({ url: options?.url }) })),
    navigate: vi.fn(async () => ({ ok: true })),
    reload: vi.fn(async () => ({ ok: true })),
    closePage: vi.fn(async () => ({ ok: true })),
    state: vi.fn(async () => ({ ok: true, pages: [], occluded: false })),
    setBounds: vi.fn(async () => ({ ok: true })),
    setVisible: vi.fn(async () => ({ ok: true })),
    setOccluded: vi.fn(async () => ({ ok: true })),
    onEvent: vi.fn(() => () => {}),
  };
  const bridge = { ...base, ...overrides };
  window.progressLedger = { ...(window.progressLedger ?? {}), browser: bridge };
  return bridge;
}

/** jsdom has no ResizeObserver; the surface needs one to exist. */
class FakeResizeObserver {
  constructor(cb) {
    this.cb = cb;
  }
  observe() {}
  disconnect() {}
}

/** A non-degenerate box, so a real rectangle is actually sent to main. */
function stubBox({ left = 12, top = 40, width = 320, height = 240 } = {}) {
  return vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
}

beforeEach(() => {
  __resetBrowserForTests();
  globalThis.ResizeObserver = FakeResizeObserver;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.progressLedger;
});

// ---------------------------------------------------------------------------
// the mirror
// ---------------------------------------------------------------------------

describe("browser mirror", () => {
  it("applies main's pushes and drops pages main says are gone", () => {
    applyBrowserEvent({ kind: "created", page: pageFrame() });
    expect(pageFor("bp-1").title).toBe("Example");

    applyBrowserEvent({ kind: "title", pageId: "bp-1", title: "Renamed" });
    expect(pageFor("bp-1").title).toBe("Renamed");

    applyBrowserEvent({ kind: "crashed", pageId: "bp-1", reason: "crashed" });
    expect(pageFor("bp-1").crashed).toBe(true);
    expect(pageFor("bp-1").lastError.reason).toBe("crashed");

    applyBrowserEvent({ kind: "destroyed", pageId: "bp-1" });
    expect(pageFor("bp-1")).toBe(null);
  });

  it("ignores an event for a page it does not know, and an unknown kind", () => {
    applyBrowserEvent({ kind: "title", pageId: "bp-9", title: "ghost" });
    applyBrowserEvent({ kind: "something-new", pageId: "bp-9" });
    expect(Object.keys(browser.pages).length).toBe(0);
  });

  it("re-syncs wholesale from main, because a renderer reload must not half-own a page", async () => {
    const bridge = makeBrowserBridge();
    bridge.state = vi.fn(async () => ({
      ok: true,
      pages: [pageFrame(), pageFrame({ id: "bp-2", title: "Second" })],
      occluded: true,
    }));
    applyBrowserEvent({ kind: "created", page: pageFrame({ id: "bp-stale" }) });

    await refresh();

    expect(Object.keys(browser.pages).sort()).toEqual(["bp-1", "bp-2"]);
    expect(browser.occluded).toBe(true);
    expect(pageFor("bp-stale")).toBe(null);
  });

  it("sends the profile id and the URL, and never invents a page id", async () => {
    const bridge = makeBrowserBridge();
    const res = await openPage({ profileId: 7, url: "example.com" });
    expect(bridge.createPage).toHaveBeenCalledWith({ profileId: 7, url: "example.com" });
    expect(res.ok).toBe(true);
    expect(pageFor("bp-1")).toBeTruthy();

    bridge.createPage = vi.fn(async () => ({ ok: false, reason: "unknown-profile" }));
    const refused = await openPage({ profileId: 999, url: "https://x.test/" });
    expect(refused.ok).toBe(false);
    expect(browser.lastError).toBe("unknown-profile");
  });

  it("sends ONE options object, with a non-default profile in browserProfileId and no restore field", async () => {
    const bridge = makeBrowserBridge();
    const res = await openPage({ profileId: 3, url: "about:blank", browserProfileId: "bp-created" });
    expect(res.ok).toBe(true);
    // Exactly one argument, an object: a positional call, or a profile
    // id landing in restoreId, fails this assertion on purpose.
    expect(bridge.createPage.mock.calls.length).toBe(1);
    expect(bridge.createPage.mock.calls[0].length).toBe(1);
    expect(bridge.createPage).toHaveBeenCalledWith({
      profileId: 3,
      url: "about:blank",
      browserProfileId: "bp-created",
    });
    expect(bridge.createPage.mock.calls[0][0].restoreId).toBeUndefined();
  });

  it("keeps restore and profile in their own fields, never swapped", async () => {
    const bridge = makeBrowserBridge();
    await openPage({ profileId: 3, url: "https://x.test/", restoreBrowserTabId: 42, browserProfileId: "bp-other" });
    expect(bridge.createPage).toHaveBeenCalledWith({
      profileId: 3,
      url: "https://x.test/",
      restoreId: 42,
      browserProfileId: "bp-other",
    });
  });

  it("keeps close, visibility and occlusion going one way: to main", async () => {
    const bridge = makeBrowserBridge();
    applyBrowserEvent({ kind: "created", page: pageFrame() });

    await closePage("bp-1");
    expect(bridge.closePage).toHaveBeenCalledWith("bp-1");
    expect(pageFor("bp-1")).toBe(null);

    await setVisible("bp-1", true);
    expect(bridge.setVisible).toHaveBeenCalledWith("bp-1", true);

    await setOccluded(true);
    expect(bridge.setOccluded).toHaveBeenCalledWith(true);
    expect(browser.occluded).toBe(true);
  });

  it("subscribes through the bridge and unsubscribes cleanly", () => {
    const stop = vi.fn();
    const bridge = makeBrowserBridge({ onEvent: vi.fn(() => stop) });
    const unsubscribe = subscribe();
    expect(bridge.onEvent).toHaveBeenCalled();
    unsubscribe();
    expect(stop).toHaveBeenCalled();
  });

  it("fails soft when the preload bridge is absent", async () => {
    delete window.progressLedger;
    expect((await refresh()).reason).toBe("bridge-unavailable");
    expect((await openPage({ profileId: 1, url: "https://x.test/" })).reason).toBe("bridge-unavailable");
  });
});

// ---------------------------------------------------------------------------
// the surface
// ---------------------------------------------------------------------------

describe("browser surface", () => {
  it("offers an address row and says what this tab is when it has no page yet", async () => {
    makeBrowserBridge();
    render(BrowserSurface, { props: { pageId: null, profileId: 3 } });

    expect(screen.getByTestId("browser-surface")).toBeTruthy();
    expect(screen.getByTestId("browser-address")).toBeTruthy();
    expect(screen.getByText("No page in this tab")).toBeTruthy();
    // Nothing is sent for a tab that has no page: there is nothing to place.
    expect(window.progressLedger.browser.setBounds).not.toHaveBeenCalled();
    expect(window.progressLedger.browser.setVisible).not.toHaveBeenCalled();
  });

  it("creates a page from the empty state and reports the id back to the workspace tab", async () => {
    const bridge = makeBrowserBridge();
    const onPageChange = vi.fn();
    render(BrowserSurface, { props: { pageId: null, profileId: 3, onPageChange } });

    await fireEvent.input(screen.getByTestId("browser-address"), {
      target: { value: "example.com" },
    });
    await fireEvent.click(screen.getByTestId("browser-go"));

    // A bare host is inferred as https before it reaches main (the old
    // test asserted the raw "example.com", which main would have
    // refused as invalid-url). The URL constructor normalizes the bare
    // host with a trailing slash.
    await waitFor(() => expect(bridge.createPage).toHaveBeenCalledWith({ profileId: 3, url: "https://example.com/" }));
    await waitFor(() => expect(onPageChange).toHaveBeenCalledWith("bp-1"));
  });

  it("shows a refusal instead of a silent no-op", async () => {
    // A file: URL is never navigated: it becomes a search query, and
    // the mock's rejection of that open still surfaces as a notice.
    const bridge = makeBrowserBridge({
      createPage: vi.fn(async () => ({ ok: false, reason: "invalid-url", detail: "blocked-scheme" })),
    });
    render(BrowserSurface, { props: { pageId: null, profileId: 3 } });

    await fireEvent.input(screen.getByTestId("browser-address"), {
      target: { value: "file:///etc/passwd" },
    });
    await fireEvent.click(screen.getByTestId("browser-go"));

    await waitFor(() => expect(screen.getByTestId("browser-notice")).toBeTruthy());
    expect(screen.getByTestId("browser-notice").textContent).toContain("blocked-scheme");
    expect(bridge.navigate).not.toHaveBeenCalled();
  });

  it("renders the page it was given: title, sanitized url, opaque id, live state", async () => {
    makeBrowserBridge();
    applyBrowserEvent({
      kind: "created",
      page: pageFrame({ url: "https://example.com/x", title: "Example" }),
    });
    render(BrowserSurface, { props: { pageId: "bp-1", profileId: 3 } });

    expect(screen.getByTestId("browser-title").textContent.trim()).toBe("Example");
    await waitFor(() => expect(screen.getByTestId("browser-address").value).toBe("https://example.com/x"));
    expect(screen.getByTestId("browser-page-id").getAttribute("data-page-id")).toBe("bp-1");
    expect(screen.queryByTestId("browser-state")).toBe(null);
  });

  it("states a failure honestly rather than showing a blank page", async () => {
    makeBrowserBridge();
    applyBrowserEvent({
      kind: "created",
      page: pageFrame({ state: "failed", loading: false, lastError: { code: -105, description: "NAME_NOT_RESOLVED" } }),
    });
    render(BrowserSurface, { props: { pageId: "bp-1", profileId: 3 } });
    expect(screen.getByTestId("browser-state").textContent).toContain("could not be loaded");
    expect(screen.getByTestId("browser-state")).toHaveClass("failed");
  });

  it("announces a live loading state in the page chrome", () => {
    makeBrowserBridge();
    applyBrowserEvent({
      kind: "created",
      page: pageFrame({ state: "loading", loading: true, title: "Example" }),
    });
    render(BrowserSurface, { props: { pageId: "bp-1", profileId: 3 } });

    const state = screen.getByRole("status");
    expect(state.textContent.trim()).toBe("Loading");
    expect(state.getAttribute("aria-live")).toBe("polite");
  });

  it("declares its rectangle to main and takes the page off screen when hidden", async () => {
    const bridge = makeBrowserBridge();
    stubBox({ left: 12, top: 40, width: 320, height: 240 });
    applyBrowserEvent({ kind: "created", page: pageFrame() });

    const { unmount } = render(BrowserSurface, { props: { pageId: "bp-1", profileId: 3 } });

    await waitFor(() => expect(bridge.setBounds).toHaveBeenCalled());
    expect(bridge.setBounds).toHaveBeenCalledWith("bp-1", {
      x: 12,
      y: 40,
      width: 320,
      height: 240,
    });
    await waitFor(() => expect(bridge.setVisible).toHaveBeenCalledWith("bp-1", true));

    unmount();
    // Leaving the tab takes the page OFF SCREEN. It is not closed: a browser tab
    // must survive being backgrounded (closing is an explicit workspace act).
    await waitFor(() => expect(bridge.setVisible).toHaveBeenCalledWith("bp-1", false));
    expect(bridge.closePage).not.toHaveBeenCalled();
  });

  it("hides the page while an overlay is open, and restores it after", async () => {
    const bridge = makeBrowserBridge();
    stubBox();
    applyBrowserEvent({ kind: "created", page: pageFrame() });

    const { rerender } = render(BrowserSurface, { props: { pageId: "bp-1", profileId: 3, occluded: false } });
    await waitFor(() => expect(bridge.setVisible).toHaveBeenCalledWith("bp-1", true));

    await rerender({ pageId: "bp-1", profileId: 3, occluded: true });
    await waitFor(() => expect(bridge.setVisible).toHaveBeenCalledWith("bp-1", false));

    bridge.setVisible.mockClear();
    await rerender({ pageId: "bp-1", profileId: 3, occluded: false });
    await waitFor(() => expect(bridge.setVisible).toHaveBeenCalledWith("bp-1", true));
  });

  it("hides the page it is LEAVING when the pane switches tabs, never the one arriving", async () => {
    const bridge = makeBrowserBridge();
    stubBox();
    applyBrowserEvent({ kind: "created", page: pageFrame({ id: "bp-1", url: "https://one.test/" }) });
    applyBrowserEvent({ kind: "created", page: pageFrame({ id: "bp-2", url: "https://two.test/" }) });

    const { rerender } = render(BrowserSurface, { props: { pageId: "bp-1", profileId: 3 } });
    await waitFor(() => expect(bridge.setVisible).toHaveBeenCalledWith("bp-1", true));
    bridge.setVisible.mockClear();

    // The same pane now shows its SECOND page tab: the props change, the
    // component instance stays. Svelte updates the prop BEFORE it runs the
    // effect cleanup, so a cleanup that reads `pageId` hides the page being
    // entered and leaves the one being left on screen — two native views
    // painted over each other in one pane, which is exactly the defect.
    await rerender({ pageId: "bp-2", profileId: 3 });

    await waitFor(() => expect(bridge.setVisible).toHaveBeenCalledWith("bp-2", true));
    expect(bridge.setVisible).toHaveBeenCalledWith("bp-1", false);
    expect(bridge.setVisible).not.toHaveBeenCalledWith("bp-2", false);
  });

  it("never sends a degenerate rectangle", async () => {
    const bridge = makeBrowserBridge();
    stubBox({ left: 0, top: 0, width: 0, height: 0 });
    applyBrowserEvent({ kind: "created", page: pageFrame() });
    render(BrowserSurface, { props: { pageId: "bp-1", profileId: 3 } });
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.setBounds).not.toHaveBeenCalled();
  });

  it("updates the address bar when switching between browser page tabs in the same pane", async () => {
    makeBrowserBridge();
    applyBrowserEvent({ kind: "created", page: pageFrame({ id: "bp-1", url: "https://first.example/" }) });
    applyBrowserEvent({ kind: "created", page: pageFrame({ id: "bp-2", url: "https://second.example/" }) });

    const { rerender } = render(BrowserSurface, { props: { pageId: "bp-1", profileId: 3 } });
    await waitFor(() => expect(screen.getByTestId("browser-address").value).toBe("https://first.example/"));

    await rerender({ pageId: "bp-2", profileId: 3 });
    await waitFor(() => expect(screen.getByTestId("browser-address").value).toBe("https://second.example/"));
  });

  it("exposes accessible roles and labels across browser controls", async () => {
    makeBrowserBridge();
    applyBrowserEvent({ kind: "created", page: pageFrame({ id: "bp-1", url: "https://example.com/" }) });

    render(BrowserSurface, { props: { pageId: "bp-1", profileId: 3 } });

    const form = screen.getByRole("search", { name: "Browser address bar" });
    expect(form).toBeTruthy();

    const goBtn = screen.getByRole("button", { name: "Go" });
    expect(goBtn).toBeTruthy();

    const reloadBtn = screen.getByRole("button", { name: "Reload" });
    expect(reloadBtn).toBeTruthy();

    const host = screen.getByRole("region", { name: "Browser web content" });
    expect(host).toBeTruthy();
  });

  it("opens a fresh page in a profile just created, and reports it to the tab", async () => {
    const created = { localId: "bp-created", displayName: "Work", color: "#e0a35c", isDefault: false };
    const bridge = makeBrowserBridge({
      listProfiles: vi.fn(async () => ({ ok: true, profiles: [created] })),
      createProfile: vi.fn(async () => ({ ok: true, profile: created })),
      updateProfile: vi.fn(async () => ({ ok: true, profile: created })),
      createPage: vi.fn(async (options) => ({
        ok: true,
        page: pageFrame({ id: "bp-9", url: options?.url }),
      })),
    });
    const onPageChange = vi.fn();
    applyBrowserEvent({ kind: "created", page: pageFrame({ id: "bp-1", url: "https://example.com/" }) });
    render(BrowserSurface, { props: { pageId: "bp-1", profileId: 3, onPageChange } });

    await fireEvent.click(screen.getByTestId("browser-profile-switcher"));
    await fireEvent.click(screen.getByTestId("browser-profile-new"));
    await waitFor(() => expect(screen.getByTestId("browser-profile-name")).toBeTruthy());
    await fireEvent.input(screen.getByTestId("browser-profile-name"), { target: { value: "Work" } });
    await fireEvent.click(screen.getByRole("button", { name: "Create profile" }));

    // The new profile is created, then a fresh page is opened IN it
    // (not in whatever profile the tab had before), and the tab is
    // told about the new page id so it becomes the active page.
    await waitFor(() => expect(bridge.createPage).toHaveBeenCalledWith({ profileId: 3, url: "about:blank", browserProfileId: "bp-created" }));
    await waitFor(() => expect(onPageChange).toHaveBeenCalledWith("bp-9"));
    await waitFor(() => expect(screen.queryByTestId("browser-profile-name")).toBe(null));
  });
});
