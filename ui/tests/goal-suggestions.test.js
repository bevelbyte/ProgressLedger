// GoalSuggestions — UI tests.
//
// Coverage:
//   - mounts with 6-8 quick-start chips, each wired to a data-testid
//   - clicking a chip appends its text (with a trailing space) to the
//     bound goal value and focuses the textarea so the user can keep
//     typing; a second chip appends rather than replaces
//   - the "Show/Hide suggestions" toggle collapses and reopens the chip
//     row; the toggle button itself stays visible either way
//
// The component is presentational: no IPC, no stores. The parent
// (ProjectWorkspace) owns the objective string through `bind:goal`.
// Svelte 5 flushes updates asynchronously, so every assertion after a
// fireEvent goes through waitFor.

import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/svelte";
import { describe, it, expect, afterEach } from "vitest";

import GoalSuggestions from "../src/features/project-mode/components/GoalSuggestions.svelte";

const CHIP_PREFIX = "[data-testid^='goal-suggestion-chip-']";

function renderWith(props = {}) {
  return render(GoalSuggestions, { props });
}

afterEach(() => {
  cleanup();
});

describe("GoalSuggestions", () => {
  it("mounts 6-8 quick-start chips with a visible toggle", () => {
    const { container } = renderWith({});

    const chips = [...container.querySelectorAll(CHIP_PREFIX)];
    expect(chips.length).toBeGreaterThanOrEqual(6);
    expect(chips.length).toBeLessThanOrEqual(8);

    // Every chip is a real keyboard-reachable button with its label as
    // the accessible name and a hint explaining what to type next.
    for (const chip of chips) {
      expect(chip.tagName).toBe("BUTTON");
      expect(chip.textContent.trim()).not.toBe("");
      expect(chip.getAttribute("title")).not.toBe("");
      expect(chip).toHaveAccessibleName(chip.textContent.trim());
    }

    const toggle = screen.getByTestId("goal-suggestions-toggle");
    expect(toggle).toBeVisible();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("goal-suggestions")).toBeInTheDocument();
    expect(screen.getByTestId("goal-input")).toBeInTheDocument();
  });

  it("clicking a chip appends its text to the goal and focuses the input", async () => {
    renderWith({ goal: "" });

    const textarea = screen.getByTestId("goal-input");
    fireEvent.click(screen.getByTestId("goal-suggestion-chip-0"));

    // The chip's label plus a trailing space lands in the input, so the
    // user can immediately type the specific file / test / error text.
    await waitFor(() => expect(textarea.value).toBe("Refactor this file "));
    // Focus moves into the textarea right after the insert.
    await waitFor(() => expect(document.activeElement).toBe(textarea));

    // A second chip appends rather than replacing, so suggestions stay
    // composable.
    fireEvent.click(screen.getByTestId("goal-suggestion-chip-1"));
    await waitFor(() => expect(textarea.value).toBe("Refactor this file Add tests for "));
  });

  it("toggles the suggestions open and closed", async () => {
    const { container } = renderWith({});
    const toggle = screen.getByTestId("goal-suggestions-toggle");

    // Visible by default — new users get the chips immediately.
    expect(screen.getByTestId("goal-suggestions")).toBeVisible();

    fireEvent.click(toggle);
    await screen.findByText("Show suggestions");
    expect(container.querySelectorAll(CHIP_PREFIX).length).toBe(0);
    expect(screen.queryByTestId("goal-suggestions")).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The input stays usable while the chips are hidden.
    expect(screen.getByTestId("goal-input")).toBeVisible();

    fireEvent.click(toggle);
    await screen.findByText("Hide suggestions");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("goal-suggestions")).toBeVisible();
    expect(container.querySelectorAll(CHIP_PREFIX).length).toBeGreaterThanOrEqual(6);
  });
});
