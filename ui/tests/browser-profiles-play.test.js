// Browser profile manager: Play, row menu, and read-only information.
//
// The mirror/store contract (explicit profile id through createPage) is
// covered by browser-surface.test.js. These tests cover what that file
// does not: the manager's Play button, the profile context menu, and
// the information view — at the IPC/workspace boundaries, with the
// workspace store mocked (the real store is covered by
// workspace-shell.test.js and workspace-model.test.js).

import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/shell/workspace/store.svelte.js", () => {
  // The pane tab the Play flow just created: its entity tracks the
  // last page id the mocked bridge minted, so the restore-row guard
  // in the component (tab.entity === pageId) can be exercised.
  let lastPageId = null;
  const workspace = {
    activeContextId: "ctx-1",
    contexts: [{ id: "ctx-1", panes: { "pane-1": { id: "pane-1", tabs: [], activeTabId: null } } }],
  };
  return {
    workspace,
    focusedPaneId: vi.fn(() => "pane-1"),
    focusedPane: vi.fn(() => ({ id: "pane-1", tabs: [{ id: "tab-1", entity: lastPageId }], activeTabId: "tab-1" })),
    focusedActiveTabId: vi.fn(() => "tab-1"),
    openPageTab: vi.fn(),
    setTabEntity: vi.fn(),
    focusPane: vi.fn(),
    switchContext: vi.fn(),
    __setLastPageId: (id) => {
      lastPageId = id;
    },
  };
});

import BrowserProfiles from "../src/features/browser/components/BrowserProfiles.svelte";
import {
  browser,
  __resetBrowserForTests,
} from "../src/shared/stores/browser.svelte.js";
import { toastState, clearToasts } from "../src/shared/stores/toasts.svelte.js";
import * as ws from "../src/shell/workspace/store.svelte.js";

function profile(overrides = {}) {
  return {
    localId: "bp-A",
    displayName: "Work",
    color: "#e0a35c",
    icon: null,
    notes: "Day job",
    profileType: "persistent",
    isDefault: true,
    temporary: false,
    proxyMode: "socks5",
    proxyHost: "127.0.0.1",
    proxyPort: 1080,
    proxyUsername: "proxyuser",
    proxyPasswordEncrypted: "SECRET-BLOB",
    proxyPassword: "hunter2",
    proxyBypass: "<local>",
    language: "en-US",
    userAgentPreset: null,
    webrtcPolicy: "default_public_interface_only",
    permissionsAllow: '["fullscreen","clipboard-sanitized-write"]',
    gpc: false,
    dnt: true,
    blockThirdPartyCookies: false,
    clearOnClose: false,
    downloadDir: null,
    createdAt: "2026-10-20T10:00:00Z",
    lastUsedAt: null,
    ...overrides,
  };
}

const PROFILES = [
  profile(),
  profile({
    localId: "bp-B",
    displayName: "Personal",
    color: "#6ea8c9",
    isDefault: false,
    proxyMode: "none",
    proxyHost: null,
    proxyPort: null,
    proxyUsername: null,
    proxyPasswordEncrypted: null,
    proxyPassword: null,
    notes: "",
  }),
  profile({
    localId: "temp-1",
    displayName: "Temporary",
    color: "#888888",
    profileType: "temporary",
    isDefault: false,
    temporary: true,
    proxyMode: "none",
    proxyHost: null,
    proxyPort: null,
    proxyUsername: null,
    proxyPasswordEncrypted: null,
    proxyPassword: null,
    notes: "",
  }),
];

