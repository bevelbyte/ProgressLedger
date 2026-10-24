// ShellHistoryFilter — UI tests.
//
// Coverage:
//   - renders shell:exec events returned by audit:list-events on mount
//   - table shows timestamp, command, exit_code, duration per row
//   - command substring filter narrows the visible rows (client-side)
//   - Refresh button re-fetches with the current filter values
//   - date-range inputs are passed through as since/until timestamps
//   - graceful degradation when the audit namespace is unavailable
//   - empty-state when the server returns no events

import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import ShellHistoryFilter from "../src/features/project-mode/components/ShellHistoryFilter.svelte";

// Sample shell:exec audit events (mirror the shape produced by exec_run.js).
const SAMPLE_EVENTS = [
  {
    ts: 1_725_000_000_000,
    event: "shell:exec",
    profileId: 1,
    projectId: 2,
    agentId: 3,
    tool: "exec_run",
    input_summary: "git status --short",
    result: "0",
    durationMs: 120,
    detail: null,
  },
  {
    ts: 1_725_001_000_000,
    event: "shell:exec",
    profileId: 1,
    projectId: 2,
    agentId: 3,
    tool: "exec_run",
    input_summary: "npm test -- --verbose",
    result: "1",
    durationMs: 5_400,
    detail: null,
  },
  {
    ts: 1_725_002_000_000,
    event: "shell:exec",
    profileId: 1,
    projectId: 2,
    agentId: 3,
    tool: "exec_run",
    input_summary: "git commit -m fix",
    result: "0",
    durationMs: 300,
    detail: null,
  },
];

/** Install a mocked window.careerflow.audit namespace. */
function setupAudit({ events = SAMPLE_EVENTS, listEventsImpl } = {}) {
  const listEvents = listEventsImpl
    ? listEventsImpl
    : vi.fn().mockResolvedValue({ ok: true, events });
  window.careerflow = { audit: { listEvents } };
  return { listEvents };
}

beforeEach(() => {
  window.careerflow = undefined;
});

afterEach(() => {
  cleanup();
});

