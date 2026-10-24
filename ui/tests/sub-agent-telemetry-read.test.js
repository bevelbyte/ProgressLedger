// Sub-agent telemetry READ-SIDE IPC — end-to-end UI test.
//
// Closes capability-matrix gap #3: `subagent-telemetry.js` shipped
// start/end/list (NAPI pmInsertSubagentRun / pmEndSubagentRun /
// pmListSubagentRuns) and the shell registered the
// `agent:list-subagent-runs` IPC channel + the `listSubagentRuns`
// preload binding, but nothing on the renderer side actually called it.
// This file exercises the full read chain from the UI down to the IPC
// namespace:
//
//   SubAgentActivity.svelte
//     -> projectModeService.listSubagentRuns(profileId, parentAgentId, limit)
//       -> window.progressLedger.projectMode.listSubagentRuns  (preload.cjs)
//         -> ipcRenderer.invoke("agent:list-subagent-runs", ...)
//           -> callPm("pmListSubagentRuns", [...])
//
// We stub at the `window.progressLedger.projectMode` boundary (the same
// seam every other project-mode UI test uses) and assert on the exact
// argument tuple that preload forwards to the channel, so a regression
// in either the service wrapper or the binding tuple is caught here.
//
// Row shape is the NAPI `SubagentRun` object (camelCase,
// `#[napi(object)]`): { id, parentAgentId, role, childAgentId, runId,
// startedAt, endedAt, outcome, tokensIn, tokensOut, error }.

import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import SubAgentActivity from "../src/features/project-mode/components/SubAgentActivity.svelte";

// Freeze only Date so every `timeAgo` / `duration` value is exact while
// real timers keep working (so findBy* / waitFor resolve normally).
const NOW = new Date("2026-08-30T10:00:00.000Z").getTime();

function makeRun(overrides = {}) {
  return {
    id: 1,
    parentAgentId: 10,
    role: "coder",
    childAgentId: 20,
    runId: "run-abc",
    startedAt: "2026-08-30T09:58:00.000Z",
    endedAt: "2026-08-30T10:00:00.000Z",
    outcome: "completed",
    tokensIn: 3200,
    tokensOut: 800,
    error: "",
    ...overrides,
  };
}

const COMPLETED = makeRun();
const FAILED = makeRun({
  id: 2,
  role: "tester",
  childAgentId: 21,
  runId: "run-def",
  startedAt: "2026-08-30T09:59:00.000Z",
  endedAt: "2026-08-30T09:59:30.000Z",
  outcome: "failed",
  tokensIn: 500,
  tokensOut: 120,
  error: "verify-exhausted:3:compile-error",
});
const INFLIGHT = makeRun({
  id: 3,
  role: "researcher",
  childAgentId: null,
  runId: "run-ghi",
  startedAt: "2026-08-30T09:58:30.000Z",
  endedAt: null,
  outcome: null,
  tokensIn: null,
  tokensOut: null,
  error: "",
});

