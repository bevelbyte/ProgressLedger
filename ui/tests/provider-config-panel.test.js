// ProviderConfigPanel — UI tests (D-1 regression lock).
//
// Defect D-1: the credentials store produces a sanitized
// `{ code: "credential-store-malformed", reason }` diagnostic when
// `pm-secrets.json` exists but cannot be parsed. `project:get-provider-config`
// returns it inside `config.diagnostic`, but the panel discarded it — so a user
// with a corrupt store saw an empty panel with no explanation and no hint that
// re-entering the config repairs it.
//
// Coverage:
//   - a malformed store surfaces the sanitized warning (classification only)
//   - a healthy store shows no warning and the "key set" badge
//   - "nothing stored" (null config) shows no warning
//   - a successful save clears the warning and forwards POSITIONALLY
//   - the renderer never holds/echoes the stored API key
//
// The IPC namespace is mocked on window.careerflow.projectMode, mirroring the
// shape shipped by shell/src/preload.cjs + shell/src/ipc/project-mode.js.

import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import ProviderConfigPanel from "../src/features/project-mode/components/ProviderConfigPanel.svelte";
import { projectModeStore } from "../src/features/project-mode/stores/projectMode.svelte.js";

const MALFORMED = {
  ok: true,
  config: {
    endpoint: null,
    model: null,
    hasKey: false,
    updatedAt: null,
    diagnostic: { code: "credential-store-malformed", reason: "unparseable-json" },
  },
};

const HEALTHY = {
  ok: true,
  config: { endpoint: "https://example.invalid/v1", model: "example-model", hasKey: true, updatedAt: 1 },
};

function setupIpc({ getImpl, setImpl, clearImpl } = {}) {
  const getProviderConfig = getImpl || vi.fn().mockResolvedValue(HEALTHY);
  const setProviderConfig =
    setImpl || vi.fn().mockResolvedValue({ ok: true, config: { endpoint: "https://example.invalid/v1", model: "example-model", hasKey: true } });
  const clearProviderConfig = clearImpl || vi.fn().mockResolvedValue({ ok: true });

  window.careerflow = { projectMode: { getProviderConfig, setProviderConfig, clearProviderConfig } };

  // Simulate an active project so the $effect fires.
  projectModeStore.activeProjectId = 7;

  return { getProviderConfig, setProviderConfig, clearProviderConfig };
}

beforeEach(() => {
  projectModeStore.activeProjectId = null;
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.careerflow = undefined;
  projectModeStore.activeProjectId = null;
});

describe("ProviderConfigPanel store diagnostic (D-1)", () => {
  it("surfaces the sanitized diagnostic when the credential store is malformed", async () => {
    setupIpc({ getImpl: vi.fn().mockResolvedValue(MALFORMED) });
    render(ProviderConfigPanel, { props: { profileId: 1 } });
    await vi.advanceTimersByTimeAsync(0);

    const warning = screen.getByTestId("provider-store-diagnostic");
    expect(warning).toBeInTheDocument();
    expect(warning).toHaveTextContent("could not be read");
    // Classification only — never store content or field values.
    expect(screen.getByTestId("provider-store-diagnostic-code")).toHaveTextContent(
      "credential-store-malformed"
    );
    // It must tell the user the (supported) action that repairs the store.
    expect(warning).toHaveTextContent("Save");
    // No key exists, so no "key set" badge.
    expect(screen.queryByTestId("provider-key-set")).not.toBeInTheDocument();
  });

  it("shows no warning for a healthy store and reports the key is set", async () => {
    setupIpc({ getImpl: vi.fn().mockResolvedValue(HEALTHY) });
    render(ProviderConfigPanel, { props: { profileId: 1 } });
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.queryByTestId("provider-store-diagnostic")).not.toBeInTheDocument();
    expect(screen.getByTestId("provider-key-set")).toBeInTheDocument();
  });

  it("shows no warning when nothing is stored at all (null config)", async () => {
    setupIpc({ getImpl: vi.fn().mockResolvedValue({ ok: true, config: null }) });
    render(ProviderConfigPanel, { props: { profileId: 1 } });
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.queryByTestId("provider-store-diagnostic")).not.toBeInTheDocument();
  });

  it("clears the warning after a successful save and forwards positionally", async () => {
    const setProviderConfig = vi.fn().mockResolvedValue({
      ok: true,
      config: { endpoint: "https://example.invalid/v1", model: "example-model", hasKey: true },
    });
    setupIpc({ getImpl: vi.fn().mockResolvedValue(MALFORMED), setImpl: setProviderConfig });

    render(ProviderConfigPanel, { props: { profileId: 1 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId("provider-store-diagnostic")).toBeInTheDocument();

    await fireEvent.input(screen.getByTestId("provider-endpoint"), {
      target: { value: "https://example.invalid/v1" },
    });
    await fireEvent.input(screen.getByTestId("provider-model"), {
      target: { value: "example-model" },
    });
    await fireEvent.input(screen.getByTestId("provider-key"), {
      target: { value: "test-key-not-a-real-secret" },
    });
    await fireEvent.click(screen.getByTestId("provider-save"));
    await vi.advanceTimersByTimeAsync(0);

    // Positional contract: (profileId, projectId, payload) — the F-1 defect
    // sent a single merged object as the first argument.
    expect(setProviderConfig).toHaveBeenCalledTimes(1);
    const args = setProviderConfig.mock.calls[0];
    expect(args[0]).toBe(1);
    expect(args[1]).toBe(7);
    expect(args[2]).toMatchObject({ endpoint: "https://example.invalid/v1", model: "example-model" });

    await waitFor(() =>
      expect(screen.queryByTestId("provider-store-diagnostic")).not.toBeInTheDocument()
    );
    expect(screen.getByTestId("provider-key-set")).toBeInTheDocument();
  });

  it("never keeps or echoes the typed API key in the DOM after save", async () => {
    setupIpc({ getImpl: vi.fn().mockResolvedValue(MALFORMED) });
    render(ProviderConfigPanel, { props: { profileId: 1 } });
    await vi.advanceTimersByTimeAsync(0);

    await fireEvent.input(screen.getByTestId("provider-endpoint"), {
      target: { value: "https://example.invalid/v1" },
    });
    await fireEvent.input(screen.getByTestId("provider-model"), {
      target: { value: "example-model" },
    });
    await fireEvent.input(screen.getByTestId("provider-key"), {
      target: { value: "test-key-not-a-real-secret" },
    });
    await fireEvent.click(screen.getByTestId("provider-save"));
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByTestId("provider-key")).toHaveValue("");
    expect(document.body.innerHTML).not.toContain("test-key-not-a-real-secret");
  });
});
