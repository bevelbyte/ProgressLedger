import { describe, it, expect, beforeEach } from "vitest";
import * as ws from "../src/shell/workspace/store.svelte.js";
import { defaultWorkspace } from "../src/shell/workspace/contexts.js";

describe("Workspace Persistence and Restoration", () => {
  beforeEach(() => {
    localStorage.clear();
    ws.__resetWorkspace();
    ws.setWorkspaceProfileId(null);
  });

  it("serializes current workspace to a version 1 snapshot", () => {
    const snapshot = ws.serializeWorkspace(ws.workspace);
    expect(snapshot).not.toBeNull();
    expect(snapshot.version).toBe(1);
    expect(typeof snapshot.activeContextId).toBe("string");
    expect(Array.isArray(snapshot.contexts)).toBe(true);
    expect(snapshot.contexts.length).toBeGreaterThan(0);
    const system = snapshot.contexts.find((c) => c.id === snapshot.activeContextId);
    expect(system).toBeDefined();
    expect(system.panes).toBeDefined();
  });

  it("validates a well-formed snapshot and rejects corrupted structures", () => {
    const valid = ws.serializeWorkspace(ws.workspace);
    expect(ws.validateWorkspaceSnapshot(valid)).not.toBeNull();

    // Wrong version
    expect(ws.validateWorkspaceSnapshot({ ...valid, version: 2 })).toBeNull();

    // Missing contexts array
    expect(ws.validateWorkspaceSnapshot({ ...valid, contexts: null })).toBeNull();

    // Active context ID not present in contexts
    expect(ws.validateWorkspaceSnapshot({ ...valid, activeContextId: "ctx-unknown" })).toBeNull();

    // Corrupted pane structure
    const corruptedContexts = JSON.parse(JSON.stringify(valid.contexts));
    corruptedContexts[0].panes = null;
    expect(ws.validateWorkspaceSnapshot({ ...valid, contexts: corruptedContexts })).toBeNull();
  });

  it("persists workspace state and restores it faithfully", () => {
    // Navigate and modify workspace
    ws.setWorkspaceProfileId(42);
    ws.navigate("deadlines");
    expect(ws.currentView()).toBe("deadlines");

    const saved = ws.saveWorkspace(42);
    expect(saved).toBe(true);

    const key = ws.resolveStorageKey(42);
    const stored = localStorage.getItem(key);
    expect(stored).not.toBeNull();

    // Reset workspace in memory
    ws.__resetWorkspace();
    expect(ws.currentView()).toBe("profiles");

    // Restore workspace
    const restored = ws.restoreWorkspace(42);
    expect(restored).toBe(true);
    expect(ws.currentView()).toBe("deadlines");
  });

  it("isolates persisted state across different profiles", () => {
    // Setup Profile 1 workspace in Study -> deadlines
    ws.setWorkspaceProfileId(1);
    ws.navigate("deadlines");
    ws.saveWorkspace(1);

    // Setup Profile 2 workspace in Desk -> home
    ws.__resetWorkspace();
    ws.setWorkspaceProfileId(2);
    ws.navigate("home");
    ws.saveWorkspace(2);

    // Restore Profile 1
    ws.__resetWorkspace();
    expect(ws.restoreWorkspace(1)).toBe(true);
    expect(ws.currentView()).toBe("deadlines");

    // Restore Profile 2
    expect(ws.restoreWorkspace(2)).toBe(true);
    expect(ws.currentView()).toBe("home");
  });

  it("handles corrupted storage safely without breaking default state", () => {
    const key = ws.resolveStorageKey(99);
    localStorage.setItem(key, "not-valid-json{{{");

    const restored = ws.restoreWorkspace(99);
    expect(restored).toBe(false);
    expect(ws.workspace.contexts.length).toBeGreaterThan(0);
    expect(ws.currentView()).toBe("profiles");
  });

  it("clears persisted workspace on clearPersistedWorkspace", () => {
    ws.setWorkspaceProfileId(77);
    ws.navigate("notes");
    ws.saveWorkspace(77);

    const key = ws.resolveStorageKey(77);
    expect(localStorage.getItem(key)).not.toBeNull();

    ws.clearPersistedWorkspace(77);
    expect(localStorage.getItem(key)).toBeNull();
    ws.__resetWorkspace();
    expect(ws.currentView()).toBe("profiles");
  });

  it("resets in-memory workspace to defaults when restoring a profile with no saved state (preventing cross-profile leakage)", () => {
    // Setup Profile 1 with a customized view
    ws.setWorkspaceProfileId(1);
    ws.navigate("deadlines");
    expect(ws.currentView()).toBe("deadlines");
    ws.saveWorkspace(1);

    // Profile 2 has NO saved snapshot in localStorage.
    // Switching to Profile 2 must NOT leave Profile 1's workspace or tabs visible.
    ws.setWorkspaceProfileId(2);
    const restored = ws.restoreWorkspace(2);
    expect(restored).toBe(false);
    expect(ws.currentView()).toBe("profiles");

    // Switching back to Profile 1 restores its saved workspace
    ws.setWorkspaceProfileId(1);
    expect(ws.restoreWorkspace(1)).toBe(true);
    expect(ws.currentView()).toBe("deadlines");
  });

  it("resets in-memory workspace to defaults when restoring a corrupted snapshot without leaking previous state", () => {
    // Leave previous state on a specific view
    ws.setWorkspaceProfileId(1);
    ws.navigate("notes");
    expect(ws.currentView()).toBe("notes");

    // Profile 3 has corrupted JSON in storage
    const key = ws.resolveStorageKey(3);
    localStorage.setItem(key, "{ malformed-json: true");

    ws.setWorkspaceProfileId(3);
    const restored = ws.restoreWorkspace(3);
    expect(restored).toBe(false);
    // Verified: does not retain "notes" from profile 1
    expect(ws.currentView()).toBe("profiles");
  });

  it("flushes pending persistence to previous profile before switching profile ID", () => {
    ws.setWorkspaceProfileId(1);
    ws.navigate("deadlines");
    // Schedule debounced persist for profile 1
    ws.schedulePersist(1, 500);

    // Immediately switch to Profile 2 before timer expires
    ws.setWorkspaceProfileId(2);

    // Profile 1 storage should have been flushed synchronously on profile change
    const key1 = ws.resolveStorageKey(1);
    expect(localStorage.getItem(key1)).not.toBeNull();
    const raw = JSON.parse(localStorage.getItem(key1));
    expect(raw.version).toBe(1);

    // Profile 2 is clean
    const restored = ws.restoreWorkspace(2);
    expect(restored).toBe(false);
    expect(ws.currentView()).toBe("profiles");
  });
});

