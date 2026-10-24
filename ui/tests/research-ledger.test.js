import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ResearchLedger from "../src/features/browser/components/ResearchLedger.svelte";

afterEach(() => { cleanup(); delete window.careerflow; });

function bridge() {
  const api = {
    listSources: vi.fn(async () => [{ id: 1, title: "Research article", url: "https://example.test/article", canonicalUrl: "https://example.test/article", domain: "example.test", keptCount: 1, savedAt: "2026-10-11 10:00:00" }]),
    listCaptures: vi.fn(async () => [{ id: 2, sourceId: 1, sourceUrl: "https://example.test/article", sourceTitle: "Research article", kind: "clip", text: "A kept passage", createdAt: "2026-10-11 10:01:00" }]),
  };
  window.careerflow = { research: api };
  return api;
}

describe("Research ledger", () => {
  it("loads persisted sources and captures without creating rows during refresh", async () => {
    const api = bridge();
    const onOpenResearchSource = vi.fn();
    render(ResearchLedger, { props: { profileId: 4, onOpenResearchSource } });
    expect(await screen.findByText("Research article")).toBeTruthy();
    expect(await screen.findByText("A kept passage")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Refresh Research ledger" }));
    await waitFor(() => expect(api.listSources).toHaveBeenCalledTimes(2));
    expect(api.listCaptures).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("Research article").length).toBeGreaterThan(0);
    expect(onOpenResearchSource).not.toHaveBeenCalled();
  });

  it("reuses the supplied page-open callback for source and passage rows", async () => {
    const onOpenResearchSource = vi.fn();
    bridge();
    render(ResearchLedger, { props: { profileId: 4, onOpenResearchSource } });
    await screen.findByText("A kept passage");
    await fireEvent.click(screen.getByRole("button", { name: "Open Research article" }));
    expect(onOpenResearchSource).toHaveBeenCalledWith("https://example.test/article");
  });

  it("filters persisted ledger rows by kind", async () => {
    bridge();
    render(ResearchLedger, { props: { profileId: 4 } });
    await screen.findByText("A kept passage");
    await fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    expect(screen.getByText("Research article")).toBeTruthy();
    expect(screen.queryByText("A kept passage")).toBeNull();
  });

  it("shows refresh failure explicitly and keeps the last successfully loaded rows", async () => {
    const api = bridge();
    const sourceRows = [{ id: 1, title: "Research article", url: "https://example.test/article", canonicalUrl: "https://example.test/article", domain: "example.test", keptCount: 1, savedAt: "2026-10-11 10:00:00" }];
    const captureRows = [{ id: 2, sourceId: 1, sourceUrl: "https://example.test/article", sourceTitle: "Research article", kind: "clip", text: "A kept passage", createdAt: "2026-10-11 10:01:00" }];
    api.listSources.mockImplementation(async () => api.listSources.mock.calls.length === 1 ? sourceRows : Promise.reject(new Error("SQLite unavailable on refresh")));
    api.listCaptures.mockImplementation(async () => captureRows);
    render(ResearchLedger, { props: { profileId: 4 } });
    expect(await screen.findByText("Research article")).toBeTruthy();
    expect(await screen.findByText("A kept passage")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "Refresh Research ledger" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Research ledger could not be loaded. Retry.");
    expect(screen.getByText("Research article")).toBeTruthy();
    expect(screen.getByText("A kept passage")).toBeTruthy();
  });

  it("preserves passage text and reports failure when capture persistence rejects", async () => {
    const api = bridge();
    api.capture = vi.fn(async () => ({ ok: false, reason: "storage-unavailable" }));
    window.careerflow.research = api;
    render(ResearchLedger, { props: { profileId: 4, researchPageId: "bp-23" } });
    const passage = await screen.findByTestId("research-passage-text");
    await fireEvent.input(passage, { target: { value: "Keep this text if storage fails." } });
    await fireEvent.click(screen.getByTestId("research-keep-passage"));

    expect(await screen.findByRole("status")).toHaveTextContent("Passage was not saved. Your text is preserved; retry when storage is available.");
    expect(passage).toHaveValue("Keep this text if storage fails.");
    expect(api.capture).toHaveBeenCalledWith(4, "bp-23", "clip", "Keep this text if storage fails.");
  });

  it("formats and copies citation for a kept passage using formatCitation", async () => {
    bridge();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });

    render(ResearchLedger, { props: { profileId: 4 } });
    await screen.findByText("A kept passage");
    const copyBtn = screen.getByRole("button", { name: "Copy citation for Research article" });
    await fireEvent.click(copyBtn);

    expect(writeText).toHaveBeenCalledTimes(1);
    const copiedText = writeText.mock.calls[0][0];
    expect(copiedText).toContain('> "A kept passage"');
    expect(copiedText).toContain("*Research article*");
    expect(await screen.findByRole("status")).toHaveTextContent("Citation copied to clipboard.");
  });
});

