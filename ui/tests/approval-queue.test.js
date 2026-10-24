// ApprovalQueue — UI tests.
//
// Coverage:
//   - renders the empty state when there are no pending approvals
//   - renders each pending approval with tool name, permission, args
//   - clicking "Show arguments" expands the full JSON args
//   - clicking Approve removes the item and calls approveCall IPC
//   - clicking Deny removes the item and calls denyCall IPC
//
// The component reads from `projectModeStore.pendingApprovals` (reactive
// Svelte 5 store), so tests populate the store directly via
// `pushApprovalRequest` and assert on the rendered DOM. The IPC namespace
// is mocked on window.careerflow.projectMode.

import { render, screen, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import ApprovalQueue from "../src/features/project-mode/components/ApprovalQueue.svelte";
import { projectModeStore, pushApprovalRequest, resolveApprovalRequest } from "../src/features/project-mode/stores/projectMode.svelte.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupIpc() {
  const approveCall = vi.fn().mockResolvedValue({ ok: true, deleted: true });
  const denyCall = vi.fn().mockResolvedValue({ ok: true, deleted: true });
  const listPendingApprovals = vi.fn().mockResolvedValue({ ok: true, approvals: [], count: 0 });

  window.careerflow = {
    projectMode: {
      approveCall,
      denyCall,
      listPendingApprovals,
    },
  };
  return { approveCall, denyCall, listPendingApprovals };
}

