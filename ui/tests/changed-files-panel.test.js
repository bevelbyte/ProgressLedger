// ChangedFilesPanel — UI tests.
//
// Three cases, matching the three observable behaviours of the panel:
//   1. mount            — it renders its header and an empty state when the
//                         working tree is clean, without throwing.
//   2. list rendering   — it parses the git working-tree diff into one row
//                         per file with the right action badge, mtime, and
//                         +N/−M counts.
//   3. click action     — clicking a file row opens the inline diff preview.
//
// Every assertion waits on a data-derived anchor: the panel fetches through a
// deferred $effect plus an async IPC stub, and its empty-state node is present
// in the DOM during the pending "Loading…" phase too, so waiting on its
// testid alone would resolve before the data actually lands.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import ChangedFilesPanel from "../src/features/project-mode/components/ChangedFilesPanel.svelte";

beforeEach(() => {
  window.progressLedger = window.progressLedger || {};
});

afterEach(() => {
  cleanup();
});

const SAMPLE_DIFF = [
  "diff --git a/src/foo.js b/src/foo.js",
  "index 1234..5678 100644",
  "--- a/src/foo.js",
  "+++ b/src/foo.js",
  "@@ -1,3 +1,4 @@",
  " line1",
  "+new line",
  " line2",
  "diff --git /dev/null b/src/new.ts",
  "new file mode 100644",
  "index 0000000..e69de29",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1 @@",
  "+export const x = 1;",
  "diff --git a/src/old.py b/src/old.py",
  "deleted file mode 100644",
  "index e69de29..0000000",
  "--- a/src/old.py",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-legacy",
].join("\n");

// 2026-07-31 03:44:12 UTC, in whole milliseconds (project-intel stores
// Math.floor(st.mtimeMs)).
const FOO_MTIME = Date.UTC(2026, 6, 31, 3, 44, 12);

function stubDiff(diff = "", entries = [], truncated = false) {
  window.progressLedger.diff = {
    workingTree: async () => ({ ok: true, result: { diff, truncated } }),
  };
  window.progressLedger.projectIntel = {
    list: async () => ({ ok: true, result: { entries, total: entries.length } }),
  };
}

function badgeCount(cls) {
  return document.querySelectorAll(`.badge.${cls}`).length;
}

function rowByPath(path) {
  return document.querySelector(`[data-testid="changed-file-row"][data-path="${path}"]`);
}

