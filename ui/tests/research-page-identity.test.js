import { render, screen, cleanup, fireEvent } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import PaneGrid from "../src/shell/PaneGrid.svelte";
import { createContext } from "../src/shell/workspace/model.js";

afterEach(() => {
  cleanup();
  delete window.progressLedger;
});

describe("Research page identity", () => {
  it("keeps the explicitly selected source page bound while the Research ledger tab is active", async () => {
    const capture = vi.fn(async () => ({ ok: true }));
    window.progressLedger = {
      research: {
        listSources: vi.fn(async () => []),
        listCaptures: vi.fn(async () => []),
        capture,
      },
    };
    const ctx = createContext({
      name: "Operator",
      views: [{ view: "research-ledger", label: "Research ledger" }],
    });

    render(PaneGrid, {
      props: {
        ctx,
        viewDeps: {
          profileId: 4,
          researchPageId: "bp-23",
          onOpenResearchSource: vi.fn(),
        },
      },
    });

    const passage = await screen.findByTestId("research-passage-text");
    await fireEvent.input(passage, { target: { value: "A passage from the selected source." } });
    await fireEvent.click(screen.getByTestId("research-keep-passage"));

    expect(capture).toHaveBeenCalledWith(4, "bp-23", "clip", "A passage from the selected source.");
  });
});