function resetStore() {
  projectModeStore.pendingApprovals = [];
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("ApprovalQueue — empty state", () => {
  beforeEach(resetStore);
  afterEach(() => { cleanup(); window.careerflow = undefined; });

  it("renders the empty state when there are no pending approvals", async () => {
    setupIpc();
    render(ApprovalQueue, { props: { profileId: 1, agentId: 42 } });

    expect(screen.getByTestId("approval-queue")).toBeInTheDocument();
    expect(screen.getByTestId("approval-queue-empty")).toBeInTheDocument();
    expect(screen.getByTestId("approval-queue-empty")).toHaveTextContent(/No pending approvals/i);
    expect(screen.queryByTestId("approval-queue-list")).not.toBeInTheDocument();
    expect(screen.getByTestId("approval-queue-count")).toHaveTextContent("0 pending");
    expect(screen.getByTestId("approval-queue")).toHaveAttribute("data-count", "0");
  });
});

// ---------------------------------------------------------------------------
// Rendering pending approvals
// ---------------------------------------------------------------------------

describe("ApprovalQueue — rendering", () => {
  beforeEach(resetStore);
  afterEach(() => { cleanup(); window.careerflow = undefined; });

  it("renders each pending approval with tool name, permission and truncated args", async () => {
    setupIpc();
    pushApprovalRequest({
      id: "req-1",
      toolName: "exec_run",
      input: { command: "npm test", cwd: "/projects/foo" },
      permission: "EXECUTE",
      requestedAt: 1_700_000_000_000,
    });
    pushApprovalRequest({
      id: "req-2",
      toolName: "fs_write",
      input: { path: "src/main.js", content: "console.log('hello')" },
      permission: "WRITE",
      requestedAt: 1_700_000_001_000,
    });

    render(ApprovalQueue, { props: { profileId: 1, agentId: 42 } });

    const rows = screen.getAllByTestId("approval-row");
    expect(rows).toHaveLength(2);

    // First row
    expect(rows[0]).toHaveAttribute("data-tool", "exec_run");
    expect(screen.getAllByTestId("approval-tool-name")[0]).toHaveTextContent("exec_run");
    expect(screen.getAllByTestId("approval-permission")[0]).toHaveTextContent("EXECUTE");
    // The arguments boundary is stated, not faked. `sanitizeApprovalEntry`
    // strips `input` in the main process, so the renderer can never show the
    // payload; DESIGN-ATLAS.md requires the permission to be stated in words
    // and the user to be sent to the transcript instead.
    const boundary = screen.getAllByTestId("approval-args-boundary")[0];
    expect(boundary).toHaveTextContent(/run a command/i);
    expect(boundary).toHaveTextContent(/not projected to the interface/i);
    // No disclosure control and no argument payload element exist at all.
    expect(screen.queryByTestId("approval-toggle-args")).not.toBeInTheDocument();
    expect(screen.queryByTestId("approval-args")).not.toBeInTheDocument();
    expect(screen.queryByTestId("approval-args-truncated")).not.toBeInTheDocument();
    // The Meridian-era placeholder string must never be rendered.
    expect(document.body.textContent).not.toMatch(/Arguments hidden for security/i);

    // Second row
    expect(rows[1]).toHaveAttribute("data-tool", "fs_write");
    expect(screen.getAllByTestId("approval-permission")[1]).toHaveTextContent("WRITE");

    // Count badge
    expect(screen.getByTestId("approval-queue-count")).toHaveTextContent("2 pending");
    expect(screen.getByTestId("approval-queue")).toHaveAttribute("data-count", "2");
  });

  it("renders permission without a badge when permission is missing", async () => {
    setupIpc();
    pushApprovalRequest({
      id: "req-noperm",
      toolName: "some_tool",
      input: {},
      requestedAt: 1_700_000_000_000,
    });

    render(ApprovalQueue, { props: { profileId: 1, agentId: 42 } });

    expect(screen.getByTestId("approval-tool-name")).toHaveTextContent("some_tool");
    expect(screen.queryByTestId("approval-permission")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Arguments boundary
// ---------------------------------------------------------------------------

describe("ApprovalQueue — arguments boundary", () => {
  beforeEach(resetStore);
  afterEach(() => { cleanup(); window.careerflow = undefined; });

  // Regression guard for a real defect: this component used to render a
  // "Show arguments" disclosure whose collapsed state was the hardcoded string
  // "Arguments hidden for security" and whose expanded state was literally
  // `{}` — because `sanitizeApprovalEntry` strips `input` before the row ever
  // reaches the renderer. The control could never reveal anything, and it sat
  // on the one screen where the user authorizes a privileged tool call.
  it("never renders an argument disclosure or payload, even when a row carries input", async () => {
    setupIpc();
    pushApprovalRequest({
      id: "req-1",
      toolName: "exec_run",
      // A renderer-side `input` must not resurrect the disclosure: the real
      // main process never sends one.
      input: { command: "npm test" },
      permission: "EXECUTE",
      requestedAt: 1_700_000_000_000,
    });

    render(ApprovalQueue, { props: { profileId: 1, agentId: 42 } });

    expect(screen.queryByTestId("approval-toggle-args")).not.toBeInTheDocument();
    expect(screen.queryByTestId("approval-args")).not.toBeInTheDocument();
    expect(screen.queryByTestId("approval-args-truncated")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Arguments hidden for security/i);
    expect(document.body.textContent).not.toContain("npm test");
  });

  it("states each permission in plain language so the decision stays informed", async () => {
    setupIpc();
    for (const [id, toolName, permission] of [
      ["req-r", "fs_read", "READ"],
      ["req-w", "fs_write", "WRITE"],
      ["req-e", "exec_run", "EXECUTE"],
      ["req-n", "http_fetch", "NETWORK"],
      ["req-d", "fs_delete", "DESTRUCTIVE"],
    ]) {
      pushApprovalRequest({ id, toolName, permission, requestedAt: 1_700_000_000_000 });
    }

    render(ApprovalQueue, { props: { profileId: 1, agentId: 42 } });

    const text = document.body.textContent;
    expect(text).toMatch(/read project data/i);
    expect(text).toMatch(/write files or state/i);
    expect(text).toMatch(/run a command/i);
    expect(text).toMatch(/reach the network/i);
    expect(text).toMatch(/destroy data/i);
  });

  it("does not invent a permission gloss when the permission is undeclared", async () => {
    setupIpc();
    pushApprovalRequest({
      id: "req-noperm",
      toolName: "mystery_tool",
      requestedAt: 1_700_000_000_000,
    });

    render(ApprovalQueue, { props: { profileId: 1, agentId: 42 } });

    const boundary = screen.getByTestId("approval-args-boundary");
    expect(boundary).toHaveTextContent(/undeclared/i);
  });
});

// ---------------------------------------------------------------------------
// Approve action
// ---------------------------------------------------------------------------

describe("ApprovalQueue — approve", () => {
  beforeEach(resetStore);
  afterEach(() => { cleanup(); window.careerflow = undefined; });

  it("removes the item from the queue and calls approveCall IPC when Approve is clicked", async () => {
    const { approveCall } = setupIpc();
    pushApprovalRequest({
      id: "req-1",
      toolName: "exec_run",
      input: { command: "npm test" },
      permission: "EXECUTE",
      requestedAt: 1_700_000_000_000,
    });

    render(ApprovalQueue, { props: { profileId: 1, agentId: 42 } });

    expect(screen.getByTestId("approval-row")).toBeInTheDocument();
    expect(screen.getByTestId("approval-queue-count")).toHaveTextContent("1 pending");

    const approveBtn = screen.getByTestId("approval-approve");
    await fireEvent.click(approveBtn);

    // The item is removed from the store
    expect(screen.getByTestId("approval-queue-empty")).toBeInTheDocument();
    expect(screen.getByTestId("approval-queue-count")).toHaveTextContent("0 pending");

    // The IPC channel was called with the right args
    expect(approveCall).toHaveBeenCalledTimes(1);
    expect(approveCall).toHaveBeenCalledWith(1, 42, "req-1");
  });

  it("generates a fallback id when the approval request has no id", async () => {
    const { approveCall } = setupIpc();
    pushApprovalRequest({
      toolName: "fs_read",
      input: { path: "README.md" },
      requestedAt: 1_700_000_000_000,
    });

    render(ApprovalQueue, { props: { profileId: 1, agentId: 42 } });

    await fireEvent.click(screen.getByTestId("approval-approve"));

    expect(approveCall).toHaveBeenCalledTimes(1);
    // The fallback id should be derived from toolName + requestedAt
    const calledWithId = approveCall.mock.calls[0][2];
    expect(calledWithId).toContain("fs_read");
    expect(calledWithId).toContain("1700000000000");
  });
});

// ---------------------------------------------------------------------------
// Deny action
// ---------------------------------------------------------------------------

describe("ApprovalQueue — deny", () => {
  beforeEach(resetStore);
  afterEach(() => { cleanup(); window.careerflow = undefined; });

  it("removes the item from the queue and calls denyCall IPC when Deny is clicked", async () => {
    const { denyCall } = setupIpc();
    pushApprovalRequest({
      id: "req-1",
      toolName: "exec_run",
      input: { command: "rm -rf /" },
      permission: "DESTRUCTIVE",
      requestedAt: 1_700_000_000_000,
    });

    render(ApprovalQueue, { props: { profileId: 1, agentId: 42 } });

    expect(screen.getByTestId("approval-row")).toBeInTheDocument();

    const denyBtn = screen.getByTestId("approval-deny");
    await fireEvent.click(denyBtn);

    // The item is removed from the store
    expect(screen.getByTestId("approval-queue-empty")).toBeInTheDocument();

    // The IPC channel was called with the right args
    expect(denyCall).toHaveBeenCalledTimes(1);
    expect(denyCall).toHaveBeenCalledWith(1, 42, "req-1");
  });
});
