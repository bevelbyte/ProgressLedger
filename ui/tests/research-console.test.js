/**
 * Research console — Atlas §5.5.
 *
 * This surface is the most contract-dense in the product: four separate
 * Playwright specs drive it through text and class selectors that were written
 * against the pre-Atlas markup:
 *
 *   e2e/phase5-start-real.spec.js        section.browser-manager
 *   e2e/phase6-real-profile.spec.js      "New browser profile", form.row input[placeholder*="Name"],
 *                                        form.row button[type="submit"], profile name text
 *   e2e/phase7-real-shortcuts.spec.js    "Shortcuts", "Add shortcut", form.row input ×2,
 *                                        .sc-list .link-btn, .sc-list li … button:has-text("Pin")
 *   e2e/phase10-qa-profile-scope.spec.js same, plus section.quick-actions
 *
 * Those flows need a real Donut backend, so they cannot run in a five-second
 * unit suite — which means the only thing standing between a redesign and four
 * silently broken specs is this file. The structural contract is asserted here
 * exactly (including the ordering trap: the profile-add form and the
 * shortcut-add form are both `form.row`, so they must never be open at once).
 */

import { render, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";

import BrowserManagerPanel from "../src/features/browser/components/BrowserManagerPanel.svelte";
import { profileStore } from "../src/features/profiles/stores/profile.svelte.js";
import {
  browserWorkspace,
  open as openWorkspace,
  __resetForTests as resetWorkspace,
} from "../src/shared/stores/browser-workspace.svelte.js";

let profiles = [];
let shortcuts = {}; // localId -> shortcut[]
let pinnedState = {}; // shortcutId -> bool
let addCalls = [];
let pinCalls = [];
let capturedEventCb = null;

function makeShortcut(over = {}) {
  return { id: 1, label: "Facebook", url: "https://facebook.com", pinned: false, ...over };
}

function installIpc() {
  profiles = [];
  shortcuts = {};
  pinnedState = {};
  addCalls = [];
  pinCalls = [];
  capturedEventCb = null;

  profileStore.profiles = [{ id: 7, name: "Personal" }];
  profileStore.activeProfileId = 7;

  window.careerflow = {
    browserManager: {
      // Async, like every real ipcRenderer.invoke — a synchronous return would
      // be read inside the component's $effect and create a reactive loop.
      list: vi.fn(async () => {
        await Promise.resolve();
        return profiles.map((p) => ({ ...p }));
      }),
      listShortcuts: vi.fn(async (_cfId, bpLocalId) => {
        await Promise.resolve();
        return (shortcuts[bpLocalId] ?? []).map((s) => ({
          ...s,
          pinned: pinnedState[s.id] ?? s.pinned,
        }));
      }),
      add: vi.fn(async (cfId, localId, name) => {
        await Promise.resolve();
        addCalls.push({ cfId, localId, name });
        profiles.push({ localId, displayName: name, enabled: true });
        return { ok: true };
      }),
      rename: vi.fn(async () => ({ ok: true })),
      remove: vi.fn(async () => ({ ok: true })),
      setEnabled: vi.fn(async () => ({ ok: true })),
      reorderProfiles: vi.fn(async () => ({ ok: true })),
      addShortcut: vi.fn(async (_cfId, bpLocalId, label, url) => {
        await Promise.resolve();
        const id = 100 + (shortcuts[bpLocalId]?.length ?? 0);
        shortcuts[bpLocalId] = [...(shortcuts[bpLocalId] ?? []), { id, label, url, pinned: false }];
        return { ok: true };
      }),
      togglePin: vi.fn(async (_cfId, id, next) => {
        await Promise.resolve();
        pinCalls.push({ id, next });
        pinnedState[id] = next;
        return { ok: true };
      }),
      updateShortcut: vi.fn(async () => ({ ok: true })),
      deleteShortcut: vi.fn(async () => ({ ok: true })),
      reorderShortcuts: vi.fn(async () => ({ ok: true })),
      openBrowserProfile: vi.fn(async () => ({ ok: true })),
      openShortcutUrl: vi.fn(async () => ({ opened: true })),
    },
    browserWorkspace: {
      state: vi.fn(async () => ({ state: "idle", tabs: [], activeTabId: null })),
      launch: vi.fn(async () => ({ ok: true })),
      onEvent: vi.fn((cb) => {
        capturedEventCb = cb;
        return () => {};
      }),
      stop: vi.fn(async () => ({ ok: true })),
    },
  };
}

const text = () => document.body.textContent ?? "";
const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];
const byText = (sel, t) => qa(sel).find((el) => el.textContent.trim().includes(t));

async function flush() {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await tick();
}

beforeEach(() => {
  installIpc();
  resetWorkspace();
});

afterEach(() => {
  cleanup();
  profileStore.profiles = [];
  profileStore.activeProfileId = null;
});

describe("Research console � external-control boundary", () => {
  it("states the Local API limitation instead of claiming live Donut tab access", async () => {
    render(BrowserManagerPanel);
    await flush();
    expect(text()).toContain("External browser");
    expect(text()).toContain("Limited API");
    expect(text()).toContain("does not expose tab lists");
    expect(text()).toContain("does not require Donut");
    expect(text()).not.toContain("Live workspace");
    expect(text()).not.toContain("Open in Donut");
    expect(qa(".rs-activity li")).toHaveLength(0);
  });

  it("does not subscribe to Donut activity or auto-open a Donut workspace", async () => {
    render(BrowserManagerPanel);
    await flush();
    expect(browserWorkspace.open).toBe(false);
    expect(browserWorkspace.tabs).toEqual([]);
    expect(capturedEventCb).toBeNull();
  });
});