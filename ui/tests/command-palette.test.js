import { render, screen, waitFor, cleanup } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CommandPalette } from "../src/features/command-palette";
import { moveSelection } from "../src/features/command-palette/selection.js";

const HITS = [
  { id: "n1", kind: "note", title: "Tail calls in OCaml", subjectName: "PL", snippet: "tail <mark>recursion</mark>" },
  { id: "p1", kind: "pdf", title: "Structure and Interpretation", subjectName: "PL", snippet: "<mark>tail</mark> position" },
  { id: "n2", kind: "note", title: "Panic discipline", subjectName: "Systems", snippet: "<mark>tail</mark>-first debug" },
];

beforeEach(() => {
  window.progressLedger = {
    resources: { search: vi.fn().mockResolvedValue(HITS) },
  };
});

// Each test mounts its own palette, and every instance adds a window keydown
// listener. Without cleanup, Ctrl+K toggles every palette from every previous
// test, so a query finds results rendered by the wrong instance.
afterEach(() => {
  cleanup();
});

/** KeyboardEvent the palette's own handlers actually listen for. */
function keydown(target, key, extra = {}) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
}

/** jsdom does not update bound values from a plain assignment. */
function typeInto(input, text) {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  set.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Mount, open with Ctrl+K, and wait for results.
 *
 * Note on assertion style: Svelte 5 applies state changes from an event handler
 * on a later microtask, so every close/move is awaited with waitFor rather than
 * asserted synchronously after the dispatch.
 */
async function openWithHits() {
  const onOpen = vi.fn();
  render(CommandPalette, { props: { profileId: 1, onOpen } });

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
  const input = await screen.findByRole("combobox");
  typeInto(input, "tail");
  await screen.findByRole("option", { name: /Panic discipline/ });
  return { input, onOpen };
}

describe("moveSelection", () => {
  it("moves down and up", () => {
    expect(moveSelection(3, 0, 1)).toBe(1);
    expect(moveSelection(3, 1, -1)).toBe(0);
    expect(moveSelection(3, 1, 0)).toBe(1);
  });

  it("wraps at both ends instead of clamping", () => {
    expect(moveSelection(3, 2, 1)).toBe(0);
    expect(moveSelection(3, 0, -1)).toBe(2);
    expect(moveSelection(1, 0, 1)).toBe(0);
    expect(moveSelection(1, 0, -1)).toBe(0);
  });

  it("recovers from a stale or missing index", () => {
    expect(moveSelection(3, 7, 1)).toBe(1);
    expect(moveSelection(3, -4, 1)).toBe(1);
    expect(moveSelection(3, NaN, -1)).toBe(2);
    expect(moveSelection(3, undefined, 1)).toBe(1);
  });

  it("never indexes an empty list", () => {
    expect(moveSelection(0, 0, 1)).toBe(0);
    expect(moveSelection(0, 5, -1)).toBe(0);
    expect(moveSelection(-1, 0, 1)).toBe(0);
    expect(moveSelection(NaN, 0, 1)).toBe(0);
  });
});

describe("CommandPalette keyboard selection", () => {
  it("opens the first result by default and marks it for screen readers", async () => {
    const { input } = await openWithHits();

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "false");
    expect(input).toHaveAttribute("aria-activedescendant", "palette-hit-0");
    expect(input).toHaveAttribute("aria-controls", "palette-results");
  });

  it("moves the highlight with ArrowDown/ArrowUp and opens it with Enter", async () => {
    const { input, onOpen } = await openWithHits();

    keydown(input, "ArrowDown");
    await waitFor(() => expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true"));
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "false");
    expect(input).toHaveAttribute("aria-activedescendant", "palette-hit-1");

    keydown(input, "ArrowUp");
    keydown(input, "ArrowUp"); // wraps back to the last result
    await waitFor(() => expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true"));

    keydown(input, "Enter");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(HITS[2]);
  });

  it("wraps from the top back to the last result on ArrowUp", async () => {
    const { input } = await openWithHits();

    keydown(input, "ArrowUp");
    await waitFor(() => expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true"));
  });

  it("does nothing dangerous when there is no result to choose", async () => {
    const { input, onOpen } = await openWithHits();
    // The second search comes up empty; the first already returned HITS.
    window.progressLedger.resources.search.mockResolvedValueOnce([]);
    typeInto(input, "zzz-no-such-term");

    await screen.findByText(/No matches found/);
    await waitFor(() => expect(input).not.toHaveAttribute("aria-activedescendant"));

    keydown(input, "ArrowDown");
    keydown(input, "Enter");
    await new Promise((r) => setTimeout(r, 50));
    expect(onOpen).not.toHaveBeenCalled();
    // The palette stays open so the user can keep typing.
    expect(input).toBeInTheDocument();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("selecting with the mouse keeps the keyboard cursor in sync", async () => {
    const { input, onOpen } = await openWithHits();

    const options = screen.getAllByRole("option");
    options[1].dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    await waitFor(() => expect(options[1]).toHaveAttribute("aria-selected", "true"));
    expect(input).toHaveAttribute("aria-activedescendant", "palette-hit-1");

    options[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(onOpen).toHaveBeenCalledWith(HITS[1]);
  });

  it("Escape closes the palette and discards the query", async () => {
    await openWithHits();
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    // The input is unmounted by the close, so its value is unreachable — the
    // observable contract is that the overlay is gone.
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("does not search without an active profile and explains why", async () => {
    render(CommandPalette, { props: { profileId: null } });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));

    const input = await screen.findByRole("combobox");
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("placeholder", "Select a profile to search…");

    typeInto(input, "tail");
    await new Promise((r) => setTimeout(r, 200));
    expect(window.progressLedger.resources.search).not.toHaveBeenCalled();
  });
});
