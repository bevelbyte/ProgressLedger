// OnboardingTour — guided tour overlay for new Project Mode users.
//
// Tests:
//   - Modal does not render until `visible` becomes true
//   - Step navigation: Next advances, Back returns
//   - Skip button dismisses and writes the localStorage completion flag
//   - Back is disabled on the first step; Finish appears on the last step
//   - ProjectModePanel auto-shows the tour on first visit and the
//     Help menu's Tour button re-opens it

import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, afterEach } from "vitest";
import OnboardingTour from "../src/features/project-mode/components/OnboardingTour.svelte";
import ProjectModePanel from "../src/features/project-mode/components/ProjectModePanel.svelte";
import { projectModeStore } from "../src/features/project-mode/stores/projectMode.svelte.js";

const TOUR_KEY = "progressledger_v2_project_mode_tour_complete";

afterEach(() => {
  cleanup();
  try {
    localStorage.removeItem(TOUR_KEY);
  } catch (_) {
    /* ignore */
  }
  projectModeStore.activeProjectId = null;
  projectModeStore.activeAgentId = null;
  projectModeStore.activeProject = null;
});

describe("OnboardingTour component", () => {
  it("does not render when visible is false", () => {
    const onClose = vi.fn();
    render(OnboardingTour, { props: { visible: false, onClose } });
    expect(screen.queryByTestId("onboarding-tour-modal")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders the modal with the welcome step when visible", async () => {
    render(OnboardingTour, { props: { visible: true, onClose: () => {} } });

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-tour-modal")).toBeInTheDocument();
    });
    expect(screen.getByTestId("onboarding-tour-title")).toHaveTextContent(
      "Welcome to Project Mode"
    );
    expect(screen.getByTestId("onboarding-tour-counter")).toHaveTextContent("1 / 6");
    expect(screen.getByTestId("onboarding-tour-back")).toBeDisabled();
    expect(screen.getByTestId("onboarding-tour-next")).toBeInTheDocument();
    expect(screen.queryByTestId("onboarding-tour-finish")).toBeNull();
  });

  it("navigates forward and backward through steps", async () => {
    render(OnboardingTour, { props: { visible: true, onClose: () => {} } });

    // Step 1 -> 2 (Plan view)
    fireEvent.click(screen.getByTestId("onboarding-tour-next"));
    await waitFor(() => {
      expect(screen.getByTestId("onboarding-tour-title")).toHaveTextContent("The plan view");
    });
    expect(screen.getByTestId("onboarding-tour-counter")).toHaveTextContent("2 / 6");

    // Step 2 -> 3 (Tool inventory)
    fireEvent.click(screen.getByTestId("onboarding-tour-next"));
    await waitFor(() => {
      expect(screen.getByTestId("onboarding-tour-title")).toHaveTextContent("Tool inventory");
    });

    // Back to step 2
    fireEvent.click(screen.getByTestId("onboarding-tour-back"));
    await waitFor(() => {
      expect(screen.getByTestId("onboarding-tour-title")).toHaveTextContent("The plan view");
    });
  });

  it("swap Next for Finish on the last step and clicking Finish marks complete", async () => {
    const onClose = vi.fn();
    render(OnboardingTour, { props: { visible: true, onClose } });

    // Advance through 5 Next clicks to land on the last step (Memory viewer).
    for (let i = 0; i < 5; i++) {
      fireEvent.click(screen.getByTestId("onboarding-tour-next"));
    }
    await waitFor(() => {
      expect(screen.getByTestId("onboarding-tour-title")).toHaveTextContent("Memory viewer");
    });
    expect(screen.getByTestId("onboarding-tour-counter")).toHaveTextContent("6 / 6");
    expect(screen.queryByTestId("onboarding-tour-next")).toBeNull();
    expect(screen.getByTestId("onboarding-tour-finish")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("onboarding-tour-finish"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(localStorage.getItem(TOUR_KEY)).toBe("1");
  });

  it("Skip button writes the completion flag and calls onClose", async () => {
    const onClose = vi.fn();
    render(OnboardingTour, { props: { visible: true, onClose } });

    fireEvent.click(screen.getByTestId("onboarding-tour-skip"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(localStorage.getItem(TOUR_KEY)).toBe("1");
  });
});

describe("ProjectModePanel tour integration", () => {
  it("auto-shows the tour when localStorage has no completion flag", async () => {
    localStorage.removeItem(TOUR_KEY);

    render(ProjectModePanel, { props: { profileId: null } });

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-tour-modal")).toBeInTheDocument();
    });
    // The Help menu also exposes a Tour button.
    expect(screen.getByTestId("help-menu-tour")).toBeInTheDocument();
  });

  it("does not auto-show the tour when completion flag is set", async () => {
    localStorage.setItem(TOUR_KEY, "1");

    render(ProjectModePanel, { props: { profileId: null } });

    // Give the $effect a tick to settle.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("onboarding-tour-modal")).toBeNull();

    // Help menu Tour button can still re-open it.
    fireEvent.click(screen.getByTestId("help-menu-tour"));
    await waitFor(() => {
      expect(screen.getByTestId("onboarding-tour-modal")).toBeInTheDocument();
    });
  });
});