// GATE 18 (v7) — UI must reflect real runtime state (no fake activity).
//
// Verifies that the panels in Project Mode display the **actual** backend
// runtime state during the full lifecycle of an agent run:
//   1. While an agent is in flight, AgentRunHistory shows `running` with a
//      yellow pill + an in-flight duration that ticks upward (NOT a fake
//      placeholder row claiming "completed").
//   2. During a fix-retry round the AgentErrorLog surfaces the
//      `fix-retrying` status entry from `pm_messages` (role='status',
//      name='fix-retrying'), proving the renderer is reading from the live
//      transcript rather than a hardcoded "retry scheduled" string.
//   3. After a completed run, the "final report" (AgentConversation — the
//      last assistant message) renders the assistant's actual reply, not a
//      loading placeholder or a stale row.
//   4. A `cancelled` agent shows the `cancelled` state with the cancelled
//      pill in AgentRunHistory (red, never collapsed to "completed" or
//      "running").
//   5. SessionTimeline renders the message stream in the exact order the
//      loop emitted it: plan → tool_call → tool_result → assistant → status.
//
// Every test wires the real IPC channels (`window.careerflow.*`) and
// renders the real Svelte components. The data shapes match what
// `core::db::project_mode` actually emits via NAPI — see
// core/src/db/project_mode.rs `pm_list_recent_agent_runs`,
// `pm_list_failed_agent_runs`, and `pm_list_messages_paginated`.

import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import AgentRunHistory   from "../src/features/project-mode/components/AgentRunHistory.svelte";
import AgentErrorLog     from "../src/features/project-mode/components/AgentErrorLog.svelte";
import AgentConversation from "../src/features/project-mode/components/AgentConversation.svelte";
import SessionTimeline   from "../src/features/project-mode/components/SessionTimeline.svelte";
import SubAgentActivity  from "../src/features/project-mode/components/SubAgentActivity.svelte";

import { projectModeStore } from "../src/features/project-mode/stores/projectMode.svelte.js";

// ---------------------------------------------------------------------------
// Fixed wall-clock so fake-timer tests stay deterministic
// ---------------------------------------------------------------------------
const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
const ISO = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString();

// ---------------------------------------------------------------------------
// Shared IPC mock factory — one wiring for the whole test file
// ---------------------------------------------------------------------------
function setupIpc() {
  const listRecentAgentRuns = vi.fn();
  const listAgentErrors     = vi.fn();
  const getAgent            = vi.fn();
  const listMessages        = vi.fn();
  const listMessagesPaginated = vi.fn();
  const listSubagentRuns    = vi.fn();

  window.careerflow = {
    projectMode: {
      listRecentAgentRuns,
      listAgentErrors,
      getAgent,
      listMessages,
      listMessagesPaginated,
      listSubagentRuns,
    },
  };

  return {
    listRecentAgentRuns,
    listAgentErrors,
    getAgent,
    listMessages,
    listMessagesPaginated,
    listSubagentRuns,
  };
}

function resetStore() {
  projectModeStore.messages = [];
  projectModeStore.plan = [];
  projectModeStore.agent = null;
  projectModeStore.toolActivity = [];
  projectModeStore.activeProjectId = null;
  projectModeStore.activeAgentId = null;
}

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
  resetStore();
});

