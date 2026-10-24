// ProjectDiff — UI tests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import ProjectDiff from "../src/features/project-mode/components/ProjectDiff.svelte";

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
  "diff --git a/src/bar.js b/src/bar.js",
  "index abcd..ef01 100644",
  "--- a/src/bar.js",
  "+++ b/src/bar.js",
  "@@ -1,2 +1,1 @@",
  " keep",
  "-removed",
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

function badgeCount(cls) {
  return document.querySelectorAll(`.badge.${cls}`).length;
}

describe("ProjectDiff", () => {
  it("renders an empty state when there are no changes", async () => {
    window.progressLedger.diff = {
      workingTree: async () => ({ ok: true, result: { diff: "", truncated: false } }),
    };
    const { getByText } = render(ProjectDiff, { props: { profileId: 1, agentId: 1 } });
    await waitFor(() => getByText(/No changes in the working tree/));
  });

  it("parses modified, added, and deleted files with correct status + counts", async () => {
    window.progressLedger.diff = {
      workingTree: async () => ({
        ok: true,
        result: { diff: SAMPLE_DIFF, truncated: false },
      }),
    };
    const { getByText } = render(ProjectDiff, { props: { profileId: 1, agentId: 1 } });

    await waitFor(() => getByText("src/foo.js"));

    // Status badges (use class selectors to avoid colliding with filter buttons)
    expect(badgeCount("badge-modified")).toBe(2);
    expect(badgeCount("badge-added")).toBe(1);
    expect(badgeCount("badge-deleted")).toBe(1);

    // Summary line
    expect(getByText(/4 files? changed/)).toBeInTheDocument();
  });

  it("renders an error message on failure", async () => {
    window.progressLedger.diff = {
      workingTree: async () => ({ ok: false, error: { message: "project root not set" } }),
    };
    const { getByText } = render(ProjectDiff, { props: { profileId: 1, agentId: 1 } });
    await waitFor(() => getByText(/project root not set/));
  });

  it("filters rows by status when a filter button is clicked", async () => {
    window.progressLedger.diff = {
      workingTree: async () => ({
        ok: true,
        result: { diff: SAMPLE_DIFF, truncated: false },
      }),
    };
    const { getByRole } = render(ProjectDiff, { props: { profileId: 1, agentId: 1 } });
    await waitFor(() => getByRole("button", { name: "D", pressed: false }));

    // Click the "D" (deleted) filter button — aria-pressed distinguishes it from badges
    const deletedFilter = getByRole("button", { name: "D", pressed: false });
    await fireEvent.click(deletedFilter);

    // Only the deleted file row should remain visible
    const fileRows = document.querySelectorAll(".file-btn");
    expect(fileRows).toHaveLength(1);
    expect(fileRows[0].textContent).toContain("src/old.py");
  });

  it("expands a file row to show the diff block on click", async () => {
    window.progressLedger.diff = {
      workingTree: async () => ({
        ok: true,
        result: { diff: SAMPLE_DIFF, truncated: false },
      }),
    };
    const { getByText } = render(ProjectDiff, { props: { profileId: 1, agentId: 1 } });
    await waitFor(() => getByText("src/bar.js"));

    // Click the file button for bar.js (which contains "-removed")
    const fileBtn = getByText("src/bar.js").closest(".file-btn");
    await fireEvent.click(fileBtn);

    // The diff block should now be visible with bar.js's content
    await waitFor(() => {
      const diffBlock = document.querySelector(".diff-block");
      expect(diffBlock).toBeInTheDocument();
      expect(diffBlock.textContent).toContain("-removed");
    });
  });

  it("shows a truncated warning when the diff is truncated", async () => {
    window.progressLedger.diff = {
      workingTree: async () => ({
        ok: true,
        result: { diff: "diff --git a/big.js b/big.js\n--- a/big.js\n+++ b/big.js\n@@ -1 +1 @@\n-old\n+new", truncated: true },
      }),
    };
    const { getByText } = render(ProjectDiff, { props: { profileId: 1, agentId: 1 } });
    await waitFor(() => getByText(/truncated/));
    expect(getByText(/raise maxBytes/)).toBeInTheDocument();
  });
});
