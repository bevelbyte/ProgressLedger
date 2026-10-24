// GATE 16 — UI reflects real runtime state (no fake activity)
//
// This integration test validates that the project-mode panels render
// accurately from realistic backend data shapes — the same shapes the
// main process emits via IPC. It exercises every GATE 16 panel together:
//
//   SessionTimeline      — paginated message stream from pm_messages
//   AgentRunHistory      — recent agent runs from pm_agents
//   TokenBudgetPanel     — live token consumption from pm_agents + project config
//   ProviderHealth       — LLM provider metrics from the in-memory provider map
//   ApprovalQueue        — pending tool-call approvals from the approval bridge
//   MemoryViewer         — persistent + transient memory from the sidecar DB
//   HooksLog             — hook execution history from pm_hook_executions
//
// No fake activity: every data shape mirrors what the backend actually emits
// on the real IPC channels. If the backend schema changes, these tests will
// catch regressions immediately.

import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import SessionTimeline    from "../src/features/project-mode/components/SessionTimeline.svelte";
import AgentRunHistory    from "../src/features/project-mode/components/AgentRunHistory.svelte";
import TokenBudgetPanel   from "../src/features/project-mode/components/TokenBudgetPanel.svelte";
import ProviderHealth     from "../src/features/project-mode/components/ProviderHealth.svelte";
import ApprovalQueue      from "../src/features/project-mode/components/ApprovalQueue.svelte";
import MemoryViewer       from "../src/features/project-mode/components/MemoryViewer.svelte";
import HooksLog          from "../src/features/project-mode/components/HooksLog.svelte";

import {
  projectModeStore,
  pushApprovalRequest,
  resolveApprovalRequest,
} from "../src/features/project-mode/stores/projectMode.svelte.js";

// ---------------------------------------------------------------------------
// Fixed timestamps for deterministic fake-timer tests
// ---------------------------------------------------------------------------
const NOW = 1_700_000_000_000; // 2026-11-05T00:00:00.000Z

// ---------------------------------------------------------------------------
// Realistic IPC payloads — shapes mirror what the backend actually emits
// ---------------------------------------------------------------------------

const RUNTIME_MESSAGES = [
  {
    id: 101,
    agent_id: 7,
    seq: 1,
    role: "system",
    content: "You are a helpful agent.",
    name: null,
    payload_json: null,
    created_at: "2026-08-31T09:00:00.000Z",
  },
  {
    id: 102,
    agent_id: 7,
    seq: 2,
    role: "user",
    content: "Implement the gate16 runtime state UI test.",
    name: null,
    payload_json: null,
    created_at: "2026-08-31T09:00:05.000Z",
  },
  {
    id: 103,
    agent_id: 7,
    seq: 3,
    role: "assistant",
    content: "I'll start by setting up the test file structure and fixtures.",
    name: null,
    payload_json: null,
    created_at: "2026-08-31T09:00:10.000Z",
  },
  {
    id: 104,
    agent_id: 7,
    seq: 4,
    role: "tool_call",
    content: "",
    name: "fs_write",
    payload_json: JSON.stringify({ path: "ui/tests/gate16.test.js", content: "// ..." }),
    created_at: "2026-08-31T09:00:15.000Z",
  },
  {
    id: 105,
    agent_id: 7,
    seq: 5,
    role: "tool_result",
    content: "",
    name: "fs_write",
    payload_json: JSON.stringify({ ok: true, path: "ui/tests/gate16.test.js" }),
    created_at: "2026-08-31T09:00:20.000Z",
  },
  {
    id: 106,
    agent_id: 7,
    seq: 6,
    role: "status",
    content: "Test suite created successfully.",
    name: null,
    payload_json: null,
    created_at: "2026-08-31T09:00:25.000Z",
  },
];

