// ToolInventory — UI tests.
//
// Coverage:
//   - renders one row per tool from window.progressLedger.projectTools.list()
//   - permission pills color-code the 5 permission classes
//   - approval-required tools show the "approval" flag
//   - search input filters by name and description (case-insensitive)
//   - category filter narrows to the picked bucket (filesystem / exec / ...)
//   - "Show schema" reveals the inputSchema JSON
//   - empty / no-match states render correctly
//
// The IPC namespace is mocked via window.progressLedger.projectTools. Tests
// reset window.progressLedger between cases for hermetic isolation.

import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, afterEach } from "vitest";

import ToolInventory from "../src/features/project-mode/components/ToolInventory.svelte";

const PERMISSION_INFO = {
  READ: { label: "Read", description: "Read files or repository metadata." },
  WRITE: { label: "Write", description: "Modify files inside the project root." },
  EXECUTE: { label: "Execute", description: "Run shell commands, tests, or builds." },
  NETWORK: { label: "Network", description: "Make outbound network requests." },
  DESTRUCTIVE: { label: "Destructive", description: "Irreversible action." },
};

const SAMPLE_TOOLS = [
  {
    name: "fs_list",
    description: "List files in a project directory (recursively).",
    permission: "READ",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "fs_read",
    description: "Read a single file from the project root.",
    permission: "READ",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "fs_write",
    description: "Write a file inside the project root.",
    permission: "WRITE",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
  },
  {
    name: "shell_git_status",
    description: "Run `git status` inside the project root.",
    permission: "READ",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "exec_run",
    description: "Run a shell command (subject to approval).",
    permission: "EXECUTE",
    inputSchema: { type: "object", properties: { command: { type: "string" } } },
  },
  {
    name: "delegate_research",
    description: "Spawn a researcher sub-agent.",
    permission: "NETWORK",
    inputSchema: { type: "object", properties: { objective: { type: "string" } } },
  },
];

function setupIpc({
  tools = SAMPLE_TOOLS,
  approvalRequired = ["fs_write", "exec_run"],
  permissionInfo = PERMISSION_INFO,
  listImpl = null,
} = {}) {
  const list = vi.fn(
    listImpl || (async () => ({ ok: true, tools, approvalRequired, permissionInfo })),
  );
  window.progressLedger = {
    projectTools: { list, approve: vi.fn(), invoke: vi.fn() },
  };
  return { list };
}

