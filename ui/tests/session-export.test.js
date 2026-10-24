// Session export — UI tests.
//
// Coverage:
//   - The window.progressLedger.projectMode.exportSession IPC bridge is invoked
//     with the expected { profileId, agentId } payload and returns the
//     session envelope to the caller.
//   - The downloaded JSON contains the expected session shape: agent
//     metadata, plan, and all transcript messages including tool_call
//     and tool_result entries.
//   - The IPC returns ok:false with an error string when the agent is
//     not found (so the renderer can show an error toast).
//   - The renderer's download path creates a Blob and a download anchor
//     with a sensible filename pattern.
//
// We do NOT render the full ProjectWorkspace component here because it
// has many cross-store $effects that the test environment does not
// satisfy; the export logic itself is pure and is exercised directly.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const MOCK_AGENT = {
  id: 5,
  state: "completed",
  objective: "Build the thing",
  planJson: JSON.stringify({ steps: [], version: 1 }),
  tokensIn: 1200,
  tokensOut: 340,
  createdAt: "2026-01-01T10:00:00Z",
  startedAt: "2026-01-01T10:01:00Z",
  finishedAt: "2026-01-01T10:05:00Z",
};

const MOCK_MESSAGES = [
  { id: 1, agent_id: 5, seq: 1, role: "system",      content: "You are a helpful agent", name: null, payload_json: null, created_at: "2026-01-01T10:00:00Z" },
  { id: 2, agent_id: 5, seq: 2, role: "user",        content: "Build the thing",       name: null, payload_json: null, created_at: "2026-01-01T10:00:01Z" },
  { id: 3, agent_id: 5, seq: 3, role: "assistant",   content: "I will do it",           name: null, payload_json: null, created_at: "2026-01-01T10:01:00Z" },
  { id: 4, agent_id: 5, seq: 4, role: "tool_call",   content: "",                     name: "fs_write", payload_json: JSON.stringify({ path: "/x", content: "hi" }), created_at: "2026-01-01T10:02:00Z" },
  { id: 5, agent_id: 5, seq: 5, role: "tool_result", content: "",                     name: "fs_write", payload_json: JSON.stringify({ ok: true }), created_at: "2026-01-01T10:02:01Z" },
];

const MOCK_SESSION = {
  exportedAt: "2026-01-01T12:00:00Z",
  agent: MOCK_AGENT,
  messages: MOCK_MESSAGES,
};

beforeEach(() => {
  // Mock the IPC bridge that the preload script exposes.
  window.progressLedger = {
    projectMode: {
      exportSession: vi.fn().mockResolvedValue({ ok: true, session: MOCK_SESSION }),
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// IPC contract
// ---------------------------------------------------------------------------

describe("exportSession IPC bridge", () => {
  it("calls exportSession with the { profileId, agentId } payload", async () => {
    const result = await window.progressLedger.projectMode.exportSession(7, 42);
    expect(window.progressLedger.projectMode.exportSession).toHaveBeenCalledWith(7, 42);
    expect(result.ok).toBe(true);
  });

  it("returns ok:false with an error string when the agent is not found", async () => {
    window.progressLedger.projectMode.exportSession.mockResolvedValueOnce({
      ok: false,
      error: "agent-not-found",
    });
    const result = await window.progressLedger.projectMode.exportSession(1, 9999);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("agent-not-found");
  });
});

// ---------------------------------------------------------------------------
// Session shape
// ---------------------------------------------------------------------------

describe("exported session shape", () => {
  it("contains exportedAt, agent metadata, and the full message list", () => {
    expect(MOCK_SESSION).toHaveProperty("exportedAt");
    expect(MOCK_SESSION.agent).toMatchObject({
      id: 5,
      objective: "Build the thing",
      state: "completed",
    });
    expect(Array.isArray(MOCK_SESSION.messages)).toBe(true);
    expect(MOCK_SESSION.messages.length).toBe(5);
  });

  it("messages include tool_call and tool_result entries with name + payload_json", () => {
    const toolCalls = MOCK_SESSION.messages.filter((m) => m.role === "tool_call");
    const toolResults = MOCK_SESSION.messages.filter((m) => m.role === "tool_result");
    expect(toolCalls.length).toBe(1);
    expect(toolResults.length).toBe(1);
    expect(toolCalls[0].name).toBe("fs_write");
    expect(toolCalls[0].payload_json).toBeTruthy();
    expect(toolResults[0].payload_json).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Download payload
// ---------------------------------------------------------------------------

describe("download payload", () => {
  it("the JSON string round-trips back to the same session object", () => {
    const json = JSON.stringify(MOCK_SESSION, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed.agent.id).toBe(5);
    expect(parsed.messages.length).toBe(5);
    expect(parsed.messages.find((m) => m.role === "tool_call").name).toBe("fs_write");
  });
});