describe("ShellHistoryFilter", () => {
  it("fetches shell:exec events from audit:list-events on mount", async () => {
    const { listEvents } = setupAudit();

    render(ShellHistoryFilter, { profileId: 1 });

    await screen.findByTestId("shell-history-table");
    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(listEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "shell:exec",
        profileId: 1,
      })
    );
    expect(listEvents.mock.calls[0][0]).toHaveProperty("limit");
  });

  it("renders timestamp, command, exit_code and duration for each event", async () => {
    setupAudit();

    render(ShellHistoryFilter, { profileId: 1 });
    await screen.findByTestId("shell-history-table");

    const rows = screen.getAllByTestId("shell-history-row");
    expect(rows).toHaveLength(3);

    // First row: git status --short, exit 0, 120ms
    expect(screen.getAllByTestId("shell-history-row-cmd")[0]).toHaveTextContent("git status --short");
    expect(screen.getAllByTestId("shell-history-row-code")[0]).toHaveTextContent("0");
    expect(screen.getAllByTestId("shell-history-row-duration")[0]).toHaveTextContent("120ms");
    // Timestamp column is populated
    expect(screen.getAllByTestId("shell-history-row-ts")[0]).not.toHaveTextContent("");
  });

  it("formats multi-second durations as 'Xs' or 'Xm Ys'", async () => {
    setupAudit();

    render(ShellHistoryFilter, { profileId: 1 });
    await screen.findByTestId("shell-history-table");

    // Row 2: 5400ms → "5s"
    expect(screen.getAllByTestId("shell-history-row-duration")[1]).toHaveTextContent("5s");
    // Row 3: 300ms → "300ms"
    expect(screen.getAllByTestId("shell-history-row-duration")[2]).toHaveTextContent("300ms");
  });

  it("filters rows by command substring (client-side, no extra IPC)", async () => {
    const { listEvents } = setupAudit();

    render(ShellHistoryFilter, { profileId: 1 });
    await screen.findByTestId("shell-history-table");

    // All 3 rows visible initially
    expect(screen.getAllByTestId("shell-history-row")).toHaveLength(3);
    expect(listEvents).toHaveBeenCalledTimes(1);

    // Type "git" → only 2 rows (git status, git commit)
    fireEvent.input(screen.getByTestId("shell-history-command"), { target: { value: "git" } });

    await waitFor(() => {
      expect(screen.getAllByTestId("shell-history-row")).toHaveLength(2);
    });
    // No new IPC call — the filter is purely client-side.
    expect(listEvents).toHaveBeenCalledTimes(1);
  });

  it("shows no-match state when substring matches nothing", async () => {
    setupAudit();

    render(ShellHistoryFilter, { profileId: 1 });
    await screen.findByTestId("shell-history-table");

    fireEvent.input(screen.getByTestId("shell-history-command"), { target: { value: "nonexistent" } });

    await screen.findByTestId("shell-history-empty");
    expect(screen.getByTestId("shell-history-empty")).toHaveTextContent("No shell commands recorded.");
  });

  it("Refresh button re-fetches with current filters", async () => {
    const { listEvents } = setupAudit();

    render(ShellHistoryFilter, { profileId: 1 });
    await screen.findByTestId("shell-history-table");
    expect(listEvents).toHaveBeenCalledTimes(1);

    // Set a command filter and click Refresh
    fireEvent.input(screen.getByTestId("shell-history-command"), { target: { value: "npm" } });
    fireEvent.click(screen.getByTestId("shell-history-refresh"));

    await waitFor(() => expect(listEvents).toHaveBeenCalledTimes(2));
    // The Refresh re-fetch should still include the eventName filter.
    expect(listEvents).toHaveBeenNthCalledWith(2, expect.objectContaining({ eventName: "shell:exec" }));
  });

  it("passes date-range as since/until timestamps to listEvents", async () => {
    const { listEvents } = setupAudit();

    render(ShellHistoryFilter, { profileId: 1 });
    await screen.findByTestId("shell-history-table");

    // Set date range
    fireEvent.input(screen.getByTestId("shell-history-since"), { target: { value: "2024-08-30" } });
    fireEvent.input(screen.getByTestId("shell-history-until"), { target: { value: "2024-08-31" } });
    fireEvent.click(screen.getByTestId("shell-history-refresh"));

    await waitFor(() => {
      expect(listEvents).toHaveBeenLastCalledWith(
        expect.objectContaining({
          eventName: "shell:exec",
          since: expect.any(Number),
          until: expect.any(Number),
        })
      );
    });
  });

  it("degrades gracefully when the audit namespace is unavailable", async () => {
    // window.careerflow is left undefined by beforeEach() on purpose.
    render(ShellHistoryFilter, { profileId: 1 });

    await screen.findByTestId("shell-history-error");
    expect(screen.getByTestId("shell-history-error")).toHaveTextContent(
      "Shell history is not available in this build."
    );
  });

  it("shows empty state when the server returns no events", async () => {
    setupAudit({ events: [] });

    render(ShellHistoryFilter, { profileId: 1 });

    await screen.findByTestId("shell-history-empty");
    expect(screen.getByTestId("shell-history-empty")).toHaveTextContent(
      "No shell commands recorded."
    );
  });

  it("shows error when listEvents returns ok:false", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      setupAudit({
        events: [],
        listEventsImpl: vi.fn().mockResolvedValue({ ok: false, reason: "db-error" }),
      });

      render(ShellHistoryFilter, { profileId: 1 });

      await screen.findByTestId("shell-history-error");
      expect(screen.getByTestId("shell-history-error")).toHaveTextContent(/Could not load shell history/);
    } finally {
      consoleError.mockRestore();
    }
  });
});
