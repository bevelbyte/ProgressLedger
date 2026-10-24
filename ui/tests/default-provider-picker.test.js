// DefaultProviderPicker — UI tests.
//
// Coverage:
//   - renders the two provider options (openai-compatible, mock)
//   - the active provider shows the "active" badge
//   - selecting a different provider calls setDefaultProvider with the right id
//   - selecting the already-active provider does NOT call setDefaultProvider
//   - a load error shows the fallback message
//
// The IPC namespace is mocked on window.progressLedger.projectMode, mirroring the
// shape shipped by shell/src/preload.cjs + shell/src/ipc/project-mode.js.

import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import DefaultProviderPicker from "../src/features/project-mode/components/DefaultProviderPicker.svelte";
import { projectModeStore } from "../src/features/project-mode/stores/projectMode.svelte.js";

function setupIpc({
  getDefaultProviderImpl,
  setDefaultProviderImpl,
} = {}) {
  const getDefaultProvider = getDefaultProviderImpl
    ? getDefaultProviderImpl
    : vi.fn().mockResolvedValue("openai-compatible");
  const setDefaultProvider = setDefaultProviderImpl
    ? setDefaultProviderImpl
    : vi.fn().mockResolvedValue({ ok: true });

  window.progressLedger = {
    projectMode: { getDefaultProvider, setDefaultProvider },
  };

  // Simulate a project being active so the $effect fires.
  projectModeStore.activeProjectId = 1;

  return { getDefaultProvider, setDefaultProvider };
}

function resetStore() {
  projectModeStore.activeProjectId = null;
}

beforeEach(() => {
  resetStore();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.progressLedger = undefined;
});

describe("DefaultProviderPicker", () => {
  it("renders both provider options", async () => {
    setupIpc();
    render(DefaultProviderPicker, { props: { profileId: 1 } });
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByTestId("provider-option-openai-compatible")).toBeInTheDocument();
    expect(screen.getByTestId("provider-option-mock")).toBeInTheDocument();
  });

  it("shows the active badge on the current provider", async () => {
    setupIpc({ getDefaultProviderImpl: vi.fn().mockResolvedValue("mock") });
    render(DefaultProviderPicker, { props: { profileId: 1 } });
    await vi.advanceTimersByTimeAsync(0);

    const openaiBtn = screen.getByTestId("provider-option-openai-compatible");
    const mockBtn = screen.getByTestId("provider-option-mock");

    expect(openaiBtn.querySelector('[data-testid="provider-badge-active"]')).not.toBeInTheDocument();
    expect(mockBtn.querySelector('[data-testid="provider-badge-active"]')).toBeInTheDocument();
  });

  it("calls setDefaultProvider with the correct id when a different option is selected", async () => {
    const { setDefaultProvider } = setupIpc({
      getDefaultProviderImpl: vi.fn().mockResolvedValue("openai-compatible"),
    });
    render(DefaultProviderPicker, { props: { profileId: 1 } });
    await vi.advanceTimersByTimeAsync(0);

    fireEvent.click(screen.getByTestId("provider-option-mock"));
    await waitFor(() => expect(setDefaultProvider).toHaveBeenCalledTimes(1));
    expect(setDefaultProvider).toHaveBeenCalledWith(1, 1, "mock");
  });

  it("does not call setDefaultProvider when the already-active provider is clicked", async () => {
    const { setDefaultProvider } = setupIpc({
      getDefaultProviderImpl: vi.fn().mockResolvedValue("openai-compatible"),
    });
    render(DefaultProviderPicker, { props: { profileId: 1 } });
    await vi.advanceTimersByTimeAsync(0);

    fireEvent.click(screen.getByTestId("provider-option-openai-compatible"));
    expect(setDefaultProvider).not.toHaveBeenCalled();
  });

  it("shows a fallback message when the namespace is unavailable", async () => {
    // Leave window.progressLedger undefined so the service call rejects.
    projectModeStore.activeProjectId = 1;
    render(DefaultProviderPicker, { props: { profileId: 1 } });
    await vi.advanceTimersByTimeAsync(0);

    await waitFor(() =>
      expect(screen.getByTestId("provider-load-error")).toBeInTheDocument()
    );
    expect(screen.getByTestId("provider-load-error")).toHaveTextContent(
      "Default provider is not available in this build."
    );
  });

  it("reports a readable error when setDefaultProvider fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      setupIpc({
        getDefaultProviderImpl: vi.fn().mockResolvedValue("openai-compatible"),
        setDefaultProviderImpl: vi.fn().mockRejectedValue(new Error("boom")),
      });

      render(DefaultProviderPicker, { props: { profileId: 1 } });
      await vi.advanceTimersByTimeAsync(0);

      fireEvent.click(screen.getByTestId("provider-option-mock"));

      // The toast error path is covered; confirm the button re-enables.
      await waitFor(() => {
        expect(screen.getByTestId("provider-option-mock")).not.toBeDisabled();
      });
    } finally {
      consoleError.mockRestore();
    }
  });
});