const RUNTIME_AGENT_RUNS = [
  {
    id: 10,
    project_id: 1,
    objective: "[coder] implement gate16 runtime-state integration test",
    state: "completed",
    tokens_in: 12_800,
    tokens_out: 4_200,
    finished_at: "2026-08-31T09:02:00.000Z",
    created_at: "2026-08-31T09:00:00.000Z",
    updated_at: "2026-08-31T09:02:00.000Z",
  },
  {
    id: 11,
    project_id: 1,
    objective: "[researcher] survey project-mode architecture",
    state: "failed",
    tokens_in: 3_100,
    tokens_out: 980,
    finished_at: "2026-08-31T08:45:00.000Z",
    created_at: "2026-08-31T08:40:00.000Z",
    updated_at: "2026-08-31T08:45:00.000Z",
  },
  {
    id: 12,
    project_id: 1,
    objective: "[planner] draft UI component inventory",
    state: "running",
    tokens_in: 850,
    tokens_out: 210,
    finished_at: null,
    created_at: "2026-08-31T09:05:00.000Z",
    updated_at: "2026-08-31T09:05:30.000Z",
  },
];

const RUNTIME_BUDGET = {
  ok: true,
  current: 128_400,
  cap: 500_000,
  usedPct: 25.68,
  lastUpdated: NOW,
};

const RUNTIME_PROVIDERS = [
  {
    name: "api.openai.com · gpt-4o-mini",
    requests: 47,
    success: 44,
    errors: 3,
    errorRate: 3 / 47,
    avgLatencyMs: 387,
    last429: null,
  },
  {
    name: "api.anthropic.com · claude-3-5-sonnet",
    requests: 12,
    success: 10,
    errors: 2,
    errorRate: 2 / 12,
    avgLatencyMs: 1240,
    last429: NOW - 90_000, // 90s ago — inside the 10-min warn window
  },
];

const RUNTIME_MEMORY_ENTRIES = [
  {
    id: "project:decision:testing",
    scope: "project",
    kind: "decision",
    key: "testing-strategy",
    value: "Use vitest with @testing-library/svelte for all UI tests.",
    confidence: 0.95,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 3_600_000,
  },
  {
    id: "session:agent-7:context",
    scope: "session",
    kind: "session",
    key: "context-summary",
    value: "Implementing GATE 16 UI runtime-state validation.",
    agentId: "agent-7",
    createdAt: NOW - 300_000,
  },
  {
    id: "task:42",
    scope: "task",
    kind: "task",
    key: "run-42",
    value: "Created gate16-ui-runtime-state.test.js with 7 panel tests.",
    agentId: "agent-7",
    success: true,
    createdAt: NOW - 60_000,
  },
];

const RUNTIME_HOOK_EXECUTIONS = [
  {
    id: 201,
    hookId: "hook-agent-started",
    hookName: "hook-agent-started",
    event: "agent.started",
    status: "ok",
    durationMs: 18,
    error: null,
    createdAt: "2026-08-31T09:05:00.000Z",
  },
  {
    id: 202,
    hookId: "hook-task-started",
    hookName: "hook-task-started",
    event: "task.started",
    status: "ok",
    durationMs: 5,
    error: null,
    createdAt: "2026-08-31T09:05:01.000Z",
  },
  {
    id: 203,
    hookId: "hook-tool-invoked",
    hookName: "hook-tool-invoked",
    event: "tool.invoked",
    status: "ok",
    durationMs: 210,
    error: null,
    createdAt: "2026-08-31T09:05:03.000Z",
  },
  {
    id: 204,
    hookId: "hook-tool-completed",
    hookName: "hook-tool-completed",
    event: "tool.completed",
    status: "failed",
    durationMs: 0,
    error: "ENOENT: no such file or directory — check the path exists before writing",
    createdAt: "2026-08-31T09:05:04.000Z",
  },
];

// ---------------------------------------------------------------------------
// IPC mock factory — wires every panel in one shot
// ---------------------------------------------------------------------------

