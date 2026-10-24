// AgentErrorLog — UI tests.
//
// Coverage:
//   - renders one table row per failed run with when/goal/error/duration
//   - clicking a row expands the full error payload (JSON pretty-printed)
//   - the Retry button re-creates the same objective as a new agent
//   - Refresh + Limit controls re-fetch with the right arguments
//   - empty state when the service returns []

import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import AgentErrorLog from "../src/features/project-mode/components/AgentErrorLog.svelte";

// Mock the projectMode store so `createAndStartAgent` and
// `projectModeStore.activeProjectId` are testable without pulling
// in the full Svelte store graph.
vi.mock("../src/features/project-mode/stores/projectMode.svelte.js", () => {
  const activeProjectId = 10;
  return {
    projectModeStore: { activeProjectId, activeAgentId: null },
    createAndStartAgent: vi.fn().mockResolvedValue({ ok: true, agentId: 99 }),
  };
});
vi.mock("../src/shared/stores/toasts.svelte.js", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/shared/utils/errors.js", () => ({
  reportError: vi.fn(),
}));

import { createAndStartAgent } from "../src/features/project-mode/stores/projectMode.svelte.js";

const VERIFY_FAILED = {
  id: 1,
  project_id: 10,
  objective: "[coder] implement the retry feature in AgentErrorLog",
  state: "failed",
  created_at: "2026-08-30T11:28:00.000Z",
  updated_at: "2026-08-30T11:30:00.000Z",
  finished_at: "2026-08-30T11:30:00.000Z",
  tokens_in: 500,
  tokens_out: 200,
  error_message: "verify-failed",
  error_payload: JSON.stringify({
    name: "verify-failed",
    reason: "test-failed",
    exitCode: 1,
    output: "FAIL  tests/foo.test.js\n  >> TypeError: Cannot read properties of undefined",
    error: "verify:exit-1",
    fixAttempts: 3,
    exhausted: true,
    ts: 1756507200000,
  }),
  error_name: "verify-failed",
  error_ts: "2026-08-30T11:30:00.000Z",
};

const NO_DETAIL = {
  id: 2,
  project_id: 10,
  objective: "[researcher] survey architecture",
  state: "failed",
  created_at: "2026-08-30T12:00:00.000Z",
  updated_at: "2026-08-30T12:00:30.000Z",
  finished_at: "2026-08-30T12:00:30.000Z",
  tokens_in: 100,
  tokens_out: 50,
  error_message: "",
  error_payload: "",
  error_name: null,
  error_ts: null,
};

function setupIpc({ runs = [], errors = [] } = {}) {
  const listAgentErrors = vi.fn().mockResolvedValue(runs);
  window.careerflow = {
    projectMode: { listAgentErrors },
  };
  return { listAgentErrors };
}

beforeEach(() => {
  window.careerflow = undefined;
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("AgentErrorLog", () => {
  it("requests 50 errors by default and renders a row per failed run", async () => {
    const { listAgentErrors } = setupIpc({ runs: [VERIFY_FAILED, NO_DETAIL] });
    render(AgentErrorLog, { props: { profileId: 1 } });

    await waitFor(() => {
      expect(listAgentErrors).toHaveBeenCalledWith(1, null, 50);
    });

    const table = await screen.findByTestId("errlog-table");
    expect(table).toBeInTheDocument();
    expect(screen.getByTestId("errlog-row-1")).toBeInTheDocument();
    expect(screen.getByTestId("errlog-row-2")).toBeInTheDocument();
    expect(screen.getByTestId("errlog-goal-1")).toHaveTextContent(/retry feature/i);
    expect(screen.getByTestId("errlog-error-msg-1")).toHaveTextContent(/verify-failed/i);
  });

  it("shows the duration for a finished failed run", async () => {
    setupIpc({ runs: [VERIFY_FAILED] });
    render(AgentErrorLog, { props: { profileId: 1 } });

    // 11:28 -> 11:30 = 120s -> "2m 0s"
    expect(await screen.findByTestId("errlog-duration-1")).toHaveTextContent("2m 0s");
  });

  it("renders a '(no detail)' placeholder when the run has no status message", async () => {
    setupIpc({ runs: [NO_DETAIL] });
    render(AgentErrorLog, { props: { profileId: 1 } });

    const cell = await screen.findByTestId("errlog-error-msg-2");
    expect(cell).toHaveTextContent(/\(no detail\)/i);
  });

  it("expands the full error payload when a row is clicked", async () => {
    setupIpc({ runs: [VERIFY_FAILED] });
    render(AgentErrorLog, { props: { profileId: 1 } });

    await screen.findByTestId("errlog-row-1");

    // Detail row is not present before clicking.
    expect(screen.queryByTestId("errlog-detail-1")).not.toBeInTheDocument();

    await fireEvent.click(screen.getByTestId("errlog-row-1"));

    // Clicking expands the payload (JSON pretty-printed, includes the
    // test failure output and the exhausted flag).
    const detail = await screen.findByTestId("errlog-detail-1");
    expect(detail).toBeInTheDocument();
    expect(detail).toHaveTextContent(/implement the retry feature/i);
    expect(detail).toHaveTextContent(/TypeError: Cannot read properties of undefined/i);
    expect(detail).toHaveTextContent(/"exhausted": true/i);
  });

  it("Retry button re-creates the same objective as a new agent", async () => {
    setupIpc({ runs: [VERIFY_FAILED] });
    render(AgentErrorLog, { props: { profileId: 1 } });

    await screen.findByTestId("errlog-retry-1");

    // Click Retry — the row click is stopPropagation'd so the detail
    // row does not also open.
    await fireEvent.click(screen.getByTestId("errlog-retry-1"));

    await waitFor(() => {
      expect(createAndStartAgent).toHaveBeenCalledWith(
        1, // profileId
        10, // projectId (from the row's project_id)
        "[coder] implement the retry feature in AgentErrorLog",
      );
    });
  });

  it("Refresh re-fetches and the Limit dropdown re-fetches with the new limit", async () => {
    const { listAgentErrors } = setupIpc({ runs: [VERIFY_FAILED] });
    render(AgentErrorLog, { props: { profileId: 1 } });

    await screen.findByTestId("errlog-table");
    expect(listAgentErrors).toHaveBeenCalledTimes(1);

    // Refresh button re-fetches (still 50).
    await fireEvent.click(screen.getByTestId("errlog-refresh"));
    await waitFor(() => {
      expect(listAgentErrors).toHaveBeenCalledTimes(2);
    });

    // Changing the limit re-fetches with the new value.
    const select = screen.getByTestId("errlog-limit");
    await fireEvent.change(select, { target: { value: "100" } });
    await waitFor(() => {
      expect(listAgentErrors).toHaveBeenLastCalledWith(1, null, 100);
    });
  });

  it("renders an empty state when there are no failed runs", async () => {
    setupIpc({ runs: [] });
    render(AgentErrorLog, { props: { profileId: 1 } });

    expect(await screen.findByTestId("errlog-empty")).toHaveTextContent(/no failed agent runs/i);
    expect(screen.queryByTestId("errlog-table")).not.toBeInTheDocument();
  });
});