afterEach(() => {
  cleanup();
  delete window.progressLedger;
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("ToolInventory — rendering", () => {
  it("renders one row per tool returned by the IPC list() call", async () => {
    setupIpc();
    render(ToolInventory);
    const rows = await screen.findAllByTestId("tool-row");
    expect(rows).toHaveLength(SAMPLE_TOOLS.length);
    // Each row has a name and a permission pill.
    expect(screen.getByText("fs_list")).toBeInTheDocument();
    expect(screen.getByText("delegate_research")).toBeInTheDocument();
  });

  it("color-codes permission pills (READ / WRITE / EXECUTE / NETWORK)", async () => {
    setupIpc();
    render(ToolInventory);
    await screen.findAllByTestId("tool-row");
    const pills = screen.getAllByTestId("tool-permission");
    const byPerm = Object.fromEntries(pills.map((p) => [p.dataset.toolPermission ?? p.textContent, p]));
    // fs_list is READ → READ pill present
    const fsListRow = screen.getAllByTestId("tool-row").find((r) => r.dataset.toolName === "fs_list");
    expect(fsListRow.querySelector(".perm-READ")).toBeInTheDocument();
    // fs_write → WRITE
    const fsWriteRow = screen.getAllByTestId("tool-row").find((r) => r.dataset.toolName === "fs_write");
    expect(fsWriteRow.querySelector(".perm-WRITE")).toBeInTheDocument();
    // exec_run → EXECUTE
    const execRow = screen.getAllByTestId("tool-row").find((r) => r.dataset.toolName === "exec_run");
    expect(execRow.querySelector(".perm-EXECUTE")).toBeInTheDocument();
    // delegate_research → NETWORK
    const delRow = screen.getAllByTestId("tool-row").find((r) => r.dataset.toolName === "delegate_research");
    expect(delRow.querySelector(".perm-NETWORK")).toBeInTheDocument();
  });

  it("marks approval-required tools with the approval flag", async () => {
    setupIpc();
    render(ToolInventory);
    await screen.findAllByTestId("tool-row");
    const flags = screen.getAllByTestId("tool-approval-flag").map((n) => n.closest("[data-tool-name]").dataset.toolName);
    expect(flags).toEqual(expect.arrayContaining(["fs_write", "exec_run"]));
    expect(flags).not.toContain("fs_list");
    // data-tool-approval on the row matches
    const fsWriteRow = screen.getAllByTestId("tool-row").find((r) => r.dataset.toolName === "fs_write");
    expect(fsWriteRow.dataset.toolApproval).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe("ToolInventory — filtering", () => {
  it("search input filters rows by name (case-insensitive)", async () => {
    setupIpc();
    render(ToolInventory);
    await screen.findAllByTestId("tool-row");
    fireEvent.input(screen.getByTestId("tool-inventory-search"), {
      target: { value: "WRITE" },
    });
    await waitFor(() => {
      const rows = screen.getAllByTestId("tool-row");
      expect(rows).toHaveLength(1);
      expect(rows[0].dataset.toolName).toBe("fs_write");
    });
  });

  it("search input filters rows by description text", async () => {
    setupIpc();
    render(ToolInventory);
    await screen.findAllByTestId("tool-row");
    fireEvent.input(screen.getByTestId("tool-inventory-search"), {
      target: { value: "researcher" },
    });
    await waitFor(() => {
      const rows = screen.getAllByTestId("tool-row");
      expect(rows).toHaveLength(1);
      expect(rows[0].dataset.toolName).toBe("delegate_research");
    });
  });

  it("category dropdown narrows the list to the picked bucket", async () => {
    setupIpc();
    render(ToolInventory);
    await screen.findAllByTestId("tool-row");
    fireEvent.change(screen.getByTestId("tool-inventory-category"), {
      target: { value: "exec" },
    });
    await waitFor(() => {
      const rows = screen.getAllByTestId("tool-row");
      expect(rows).toHaveLength(1);
      expect(rows[0].dataset.toolName).toBe("exec_run");
    });
  });

  it("shows the no-match empty state when search yields nothing", async () => {
    setupIpc();
    render(ToolInventory);
    await screen.findAllByTestId("tool-row");
    fireEvent.input(screen.getByTestId("tool-inventory-search"), {
      target: { value: "definitely-not-a-real-tool" },
    });
    await waitFor(() => expect(screen.getByTestId("tool-inventory-no-match")).toBeInTheDocument());
    expect(screen.getByTestId("tool-inventory-count")).toHaveTextContent("0/6");
  });
});

// ---------------------------------------------------------------------------
// Schema expansion
// ---------------------------------------------------------------------------

describe("ToolInventory — schema expansion", () => {
  it("'Show schema' reveals the inputSchema JSON", async () => {
    setupIpc();
    render(ToolInventory);
    await screen.findAllByTestId("tool-row");
    expect(screen.queryByTestId("tool-schema")).not.toBeInTheDocument();
    // The fs_read row has a structured schema.
    const fsReadRow = screen.getAllByTestId("tool-row").find((r) => r.dataset.toolName === "fs_read");
    const expandBtn = fsReadRow.querySelector('[data-testid="tool-expand"]');
    fireEvent.click(expandBtn);
    const schema = await screen.findByTestId("tool-schema");
    expect(schema.textContent).toContain("path");
    expect(schema.textContent).toContain("required");
  });

  it("clicking 'Hide schema' collapses it back", async () => {
    setupIpc();
    render(ToolInventory);
    await screen.findAllByTestId("tool-row");
    const row = screen.getAllByTestId("tool-row").find((r) => r.dataset.toolName === "fs_read");
    const btn = () => row.querySelector('[data-testid="tool-expand"]');
    fireEvent.click(btn());
    expect(await screen.findByTestId("tool-schema")).toBeInTheDocument();
    fireEvent.click(btn());
    await waitFor(() => expect(row.querySelector('[data-testid="tool-schema"]')).toBeNull());
  });
});

// ---------------------------------------------------------------------------
// Empty / failure states
// ---------------------------------------------------------------------------

describe("ToolInventory — empty / failure states", () => {
  it("renders the empty hint when the registry returns no tools", async () => {
    setupIpc({ tools: [] });
    render(ToolInventory);
    await waitFor(() => expect(screen.getByTestId("tool-inventory-empty")).toBeInTheDocument());
    expect(screen.getByText(/No tools registered/i)).toBeInTheDocument();
    expect(screen.getByTestId("tool-inventory-count")).toHaveTextContent("0/0");
  });

  it("treats a non-ok IPC response as an empty list (does not throw)", async () => {
    setupIpc({ listImpl: async () => ({ ok: false, reason: "no-project" }) });
    render(ToolInventory);
    await waitFor(() => expect(screen.getByTestId("tool-inventory-empty")).toBeInTheDocument());
    expect(screen.queryByTestId("tool-row")).toBeNull();
  });
});