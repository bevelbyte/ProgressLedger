// SessionTimeline — UI tests.
//
// Coverage:
//   - Renders the loading indicator while fetching the first page
//   - Renders a stream of message entries with role icons and cards
//   - Shows an empty state when the agent has no messages yet
//   - "Load more" button appends the next page without duplicates
//   - Does not crash when profileId or agentId is null
//
// The IPC namespace is mocked via window.progressLedger.projectMode.
// The shared projectModeStore is NOT touched — the component calls the
// service directly (not the store), so the two are fully independent.

import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import SessionTimeline from "../src/features/project-mode/components/SessionTimeline.svelte";

const MOCK_MESSAGES = [
  { id: 10, agent_id: 1, seq: 10, role: "system",  content: "You are helpful",    name: null,              payload_json: null,                        created_at: "2026-01-01T10:00:00Z" },
  { id: 11, agent_id: 1, seq: 11, role: "user",     content: "Do the thing",      name: null,              payload_json: null,                        created_at: "2026-01-01T10:01:00Z" },
  { id: 12, agent_id: 1, seq: 12, role: "assistant",content: "I will do it",      name: null,              payload_json: null,                        created_at: "2026-01-01T10:02:00Z" },
  { id: 13, agent_id: 1, seq: 13, role: "tool_call",content: "",                  name: "fs_write",        payload_json: JSON.stringify({ path: "/x", content: "hi" }), created_at: "2026-01-01T10:03:00Z" },
  { id: 14, agent_id: 1, seq: 14, role: "tool_result",content: "",                name: "fs_write",        payload_json: JSON.stringify({ ok: true }), created_at: "2026-01-01T10:04:00Z" },
  { id: 15, agent_id: 1, seq: 15, role: "status",   content: "Done.",              name: null,              payload_json: null,                        created_at: "2026-01-01T10:05:00Z" },
];

function mockListMessagesPaginated(resolver) {
  window.progressLedger = {
    projectMode: {
      listMessagesPaginated: vi.fn().mockImplementation(resolver),
    },
  };
}

