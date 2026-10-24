import { describe, it, expect } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import ProjectModeGuide from "../src/features/project-mode/components/ProjectModeGuide.svelte";

describe("ProjectModeGuide", () => {
  it("renders loading state on mount, then the guide HTML", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url) => {
      expect(String(url)).toContain("PROJECT-MODE-GUIDE.md");
      return Promise.resolve(
        new Response("# Test Guide\n\nHello world.", {
          status: 200,
          headers: { "Content-Type": "text/markdown" },
        })
      );
    };
    const { getByText, container } = render(ProjectModeGuide, {
      props: { onClose: () => {} },
    });
    // Loading state visible immediately (no await yet).
    expect(container.textContent).toMatch(/loading/i);
    await waitFor(() => {
      expect(container.querySelector("h1")).not.toBeNull();
    });
    expect(getByText("Test Guide")).toBeTruthy();
    expect(container.textContent).toContain("Hello world");
    globalThis.fetch = originalFetch;
  });

  it("shows an error message when the fetch fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error("network down"));
    const { container } = render(ProjectModeGuide, {
      props: { onClose: () => {} },
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/network down/);
    });
    globalThis.fetch = originalFetch;
  });

  it("calls onClose when the close button is clicked", async () => {
    let closed = false;
    const { getByRole } = render(ProjectModeGuide, {
      props: { onClose: () => (closed = true) },
    });
    // The button label may vary; query by role+name
    const closeBtn = getByRole("button", { name: /close/i });
    await fireEvent.click(closeBtn);
    await tick();
    expect(closed).toBe(true);
  });
});
