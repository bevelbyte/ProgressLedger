// Tests for the persistent right-dock browser workspace store.
//
// These exercise the module-scoped browser-workspace store directly against
// the REAL preload contract (preload.cjs → ipc/browser-workspace.js):
//   - launch(profileLocalId, cfProfileId) → { ok, workspace? }
//   - state() → sanitized snapshot { state, backend, profileLocalId, tabs,
//     activeTabId, lastError, ... } with tabs as { id, title, url, active }
//   - navigate(profileLocalId, url) / newTab(profileLocalId) /
//     closeTab(profileLocalId, tabId) / activateTab(profileLocalId, tabId) /
//     reload(profileLocalId, tabId) / screenshot(profileLocalId, tabId) /
//     stop()
//   - onEvent(cb) → unsubscribe fn; events carry a `kind`
//
// Coverage matrix:
//   - open/close/toggle + width + profile persistence across module reloads
//   - subscription start on open, unsubscribed on close, exactly once
//   - auto-launch: open() restores the persisted workspace (first managed
//     browser profile of the active CF profile when no local id is stored)
//   - launch passes (profileLocalId, cfProfileId) and applies the snapshot
//   - launch surfaces refusals (busy) and missing-IPC as thrown reasons
//   - navigate/closeTab/activateTab/reload/screenshot forward the right
//     (profileLocalId, tabId, url) payloads
//   - screenshot stores the data URL; degrades honestly when unavailable
//   - pushed events: launched/navigated/new-tab → refresh; *-failed →
//     lastError; stopped → closed
//
// We mock `window.careerflow.browserWorkspace` / `browserManager` and set
// the profileStore's active profile per-test so every scenario owns its
// IPC stub. localStorage is reset between tests to avoid leakage.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { profileStore } from "../src/features/profiles/stores/profile.svelte.js";
import * as browserWorkspaceModule from "../src/shared/stores/browser-workspace.svelte.js";

const STORE_PATH = "../src/shared/stores/browser-workspace.svelte.js";

/** Sanitized snapshot exactly as the main process returns it. */
function snapshot(over = {}) {
  return {
    state: "closed",
    backend: null,
    profileLocalId: null,
    tabs: [],
    activeTabId: null,
    lastError: null,
    openedAt: null,
    updatedAt: 0,
    ...over,
  };
}

/** Install a fake `window.careerflow` matching the real preload surface.
 *  `state` is a mutable snapshot shared by `state()` and `launch()` — tests
 *  mutate it to mirror how the main process updates its own state, so the
 *  store's post-op refresh() reconciles against the same reality. */
function installIpc({ workspace = {}, cdp = {}, profiles = {}, browserManager = {} } = {}) {
  const state = snapshot({
    state: "ready",
    profileLocalId: "bp-1",
    tabs: [{ id: "tab-1", title: "Example", url: "https://example.com", active: true }],
    activeTabId: "tab-1",
  });
  const wsHandlers = {
    launch: vi.fn(async () => ({ ok: true, workspace: state })),
    state: vi.fn(async () => state),
    stop: vi.fn(async () => ({ ok: true })),
    navigate: vi.fn(async () => ({ ok: true })),
    newTab: vi.fn(async () => ({ ok: true, tabId: "tab-2" })),
    closeTab: vi.fn(async () => ({ ok: true })),
    activateTab: vi.fn(async () => ({ ok: true })),
    reload: vi.fn(async () => ({ ok: true })),
    back: vi.fn(async () => ({ ok: true })),
    forward: vi.fn(async () => ({ ok: true })),
    screenshot: vi.fn(async () => ({ ok: true, image: { dataUrl: "data:image/png;base64,AAA" } })),
    onEvent: vi.fn(() => () => {}),
    ...workspace,
  };
  const cdpHandlers = {
    screenshot: vi.fn(async () => ({ dataUrl: "data:image/png;base64,CDP" })),
    ...cdp,
  };
  window.careerflow = {
    profiles,
    browserManager: {
      list: vi.fn(async () => [{ localId: "auto-1", name: "Auto" }]),
      ...browserManager,
    },
    browserWorkspace: wsHandlers,
    cdp: cdpHandlers,
  };
  return { ws: wsHandlers, cdp: cdpHandlers, state };
}

