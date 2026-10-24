// SessionTimeline — search/filter UI tests.
//
// Coverage:
//   - Typing in the search input filters visible entries
//   - Clear button restores all entries
//   - Count badge updates to show "matched / total"

import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import SessionTimeline from "../src/features/project-mode/components/SessionTimeline.svelte";

const MOCK_MESSAGES = [
  { id: 20, agent_id: 1, seq: 20, role: "system",     content: "You are a coding assistant", name: null, payload_json: null, created_at: "2026-01-01T10:00:00Z" },
  { id: 21, agent_id: 1, seq: 21, role: "user",        content: "Write a Python script",     name: null, payload_json: null, created_at: "2026-01-01T10:01:00Z" },
  { id: 22, agent_id: 1, seq: 22, role: "assistant",   content: "Here is the script",        name: null, payload_json: null, created_at: "2026-01-01T10:02:00Z" },
  { id: 23, agent_id: 1, seq: 23, role: "tool_call",   content: "",                          name: "fs_write",  payload_json: JSON.stringify({ path: "/tmp/script.py" }), created_at: "2026-01-01T10:03:00Z" },
  { id: 24, agent_id: 1, seq: 24, role: "tool_result", content: "",                          name: "fs_write",  payload_json: JSON.stringify({ ok: true }), created_at: "2026-01-01T10:04:00Z" },
  { id: 25, agent_id: 1, seq: 25, role: "status",      content: "Done.",                     name: null,       payload_json: null, created_at: "2026-01-01T10:05:00Z" },
];

function mockListMessagesPaginated(resolver) {
  window.progressLedger = {
    projectMode: {
      listMessagesPaginated: vi.fn().mockImplementation(resolver),
    },
  };
}

beforeEach(() => {
  mockListMessagesPaginated(() => Promise.resolve(MOCK_MESSAGES));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SessionTimeline search filter", () => {
  it("filters entries when the user types in the search input", async () => {
    render(SessionTimeline, { props: { profileId: 1, agentId: 1 } });

    await waitFor(() => {
      expect(screen.getByTestId("timeline-entry-20")).toBeInTheDocument();
    });

    // All 6 entries visible initially
    expect(screen.getByTestId("timeline-count")).toHaveTextContent("6 messages");

    // Type "python" — only the user message contains it
    const input = screen.getByTestId("timeline-search-input");
    await fireEvent.input(input, { target: { value: "python" } });

    // Count updates to 1 / 6
    expect(screen.getByTestId("timeline-count")).toHaveTextContent("1 / 6");

    // Only entry 21 ("Write a Python script") should be visible
    expect(screen.getByTestId("timeline-entry-21")).toBeInTheDocument();
    expect(screen.queryByTestId("timeline-entry-20")).toBeNull();
    expect(screen.queryByTestId("timeline-entry-22")).toBeNull();
  });

  it("matches tool calls and results by name and payload", async () => {
    render(SessionTimeline, { props: { profileId: 1, agentId: 1 } });

    await waitFor(() => {
      expect(screen.getByTestId("timeline-entry-23")).toBeInTheDocument();
    });

    // Search for "fs_write" — matches tool_call (id 23) and tool_result (id 24) by name
    const input = screen.getByTestId("timeline-search-input");
    await fireEvent.input(input, { target: { value: "fs_write" } });

    expect(screen.getByTestId("timeline-count")).toHaveTextContent("2 / 6");
    expect(screen.getByTestId("timeline-entry-23")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-entry-24")).toBeInTheDocument();
    expect(screen.queryByTestId("timeline-entry-20")).toBeNull();
  });

  it("clear button restores all entries and resets the count", async () => {
    render(SessionTimeline, { props: { profileId: 1, agentId: 1 } });

    await waitFor(() => {
      expect(screen.getByTestId("timeline-entry-20")).toBeInTheDocument();
    });

    // Apply a filter
    const input = screen.getByTestId("timeline-search-input");
    await fireEvent.input(input, { target: { value: "python" } });

    await waitFor(() => {
      expect(screen.getByTestId("timeline-count")).toHaveTextContent("1 / 6");
    });
    expect(screen.queryByTestId("timeline-entry-22")).toBeNull();

    // Click Clear
    const clearBtn = screen.getByTestId("timeline-search-clear");
    await fireEvent.click(clearBtn);

    // Input is empty, clear button is gone, all entries restored
    expect(screen.queryByTestId("timeline-search-clear")).toBeNull();
    expect(input.value).toBe("");
    expect(screen.getByTestId("timeline-count")).toHaveTextContent("6 messages");
    expect(screen.getByTestId("timeline-entry-20")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-entry-22")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-entry-25")).toBeInTheDocument();
  });
});