function makeBridge(overrides = {}) {
  const bridge = {
    listProfiles: vi.fn(async () => ({ ok: true, profiles: PROFILES })),
    createPage: vi.fn(async (options) => {
      ws.__setLastPageId(`bp-page-${options?.browserProfileId}`);
      return {
        ok: true,
        page: { id: `bp-page-${options?.browserProfileId}`, title: "" },
        browserTabId: 42,
      };
    }),
    createProfile: vi.fn(async () => ({ ok: true, profile: profile({ localId: "bp-side", displayName: "Side" }) })),
    updateProfile: vi.fn(async () => ({ ok: true, profile: profile() })),
    deleteProfile: vi.fn(async () => ({ ok: true, deletedLedger: 0 })),
    duplicateProfile: vi.fn(async () => ({ ok: true, profile: profile({ localId: "bp-copy", displayName: "Work copy" }) })),
    clearProfileData: vi.fn(async () => ({ ok: true })),
    ledgerCountForProfile: vi.fn(async () => ({ ok: true, count: 2 })),
    getLiveCap: vi.fn(async () => ({ ok: true, cap: 5 })),
    setLiveCap: vi.fn(async () => ({ ok: true, cap: 5 })),
    closePage: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
  window.progressLedger = { ...(window.progressLedger ?? {}), browser: bridge };
  return bridge;
}

async function renderManager(bridgeOverrides = {}) {
  const bridge = makeBridge(bridgeOverrides);
  render(BrowserProfiles, { props: { profileId: 1, onBrowserOverlayChange: vi.fn() } });
  await screen.findByTestId("browser-profile-row-bp-A");
  return bridge;
}

beforeEach(() => {
  __resetBrowserForTests();
  clearToasts();
  try {
    localStorage.clear();
  } catch {}
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.progressLedger;
});

describe("Play button", () => {
  it("exists on every row with an accessible Open name", async () => {
    await renderManager();
    expect(screen.getByTestId("browser-profile-play-bp-A")).toHaveAttribute("aria-label", "Open Work");
    expect(screen.getByTestId("browser-profile-play-bp-B")).toHaveAttribute("aria-label", "Open Personal");
    expect(screen.getByTestId("browser-profile-play-temp-1")).toHaveAttribute("aria-label", "Open Temporary");
  });

  it("sends the clicked row's explicit profile id, not the current profile", async () => {
    const bridge = await renderManager();
    // Make Work the current profile, then Play Personal.
    await fireEvent.click(screen.getByTestId("browser-profile-menu-bp-A"));
    await fireEvent.click(screen.getByTestId("browser-profile-use-bp-A"));
    expect(browser.currentProfileId).toBe("bp-A");
    await fireEvent.click(screen.getByTestId("browser-profile-play-bp-B"));
    await waitFor(() => expect(bridge.createPage).toHaveBeenCalledTimes(1));
    expect(bridge.createPage).toHaveBeenCalledWith({ profileId: 1, url: "about:blank", browserProfileId: "bp-B" });
    await waitFor(() => expect(ws.openPageTab).toHaveBeenCalledWith("pane-1", "Web page", "bp-page-bp-B", { activate: true }));
    await waitFor(() => expect(ws.setTabEntity).toHaveBeenCalledWith("pane-1", "tab-1", "bp-page-bp-B", 42));
  });

  it("a failed create opens no tab and reports honestly", async () => {
    const bridge = await renderManager({
      createPage: vi.fn(async () => ({ ok: false, reason: "unknown-browser-profile" })),
    });
    await fireEvent.click(screen.getByTestId("browser-profile-play-bp-B"));
    await screen.findByTestId("browser-profiles-notice");
    expect(screen.getByTestId("browser-profiles-notice")).toHaveTextContent("unknown-browser-profile");
    expect(ws.openPageTab).not.toHaveBeenCalled();
    expect(bridge.closePage).not.toHaveBeenCalled();
  });

  it("a busy Play ignores repeated clicks until it finishes", async () => {
    let resolveCreate;
    const bridge = await renderManager({
      createPage: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveCreate = () =>
              resolve({ ok: true, page: { id: "bp-page-bp-A", title: "" }, browserTabId: 42 });
          }),
      ),
    });
    const button = screen.getByTestId("browser-profile-play-bp-A");
    await fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Opening");
    await fireEvent.click(button);
    expect(bridge.createPage).toHaveBeenCalledTimes(1);
    resolveCreate();
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(ws.openPageTab).toHaveBeenCalledTimes(1);
  });

  it("different rows keep targeting their own profiles", async () => {
    const bridge = await renderManager();
    await fireEvent.click(screen.getByTestId("browser-profile-play-bp-A"));
    await waitFor(() => expect(bridge.createPage).toHaveBeenCalledTimes(1));
    await fireEvent.click(screen.getByTestId("browser-profile-play-bp-B"));
    await waitFor(() => expect(bridge.createPage).toHaveBeenCalledTimes(2));
    expect(bridge.createPage).toHaveBeenNthCalledWith(1, { profileId: 1, url: "about:blank", browserProfileId: "bp-A" });
    expect(bridge.createPage).toHaveBeenNthCalledWith(2, { profileId: 1, url: "about:blank", browserProfileId: "bp-B" });
  });
});