function setupIpc({ runs = [], impl = null } = {}) {
  const listSubagentRuns = impl ? impl : vi.fn().mockResolvedValue(runs);
  window.progressLedger = { projectMode: { listSubagentRuns } };
  return { listSubagentRuns };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  window.progressLedger = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

// ---------------------------------------------------------------------------
// Read-side IPC: argument tuple + rendering
// ---------------------------------------------------------------------------

describe("SubAgentActivity — read-side IPC (agent:list-subagent-runs)", () => {
  it("calls listSubagentRuns with (profileId, parentAgentId, default limit 50) and renders one row per run", async () => {
    const { listSubagentRuns } = setupIpc({ runs: [COMPLETED, FAILED, INFLIGHT] });
    render(SubAgentActivity, { props: { profileId: 1, parentAgentId: 10 } });

    // The exact tuple preload forwards to `agent:list-subagent-runs`.
    await waitFor(() => {
      expect(listSubagentRuns).toHaveBeenCalledWith(1, 10, 50);
    });

    const table = await screen.findByTestId("activity-table");
    expect(table).toBeInTheDocument();
    expect(screen.getByTestId("activity-row-1")).toBeInTheDocument();
    expect(screen.getByTestId("activity-row-2")).toBeInTheDocument();
    expect(screen.getByTestId("activity-row-3")).toBeInTheDocument();
    expect(screen.getByTestId("activity-role-1")).toHaveTextContent("coder");
    expect(screen.getByTestId("activity-parent-1")).toHaveTextContent("#10");
    expect(screen.getByTestId("activity-child-2")).toHaveTextContent("#21");
  });

  it("formats tokens, duration and the started-ago column", async () => {
    setupIpc({ runs: [COMPLETED] });
    render(SubAgentActivity, { props: { profileId: 1, parentAgentId: 10 } });

    // 09:58 -> 10:00 = 120s -> "2m 0s"; 10:00 - 2min = "2m ago".
    expect(await screen.findByTestId("activity-duration-1")).toHaveTextContent("2m 0s");
    expect(screen.getByTestId("activity-started-1")).toHaveTextContent("2m ago");
    // 3200 -> "3.2k", 800 stays literal.
    expect(screen.getByTestId("activity-tokens-in-1")).toHaveTextContent("3.2k");
    expect(screen.getByTestId("activity-tokens-out-1")).toHaveTextContent("800");
  });

  it("maps outcome to the green/red/yellow pill", async () => {
    setupIpc({ runs: [COMPLETED, FAILED, INFLIGHT] });
    render(SubAgentActivity, { props: { profileId: 1, parentAgentId: 10 } });

    const green = (await screen.findByTestId("outcome-completed")).className;
    const red = (await screen.findByTestId("outcome-failed")).className;
    // No outcome yet (ended_at NULL) renders as "running" + yellow.
    const yellow = (await screen.findByTestId("outcome-running")).className;
    expect(green).toContain("pill-green");
    expect(red).toContain("pill-red");
    expect(yellow).toContain("pill-yellow");
  });

  it("expands the row to show run id, timestamps and the failure reason", async () => {
    setupIpc({ runs: [FAILED] });
    render(SubAgentActivity, { props: { profileId: 1, parentAgentId: 10 } });

    await screen.findByTestId("activity-row-2");
    expect(screen.queryByTestId("activity-detail-2")).not.toBeInTheDocument();

    await fireEvent.click(screen.getByTestId("activity-row-2"));

    const detail = await screen.findByTestId("activity-detail-2");
    expect(detail).toBeInTheDocument();
    expect(detail).toHaveTextContent("run-def");
    expect(detail).toHaveTextContent(/2026-08-30T09:59:00/);
    expect(detail).toHaveTextContent(/verify-exhausted:3:compile-error/);

    // Click again collapses.
    await fireEvent.click(screen.getByTestId("activity-row-2"));
    await waitFor(() => {
      expect(screen.queryByTestId("activity-detail-2")).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Controls: scope toggle, limit dropdown, refresh
// ---------------------------------------------------------------------------

describe("SubAgentActivity — controls", () => {
  it("defaults to the scoped parent and re-fetches with null when 'All parents' is picked", async () => {
    const { listSubagentRuns } = setupIpc({ runs: [COMPLETED] });
    render(SubAgentActivity, { props: { profileId: 1, parentAgentId: 10 } });

    await screen.findByTestId("activity-table");
    expect(listSubagentRuns).toHaveBeenLastCalledWith(1, 10, 50);

    const scope = screen.getByTestId("activity-scope");
    await fireEvent.change(scope, { target: { value: "all" } });

    // null parentAgentId = unscoped read across the whole profile.
    await waitFor(() => {
      expect(listSubagentRuns).toHaveBeenLastCalledWith(1, null, 50);
    });
  });

  it("omits the scope control when no parentAgentId prop is supplied", async () => {
    const { listSubagentRuns } = setupIpc({ runs: [] });
    render(SubAgentActivity, { props: { profileId: 1 } });

    await screen.findByTestId("activity-empty");
    expect(screen.queryByTestId("activity-scope")).not.toBeInTheDocument();
    expect(listSubagentRuns).toHaveBeenLastCalledWith(1, null, 50);
  });

  it("Refresh re-fetches and the Limit dropdown re-fetches with the new limit", async () => {
    const { listSubagentRuns } = setupIpc({ runs: [COMPLETED] });
    render(SubAgentActivity, { props: { profileId: 1, parentAgentId: 10 } });

    await screen.findByTestId("activity-table");
    expect(listSubagentRuns).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByTestId("activity-refresh"));
    await waitFor(() => {
      expect(listSubagentRuns).toHaveBeenCalledTimes(2);
    });

    const select = screen.getByTestId("activity-limit");
    await fireEvent.change(select, { target: { value: "100" } });
    await waitFor(() => {
      expect(listSubagentRuns).toHaveBeenLastCalledWith(1, 10, 100);
    });
  });
});

// ---------------------------------------------------------------------------
// Empty + degraded states
// ---------------------------------------------------------------------------

describe("SubAgentActivity — empty and degraded states", () => {
  it("renders an empty state when the IPC returns []", async () => {
    setupIpc({ runs: [] });
    render(SubAgentActivity, { props: { profileId: 1, parentAgentId: 10 } });

    expect(await screen.findByTestId("activity-empty")).toHaveTextContent(/no sub-agent runs yet/i);
    expect(screen.queryByTestId("activity-table")).not.toBeInTheDocument();
  });

  it("surfaces the core-not-wired reason instead of crashing on a non-array response", async () => {
    // callPm returns `{ ok: false, reason }` (not an array) when the
    // Rust core is not wired — the panel must render empty + the reason.
    const { listSubagentRuns } = setupIpc({
      impl: vi.fn().mockResolvedValue({ ok: false, reason: "core-not-wired" }),
    });
    render(SubAgentActivity, { props: { profileId: 1, parentAgentId: 10 } });

    await waitFor(() => {
      expect(listSubagentRuns).toHaveBeenCalledWith(1, 10, 50);
    });
    expect(await screen.findByTestId("activity-empty")).toBeInTheDocument();
    expect(screen.getByTestId("activity-error")).toHaveTextContent("core-not-wired");
  });

  it("surfaces a thrown rejection as an error and keeps the table empty", async () => {
    setupIpc({ impl: vi.fn().mockRejectedValue(new Error("ipc-broken")) });
    render(SubAgentActivity, { props: { profileId: 1, parentAgentId: 10 } });

    expect(await screen.findByTestId("activity-error")).toHaveTextContent("ipc-broken");
    expect(screen.queryByTestId("activity-table")).not.toBeInTheDocument();
  });

  it("stays inert (no fetch, no table) and hints when profileId is missing", async () => {
    const { listSubagentRuns } = setupIpc({ runs: [COMPLETED] });
    render(SubAgentActivity, { props: { profileId: null, parentAgentId: 10 } });

    // Give the effect a tick to run.
    await new Promise((r) => setTimeout(r, 0));
    // The read-side IPC must never be called without a profile scope.
    expect(listSubagentRuns).not.toHaveBeenCalled();
    expect(screen.queryByTestId("activity-table")).not.toBeInTheDocument();
    expect(await screen.findByTestId("activity-empty")).toHaveTextContent(/select a project/i);
  });
});