function setActiveCfProfile(store, id = 7) {
  store.profiles = [{ id, name: "A" }];
  store.activeProfileId = id;
}

let mod;

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* noop */
  }
  setActiveCfProfile(profileStore);
  // Keep the store/profile modules loaded during collection rather than
  // recompiling the full Svelte graph inside every 10s test hook. The store
  // exposes an explicit test reset so this does not relax isolation.
  mod = browserWorkspaceModule;
  mod.__resetForTests();
});

afterEach(() => {
  profileStore.profiles = [];
  profileStore.activeProfileId = null;
  delete window.careerflow;
  try {
    localStorage.clear();
  } catch {
    /* noop */
  }
});

/** Flush the microtask + macrotask queue so fire-and-forget IPC roundtrips settle. */
async function flushAsync() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("browserWorkspace store", () => {
  it("starts closed with a medium default width", async () => {
    installIpc();
        expect(mod.browserWorkspace.open).toBe(false);
    expect(mod.browserWorkspace.width).toBe(480);
    expect(mod.browserWorkspace.status).toBe("idle");
  });

  it("open() flips the open flag and persists it", async () => {
    installIpc();
        mod.open(false); // no auto-launch for this assertion
    expect(mod.browserWorkspace.open).toBe(true);
    expect(JSON.parse(localStorage.getItem("cf.browserWorkspace.open"))).toBe(true);
  });

  it("close() hides the dock and stops the event subscription", async () => {
    const { ws } = installIpc();
        mod.open(false);
    expect(ws.onEvent).toHaveBeenCalledTimes(1);
    mod.close();
    expect(mod.browserWorkspace.open).toBe(false);
    expect(mod.browserWorkspace._unsubscribe).toBeNull();
  });

  it("toggle() flips open/close", async () => {
    installIpc();
        mod.toggle();
    expect(mod.browserWorkspace.open).toBe(true);
    mod.toggle();
    expect(mod.browserWorkspace.open).toBe(false);
  });

  it("setWidth() clamps to the [280, 760] range and persists", async () => {
    installIpc();
    
    mod.setWidth(60);
    expect(mod.browserWorkspace.width).toBe(280);

    mod.setWidth(9000);
    expect(mod.browserWorkspace.width).toBe(760);

    mod.setWidth(420);
    expect(mod.browserWorkspace.width).toBe(420);
    expect(JSON.parse(localStorage.getItem("cf.browserWorkspace.width"))).toBe(420);
  });

  it("setWidthPreset() maps the narrow/medium/wide presets", async () => {
    installIpc();
        mod.setWidthPreset("narrow");
    expect(mod.browserWorkspace.width).toBe(320);
    mod.setWidthPreset("medium");
    expect(mod.browserWorkspace.width).toBe(480);
    mod.setWidthPreset("wide");
    expect(mod.browserWorkspace.width).toBe(640);
  });

  it("persists open + width across module reloads", async () => {
    installIpc();
    {
      mod.open(false);
      mod.setWidth(560);
    }
    // Reset the module cache so the store re-initializes from localStorage.
    vi.resetModules();
    const mod2 = await import(STORE_PATH);
    expect(mod2.browserWorkspace.open).toBe(true);
    expect(mod2.browserWorkspace.width).toBe(560);
  });

  it("starts the event subscription exactly once when opened", async () => {
    const { ws } = installIpc();
        mod.open(false);
    mod.open(false); // idempotent
    mod.open(false);
    expect(ws.onEvent).toHaveBeenCalledTimes(1);
  });

  it("open() auto-launches the persisted/available workspace (first managed profile)", async () => {
    const { ws, state } = installIpc();
    // Mirror the main process: nothing running yet…
    state.state = "closed";
    state.profileLocalId = null;
    state.tabs = [];
    state.activeTabId = null;
    // …and launch() flips the backend state to ready (the spy mirrors the
    // service, which updates its own state before answering).
    const ready = snapshot({
      state: "ready",
      profileLocalId: "bp-1",
      tabs: [{ id: "tab-1", title: "Example", url: "https://example.com", active: true }],
      activeTabId: "tab-1",
    });
    ws.launch.mockImplementation(async () => {
      Object.assign(state, ready);
      return { ok: true, workspace: state };
    });
    mod.open(); // autoLaunch = true
    await flushAsync();
    expect(ws.launch).toHaveBeenCalledWith("auto-1", 7); // auto-picked profile + CF id
    expect(mod.browserWorkspace.status).toBe("ready");
    expect(mod.browserWorkspace.activeProfileLocalId).toBe("bp-1");
  });
});