describe("row menu", () => {
  it("opens on the row button and on right-click, and targets the clicked row", async () => {
    await renderManager();
    await fireEvent.click(screen.getByTestId("browser-profile-menu-bp-B"));
    expect(screen.getByTestId("browser-profile-menu")).toBeInTheDocument();
    await fireEvent.click(screen.getByTestId("browser-profile-use-bp-B"));
    expect(browser.currentProfileId).toBe("bp-B");
    expect(screen.queryByTestId("browser-profile-menu")).not.toBeInTheDocument();

    await fireEvent.contextMenu(screen.getByTestId("browser-profile-row-bp-A"), { clientX: 100, clientY: 100 });
    expect(screen.getByTestId("browser-profile-menu")).toBeInTheDocument();
    await fireEvent.click(screen.getByTestId("browser-profile-use-bp-A"));
    expect(browser.currentProfileId).toBe("bp-A");
  });

  it("Escape closes the menu and returns focus to the trigger", async () => {
    await renderManager();
    const trigger = screen.getByTestId("browser-profile-menu-bp-A");
    await fireEvent.click(trigger);
    const item = screen.getByTestId("browser-profile-open-bp-A");
    await waitFor(() => expect(item).toHaveFocus());
    await fireEvent.keyDown(item, { key: "Escape" });
    expect(screen.queryByTestId("browser-profile-menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("temporary rows offer only information and set-as-current", async () => {
    await renderManager();
    await fireEvent.click(screen.getByTestId("browser-profile-menu-temp-1"));
    expect(screen.getByTestId("browser-profile-info-temp-1")).toBeInTheDocument();
    expect(screen.getByTestId("browser-profile-use-temp-1")).toBeInTheDocument();
    expect(screen.queryByTestId("browser-profile-edit-temp-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("browser-profile-duplicate-temp-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("browser-profile-clear-temp-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("browser-profile-delete-temp-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("browser-profile-open-temp-1")).toBeInTheDocument();
    expect(screen.getByTestId("browser-profile-copy-id-temp-1")).toBeInTheDocument();
    expect(screen.queryByTestId("browser-profile-rename-temp-1")).not.toBeInTheDocument();
  });

  it("edit opens the existing editor for that profile", async () => {
    await renderManager();
    await fireEvent.click(screen.getByTestId("browser-profile-menu-bp-B"));
    await fireEvent.click(screen.getByTestId("browser-profile-edit-bp-B"));
    expect(screen.getByTestId("browser-profile-name")).toHaveValue("Personal");
  });

  it("duplicate uses the existing workflow and toasts on success", async () => {
    const bridge = await renderManager();
    await fireEvent.click(screen.getByTestId("browser-profile-menu-bp-B"));
    await fireEvent.click(screen.getByTestId("browser-profile-duplicate-bp-B"));
    await waitFor(() => expect(bridge.duplicateProfile).toHaveBeenCalledWith(1, "bp-B"));
    await waitFor(() => expect(toastState.items.some((t) => /duplicated/.test(t.message))).toBe(true));
  });

  it("clear requires confirmation and cancel does nothing", async () => {
    const bridge = await renderManager();
    await fireEvent.click(screen.getByTestId("browser-profile-menu-bp-B"));
    await fireEvent.click(screen.getByTestId("browser-profile-clear-bp-B"));
    expect(screen.getByTestId("browser-profile-clear-confirm")).toBeInTheDocument();
    await fireEvent.click(screen.getByText("Cancel"));
    expect(bridge.clearProfileData).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByTestId("browser-profile-menu-bp-B"));
    await fireEvent.click(screen.getByTestId("browser-profile-clear-bp-B"));
    await fireEvent.click(screen.getByTestId("browser-profile-clear-confirm"));
    await waitFor(() => expect(bridge.clearProfileData).toHaveBeenCalledWith(1, "bp-B"));
  });

  it("delete requires confirmation and passes the ledger choice", async () => {
    const bridge = await renderManager();
    await fireEvent.click(screen.getByTestId("browser-profile-menu-bp-B"));
    await fireEvent.click(screen.getByTestId("browser-profile-delete-bp-B"));
    expect(screen.getByTestId("browser-profile-delete-confirm")).toBeInTheDocument();
    expect(screen.getByText(/Delete “Personal”\?/)).toBeInTheDocument();
    await fireEvent.click(screen.getByTestId("browser-profile-delete-ledger"));
    await fireEvent.click(screen.getByTestId("browser-profile-delete-confirm"));
    await waitFor(() => expect(bridge.deleteProfile).toHaveBeenCalledWith(1, "bp-B", true));
    await waitFor(() => expect(toastState.items.some((t) => /deleted/.test(t.message))).toBe(true));
  });
});

describe("profile information view", () => {
  it("is read-only, shows safe fields, and never shows secrets", async () => {
    const bridge = await renderManager();
    await fireEvent.click(screen.getByTestId("browser-profile-menu-bp-A"));
    await fireEvent.click(screen.getByTestId("browser-profile-info-bp-A"));
    const info = screen.getByTestId("browser-profile-info");
    expect(info).toHaveTextContent("Work");
    expect(info).toHaveTextContent("SOCKS5 127.0.0.1:1080");
    expect(info).toHaveTextContent("Day job");
    expect(document.body.textContent).not.toContain("hunter2");
    expect(document.body.textContent).not.toContain("SECRET-BLOB");
    expect(bridge.updateProfile).not.toHaveBeenCalled();
    expect(bridge.createProfile).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByTestId("browser-profile-info-close"));
    expect(screen.queryByTestId("browser-profile-info")).not.toBeInTheDocument();
  });
});

describe("new-profile flow", () => {
  it("stays in the manager with a toast instead of a bare tab or a current-profile switch", async () => {
    const bridge = await renderManager();
    await fireEvent.click(screen.getByTestId("browser-profiles-new"));
    await fireEvent.input(screen.getByTestId("browser-profile-name"), { target: { value: "Side" } });
    await fireEvent.click(screen.getByText("Create profile"));
    await waitFor(() => expect(bridge.createProfile).toHaveBeenCalled());
    await waitFor(() => expect(toastState.items.some((t) => /created\. Press Play/.test(t.message))).toBe(true));
    expect(ws.openPageTab).not.toHaveBeenCalled();
    expect(bridge.createPage).not.toHaveBeenCalled();
    expect(browser.currentProfileId).not.toBe("bp-side");
  });
});

describe("search and sort", () => {
  it("filters rows by name", async () => {
    await renderManager();
    await fireEvent.input(screen.getByTestId("browser-profile-search"), { target: { value: "pers" } });
    expect(screen.queryByTestId("browser-profile-row-bp-A")).not.toBeInTheDocument();
    expect(screen.getByTestId("browser-profile-row-bp-B")).toBeInTheDocument();
    await fireEvent.input(screen.getByTestId("browser-profile-search"), { target: { value: "" } });
    expect(screen.getByTestId("browser-profile-row-bp-A")).toBeInTheDocument();
  });

  it("sorts by name A-Z then Z-A", async () => {
    await renderManager();
    await fireEvent.click(screen.getByTestId("browser-profile-sort"));
    const rowsAZ = [...document.querySelectorAll('[data-testid^="browser-profile-row-"]')].map((r) =>
      r.getAttribute("data-testid"),
    );
    expect(rowsAZ).toEqual(["browser-profile-row-bp-B", "browser-profile-row-temp-1", "browser-profile-row-bp-A"]);
    await fireEvent.click(screen.getByTestId("browser-profile-sort"));
    const rowsZA = [...document.querySelectorAll('[data-testid^="browser-profile-row-"]')].map((r) =>
      r.getAttribute("data-testid"),
    );
    expect(rowsZA).toEqual(["browser-profile-row-bp-A", "browser-profile-row-temp-1", "browser-profile-row-bp-B"]);
  });
});

describe("manager menu additions", () => {
  it("uses the CareerFlow-style labels: Open, Open details, Set as current, Rename, Copy ID", async () => {
    await renderManager();
    await fireEvent.click(screen.getByTestId("browser-profile-menu-bp-A"));
    expect(screen.getByTestId("browser-profile-open-bp-A").textContent.trim()).toBe("Open");
    expect(screen.getByTestId("browser-profile-info-bp-A")).toHaveTextContent("Open details");
    expect(screen.getByTestId("browser-profile-use-bp-A")).toHaveTextContent("Set as current");
    expect(screen.getByTestId("browser-profile-rename-bp-A")).toHaveTextContent("Rename (F2)");
    expect(screen.getByTestId("browser-profile-copy-id-bp-A")).toHaveTextContent("Copy ID");
    expect(screen.queryByText("Use for new tabs")).not.toBeInTheDocument();
  });

  it("Copy ID writes the local id and toasts", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await renderManager();
    await fireEvent.click(screen.getByTestId("browser-profile-menu-bp-A"));
    await fireEvent.click(screen.getByTestId("browser-profile-copy-id-bp-A"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("bp-A"));
    await waitFor(() => expect(toastState.items.some((t) => /Profile ID copied/.test(t.message))).toBe(true));
  });

  it("F2 on a focused row opens rename with the name focused", async () => {
    await renderManager();
    const row = screen.getByTestId("browser-profile-row-bp-B");
    await fireEvent.keyDown(row, { key: "F2" });
    const name = screen.getByTestId("browser-profile-name");
    expect(name).toHaveValue("Personal");
    await waitFor(() => expect(name).toHaveFocus());
  });

  it("double-click opens the profile", async () => {
    const bridge = await renderManager();
    await fireEvent.dblClick(screen.getByTestId("browser-profile-row-bp-B"));
    await waitFor(() =>
      expect(bridge.createPage).toHaveBeenCalledWith({ profileId: 1, url: "about:blank", browserProfileId: "bp-B" }),
    );
  });

  it("Play opens each start page, first focused, rest background", async () => {
    const starty = profile({
      localId: "bp-S",
      displayName: "Starty",
      startPages: "https://a.example\nhttps://b.example",
    });
    const bridge = await renderManager({
      listProfiles: vi.fn(async () => ({ ok: true, profiles: [starty] })),
    });
    await fireEvent.click(screen.getByTestId("browser-profile-play-bp-S"));
    await waitFor(() => expect(bridge.createPage).toHaveBeenCalledTimes(2));
    expect(bridge.createPage).toHaveBeenNthCalledWith(1, {
      profileId: 1,
      url: "https://a.example",
      browserProfileId: "bp-S",
    });
    expect(bridge.createPage).toHaveBeenNthCalledWith(2, {
      profileId: 1,
      url: "https://b.example",
      browserProfileId: "bp-S",
    });
    await waitFor(() => expect(ws.openPageTab).toHaveBeenCalledWith("pane-1", "Web page", "bp-page-bp-S", { activate: true }));
    await waitFor(() => expect(ws.openPageTab).toHaveBeenCalledWith("pane-1", "Web page", "bp-page-bp-S", { activate: false }));
  });
});

describe("profile details panel", () => {
  it("shows Overview with ID, data size, and the three tabs", async () => {
    await renderManager({
      partitionSize: vi.fn(async () => ({ ok: true, bytes: 2048, files: 3, complete: true })),
    });
    await fireEvent.click(screen.getByTestId("browser-profile-details-bp-A"));
    const info = screen.getByTestId("browser-profile-info");
    expect(info).toHaveTextContent("bp-A");
    await waitFor(() => expect(screen.getByTestId("browser-profile-info-size")).toHaveTextContent("2.0 KB"));
    expect(screen.getByTestId("browser-profile-tab-network")).toBeInTheDocument();
    expect(screen.getByTestId("browser-profile-tab-start-pages")).toBeInTheDocument();
    await fireEvent.click(screen.getByTestId("browser-profile-tab-start-pages"));
    expect(info).toHaveTextContent("No start pages set");
    await fireEvent.click(screen.getByTestId("browser-profile-tab-network"));
    expect(info).toHaveTextContent("SOCKS5 127.0.0.1:1080");
  });

  it("dialog rejects a bad start page and does not save", async () => {
    const bridge = await renderManager();
    await fireEvent.click(screen.getByTestId("browser-profile-menu-bp-B"));
    await fireEvent.click(screen.getByTestId("browser-profile-edit-bp-B"));
    await fireEvent.input(screen.getByTestId("browser-profile-start-pages"), { target: { value: "not a url" } });
    await fireEvent.click(screen.getByText("Save changes"));
    expect(screen.getByTestId("browser-profile-error")).toHaveTextContent("Start pages must be http(s) URLs");
    expect(bridge.updateProfile).not.toHaveBeenCalled();
  });
});
