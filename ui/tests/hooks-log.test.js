// HooksLog — UI tests.
//
// Coverage:
//   - renders one table row per execution with time/hook/event/status/duration
//   - status pill class maps ok -> green, failed -> red
//   - clicking a failed row expands the error detail
//   - filter dropdowns re-fetch with the selected hook/event
//   - Refresh button re-fetches
//   - empty state when the service returns []

import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import HooksLog from "../src/features/project-mode/components/HooksLog.svelte";

const OK_EXEC = {
  id: 1,
  hookId: "hook-task-started-1",
  hookName: "hook-task-started-1",
  event: "task.started",
  status: "ok",
  durationMs: 42,
  error: null,
  createdAt: "2026-08-30T10:00:00.000Z",
};

const FAILED_EXEC = {
  id: 2,
  hookId: "hook-task-completed-1",
  hookName: "hook-task-completed-1",
  event: "task.completed",
  status: "failed",
  durationMs: 1500,
  error: "TypeError: Cannot read property 'foo' of undefined",
  createdAt: "2026-08-30T10:05:00.000Z",
};

const OK_EXEC_2 = {
  id: 3,
  hookId: "hook-tool-invoked-1",
  hookName: "hook-tool-invoked-1",
  event: "tool.invoked",
  status: "ok",
  durationMs: 0,
  error: null,
  createdAt: "2026-08-30T10:10:00.000Z",
};

function setupIpc({ executions = [], emitter = undefined } = {}) {
  // `emitter` is the main process's derived dormant-state report. Left
  // undefined by default so the pre-existing tests exercise the
  // "shell did not report it" path, which must fall back to the plain empty
  // message rather than asserting something it cannot support.
  const res = { executions };
  if (emitter !== undefined) res.emitter = emitter;
  const listExecutions = vi.fn().mockResolvedValue(res);
  window.progressLedger = {
    hooks: { listExecutions },
  };
  return { listExecutions };
}

beforeEach(() => {
  window.progressLedger = undefined;
});

afterEach(() => {
  cleanup();
});

