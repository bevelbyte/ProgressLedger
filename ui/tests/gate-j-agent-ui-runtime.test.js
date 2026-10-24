// GATE J — Agent UI runtime contract locks.
//
// The GATE J E2E (e2e/agent-ui-runtime.spec.js) proves the full real-Electron
// chain: UI start -> approval card -> renderer reload -> profile restoration
// -> correct agent restoration -> approval rehydration -> UI approve click ->
// tool execution -> conversation update -> completion.
//
// This unit suite locks the two renderer-side defects that previously made that
// chain unreachable, at the cheapest level, so they cannot silently return
// between expensive E2E runs:
//
//   1. startAgent argument contract — the store calls
//      projectModeService.startAgent({ profileId, agentId }) while the preload
//      binding is POSITIONAL: startAgent(profileId, agentId). Forwarding the
//      object verbatim sent { profileId: {…}, agentId: undefined } over IPC, so
//      the main-process ownership check rejected every UI-driven start.
//
//   2. Active-profile restoration — the active profile is persisted to
//      localStorage and validated against the freshly loaded list on the next
//      load. Without it, a renderer reload dropped the working context and
//      disabled all profile-gated navigation until the user re-picked a profile.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the profile IPC service so the store's load path is deterministic.
vi.mock("../src/features/profiles/services/profile.service.js", () => ({
  profileService: { list: vi.fn() },
}));

import { projectModeService } from "../src/features/project-mode/services/projectMode.service.js";
import { profileService } from "../src/features/profiles/services/profile.service.js";
import { profileStore, loadProfiles, selectProfile } from "../src/features/profiles/stores/profile.svelte.js";

const LAST_PROFILE_KEY = "careerflow_last_active_profile_id";

afterEach(() => {
  window.careerflow = undefined;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. startAgent argument contract
// ---------------------------------------------------------------------------

describe("GATE J — projectModeService.startAgent forwards positional args", () => {
  it("converts the { profileId, agentId } object form into (profileId, agentId)", async () => {
    const startAgent = vi.fn().mockResolvedValue({ ok: true, runId: "run-1" });
    window.careerflow = { projectMode: { startAgent } };

    const res = await projectModeService.startAgent({ profileId: 3, agentId: 7 });

    expect(res).toEqual({ ok: true, runId: "run-1" });
    expect(startAgent).toHaveBeenCalledTimes(1);
    // The binding receives two positional numbers — never the wrapper object.
    expect(startAgent).toHaveBeenCalledWith(3, 7);
    const [firstArg, secondArg] = startAgent.mock.calls[0];
    expect(typeof firstArg).toBe("number");
    expect(typeof secondArg).toBe("number");
  });

  it("regression guard: the object is never forwarded verbatim", async () => {
    // If this assertion fails, a UI-driven start will be rejected by the
    // main-process ownership check (profileId would arrive as an object).
    const startAgent = vi.fn().mockResolvedValue({ ok: true });
    window.careerflow = { projectMode: { startAgent } };

    await projectModeService.startAgent({ profileId: 11, agentId: 22 });

    expect(startAgent).not.toHaveBeenCalledWith({ profileId: 11, agentId: 22 });
    expect(startAgent.mock.calls[0]).toHaveLength(2);
  });

  it("surfaces a missing binding as a rejection instead of throwing synchronously", async () => {
    window.careerflow = { projectMode: {} };
    await expect(projectModeService.startAgent({ profileId: 1, agentId: 1 })).rejects.toThrow(
      /projectMode\.startAgent is not available/,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Active-profile restoration across a renderer reload
// ---------------------------------------------------------------------------

describe("GATE J — active profile survives a renderer reload", () => {
  beforeEach(() => {
    profileStore.profiles = [];
    profileStore.activeProfileId = null;
    try {
      localStorage.clear();
    } catch (_) {
      // jsdom always provides localStorage; guard for parity with the store.
    }
    profileService.list.mockReset();
  });

  it("restores the persisted active profile on load (validated against the fresh list)", async () => {
    profileService.list.mockResolvedValue([{ id: 1, name: "A" }, { id: 2, name: "B" }]);
    localStorage.setItem(LAST_PROFILE_KEY, "2");

    await loadProfiles();

    expect(profileStore.activeProfileId).toBe(2);
    expect(profileStore.activeProfile && profileStore.activeProfile.id).toBe(2);
  });

  it("ignores a persisted id that no longer exists (never invents a profile)", async () => {
    profileService.list.mockResolvedValue([{ id: 1, name: "A" }]);
    localStorage.setItem(LAST_PROFILE_KEY, "99");

    await loadProfiles();

    expect(profileStore.activeProfileId).toBeNull();
  });

  it("does not clobber an already-active profile on a subsequent load", async () => {
    profileService.list.mockResolvedValue([{ id: 1, name: "A" }, { id: 2, name: "B" }]);
    localStorage.setItem(LAST_PROFILE_KEY, "2");
    profileStore.activeProfileId = 1;

    await loadProfiles();

    expect(profileStore.activeProfileId).toBe(1);
  });

  it("persists the selection so the next load restores it", () => {
    profileStore.profiles = [{ id: 1 }, { id: 2 }];

    selectProfile(2);

    expect(localStorage.getItem(LAST_PROFILE_KEY)).toBe("2");
    expect(profileStore.activeProfileId).toBe(2);
  });
});