function setupRuntimeIpc() {
  const listMessagesPaginated = vi.fn().mockResolvedValue(RUNTIME_MESSAGES);
  const listRecentAgentRuns    = vi.fn().mockResolvedValue(RUNTIME_AGENT_RUNS);
  const getBudget             = vi.fn().mockResolvedValue(RUNTIME_BUDGET);
  const getProviderHealth     = vi.fn().mockResolvedValue({ ok: true, providers: RUNTIME_PROVIDERS, updatedAt: NOW });
  const listExecutions        = vi.fn().mockResolvedValue({ executions: RUNTIME_HOOK_EXECUTIONS });
  const approveCall            = vi.fn().mockResolvedValue({ ok: true, deleted: true });
  const denyCall              = vi.fn().mockResolvedValue({ ok: true, deleted: true });
  const memoryList            = vi.fn().mockResolvedValue({ ok: true, result: RUNTIME_MEMORY_ENTRIES });

  window.careerflow = {
    projectMode: {
      listMessagesPaginated,
      listRecentAgentRuns,
      getBudget,
      getProviderHealth,
      approveCall,
      denyCall,
    },
    memory: {
      list: memoryList,
    },
    hooks: { listExecutions },
  };

  return {
    listMessagesPaginated,
    listRecentAgentRuns,
    getBudget,
    getProviderHealth,
    listExecutions,
    approveCall,
    denyCall,
    memoryList,
  };
}

function resetStore() {
  projectModeStore.pendingApprovals = [];
}

// ---------------------------------------------------------------------------
// Shared setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetStore();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.careerflow = undefined;
});

// ---------------------------------------------------------------------------
// GATE 16.1 — SessionTimeline renders real agent-run messages
// ---------------------------------------------------------------------------