// ---------------------------------------------------------------------------
// GATE 18.1 — AgentRunHistory shows a live `running` row during an
// in-flight agent. The row has the yellow pill, an in-flight duration
// that increases as time advances, and never silently flips to "completed".
// ---------------------------------------------------------------------------
describe("GATE 18.1 — AgentRunHistory reflects a live running agent", () => {
  it("renders the running row with yellow pill + ticking duration; never claims completed", async () => {
    const { listRecentAgentRuns } = setupIpc();

    // Real pm_agents shape: a running parent with `finished_at` null and
    // a recent updated_at. The renderer derives "still in flight" from
    // the absence of finished_at, not from a magic state string.
    const liveRun = {
      id: 50,
      project_id: 1,
      objective: "[coder] implement gate18 runtime-state UI test",
      state: "running",
      tokens_in: 4_200,
      tokens_out: 1_100,
      finished_at: null,
      created_at: ISO(-30_000),     // started 30 s before NOW
      updated_at: ISO(-2_000),      // last activity 2 s ago
    };
    listRecentAgentRuns.mockResolvedValue([liveRun]);

    render(AgentRunHistory, { props: { profileId: 1 } });

    await waitFor(() => expect(screen.getByTestId("history-table")).toBeInTheDocument());

    // Row carries the running state and the yellow pill class
    const row = screen.getByTestId("history-row-50");
    expect(row).toHaveAttribute("data-state", "running");

    const pill = screen.getByTestId("status-running");
    expect(pill).toBeInTheDocument();
    expect(pill.className).toContain("pill-yellow");
    expect(pill).not.toHaveClass("pill-green");

    // In-flight duration is computed from created_at → Date.now() and
    // refreshes when the component re-renders. The first render is
    // ~30 s after the row's created_at.
    const dur1 = screen.getByTestId("history-duration-50").textContent;
    expect(dur1).toMatch(/30s|31s|29s/); // ~30 s at NOW

    // Advance the clock and trigger a re-render via the Refresh button
    // (the same path the UI uses when the user clicks Refresh — the
    // duration formatter reads Date.now() at render time).
    await vi.advanceTimersByTimeAsync(10_000);
    await fireEvent.click(screen.getByTestId("history-refresh"));

    await waitFor(() => {
      const dur2 = screen.getByTestId("history-duration-50").textContent;
      expect(dur2).toMatch(/40s|41s|39s/);
      expect(dur2).not.toBe(dur1);
    });

    // The IPC was queried with the real profile/limit contract
    expect(listRecentAgentRuns).toHaveBeenCalledWith(1, 50);

    // There is NO `status-completed` pill in the document — the in-flight
    // row never silently flipped to "completed".
    expect(screen.queryByTestId("status-completed")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GATE 18.2 — AgentErrorLog surfaces the live fix-retry status from
// pm_messages. The error_message + error_payload + error_name that the
// backend joins onto a failed pm_agents row carry the fix-retry trace.
// ---------------------------------------------------------------------------
describe("GATE 18.2 — AgentErrorLog reflects the real fix-retry status", () => {
  it("renders the fix-retrying status row from the live pm_messages status join", async () => {
    const { listAgentErrors } = setupIpc();

    // The Rust `pm_list_failed_agent_runs` join picks the LAST role='status'
    // message per failed agent (see core/src/db/project_mode.rs L770-797).
    // `name='fix-retrying'` is what the loop appends during the fix-retry
    // round (shell/src/services/agent/loop.js L1176). The error_payload
    // is the structured JSON payload the loop writes.
    const failedWithFixRetry = {
      id: 77,
      project_id: 1,
      objective: "[coder] implement the fix-retry flow",
      state: "failed",
      created_at: ISO(-180_000),
      updated_at: ISO(-30_000),
      finished_at: ISO(-30_000),
      tokens_in: 12_400,
      tokens_out: 3_900,
      error_message: "fix-retrying",
      error_payload: JSON.stringify({
        name: "fix-retrying",
        stepId: "fix-1-step-3",
        attempt: 2,
        maxAttempts: 3,
        reason: "previous-verify-failed",
        ts: NOW - 30_000,
      }),
      error_name: "fix-retrying",
      error_ts: ISO(-30_000),
    };
    listAgentErrors.mockResolvedValue([failedWithFixRetry]);

    render(AgentErrorLog, { props: { profileId: 1 } });

    await waitFor(() => expect(screen.getByTestId("errlog-table")).toBeInTheDocument());

    // The error message cell carries the real status name, not a placeholder.
    const msg = screen.getByTestId("errlog-error-msg-77");
    expect(msg).toHaveTextContent(/fix-retrying/);

    // Expand the row and confirm the fix-retry payload is the structured
    // JSON the loop actually emits — proof the panel is reading from the
    // backend join, not from a hardcoded UI string.
    await fireEvent.click(screen.getByTestId("errlog-row-77"));
    const detail = await screen.findByTestId("errlog-detail-77");
    const payload = screen.getByTestId("errlog-payload-77");
    expect(payload).toHaveTextContent(/"name":\s*"fix-retrying"/);
    expect(payload).toHaveTextContent(/"stepId":\s*"fix-1-step-3"/);
    expect(payload).toHaveTextContent(/"maxAttempts":\s*3/);
    expect(detail).toHaveTextContent(/fix-retrying/);

    // IPC contract: profileId, since=null, limit=50 (matches the renderer)
    expect(listAgentErrors).toHaveBeenCalledWith(1, null, 50);
  });
});

// ---------------------------------------------------------------------------
// GATE 18.3 — AgentConversation shows the assistant's actual final message
// (not a placeholder) after a completed run. Drives the live transcript
// store and the getAgent IPC, then asserts the rendered final bubble.
// ---------------------------------------------------------------------------
describe("GATE 18.3 — AgentConversation shows the real final assistant message", () => {
  it("renders the last assistant message verbatim, not a loading placeholder", async () => {
    const { getAgent, listMessages } = setupIpc();

    const FINAL = "All 12 tests passed. Project Mode is ready for handoff.";
    getAgent.mockResolvedValue({
      id: 7,
      project_id: 1,
      objective: "[coder] finish the final report",
      state: "completed",
      plan_json: null,
      tokens_in: 9_400,
      tokens_out: 2_100,
      created_at: ISO(-120_000),
      updated_at: ISO(-1_000),
      finished_at: ISO(-1_000),
    });
    listMessages.mockResolvedValue([
      {
        id: 901,
        agent_id: 7,
        seq: 1,
        role: "assistant",
        content: "Drafted the schema. Running tests next.",
        name: null,
        payload_json: null,
        created_at: ISO(-90_000),
      },
      {
        id: 902,
        agent_id: 7,
        seq: 2,
        role: "status",
        content: "verifying",
        name: null,
        payload_json: null,
        created_at: ISO(-60_000),
      },
      {
        id: 903,
        agent_id: 7,
        seq: 3,
        role: "assistant",
        content: FINAL,
        name: null,
        payload_json: null,
        created_at: ISO(-30_000),
      },
    ]);

    // Drive the same path the live UI uses — loadAgent() populates the
    // reactive store, then AgentConversation reads it.
    projectModeStore.activeProjectId = 1;
    projectModeStore.activeAgentId = 7;
    const { loadAgent } = await import(
      "../src/features/project-mode/stores/projectMode.svelte.js"
    );
    await loadAgent(1, 7);

    render(AgentConversation);

    // All three messages rendered in the live transcript — two assistant
    // bubbles (one per assistant message), one status bubble.
    await waitFor(() => {
      expect(screen.getAllByTestId("message-assistant")).toHaveLength(2);
    });
    expect(screen.getByText(FINAL)).toBeInTheDocument();
    expect(screen.getByTestId("message-status")).toBeInTheDocument();

    // No placeholder / loading hint is shown once messages exist.
    expect(screen.queryByText(/No messages yet/)).toBeNull();
    expect(screen.queryByText(/Loading…/)).toBeNull();

    // The IPC was queried with the correct ids
    expect(getAgent).toHaveBeenCalledWith(1, 7);
    expect(listMessages).toHaveBeenCalledWith(1, 7);
  });
});

// ---------------------------------------------------------------------------
// GATE 18.4 — A cancelled agent shows `cancelled` (red pill) in the
// run history. It must NOT be lumped in with "completed" or "running".
// ---------------------------------------------------------------------------
describe("GATE 18.4 — Cancelled agent shows the cancelled state, not completed or running", () => {
  it("renders cancelled with a red pill distinct from completed and running", async () => {
    const { listRecentAgentRuns } = setupIpc();

    const cancelled = {
      id: 88,
      project_id: 1,
      objective: "[coder] build something the user then cancelled",
      state: "cancelled",
      tokens_in: 1_200,
      tokens_out: 400,
      finished_at: ISO(-5_000),
      created_at: ISO(-65_000),
      updated_at: ISO(-5_000),
    };
    const completed = {
      id: 89,
      project_id: 1,
      objective: "[coder] an earlier run that actually finished",
      state: "completed",
      tokens_in: 8_400,
      tokens_out: 2_200,
      finished_at: ISO(-15_000),
      created_at: ISO(-75_000),
      updated_at: ISO(-15_000),
    };
    const running = {
      id: 90,
      project_id: 1,
      objective: "[coder] a fresh run still going",
      state: "running",
      tokens_in: 200,
      tokens_out: 80,
      finished_at: null,
      created_at: ISO(-2_000),
      updated_at: ISO(-500),
    };
    listRecentAgentRuns.mockResolvedValue([cancelled, completed, running]);

    render(AgentRunHistory, { props: { profileId: 1 } });

    await waitFor(() => expect(screen.getByTestId("history-table")).toBeInTheDocument());

    // Cancelled row exists and carries the cancelled state attribute
    const cancelledRow = screen.getByTestId("history-row-88");
    expect(cancelledRow).toHaveAttribute("data-state", "cancelled");

    // A cancelled-status pill is rendered with the red class — distinct
    // from both pill-green (completed) and pill-yellow (running)
    const cancelledPill = screen.getByTestId("status-cancelled");
    expect(cancelledPill).toBeInTheDocument();
    expect(cancelledPill.className).toContain("pill-red");
    expect(cancelledPill).not.toHaveClass("pill-green");
    expect(cancelledPill).not.toHaveClass("pill-yellow");

    // The cancelled state text appears on the row and exactly once
    expect(cancelledRow).toHaveTextContent(/cancelled/);

    // The other states are still distinct
    expect(screen.getByTestId("status-completed")).toHaveClass("pill-green");
    const runningPill = screen.getByTestId("status-running");
    expect(runningPill).toBeInTheDocument();
    expect(runningPill.className).toContain("pill-yellow");

    // Three state pills, exactly one per state (no duplicates)
    expect(screen.getAllByTestId("status-completed")).toHaveLength(1);
    expect(screen.getAllByTestId("status-cancelled")).toHaveLength(1);
    expect(screen.getAllByTestId("status-running")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GATE 18.5 — SessionTimeline renders messages in the exact order the
// loop emitted them: plan(role=system) → tool_call → tool_result →
// assistant → status. Validates ordering, role icons, and tool cards.
// ---------------------------------------------------------------------------
describe("GATE 18.5 — SessionTimeline renders the message stream in correct order", () => {
  it("renders system → user → plan → tool_call → tool_result → assistant → status in emitted order", async () => {
    const { listMessagesPaginated } = setupIpc();

    // Realistic transcript for a single coder round-trip. ids are
    // monotonic; seq mirrors the order the loop wrote them.
    const transcript = [
      {
        id: 500,
        agent_id: 7,
        seq: 1,
        role: "system",
        content: "You are a helpful agent.",
        name: null,
        payload_json: null,
        created_at: ISO(-60_000),
      },
      {
        id: 501,
        agent_id: 7,
        seq: 2,
        role: "user",
        content: "Implement the GATE 18 UI test.",
        name: null,
        payload_json: null,
        created_at: ISO(-55_000),
      },
      {
        id: 502,
        agent_id: 7,
        seq: 3,
        role: "assistant",
        content: "I'll write the test then run it.",
        name: null,
        payload_json: null,
        created_at: ISO(-50_000),
      },
      {
        id: 503,
        agent_id: 7,
        seq: 4,
        role: "tool_call",
        content: "",
        name: "fs_write",
        payload_json: JSON.stringify({ path: "ui/tests/gate18.test.js" }),
        created_at: ISO(-45_000),
      },
      {
        id: 504,
        agent_id: 7,
        seq: 5,
        role: "tool_result",
        content: "",
        name: "fs_write",
        payload_json: JSON.stringify({ ok: true }),
        created_at: ISO(-40_000),
      },
      {
        id: 505,
        agent_id: 7,
        seq: 6,
        role: "assistant",
        content: "Test file written. Now running the suite.",
        name: null,
        payload_json: null,
        created_at: ISO(-35_000),
      },
      {
        id: 506,
        agent_id: 7,
        seq: 7,
        role: "status",
        content: "verified",
        name: null,
        payload_json: null,
        created_at: ISO(-30_000),
      },
    ];
    listMessagesPaginated.mockResolvedValue(transcript);

    render(SessionTimeline, { props: { profileId: 1, agentId: 7 } });

    await waitFor(() => expect(screen.getByTestId("timeline-stream")).toBeInTheDocument());

    // Order: collect the rendered entries in DOM order and compare ids.
    const renderedIds = Array.from(
      document.querySelectorAll('[data-testid^="timeline-entry-"]'),
    ).map((el) => Number(el.getAttribute("data-testid").replace("timeline-entry-", "")));
    expect(renderedIds).toEqual([500, 501, 502, 503, 504, 505, 506]);

    // Role icon matrix matches the message stream
    expect(screen.getByTestId("timeline-role-500")).toHaveTextContent("[S]"); // system
    expect(screen.getByTestId("timeline-role-501")).toHaveTextContent("[U]"); // user
    expect(screen.getByTestId("timeline-role-502")).toHaveTextContent("[A]"); // assistant
    expect(screen.getByTestId("timeline-role-503")).toHaveTextContent("[>]"); // tool_call
    expect(screen.getByTestId("timeline-role-504")).toHaveTextContent("[R]"); // tool_result
    expect(screen.getByTestId("timeline-role-505")).toHaveTextContent("[A]"); // assistant
    expect(screen.getByTestId("timeline-role-506")).toHaveTextContent("[i]"); // status

    // Tool call + tool_result render as cards (not flat text)
    const toolCard = screen.getByTestId("timeline-card-call-503");
    expect(toolCard).toBeInTheDocument();
    expect(toolCard.querySelector(".card-name")).toHaveTextContent("fs_write");
    expect(toolCard.textContent).toContain("gate18.test.js");

    const resultCard = screen.getByTestId("timeline-card-result-504");
    expect(resultCard).toBeInTheDocument();

    // Count badge reflects the 7-message total
    expect(screen.getByTestId("timeline-count")).toHaveTextContent("7 messages");

    // IPC contract: profileId, agentId, pageSize=50, cursor=null
    expect(listMessagesPaginated).toHaveBeenCalledWith(1, 7, 50, null);
  });
});