describe("browserWorkspace actions", () => {
  it("launch() forwards (profileLocalId, cfProfileId) and stores the profile on success", async () => {
    const { ws } = installIpc();
        await mod.launch("bp-local-1");
    expect(ws.launch).toHaveBeenCalledWith("bp-local-1", 7);
    expect(mod.browserWorkspace.activeProfileLocalId).toBe("bp-1"); // from snapshot
    expect(mod.browserWorkspace.status).toBe("ready");
    expect(mod.browserWorkspace.tabs[0]).toMatchObject({ tabId: "tab-1", url: "https://example.com" });
  });

  it("launch() surfaces backend refusal as lastError + thrown error", async () => {
    installIpc({ workspace: { launch: vi.fn(async () => ({ ok: false, reason: "busy" })) } });
        await expect(mod.launch("bp-local-2")).rejects.toMatchObject({ reason: "busy" });
    expect(mod.browserWorkspace.status).toBe("error");
    expect(mod.browserWorkspace.lastError).toBe("busy");
  });

  it("launch() throws not-available when IPC is missing", async () => {
    window.careerflow = {}; // no namespaces at all
        await expect(mod.launch()).rejects.toMatchObject({ reason: "not-available" });
    expect(mod.browserWorkspace.lastError).toBe("Browser workspace IPC not available");
  });

  it("navigate() forwards (profileLocalId, trimmed url) and marks the tab loading", async () => {
    const { ws, state } = installIpc();
    await mod.launch("bp-1");
    const nav = mod.navigate("  https://careerflow.example  ");
    // Optimistic loading is set synchronously before the IPC roundtrip.
    expect(mod.browserWorkspace.tabs.find((t) => t.tabId === "tab-1").loading).toBe(true);
    state.tabs = [{ id: "tab-1", title: "Example", url: "https://careerflow.example", active: true }];
    await nav;
    expect(ws.navigate).toHaveBeenCalledWith("bp-1", 7, "https://careerflow.example");
    await flushAsync();
    // refresh() reconciles loading back to the backend truth.
    const tab = mod.browserWorkspace.tabs.find((t) => t.tabId === "tab-1");
    expect(tab.loading).toBe(false);
    expect(tab.url).toBe("https://careerflow.example");
  });

  it("navigate() throws unknown-profile when no workspace profile is bound", async () => {
    installIpc({ workspace: { state: vi.fn(async () => snapshot({ state: "closed" })) } });
        await expect(mod.navigate("https://example.com")).rejects.toMatchObject({
      reason: "unknown-profile",
    });
  });

  it("newTab() forwards the profileLocalId and refreshes tabs", async () => {
    const { ws } = installIpc();
        await mod.launch("bp-1");
    await mod.newTab();
    expect(ws.newTab).toHaveBeenCalledWith("bp-1", 7);
    await flushAsync();
    expect(mod.browserWorkspace.activeTabId).toBe("tab-1");
  });

  it("closeTab() optimistically removes the tab locally and forwards (profileLocalId, tabId)", async () => {
    const { ws, state } = installIpc();
    await mod.launch("bp-1");
    const closing = mod.closeTab("tab-1");
    expect(mod.browserWorkspace.tabs).toEqual([]); // optimistic removal
    // Mirror the main process: the tab is gone and the active id is re-elected.
    state.tabs = [];
    state.activeTabId = null;
    await closing;
    expect(ws.closeTab).toHaveBeenCalledWith("bp-1", 7, "tab-1");
    await flushAsync();
    expect(mod.browserWorkspace.tabs).toEqual([]); // refresh agrees
    expect(mod.browserWorkspace.activeTabId).toBeNull();
  });

  it("activateTab() updates activeTabId locally and forwards (profileLocalId, tabId)", async () => {
    const { ws, state } = installIpc();
    state.tabs = [
      { id: "tab-1", title: "A", url: "https://a.example", active: true },
      { id: "tab-2", title: "B", url: "https://b.example", active: false },
    ];
    state.activeTabId = "tab-1";
    // Mirror the service: activation flips the flags in its own state.
    ws.activateTab.mockImplementation(async () => {
      state.tabs = [
        { id: "tab-1", title: "A", url: "https://a.example", active: false },
        { id: "tab-2", title: "B", url: "https://b.example", active: true },
      ];
      state.activeTabId = "tab-2";
      return { ok: true };
    });
    await mod.launch("bp-1");
    await mod.activateTab("tab-2");
    expect(ws.activateTab).toHaveBeenCalledWith("bp-1", 7, "tab-2");
    await flushAsync();
    expect(mod.browserWorkspace.activeTabId).toBe("tab-2");
    expect(mod.browserWorkspace.tabs.find((t) => t.tabId === "tab-2").active).toBe(true);
  });

  it("reload() forwards the owned profile, CareerFlow profile and tab", async () => {
    const { ws } = installIpc();
    await mod.launch("bp-1");
    await mod.reload();
    expect(ws.reload).toHaveBeenCalledWith("bp-1", 7, "tab-1");
  });

  it("stop() forwards and closes the local workspace state", async () => {
    const { ws } = installIpc();
        await mod.launch("bp-1");
    await mod.stop();
    expect(ws.stop).toHaveBeenCalledTimes(1);
    expect(mod.browserWorkspace.status).toBe("closed");
    expect(mod.browserWorkspace.tabs).toEqual([]);
    expect(mod.browserWorkspace.activeTabId).toBeNull();
  });
});

