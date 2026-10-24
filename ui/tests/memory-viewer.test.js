// MemoryViewer — UI tests.
//
// Coverage:
//   - renders one row per entry returned by window.careerflow.memory.list()
//   - search input filters rows by key/value/kind (case-insensitive)
//   - scope filter narrows the list to the picked bucket (project / session / task)
//   - clicking a row expands to reveal the full value
//   - empty / no-match states render correctly
//
// The IPC namespace is mocked via window.careerflow.memory, mirroring the
// shape shipped by shell/src/preload.cjs + shell/src/ipc/memory.js.

import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, afterEach } from "vitest";

import MemoryViewer from "../src/features/project-mode/components/MemoryViewer.svelte";

const SAMPLE_ENTRIES = [
  {
    id: "project:decision:framework",
    scope: "project",
    kind: "decision",
    key: "framework",
    value: "Use Svelte 5 for the renderer.",
    confidence: 0.9,
    createdAt: 1714000000000,
    updatedAt: 1714000000000,
  },
  {
    id: "project:risk:concurrent-writes",
    scope: "project",
    kind: "risk",
    key: "concurrent-writes",
    value: "Sidecar SQLite may need WAL mode for concurrent agents.",
    confidence: 0.8,
    createdAt: 1714100000000,
    updatedAt: 1714100000000,
  },
  {
    id: "session:agent-7:next-step",
    scope: "session",
    kind: "session",
    key: "next-step",
    value: "Wire the diff view into ProjectWorkspace before commit.",
    agentId: "agent-7",
    createdAt: 1714200000000,
  },
  {
    id: "task:42",
    scope: "task",
    kind: "task",
    key: "run-42",
    value: "Added memory IPC channel.",
    agentId: "agent-3",
    success: true,
    createdAt: 1714300000000,
  },
  {
    id: "task:43",
    scope: "task",
    kind: "task",
    key: "run-43",
    value: "Failed to open sidecar DB.",
    agentId: "agent-4",
    success: false,
    createdAt: 1714400000000,
  },
];

function setupIpc({ entries = SAMPLE_ENTRIES, listImpl = null } = {}) {
  const list = vi.fn(
    listImpl || (async () => ({ ok: true, result: entries })),
  );
  window.careerflow = {
    memory: { list, projectList: vi.fn(), contextPacket: vi.fn(), projectSet: vi.fn() },
  };
  return { list };
}

afterEach(() => {
  cleanup();
  delete window.careerflow;
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("MemoryViewer — rendering", () => {
  it("renders one row per entry returned by memory.list()", async () => {
    setupIpc();
    render(MemoryViewer, { props: { profileId: 1, projectId: 10 } });
    const rows = await screen.findAllByTestId("memory-row");
    expect(rows).toHaveLength(SAMPLE_ENTRIES.length);
    expect(screen.getByText("framework")).toBeInTheDocument();
    expect(screen.getByText("next-step")).toBeInTheDocument();
  });

  it("renders the empty hint when the IPC returns no entries", async () => {
    setupIpc({ entries: [] });
    render(MemoryViewer, { props: { profileId: 1, projectId: 10 } });
    await waitFor(() => expect(screen.getByTestId("memory-viewer-empty")).toBeInTheDocument());
    expect(screen.queryByTestId("memory-row")).toBeNull();
    expect(screen.getByTestId("memory-viewer-count")).toHaveTextContent("0/0");
  });

  it("treats a non-ok IPC response as an empty list (does not throw)", async () => {
    setupIpc({ listImpl: async () => ({ ok: false, reason: "no-project" }) });
    render(MemoryViewer, { props: { profileId: 1, projectId: 10 } });
    await waitFor(() => expect(screen.getByTestId("memory-viewer-empty")).toBeInTheDocument());
    expect(screen.queryByTestId("memory-row")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe("MemoryViewer — filtering", () => {
  it("search input filters rows by key (case-insensitive)", async () => {
    setupIpc();
    render(MemoryViewer, { props: { profileId: 1, projectId: 10 } });
    await screen.findAllByTestId("memory-row");
    fireEvent.input(screen.getByTestId("memory-viewer-search"), {
      target: { value: "FRAMEWORK" },
    });
    await waitFor(() => {
      const rows = screen.getAllByTestId("memory-row");
      expect(rows).toHaveLength(1);
      expect(rows[0].dataset.memoryId).toBe("project:decision:framework");
    });
  });

  it("search input filters rows by value text", async () => {
    setupIpc();
    render(MemoryViewer, { props: { profileId: 1, projectId: 10 } });
    await screen.findAllByTestId("memory-row");
    fireEvent.input(screen.getByTestId("memory-viewer-search"), {
      target: { value: "WAL" },
    });
    await waitFor(() => {
      const rows = screen.getAllByTestId("memory-row");
      expect(rows).toHaveLength(1);
      expect(rows[0].dataset.memoryScope).toBe("project");
    });
  });

  it("scope filter narrows the list to the picked bucket", async () => {
    setupIpc();
    render(MemoryViewer, { props: { profileId: 1, projectId: 10 } });
    await screen.findAllByTestId("memory-row");
    fireEvent.change(screen.getByTestId("memory-viewer-scope"), {
      target: { value: "task" },
    });
    await waitFor(() => {
      const rows = screen.getAllByTestId("memory-row");
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(r.dataset.memoryScope).toBe("task");
    });
  });

  it("shows the no-match empty state when search yields nothing", async () => {
    setupIpc();
    render(MemoryViewer, { props: { profileId: 1, projectId: 10 } });
    await screen.findAllByTestId("memory-row");
    fireEvent.input(screen.getByTestId("memory-viewer-search"), {
      target: { value: "definitely-not-a-real-entry" },
    });
    await waitFor(() => expect(screen.getByTestId("memory-viewer-no-match")).toBeInTheDocument());
    expect(screen.getByTestId("memory-viewer-count")).toHaveTextContent("0/5");
  });
});

// ---------------------------------------------------------------------------
// Row expansion
// ---------------------------------------------------------------------------

describe("MemoryViewer — row expansion", () => {
  it("clicking a row reveals the full value", async () => {
    setupIpc();
    render(MemoryViewer, { props: { profileId: 1, projectId: 10 } });
    const row = (await screen.findAllByTestId("memory-row")).find(
      (r) => r.dataset.memoryId === "project:risk:concurrent-writes",
    );
    expect(row.querySelector('[data-testid="memory-full-value"]')).toBeNull();
    fireEvent.click(row);
    const full = await screen.findByTestId("memory-full-value");
    expect(full.textContent).toContain("WAL mode");
    expect(full.textContent).toContain("concurrent agents");
  });

  it("clicking the same row twice collapses the value back", async () => {
    setupIpc();
    render(MemoryViewer, { props: { profileId: 1, projectId: 10 } });
    const row = (await screen.findAllByTestId("memory-row")).find(
      (r) => r.dataset.memoryId === "project:risk:concurrent-writes",
    );
    fireEvent.click(row);
    await screen.findByTestId("memory-full-value");
    fireEvent.click(row);
    await waitFor(() =>
      expect(row.querySelector('[data-testid="memory-full-value"]')).toBeNull(),
    );
  });
});
