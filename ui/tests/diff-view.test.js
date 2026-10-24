// DiffView — UI tests.

import { describe, it, expect, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/svelte";
import DiffView from "../src/features/project-mode/components/DiffView.svelte";

beforeEach(() => {
  window.progressLedger = window.progressLedger || {};
});

describe("DiffView", () => {
  it("renders an empty state when diff is empty", async () => {
    window.progressLedger.diff = {
      workingTree: async () => ({ ok: true, result: { diff: "", truncated: false, root: "/p" } }),
    };
    const { container, getByText } = render(DiffView, { props: { profileId: 1, agentId: 1 } });
    await waitFor(() => getByText(/No changes in the working tree/));
    expect(container.textContent).toContain("No changes");
  });

  it("renders a diff with added and removed lines", async () => {
    window.progressLedger.diff = {
      workingTree: async () => ({
        ok: true,
        result: {
          diff: [
            "diff --git a/foo.js b/foo.js",
            "index 1234..5678 100644",
            "--- a/foo.js",
            "+++ b/foo.js",
            "@@ -1,1 +1,1 @@",
            "-old",
            "+new",
          ].join("\n"),
          truncated: false,
          root: "/p",
        },
      }),
    };
    const { container } = render(DiffView, { props: { profileId: 1, agentId: 1 } });
    await waitFor(() => {
      expect(container.textContent).toContain("-old");
      expect(container.textContent).toContain("+new");
    });
  });

  it("renders an error message on failure", async () => {
    window.progressLedger.diff = {
      workingTree: async () => ({ ok: false, error: { message: "boom" } }),
    };
    const { container, getByText } = render(DiffView, { props: { profileId: 1, agentId: 1 } });
    await waitFor(() => getByText(/boom/));
    expect(container.textContent).toContain("boom");
  });
});
