// Supported credential-store IPC contract (renderer -> preload).
//
// DEFECT CLOSED HERE: projectModeService.setProviderConfig spread the whole
// payload into the FIRST argument —
//     call("setProviderConfig", { profileId, projectId, ...config })
// — while the preload binding is POSITIONAL:
//     setProviderConfig: (profileId, projectId, config) => …
// The preload therefore received { profileId: {…}, projectId: undefined,
// config: undefined } and forwarded { profileId: {…}, projectId: undefined,
// endpoint: undefined, … } to project:set-provider-config. The main-process
// project-ownership check rejected every save, so the SUPPORTED
// credential-store write path was dead and the agent silently fell back to
// the mock provider. This is the same argument-contract bug class as the
// GATE J startAgent mismatch.
//
// These tests lock the positional forwarding for the credential + provider
// methods so the class cannot silently return.

import { describe, it, expect, afterEach, vi } from "vitest";

import { projectModeService } from "../src/features/project-mode/services/projectMode.service.js";

function bindIpc() {
  const ns = {
    getProviderConfig: vi.fn().mockResolvedValue({ ok: true }),
    setProviderConfig: vi.fn().mockResolvedValue({ ok: true }),
    clearProviderConfig: vi.fn().mockResolvedValue({ ok: true }),
    getDefaultProvider: vi.fn().mockResolvedValue({ ok: true }),
    setDefaultProvider: vi.fn().mockResolvedValue({ ok: true }),
  };
  window.progressLedger = { projectMode: ns };
  return ns;
}

afterEach(() => {
  window.progressLedger = undefined;
  vi.restoreAllMocks();
});

const CONFIG = { endpoint: "https://api.example.com", apiKey: "sk-fixture-not-a-secret", model: "gpt-test" };

describe("credential-store IPC contract — setProviderConfig", () => {
  it("forwards (profileId, projectId, config) positionally to the preload binding", async () => {
    const ns = bindIpc();

    await projectModeService.setProviderConfig(4, 9, CONFIG);

    expect(ns.setProviderConfig).toHaveBeenCalledTimes(1);
    expect(ns.setProviderConfig).toHaveBeenCalledWith(4, 9, CONFIG);
    const [a, b, c] = ns.setProviderConfig.mock.calls[0];
    expect(a).toBe(4);
    expect(b).toBe(9);
    expect(c).toBe(CONFIG);
  });

  it("regression guard: the payload is never collapsed into a single object argument", async () => {
    const ns = bindIpc();

    await projectModeService.setProviderConfig(4, 9, CONFIG);

    // The exact shape that broke ownership: { profileId: {…}, agentId/projectId: undefined }.
    expect(ns.setProviderConfig).not.toHaveBeenCalledWith({ profileId: 4, projectId: 9, ...CONFIG });
    expect(typeof ns.setProviderConfig.mock.calls[0][0]).toBe("number");
    expect(typeof ns.setProviderConfig.mock.calls[0][1]).toBe("number");
  });
});

describe("credential-store IPC contract — read / clear / default provider", () => {
  it("keeps every other provider binding positional", async () => {
    const ns = bindIpc();

    await projectModeService.getProviderConfig(1, 2);
    await projectModeService.clearProviderConfig(1, 2);
    await projectModeService.getDefaultProvider(1, 2);
    await projectModeService.setDefaultProvider(1, 2, "openai-compatible");

    expect(ns.getProviderConfig).toHaveBeenCalledWith(1, 2);
    expect(ns.clearProviderConfig).toHaveBeenCalledWith(1, 2);
    expect(ns.getDefaultProvider).toHaveBeenCalledWith(1, 2);
    expect(ns.setDefaultProvider).toHaveBeenCalledWith(1, 2, "openai-compatible");
  });
});