beforeEach(() => {
  mockListMessagesPaginated(() => Promise.resolve([]));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

describe("SessionTimeline", () => {
  it("shows a loading indicator while fetching the first page", async () => {
    let resolve;
    const p = new Promise((r) => { resolve = r; });
    mockListMessagesPaginated(() => p);
    render(SessionTimeline, { props: { profileId: 1, agentId: 1 } });
    expect(screen.getByTestId("timeline-loading")).toBeInTheDocument();
    resolve([]);
  });

  // ---------------------------------------------------------------------------
  // Message stream
  // ---------------------------------------------------------------------------

  it("renders a stream of message entries with role icons", async () => {
    mockListMessagesPaginated(() => Promise.resolve(MOCK_MESSAGES));
    render(SessionTimeline, { props: { profileId: 1, agentId: 1 } });

    await waitFor(() => {
      expect(screen.getByTestId("timeline-entry-10")).toBeInTheDocument();
    });

    // Role icons
    expect(screen.getByTestId("timeline-role-10")).toHaveTextContent("[S]");
    expect(screen.getByTestId("timeline-role-11")).toHaveTextContent("[U]");
    expect(screen.getByTestId("timeline-role-12")).toHaveTextContent("[A]");
    expect(screen.getByTestId("timeline-role-13")).toHaveTextContent("[>]");
    expect(screen.getByTestId("timeline-role-14")).toHaveTextContent("[R]");

    // Text content
    expect(screen.getByTestId("timeline-text-10")).toHaveTextContent("You are helpful");
    expect(screen.getByTestId("timeline-text-11")).toHaveTextContent("Do the thing");

    // Tool cards
    const toolCard = screen.getByTestId("timeline-card-call-13");
    expect(toolCard.querySelector(".card-name")).toHaveTextContent("fs_write");

    // Count badge
    expect(screen.getByTestId("timeline-count")).toHaveTextContent("6 messages");
  });

  // ---------------------------------------------------------------------------
  // Empty state
  // ---------------------------------------------------------------------------

  it("shows an empty state when there are no messages", async () => {
    mockListMessagesPaginated(() => Promise.resolve([]));
    render(SessionTimeline, { props: { profileId: 1, agentId: 1 } });
    await waitFor(() => {
      expect(screen.getByTestId("timeline-empty")).toBeInTheDocument();
    });
    expect(screen.getByTestId("timeline-count")).toHaveTextContent("0 messages");
  });

  // ---------------------------------------------------------------------------
  // Load more / pagination
  // ---------------------------------------------------------------------------

  it('appends the next page when "Load more" is clicked', async () => {
    const page1 = MOCK_MESSAGES.slice(0, 3); // ids 10, 11, 12
    const page2 = MOCK_MESSAGES.slice(3);     // ids 13, 14, 15

    mockListMessagesPaginated((profileId, agentId, limit, before) => {
      if (before == null) return Promise.resolve(page1);
      if (before === 12)  return Promise.resolve(page2);
      return Promise.resolve([]);
    });

    // Use a small pageSize so the first page of 3 messages still leaves
    // hasMore=true and the "Load more" button is rendered.
    render(SessionTimeline, { props: { profileId: 1, agentId: 1, pageSize: 3 } });

    // Wait for first page
    await waitFor(() => {
      expect(screen.getByTestId("timeline-entry-12")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("timeline-entry-13")).toBeNull();

    // Click "Load more"
    const btn = screen.getByTestId("timeline-load-more");
    await fireEvent.click(btn);

    // Wait for second page entries
    await waitFor(() => {
      expect(screen.getByTestId("timeline-entry-13")).toBeInTheDocument();
    });

    // Count should now reflect all 6 messages
    expect(screen.getByTestId("timeline-count")).toHaveTextContent("6 messages");

    // No duplicate entries
    const ids = Array.from(screen.queryAllByTestId(/^timeline-entry-\d+$/)).map((el) => el.dataset.testid);
    const unique = new Set(ids);
    expect(unique.size).toBe(6);
  });

  // ---------------------------------------------------------------------------
  // Null / missing props
  // ---------------------------------------------------------------------------

  it("does not crash when profileId is null", () => {
    mockListMessagesPaginated(() => new Promise(() => {})); // should never be called
    expect(() => render(SessionTimeline, { props: { profileId: null, agentId: 1 } })).not.toThrow();
  });

  it("does not crash when agentId is null", () => {
    mockListMessagesPaginated(() => new Promise(() => {})); // should never be called
    expect(() => render(SessionTimeline, { props: { profileId: 1, agentId: null } })).not.toThrow();
  });

  it("renders end-of-session marker when hasMore is false", async () => {
    // Simulate a short session with no more pages available
    mockListMessagesPaginated(() => Promise.resolve(MOCK_MESSAGES.slice(0, 2)));
    render(SessionTimeline, { props: { profileId: 1, agentId: 1 } });
    await waitFor(() => {
      expect(screen.getByTestId("timeline-end")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("timeline-load-more")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D13 — NATIVE (camelCase) rows.
//
// `agent:list-messages` returns RAW napi rows, so the fields are camelCase
// (`payloadJson`, `createdAt`). The fixture above is the legacy shape, which is
// why the snake-only reads in this component never failed a test.
// ---------------------------------------------------------------------------

describe("SessionTimeline — native (camelCase) rows", () => {
  const NATIVE = [
    { id: 10, agentId: 1, seq: 10, role: "tool_call", content: "", name: "fs_write",
      payloadJson: JSON.stringify({ path: "/x", content: "hi" }), createdAt: "2026-01-01T10:03:00Z" },
    { id: 11, agentId: 1, seq: 11, role: "status", content: "Done.", name: null,
      payloadJson: null, createdAt: "2026-01-01T10:05:00Z" },
  ];

  it("renders the tool payload and the timestamp from the camelCase fields", async () => {
    mockListMessagesPaginated(() => Promise.resolve(NATIVE));
    render(SessionTimeline, { props: { profileId: 1, agentId: 1 } });

    const card = await screen.findByTestId("timeline-card-call-10");
    expect(card.querySelector(".args")).toHaveTextContent("/x");

    // The time chip is gated on the message's timestamp; a snake-only read left
    // it permanently absent for real rows.
    expect(screen.getByTestId("timeline-time-10")).toBeInTheDocument();
  });
});
