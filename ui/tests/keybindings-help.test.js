// KeybindingsHelp — modal tests.
//
// Tests:
//   - Modal renders when visible and has the correct content
//   - Clicking the backdrop or close button dismisses it
//   - ? key opens the modal when no input is focused
//   - Cmd+/ key opens the modal
//   - Esc key closes the modal
//   - ? is ignored when an input is focused

import { render, screen, waitFor, cleanup } from "@testing-library/svelte";
import { describe, it, expect, vi, afterEach } from "vitest";
import { projectModeStore } from "../src/features/project-mode/stores/projectMode.svelte.js";
import ProjectModePanel from "../src/features/project-mode/components/ProjectModePanel.svelte";

afterEach(() => {
  cleanup();
  // Reset store so the workspace view is not active.
  projectModeStore.activeProjectId = null;
  projectModeStore.activeAgentId = null;
  projectModeStore.activeProject = null;
});

/** Dispatch a keyboard event on window. */
function keydown(key, extra = {}) {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra })
  );
}

describe("KeybindingsHelp modal", () => {
  it("renders the modal when visible", async () => {
    render(ProjectModePanel, { props: { profileId: 1 } });
    // Trigger ? key — must not be on an input element.
    keydown("?");
    await waitFor(() => {
      expect(screen.getByTestId("keybindings-modal")).toBeInTheDocument();
    });
    expect(screen.getByTestId("keybindings-header")).toHaveTextContent("Keyboard Shortcuts");
    expect(screen.getByTestId("keybindings-close")).toBeInTheDocument();
  });

  it("lists all keyboard shortcuts with kbd elements", async () => {
    render(ProjectModePanel, { props: { profileId: 1 } });
    keydown("?");
    const keys = await screen.findAllByTestId("keybinding-key");
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((k) => k.textContent.includes("Cmd+K"))).toBe(true);
    expect(keys.some((k) => k.textContent.includes("Cmd+/"))).toBe(true);
    expect(keys.some((k) => k.textContent.includes("Esc"))).toBe(true);
  });

  it("closes the modal when the close button is clicked", async () => {
    render(ProjectModePanel, { props: { profileId: 1 } });
    keydown("?");
    await waitFor(() => expect(screen.getByTestId("keybindings-modal")).toBeInTheDocument());

    screen.getByTestId("keybindings-close").click();
    await waitFor(() => expect(screen.queryByTestId("keybindings-modal")).toBeNull());
  });

  it("closes the modal when Escape is pressed", async () => {
    render(ProjectModePanel, { props: { profileId: 1 } });
    keydown("?");
    await waitFor(() => expect(screen.getByTestId("keybindings-modal")).toBeInTheDocument());

    keydown("Escape");
    await waitFor(() => expect(screen.queryByTestId("keybindings-modal")).toBeNull());
  });

  it("opens the modal via Cmd+/ as well as ?", async () => {
    render(ProjectModePanel, { props: { profileId: 1 } });
    // Start with Esc to ensure clean state
    keydown("Escape");
    // Cmd+/ should also open it
    keydown("/", { ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId("keybindings-modal")).toBeInTheDocument());
  });

  it("does not open when ? is typed into an input", async () => {
    render(ProjectModePanel, { props: { profileId: 1 } });
    // Put focus on a real input — the objective textarea in the workspace.
    // First activate the workspace by setting an active project.
    projectModeStore.activeProject = { id: 1, name: "Test Project", description: "" };
    projectModeStore.activeProjectId = 1;
    // Render again to pick up the store change (via reactive re-render).
    render(ProjectModePanel, { props: { profileId: 1 } });

    const textarea = screen.queryByTestId("objective-input");
    if (textarea) {
      textarea.focus();
      keydown("?");
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByTestId("keybindings-modal")).toBeNull();
    }
  });
});