describe("browserWorkspace.screenshot()", () => {
  it("stores the dataUrl returned by the workspace channel on success", async () => {
    const { ws } = installIpc();
        await mod.launch("bp-1");
    const res = await mod.screenshot();
    expect(ws.screenshot).toHaveBeenCalledWith("bp-1", 7, "tab-1");
    expect(res.image.dataUrl).toBe("data:image/png;base64,AAA");
    expect(mod.browserWorkspace.screenshotDataUrl).toBe("data:image/png;base64,AAA");
    expect(mod.browserWorkspace.screenshotError).toBeNull();
    expect(typeof mod.browserWorkspace.screenshotAt).toBe("number");
  });

  it("sets screenshotError when the workspace screenshot channel is missing", async () => {
    installIpc();
    await mod.launch("bp-1"); // active tab exists…
    delete window.careerflow.browserWorkspace.screenshot; // …but the channel is gone
    const res = await mod.screenshot();
    expect(res).toBeNull();
    expect(mod.browserWorkspace.screenshotError).toMatch(/not available/i);
    expect(mod.browserWorkspace.screenshotDataUrl).toBeNull();
  });

  it("sets screenshotError when the channel rejects", async () => {
    installIpc({ workspace: { screenshot: vi.fn(async () => { throw new Error("boom"); }) } });
        await mod.launch("bp-1");
    const res = await mod.screenshot();
    expect(res).toBeNull();
    expect(mod.browserWorkspace.screenshotError).toBe("boom");
  });

  it("refuses to capture when there is no active tab", async () => {
    const { ws } = installIpc({
      workspace: {
        launch: vi.fn(async () => ({
          ok: true,
          workspace: snapshot({ state: "ready", profileLocalId: "bp-1", activeTabId: null }),
        })),
        state: vi.fn(async () =>
          snapshot({ state: "ready", profileLocalId: "bp-1", activeTabId: null })
        ),
      },
    });
    await mod.launch("bp-1");
    const res = await mod.screenshot();
    expect(res).toBeNull();
    expect(mod.browserWorkspace.screenshotError).toBe("No active tab to capture.");
    expect(ws.screenshot).not.toHaveBeenCalled();
  });
});