describe("ChangedFilesPanel", () => {
  it("mounts and shows an empty state when the working tree is clean", async () => {
    stubDiff("", []);
    const { getByText, queryByTestId } = render(ChangedFilesPanel, {
      props: { profileId: 1, projectId: 1, agentId: 1 },
    });

    // Wait for the resolved message, not the header: the header is in the
    // DOM from the very first render.
    await waitFor(() => getByText("No files written this run."));
    expect(getByText("Changed Files")).toBeInTheDocument();
    // No rows, no error banner.
    expect(document.querySelectorAll('[data-testid="changed-file-row"]')).toHaveLength(0);
    expect(queryByTestId("changed-files-error")).toBeNull();
  });

  it("renders one row per changed file with action, timestamp, and line counts", async () => {
    stubDiff(SAMPLE_DIFF, [
      { path: "src/foo.js", size: 20, mtime: FOO_MTIME, language: "javascript" },
    ]);
    const { getByText } = render(ChangedFilesPanel, {
      props: { profileId: 1, projectId: 1, agentId: 1 },
    });

    await waitFor(() => getByText("src/foo.js"));

    // Actions: foo.js modified, new.ts created, old.py deleted.
    expect(badgeCount("badge-modified")).toBe(1);
    expect(badgeCount("badge-created")).toBe(1);
    expect(badgeCount("badge-deleted")).toBe(1);

    // Row count matches the number of diff sections.
    expect(document.querySelectorAll('[data-testid="changed-file-row"]')).toHaveLength(3);

    // The indexed file gets a UTC timestamp; unindexed ones render "—".
    expect(getByText("2026-07-31 03:44:12")).toBeInTheDocument();
    const timeCells = Array.from(document.querySelectorAll("td.col-time"));
    expect(timeCells).toHaveLength(3);
    expect(timeCells.filter((td) => td.textContent.trim() === "—")).toHaveLength(2);

    // foo.js: +1 / −0. new.ts: +1 / −0. old.py: +0 / −1.
    expect(getByText(/3 files? changed/)).toBeInTheDocument();
    expect(rowByPath("src/foo.js").querySelector(".add-count").textContent).toBe("+1");
    expect(rowByPath("src/foo.js").querySelector(".del-count").textContent).toBe("−0");
    expect(rowByPath("src/new.ts").querySelector(".add-count").textContent).toBe("+1");
    expect(rowByPath("src/old.py").querySelector(".del-count").textContent).toBe("−1");
  });

  it("opens an inline diff preview when a file row is clicked", async () => {
    stubDiff(SAMPLE_DIFF, []);
    const { getByText } = render(ChangedFilesPanel, {
      props: { profileId: 1, projectId: 1, agentId: 1 },
    });

    await waitFor(() => getByText("src/foo.js"));
    expect(document.querySelector('[data-testid="changed-file-preview"]')).toBeNull();

    const fileBtn = getByText("src/foo.js").closest('[data-testid="changed-file-btn"]');
    await fireEvent.click(fileBtn);

    const preview = await waitFor(() => {
      const el = document.querySelector('[data-testid="changed-file-preview"]');
      if (!el) throw new Error("preview not rendered");
      return el;
    });
    expect(preview).toBeInTheDocument();
    expect(preview.textContent).toContain("+new line");

    // Clicking the same row again collapses it.
    await fireEvent.click(fileBtn);
    await waitFor(() => {
      expect(document.querySelector('[data-testid="changed-file-preview"]')).toBeNull();
    });
  });
;
  // -------------------------------------------------------------------------
  // The indexing control.
  //
  // The panel has always told the user "re-index to timestamp every row" while
  // providing no way to re-index, so the index was never built and the
  // "written at" column was permanently em-dash. These cases pin that the
  // control now exists, that it calls the already-exposed channel with no root,
  // and — most importantly — that a REFUSED index stays refused rather than
  // being reported as a success.
  // -------------------------------------------------------------------------

  it("offers an Index project control and calls project:intel:index with no root", async () => {
    stubDiff(SAMPLE_DIFF, []);
    const index = vi.fn().mockResolvedValue({ ok: true });
    window.progressLedger.projectIntel.index = index;

    render(ChangedFilesPanel, { props: { profileId: 1, projectId: 7, agentId: 1 } });

    const btn = await screen.findByTestId("changed-files-index");
    expect(btn).not.toBeDisabled();
    await fireEvent.click(btn);

    await waitFor(() => {
      expect(index).toHaveBeenCalledTimes(1);
    });
    // Only ids and mode. The renderer must never be able to name a filesystem
    // root here: the main process resolves the authorized root itself.
    expect(index).toHaveBeenCalledWith(1, 7, "full");
    const args = index.mock.calls[0];
    expect(args).toHaveLength(3);
    expect(JSON.stringify(args)).not.toMatch(/root/i);
  });

  it("reports success only after the main process actually returns ok", async () => {
    stubDiff(SAMPLE_DIFF, []);
    window.progressLedger.projectIntel.index = vi.fn().mockResolvedValue({ ok: true });

    render(ChangedFilesPanel, { props: { profileId: 1, projectId: 7, agentId: 1 } });
    await fireEvent.click(await screen.findByTestId("changed-files-index"));

    expect(await screen.findByTestId("changed-files-indexed")).toBeInTheDocument();
    expect(screen.queryByTestId("changed-files-index-error")).toBeNull();
  });

  it("keeps a refused index visible as a failure, including its code", async () => {
    stubDiff(SAMPLE_DIFF, []);
    window.progressLedger.projectIntel.index = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "root-mismatch", message: "stored root does not match" },
    });

    render(ChangedFilesPanel, { props: { profileId: 1, projectId: 7, agentId: 1 } });
    await fireEvent.click(await screen.findByTestId("changed-files-index"));

    const err = await screen.findByTestId("changed-files-index-error");
    expect(err.textContent).toContain("root-mismatch");
    expect(err.textContent).toContain("stored root does not match");
    // Crucially, no success claim.
    expect(screen.queryByTestId("changed-files-indexed")).toBeNull();
  });

  it("surfaces a thrown index call as a failure rather than swallowing it", async () => {
    stubDiff(SAMPLE_DIFF, []);
    window.progressLedger.projectIntel.index = vi.fn().mockRejectedValue(new Error("ipc exploded"));

    render(ChangedFilesPanel, { props: { profileId: 1, projectId: 7, agentId: 1 } });
    await fireEvent.click(await screen.findByTestId("changed-files-index"));

    const err = await screen.findByTestId("changed-files-index-error");
    expect(err.textContent).toContain("ipc exploded");
    expect(screen.queryByTestId("changed-files-indexed")).toBeNull();
  });

  it("disables the control when no project is selected", async () => {
    stubDiff(SAMPLE_DIFF, []);
    const index = vi.fn();
    window.progressLedger.projectIntel.index = index;

    render(ChangedFilesPanel, { props: { profileId: 1, projectId: null, agentId: 1 } });
    const btn = await screen.findByTestId("changed-files-index");
    expect(btn).toBeDisabled();
    await fireEvent.click(btn);
    expect(index).not.toHaveBeenCalled();
  });

  it("the mtime hint names the control it depends on", async () => {
    stubDiff(SAMPLE_DIFF, []); // empty index -> timestamps missing
    render(ChangedFilesPanel, { props: { profileId: 1, projectId: 7, agentId: 1 } });

    const hint = await screen.findByTestId("changed-files-mtime-hint");
    expect(hint.textContent).toMatch(/index project/i);
  });
});