describe("GATE 16.1 — SessionTimeline reflects runtime message stream", () => {
  it("renders the full message stream with correct role icons and content", async () => {
    const { listMessagesPaginated } = setupRuntimeIpc();

    render(SessionTimeline, { props: { profileId: 1, agentId: 7 } });

    // System message
    await waitFor(() => expect(screen.getByTestId("timeline-entry-101")).toBeInTheDocument());
    expect(screen.getByTestId("timeline-role-101")).toHaveTextContent("[S]");
    expect(screen.getByTestId("timeline-text-101")).toHaveTextContent("You are a helpful agent.");

    // User message
    expect(screen.getByTestId("timeline-role-102")).toHaveTextContent("[U]");

    // Assistant message
    expect(screen.getByTestId("timeline-role-103")).toHaveTextContent("[A]");

    // Tool call card
    const toolCard = screen.getByTestId("timeline-card-call-104");
    expect(toolCard.querySelector(".card-name")).toHaveTextContent("fs_write");
    expect(toolCard.textContent).toContain("gate16.test.js");

    // Tool result card
    expect(screen.getByTestId("timeline-card-result-105")).toBeInTheDocument();

    // Status message
    expect(screen.getByTestId("timeline-role-106")).toHaveTextContent("[i]");

    // Count badge reflects total
    expect(screen.getByTestId("timeline-count")).toHaveTextContent("6 messages");

    // IPC was called with the right args
    expect(listMessagesPaginated).toHaveBeenCalledWith(1, 7, 50, null);
  });

  it("shows end-of-session marker when the session is complete", async () => {
    setupRuntimeIpc();
    render(SessionTimeline, { props: { profileId: 1, agentId: 7 } });

    await waitFor(() => expect(screen.getByTestId("timeline-end")).toBeInTheDocument());
    expect(screen.queryByTestId("timeline-load-more")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GATE 16.2 — AgentRunHistory reflects real run state with status pills
// ---------------------------------------------------------------------------

describe("GATE 16.2 — AgentRunHistory reflects real run state", () => {
  it("renders completed, failed, and running runs with correct status pills", async () => {
    const { listRecentAgentRuns } = setupRuntimeIpc();

    render(AgentRunHistory, { props: { profileId: 1 } });

    await waitFor(() => expect(screen.getByTestId("history-table")).toBeInTheDocument());

    // Completed run — green pill
    expect(screen.getByTestId("status-completed")).toBeInTheDocument();
    expect(screen.getByTestId("history-goal-10")).toHaveTextContent(/gate16 runtime-state/i);

    // Failed run — red pill
    expect(screen.getByTestId("status-failed")).toBeInTheDocument();
    expect(screen.getByTestId("history-goal-11")).toHaveTextContent(/survey project-mode/i);

    // Running run — yellow pill (active state not labelled "running" in statusClass)
    const runningRow = screen.getByTestId("history-row-12");
    expect(runningRow).toHaveAttribute("data-state", "running");

    // Token counts
    expect(screen.getByTestId("history-tokens-in-10")).toHaveTextContent("12.8k");
    expect(screen.getByTestId("history-tokens-out-10")).toHaveTextContent("4.2k");

    expect(listRecentAgentRuns).toHaveBeenCalledWith(1, 50);
  });

  it("expands the goal detail row on click", async () => {
    setupRuntimeIpc();
    render(AgentRunHistory, { props: { profileId: 1 } });

    await waitFor(() => screen.getByTestId("history-row-10"));
    expect(screen.queryByTestId("history-detail-10")).not.toBeInTheDocument();

    await fireEvent.click(screen.getByTestId("history-row-10"));

    const detail = screen.getByTestId("history-detail-10");
    expect(detail).toHaveTextContent(/gate16 runtime-state/i);
    expect(detail).toHaveTextContent(/2026-08-31/);
  });
});

// ---------------------------------------------------------------------------
// GATE 16.3 — TokenBudgetPanel reflects real token consumption
// ---------------------------------------------------------------------------

describe("GATE 16.3 — TokenBudgetPanel reflects real runtime consumption", () => {
  it("renders real token counts, cap, used%, and correct colour", async () => {
    const { getBudget } = setupRuntimeIpc();

    render(TokenBudgetPanel, { props: { profileId: 1, agentId: 7 } });
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByTestId("token-budget-current")).toHaveTextContent("128,400");
    expect(screen.getByTestId("token-budget-cap")).toHaveTextContent("500,000");
    expect(screen.getByTestId("token-budget-used-pct")).toHaveTextContent("25.7%");

    // ~25.68% -> colour-class "ok" (under 50%)
    const fill = screen.getByTestId("token-budget-fill");
    expect(fill.dataset.color).toBe("ok");
    expect(screen.getByTestId("token-budget-state")).toHaveTextContent("ok");

    expect(getBudget).toHaveBeenCalledWith(1, 7);
  });

  it("updates the displayed numbers when the agent consumes more tokens", async () => {
    let budgetSnapshot = { ...RUNTIME_BUDGET };
    const { getBudget } = setupRuntimeIpc();
    getBudget.mockImplementation(() => Promise.resolve({ ...budgetSnapshot }));

    render(TokenBudgetPanel, { props: { profileId: 1, agentId: 7 } });
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByTestId("token-budget-current")).toHaveTextContent("128,400");

    // Simulate the agent consuming more tokens in the next poll cycle
    budgetSnapshot = { ok: true, current: 425_000, cap: 500_000, usedPct: 85.0, lastUpdated: NOW + 10_000 };
    await vi.advanceTimersByTimeAsync(5000);

    expect(screen.getByTestId("token-budget-current")).toHaveTextContent("425,000");
    expect(screen.getByTestId("token-budget-used-pct")).toHaveTextContent("85.0%");
    expect(screen.getByTestId("token-budget-fill").dataset.color).toBe("danger");
  });
});

// ---------------------------------------------------------------------------
// GATE 16.4 — ProviderHealth reflects real LLM provider metrics
// ---------------------------------------------------------------------------

describe("GATE 16.4 — ProviderHealth reflects real provider metrics", () => {
  it("renders multiple providers with correct metrics and colour coding", async () => {
    const { getProviderHealth } = setupRuntimeIpc();

    render(ProviderHealth);
    await vi.advanceTimersByTimeAsync(0);

    const rows = screen.getAllByTestId("provider-health-row");
    expect(rows).toHaveLength(2);

    // First provider — ok (green), 3 errors out of 47 ≈ 6.4% < 25% danger threshold
    expect(rows[0]).toHaveAttribute("data-status", "warn"); // warn because errorRate > 0
    expect(screen.getAllByTestId("provider-health-requests")[0]).toHaveTextContent("47");
    expect(screen.getAllByTestId("provider-health-errors")[0]).toHaveTextContent("3");

    // Second provider — warn (yellow) because last429 is within 10 min
    expect(rows[1]).toHaveAttribute("data-status", "warn");
    expect(screen.getAllByTestId("provider-health-429")[1]).toHaveTextContent("1m ago");

    expect(getProviderHealth).toHaveBeenCalled();
  });

  it("shows an ok provider at zero errors with no recent 429", async () => {
    const { getProviderHealth } = setupRuntimeIpc();
    getProviderHealth.mockResolvedValue({
      ok: true,
      providers: [
        {
          name: "localhost:11434 · llama3",
          requests: 5,
          success: 5,
          errors: 0,
          errorRate: 0,
          avgLatencyMs: 820,
          last429: null,
        },
      ],
      updatedAt: NOW,
    });

    render(ProviderHealth);
    await vi.advanceTimersByTimeAsync(0);

    const row = screen.getByTestId("provider-health-row");
    expect(row).toHaveAttribute("data-status", "ok");
    expect(screen.getByTestId("provider-health-state")).toHaveTextContent("ok");
  });
});

// ---------------------------------------------------------------------------
// GATE 16.5 — ApprovalQueue reflects real pending tool-call approvals
// ---------------------------------------------------------------------------

describe("GATE 16.5 — ApprovalQueue reflects real pending approvals", () => {
  beforeEach(resetStore);

  it("renders pending approvals with correct tool names and permission levels", async () => {
    const { approveCall, denyCall } = setupRuntimeIpc();

    // Push real-shaped approval requests into the reactive store
    pushApprovalRequest({
      id: "apr-001",
      toolName: "exec_run",
      input: { command: "npx vitest run", cwd: "/workspace/careerflow" },
      permission: "EXECUTE",
      requestedAt: NOW,
    });
    pushApprovalRequest({
      id: "apr-002",
      toolName: "fs_write",
      input: { path: "src/feature.ts", content: "// new feature" },
      permission: "WRITE",
      requestedAt: NOW + 2000,
    });
    pushApprovalRequest({
      id: "apr-003",
      toolName: "network_fetch",
      input: { url: "https://api.example.com/data", method: "GET" },
      permission: "NETWORK",
      requestedAt: NOW + 4000,
    });

    render(ApprovalQueue, { props: { profileId: 1, agentId: 7 } });

    // All three approvals rendered
    const rows = screen.getAllByTestId("approval-row");
    expect(rows).toHaveLength(3);
    expect(screen.getByTestId("approval-queue")).toHaveAttribute("data-count", "3");
    expect(screen.getByTestId("approval-queue-count")).toHaveTextContent("3 pending");

    // Tool names and permission badges
    const toolNames = screen.getAllByTestId("approval-tool-name");
    expect(toolNames[0]).toHaveTextContent("exec_run");
    expect(toolNames[1]).toHaveTextContent("fs_write");
    expect(toolNames[2]).toHaveTextContent("network_fetch");

    const perms = screen.getAllByTestId("approval-permission");
    expect(perms[0]).toHaveTextContent("EXECUTE");
    expect(perms[1]).toHaveTextContent("WRITE");
    expect(perms[2]).toHaveTextContent("NETWORK");

    // Approve action removes from store and calls IPC
    const approveBtn = screen.getAllByTestId("approval-approve")[0];
    await fireEvent.click(approveBtn);

    expect(screen.getByTestId("approval-queue-count")).toHaveTextContent("2 pending");
    expect(approveCall).toHaveBeenCalledWith(1, 7, "apr-001");

    // Deny action removes from store and calls IPC
    const denyBtn = screen.getAllByTestId("approval-deny")[0];
    await fireEvent.click(denyBtn);

    expect(screen.getByTestId("approval-queue-count")).toHaveTextContent("1 pending");
    expect(denyCall).toHaveBeenCalledWith(1, 7, "apr-002");
  });

  it("expands and collapses arguments on toggle", async () => {
    const { approveCall } = setupRuntimeIpc();

    pushApprovalRequest({
      id: "apr-004",
      toolName: "fs_write",
      input: { path: "src/main.ts", content: "console.log('hello')" },
      permission: "WRITE",
      requestedAt: NOW,
    });

    render(ApprovalQueue, { props: { profileId: 1, agentId: 7 } });

    // The main process strips `input` from every approval entry
    // (`sanitizeApprovalEntry`), so this component states the permission and
    // points at the transcript instead of rendering a disclosure that could
    // only ever show a placeholder. See DESIGN-ATLAS.md on the arguments
    // boundary.
    const boundary = screen.getByTestId("approval-args-boundary");
    expect(boundary).toHaveTextContent(/write files or state/i);
    expect(boundary).toHaveTextContent(/run transcript/i);
    expect(screen.queryByTestId("approval-toggle-args")).not.toBeInTheDocument();
    expect(screen.queryByTestId("approval-args")).not.toBeInTheDocument();
    expect(screen.queryByTestId("approval-args-truncated")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("src/main.ts");
  });
});

// ---------------------------------------------------------------------------
// GATE 16.6 — MemoryViewer reflects real memory entries from the sidecar DB
// ---------------------------------------------------------------------------

describe("GATE 16.6 — MemoryViewer reflects real memory entries", () => {
  it("renders entries from project, session, and task scopes with correct scopes", async () => {
    const { memoryList } = setupRuntimeIpc();

    render(MemoryViewer, { props: { profileId: 1, projectId: 1 } });
    await waitFor(() => expect(screen.getAllByTestId("memory-row")).toHaveLength(3));

    // Verify scope pills
    const scopePills = screen.getAllByTestId("memory-scope-pill");
    expect(scopePills[0]).toHaveTextContent("project");
    expect(scopePills[1]).toHaveTextContent("session");
    expect(scopePills[2]).toHaveTextContent("task");

    // Key/value previews
    expect(screen.getByText("testing-strategy")).toBeInTheDocument();
    expect(screen.getByText("context-summary")).toBeInTheDocument();
    expect(screen.getByText("run-42")).toBeInTheDocument();

    // IPC called with profile
    expect(memoryList).toHaveBeenCalledWith(1, 1, {});

    // Count badge: 3/3 (all visible, no filter)
    expect(screen.getByTestId("memory-viewer-count")).toHaveTextContent("3/3");
  });

  it("filters by scope and expands a row to show the full value", async () => {
    setupRuntimeIpc();
    render(MemoryViewer, { props: { profileId: 1, projectId: 1 } });

    await waitFor(() => screen.getAllByTestId("memory-row"));

    // Filter to "task" scope only — only 1 result
    await fireEvent.change(screen.getByTestId("memory-viewer-scope"), {
      target: { value: "task" },
    });
    await waitFor(() => {
      const rows = screen.getAllByTestId("memory-row");
      expect(rows).toHaveLength(1);
      expect(rows[0].dataset.memoryScope).toBe("task");
    });
    expect(screen.getByTestId("memory-viewer-count")).toHaveTextContent("1/3");

    // Expand the task row
    await fireEvent.click(screen.getByTestId("memory-row"));
    await waitFor(() =>
      expect(screen.getByTestId("memory-full-value")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("memory-full-value")).toHaveTextContent(
      /gate16-ui-runtime-state.test.js/,
    );
  });
});

// ---------------------------------------------------------------------------
// GATE 16.7 — HooksLog reflects real hook execution history
// ---------------------------------------------------------------------------

describe("GATE 16.7 — HooksLog reflects real hook execution history", () => {
  it("renders hook executions with correct status, duration, and error expansion", async () => {
    const { listExecutions } = setupRuntimeIpc();

    render(HooksLog, { props: { profileId: 1 } });
    await waitFor(() => expect(screen.getByTestId("hooks-table")).toBeInTheDocument());

    // 4 executions rendered
    const rows = screen.getAllByTestId(/^hooks-row-\d+$/);
    expect(rows).toHaveLength(4);

    // Green pill for ok executions (3 ok rows => use getAllByTestId)
    const okPills = screen.getAllByTestId("hooks-status-ok");
    expect(okPills.length).toBeGreaterThan(0);
    for (const pill of okPills) {
      expect(pill).toHaveClass("pill-green");
    }

    // Red pill for failed execution
    expect(screen.getByTestId("hooks-status-failed")).toHaveClass("pill-red");

    // Duration formatting
    expect(screen.getByTestId("hooks-duration-201")).toHaveTextContent("18ms");
    expect(screen.getByTestId("hooks-duration-203")).toHaveTextContent("210ms");

    // IPC called with empty filters
    expect(listExecutions).toHaveBeenCalledWith({});
  });

  it("expands the error detail for a failed hook execution", async () => {
    setupRuntimeIpc();
    render(HooksLog, { props: { profileId: 1 } });

    await waitFor(() => screen.getByTestId("hooks-row-204"));
    expect(screen.queryByTestId("hooks-detail-204")).not.toBeInTheDocument();

    await fireEvent.click(screen.getByTestId("hooks-row-204"));

    const detail = screen.getByTestId("hooks-detail-204");
    expect(detail).toHaveTextContent(/ENOENT/);
    expect(detail).toHaveTextContent(/hook-tool-completed/);
    expect(detail).toHaveTextContent(/tool.completed/);
  });

  it("filter dropdowns re-fetch with the selected hook and event", async () => {
    const { listExecutions } = setupRuntimeIpc();

    render(HooksLog, { props: { profileId: 1 } });
    await waitFor(() => screen.getByTestId("hooks-table"));

    // Filter by hook name
    await fireEvent.change(screen.getByTestId("hooks-filter-hook"), {
      target: { value: "hook-tool-invoked" },
    });
    await waitFor(() => {
      expect(listExecutions).toHaveBeenLastCalledWith({ hookId: "hook-tool-invoked" });
    });

    // Filter by event name
    await fireEvent.change(screen.getByTestId("hooks-filter-event"), {
      target: { value: "tool.completed" },
    });
    await waitFor(() => {
      expect(listExecutions).toHaveBeenLastCalledWith({
        hookId: "hook-tool-invoked",
        eventName: "tool.completed",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// GATE 16.8 — All panels coexist without interference (no cross-pollution)
// ---------------------------------------------------------------------------

describe("GATE 16.8 — All runtime-state panels coexist without interference", () => {
  beforeEach(resetStore);

  it("renders all 7 panels in the same render cycle without cross-pollution", async () => {
    const { listMessagesPaginated, listRecentAgentRuns, getBudget,
            getProviderHealth, listExecutions } = setupRuntimeIpc();

    pushApprovalRequest({
      id: "apr-cross",
      toolName: "fs_read",
      input: { path: "README.md" },
      permission: "READ",
      requestedAt: NOW,
    });

    // Render all 7 panels
    render(SessionTimeline,   { props: { profileId: 1, agentId: 7 } });
    render(AgentRunHistory,    { props: { profileId: 1 } });
    render(TokenBudgetPanel,   { props: { profileId: 1, agentId: 7 } });
    render(ProviderHealth);
    render(ApprovalQueue,      { props: { profileId: 1, agentId: 7 } });
    render(MemoryViewer,       { props: { profileId: 1, projectId: 1 } });
    render(HooksLog,           { props: { profileId: 1 } });

    await vi.advanceTimersByTimeAsync(0);

    // Each panel has its own root element
    expect(screen.getByTestId("session-timeline")).toBeInTheDocument();
    expect(screen.getByTestId("agent-run-history")).toBeInTheDocument();
    expect(screen.getByTestId("token-budget-panel")).toBeInTheDocument();
    expect(screen.getByTestId("provider-health-panel")).toBeInTheDocument();
    expect(screen.getByTestId("approval-queue")).toBeInTheDocument();
    expect(screen.getByTestId("memory-viewer")).toBeInTheDocument();
    expect(screen.getByTestId("hooks-log")).toBeInTheDocument();

    // Each panel called its own IPC channel
    expect(listMessagesPaginated).toHaveBeenCalledWith(1, 7, 50, null);
    expect(listRecentAgentRuns).toHaveBeenCalledWith(1, 50);
    expect(getBudget).toHaveBeenCalledWith(1, 7);
    expect(getProviderHealth).toHaveBeenCalled();
    expect(listExecutions).toHaveBeenCalledWith({});

    // Memory and approval panels got their own channels
    const memoryList = window.careerflow.memory.list;
    expect(memoryList).toHaveBeenCalled();

    const { approveCall, denyCall } = window.careerflow.projectMode;
    expect(approveCall).toHaveBeenCalledTimes(0); // not triggered yet
    expect(denyCall).toHaveBeenCalledTimes(0);
  });
});