describe("HooksLog", () => {
  it("requests executions on mount and renders a row per execution", async () => {
    const { listExecutions } = setupIpc({ executions: [OK_EXEC, FAILED_EXEC] });
    render(HooksLog, { props: { profileId: 1 } });

    await waitFor(() => {
      expect(listExecutions).toHaveBeenCalledWith({});
    });

    const table = await screen.findByTestId("hooks-table");
    expect(table).toBeInTheDocument();
    expect(screen.getByTestId("hooks-row-1")).toBeInTheDocument();
    expect(screen.getByTestId("hooks-row-2")).toBeInTheDocument();
    expect(screen.getByTestId("hooks-hook-1")).toHaveTextContent("hook-task-started-1");
    expect(screen.getByTestId("hooks-event-1")).toHaveTextContent("task.started");
  });

  it("maps status to the right pill colour (green/red)", async () => {
    setupIpc({ executions: [OK_EXEC, FAILED_EXEC] });
    render(HooksLog, { props: { profileId: 1 } });

    await screen.findByTestId("hooks-table");
    const green = screen.getByTestId("hooks-status-ok").className;
    const red = screen.getByTestId("hooks-status-failed").className;
    expect(green).toContain("pill-green");
    expect(red).toContain("pill-red");
  });

  it("formats duration for each execution", async () => {
    setupIpc({ executions: [OK_EXEC, FAILED_EXEC, OK_EXEC_2] });
    render(HooksLog, { props: { profileId: 1 } });

    await screen.findByTestId("hooks-table");
    // 42ms -> "42ms"
    expect(screen.getByTestId("hooks-duration-1")).toHaveTextContent("42ms");
    // 1500ms -> "1s"
    expect(screen.getByTestId("hooks-duration-2")).toHaveTextContent("1s");
    // 0ms -> "0ms"
    expect(screen.getByTestId("hooks-duration-3")).toHaveTextContent("0ms");
  });

  it("expands the error detail when a failed row is clicked", async () => {
    setupIpc({ executions: [FAILED_EXEC] });
    render(HooksLog, { props: { profileId: 1 } });

    await screen.findByTestId("hooks-row-2");
    expect(screen.queryByTestId("hooks-detail-2")).not.toBeInTheDocument();

    await fireEvent.click(screen.getByTestId("hooks-row-2"));

    const detail = await screen.findByTestId("hooks-detail-2");
    expect(detail).toBeInTheDocument();
    expect(detail).toHaveTextContent(/TypeError: Cannot read property/i);
    expect(detail).toHaveTextContent(/hook-task-completed-1/);
    expect(detail).toHaveTextContent(/task.completed/);
  });

  it("does NOT expand detail for an ok row with no error", async () => {
    setupIpc({ executions: [OK_EXEC] });
    render(HooksLog, { props: { profileId: 1 } });

    await screen.findByTestId("hooks-row-1");
    await fireEvent.click(screen.getByTestId("hooks-row-1"));

    // No detail row because error is null
    expect(screen.queryByTestId("hooks-detail-1")).not.toBeInTheDocument();
  });

  it("Refresh button re-fetches executions", async () => {
    const { listExecutions } = setupIpc({ executions: [OK_EXEC] });
    render(HooksLog, { props: { profileId: 1 } });

    await screen.findByTestId("hooks-table");
    expect(listExecutions).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByTestId("hooks-refresh"));
    await waitFor(() => {
      expect(listExecutions).toHaveBeenCalledTimes(2);
    });
  });

  it("filter dropdowns re-fetch with the selected hook/event", async () => {
    setupIpc({ executions: [OK_EXEC, FAILED_EXEC, OK_EXEC_2] });
    const { listExecutions } = setupIpc({ executions: [OK_EXEC, FAILED_EXEC, OK_EXEC_2] });
    render(HooksLog, { props: { profileId: 1 } });

    await screen.findByTestId("hooks-table");

    // Filter by hook name
    const hookSelect = screen.getByTestId("hooks-filter-hook");
    await fireEvent.change(hookSelect, { target: { value: "hook-task-started-1" } });
    await waitFor(() => {
      expect(listExecutions).toHaveBeenLastCalledWith({ hookId: "hook-task-started-1" });
    });

    // Filter by event name
    const eventSelect = screen.getByTestId("hooks-filter-event");
    await fireEvent.change(eventSelect, { target: { value: "task.completed" } });
    await waitFor(() => {
      expect(listExecutions).toHaveBeenLastCalledWith({
        hookId: "hook-task-started-1",
        eventName: "task.completed",
      });
    });
  });

  it("renders an empty state when there are no executions", async () => {
    setupIpc({ executions: [] });
    render(HooksLog, { props: { profileId: 1 } });

    expect(await screen.findByTestId("hooks-empty")).toHaveTextContent(/no hook executions yet/i);
    expect(screen.queryByTestId("hooks-table")).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Dormant-state notice.
  //
  // The hooks surface is implemented but nothing in production calls
  // emit(), so an empty log is EXPECTED rather than a fault. Showing the
  // ordinary "No hook executions yet." message in that state reads as
  // "working, just no data yet" and lets unbuilt infrastructure masquerade as
  // a working feature — the specific harm these cases lock down.
  //
  // The notice is driven by the main process's DERIVED report, so it appears
  // only when the shell says it is dormant, and disappears on its own once an
  // emitter is wired.
  // -------------------------------------------------------------------------

  it("shows the dormant notice instead of the plain empty state when nothing has ever emitted", async () => {
    setupIpc({ executions: [], emitter: { dormant: true, emitCalls: 0 } });
    render(HooksLog, { props: { profileId: 1 } });

    const notice = await screen.findByTestId("hooks-dormant-notice");
    expect(notice).toHaveTextContent(/not wired up yet/i);
    expect(notice).toHaveTextContent(/empty log is expected rather than an error/i);
    // The misleading message must be gone.
    expect(screen.queryByTestId("hooks-empty")).not.toBeInTheDocument();
    expect(screen.queryByTestId("hooks-table")).not.toBeInTheDocument();
  });

  it("shows the plain empty state when an emitter exists but produced no executions", async () => {
    // Same empty list, but the surface IS wired. Here an empty log does mean
    // something is wrong, so it must NOT be excused by the dormant notice.
    setupIpc({ executions: [], emitter: { dormant: false, emitCalls: 7 } });
    render(HooksLog, { props: { profileId: 1 } });

    expect(await screen.findByTestId("hooks-empty")).toHaveTextContent(/no hook executions yet/i);
    expect(screen.queryByTestId("hooks-dormant-notice")).not.toBeInTheDocument();
  });

  it("falls back to the plain empty state when the shell reports no emitter status", async () => {
    // Older shell, or the field missing: assert nothing we cannot support.
    setupIpc({ executions: [] });
    render(HooksLog, { props: { profileId: 1 } });

    expect(await screen.findByTestId("hooks-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("hooks-dormant-notice")).not.toBeInTheDocument();
  });

  it("renders the table and no dormant notice once executions exist", async () => {
    setupIpc({ executions: [OK_EXEC], emitter: { dormant: false, emitCalls: 3 } });
    render(HooksLog, { props: { profileId: 1 } });

    expect(await screen.findByTestId("hooks-table")).toBeInTheDocument();
    expect(screen.queryByTestId("hooks-dormant-notice")).not.toBeInTheDocument();
    expect(screen.queryByTestId("hooks-empty")).not.toBeInTheDocument();
  });
});