describe("browserWorkspace event subscription", () => {
  function captureEvents(over = {}) {
    let capturedHandler = null;
    installIpc({
      workspace: {
        onEvent: vi.fn((h) => {
          capturedHandler = h;
          return () => {};
        }),
        ...over,
      },
    });
    return () => capturedHandler;
  }

  it("forwards 'navigated' into a refresh (tabs come from the snapshot, never invented)", async () => {
    const getHandler = captureEvents();
        mod.open(false);
    expect(typeof getHandler()).toBe("function");
    getHandler()({ kind: "navigated", profileLocalId: "bp-1", url: "https://next.example" });
    await flushAsync();
    expect(mod.browserWorkspace.status).toBe("ready");
    expect(mod.browserWorkspace.lastError).toBeNull();
  });

  it("surfaces '*'-failed kinds as lastError", async () => {
    const getHandler = captureEvents();
        mod.open(false);
    getHandler()({ kind: "navigate-failed", reason: "invalid-url", profileLocalId: "bp-1" });
    expect(mod.browserWorkspace.lastError).toBe("invalid-url");
  });

  it("maps 'stopped' to the closed status", async () => {
    const getHandler = captureEvents({ state: vi.fn(async () => snapshot({ state: "closed" })) });
        mod.open(false);
    getHandler()({ kind: "stopped" });
    expect(mod.browserWorkspace.status).toBe("closed");
    await flushAsync();
    expect(mod.browserWorkspace.status).toBe("closed"); // refresh agrees
  });

  it("captures 'error' kinds into lastError", async () => {
    const getHandler = captureEvents();
        mod.open(false);
    getHandler()({ kind: "error", message: "tab crashed" });
    expect(mod.browserWorkspace.lastError).toBe("tab crashed");
  });

  it("calls the unsubscribe function returned by onEvent when closing", async () => {
    const unsub = vi.fn();
    installIpc({ workspace: { onEvent: vi.fn(() => unsub) } });
        mod.open(false);
    mod.close();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  // The Research console renders this trace as "operator activity". It must be
  // a record of what really happened and never a synthesised narrative.
  describe("activity trace", () => {
    it("records real pushed events, newest first, with their detail", async () => {
      const getHandler = captureEvents();
      mod.open(false);

      getHandler()({ kind: "launched", profileLocalId: "bp-1" });
      getHandler()({ kind: "navigated", url: "https://example.edu/a" });
      await flushAsync();

      const kinds = mod.browserWorkspace.activity.map((e) => e.kind);
      expect(kinds).toEqual(["navigated", "launched"]);
      expect(mod.browserWorkspace.activity[0].detail).toBe("https://example.edu/a");
      expect(mod.browserWorkspace.activity[0].at).toBeGreaterThan(0);
    });

    it("falls back to the reason for a failed event, and carries no URL for it", async () => {
      const getHandler = captureEvents();
      mod.open(false);

      getHandler()({ kind: "navigate-failed", reason: "invalid-url" });
      await flushAsync();

      const entry = mod.browserWorkspace.activity[0];
      expect(entry.kind).toBe("navigate-failed");
      expect(entry.detail).toBe("invalid-url");
    });

    it("stays empty when the backend pushes nothing — no invented history", async () => {
      captureEvents();
      mod.open(false);
      await flushAsync();
      expect(mod.browserWorkspace.activity).toEqual([]);
    });

    it("is bounded, so a chatty session cannot grow renderer memory without limit", async () => {
      const getHandler = captureEvents();
      mod.open(false);

      for (let i = 0; i < 120; i += 1) getHandler()({ kind: "navigated", url: `https://e/${i}` });
      await flushAsync();

      const { activity } = mod.browserWorkspace;
      expect(activity.length).toBe(40);
      // Newest kept, oldest dropped.
      expect(activity[0].detail).toBe("https://e/119");
      expect(activity[39].detail).toBe("https://e/80");
    });

    it("is cleared by the test reset so scenarios stay isolated", () => {
      const getHandler = captureEvents();
      mod.open(false);
      getHandler()({ kind: "navigated" });
      expect(mod.browserWorkspace.activity).toHaveLength(1);
      mod.__resetForTests();
      expect(mod.browserWorkspace.activity).toEqual([]);
    });
  });
});
