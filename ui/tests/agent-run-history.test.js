// AgentRunHistory — UI tests.
//
// Coverage:
//   - renders one table row per run with started/duration/tokens/goal
//   - status pill class maps state -> green/red/yellow
//   - clicking a row expands the goal detail
//   - Refresh button re-fetches
//   - Limit dropdown re-fetches with the new limit
//   - empty state when the service returns []

import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import AgentRunHistory from "../src/features/project-mode/components/AgentRunHistory.svelte";

const COMPLETED = {
  id: 1,
  project_id: 10,
  objective: "[coder] implement agent run history view in the Project Mode panel",
  state: "completed",
  tokens_in: 3200,
  tokens_out: 800,
  finished_at: "2026-08-30T10:02:00.000Z",
  created_at: "2026-08-30T10:00:00.000Z",
  updated_at: "2026-08-30T10:02:00.000Z",
};
const FAILED = {
  id: 2,
  project_id: 10,
  objective: "[researcher] survey architecture",
  state: "failed",
  tokens_in: 500,
  tokens_out: 200,
  finished_at: "2026-08-30T11:30:00.000Z",
  created_at: "2026-08-30T11:28:00.000Z",
  updated_at: "2026-08-30T11:30:00.000Z",
};

function setupIpc({ runs = [] } = {}) {
  const listRecentAgentRuns = vi.fn().mockResolvedValue(runs);
  window.careerflow = {
    projectMode: { listRecentAgentRuns },
  };
  return { listRecentAgentRuns };
}

beforeEach(() => {
  window.careerflow = undefined;
});

afterEach(() => {
  cleanup();
});

describe("AgentRunHistory", () => {
  it("requests 50 runs by default and renders a row per run", async () => {
    const { listRecentAgentRuns } = setupIpc({ runs: [COMPLETED, FAILED] });
    render(AgentRunHistory, { props: { profileId: 1 } });

    await waitFor(() => {
      expect(listRecentAgentRuns).toHaveBeenCalledWith(1, 50);
    });

    const table = await screen.findByTestId("history-table");
    expect(table).toBeInTheDocument();
    expect(screen.getByTestId("history-row-1")).toBeInTheDocument();
    expect(screen.getByTestId("history-row-2")).toBeInTheDocument();
    expect(screen.getByTestId("history-goal-1")).toHaveTextContent(/agent run history view/i);
  });

  it("formats duration and tokens for finished runs", async () => {
    setupIpc({ runs: [COMPLETED] });
    render(AgentRunHistory, { props: { profileId: 1 } });

    // 10:00 -> 10:02 = 120s -> "2m 0s"
    expect(await screen.findByTestId("history-duration-1")).toHaveTextContent("2m 0s");
    // 3200 -> "3.2k", 800 stays as "800"
    expect(screen.getByTestId("history-tokens-in-1")).toHaveTextContent("3.2k");
    expect(screen.getByTestId("history-tokens-out-1")).toHaveTextContent("800");
  });

  it("maps state to the right status pill colour (green/red/yellow)", async () => {
    setupIpc({ runs: [COMPLETED, FAILED] });
    render(AgentRunHistory, { props: { profileId: 1 } });

    await screen.findByTestId("status-completed");
    const green = screen.getByTestId("status-completed").className;
    const red = screen.getByTestId("status-failed").className;
    expect(green).toContain("pill-green");
    expect(red).toContain("pill-red");
  });

  it("expands the goal detail when a row is clicked", async () => {
    setupIpc({ runs: [COMPLETED] });
    render(AgentRunHistory, { props: { profileId: 1 } });

    await screen.findByTestId("history-row-1");

    // Detail row is not present before clicking.
    expect(screen.queryByTestId("history-detail-1")).not.toBeInTheDocument();

    await fireEvent.click(screen.getByTestId("history-row-1"));

    // Clicking expands the full objective.
    const detail = await screen.findByTestId("history-detail-1");
    expect(detail).toBeInTheDocument();
    expect(detail).toHaveTextContent(/implement agent run history view/i);
  });

  it("Refresh re-fetches and the Limit dropdown re-fetches with the new limit", async () => {
    const { listRecentAgentRuns } = setupIpc({ runs: [COMPLETED] });
    render(AgentRunHistory, { props: { profileId: 1 } });

    await screen.findByTestId("history-table");
    expect(listRecentAgentRuns).toHaveBeenCalledTimes(1);

    // Refresh button re-fetches (still 50).
    await fireEvent.click(screen.getByTestId("history-refresh"));
    await waitFor(() => {
      expect(listRecentAgentRuns).toHaveBeenCalledTimes(2);
    });

    // Changing the limit re-fetches with the new value.
    const select = screen.getByTestId("history-limit");
    await fireEvent.change(select, { target: { value: "100" } });
    await waitFor(() => {
      expect(listRecentAgentRuns).toHaveBeenLastCalledWith(1, 100);
    });
  });

  it("renders an empty state when there are no runs", async () => {
    setupIpc({ runs: [] });
    render(AgentRunHistory, { props: { profileId: 1 } });

    expect(await screen.findByTestId("history-empty")).toHaveTextContent(/no agent runs yet/i);
    expect(screen.queryByTestId("history-table")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// D13 — NATIVE (camelCase) rows.
//
// `agent:list-recent` returns RAW napi rows (`createdAt`, `tokensIn`,
// `finishedAt`). The fixtures above are the LEGACY snake_case shape, which is
// why the snake-only reads here never failed a test while every real run
// rendered "—" for its start time, duration and token counts.
// ---------------------------------------------------------------------------

describe("AgentRunHistory — native (camelCase) rows", () => {
  const NATIVE_DONE = {
    id: 11,
    projectId: 10,
    objective: "[coder] native shape run",
    state: "completed",
    tokensIn: 3200,
    tokensOut: 800,
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:02:00.000Z",
    finishedAt: "2026-08-30T10:02:00.000Z",
  };

  it("formats duration, tokens and project from the camelCase fields", async () => {
    setupIpc({ runs: [NATIVE_DONE] });
    render(AgentRunHistory, { props: { profileId: 1 } });

    expect(await screen.findByTestId("history-duration-11")).toHaveTextContent("2m 0s");
    expect(screen.getByTestId("history-tokens-in-11")).toHaveTextContent("3.2k");
    expect(screen.getByTestId("history-tokens-out-11")).toHaveTextContent("800");

    await fireEvent.click(screen.getByTestId("history-row-11"));
    const detail = await screen.findByTestId("history-detail-11");
    expect(detail).toHaveTextContent("#10");
  });

  it("still shows elapsed time for an in-flight run (native rows omit finishedAt)", async () => {
    setupIpc({ runs: [{ ...NATIVE_DONE, id: 12, state: "running", finishedAt: undefined }] });
    render(AgentRunHistory, { props: { profileId: 1 } });

    const duration = await screen.findByTestId("history-duration-12");
    expect(duration.textContent).not.toBe("—");
  });
});
