// Tool activity rebuild — D13 regression locks.
//
// The real-Electron gate (e2e/agent-ui-runtime.spec.js LEG1) requires a tool row
// to be VISIBLE after the user approves. It was red for two passes because the
// rebuild of that trace could not read the rows it was rebuilding from, and then
// overwrote the live trace with the empty result. Two defects, one shape:
//
//   1. Native `pm_messages` rows are napi objects, so the Rust field
//      `payload_json` reaches the renderer as `payloadJson`. Reading only the
//      snake name made `JSON.parse` see "{}" for every real run, so the rebuild
//      was ALWAYS empty.
//   2. `loadAgent` runs that rebuild immediately after `startAgent` resolves -
//      i.e. while the run's own live events (and their tool rows) are still
//      arriving. An empty rebuild therefore ERASED a live row, and the panel
//      read "No tool activity yet." for the rest of a healthy run.
//
// These tests lock both, at the cheapest level, so neither can return silently
// between expensive E2E runs. They assert the shape the RUNNING APP actually
// returns (verified in the D13 probe), not a convenient fixture.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  projectModeStore,
  applyAgentEvent,
  loadAgent,
} from "../src/features/project-mode/stores/projectMode.svelte.js";

const CREATED_AT = "2026-10-07T10:00:00.000Z";

/** A native-shaped (camelCase) tool_call row exactly as `project:list-messages` returns it. */
function nativeToolCall(id = "call-1", name = "fs_write") {
  return {
    id: 3,
    agentId: 1,
    seq: 3,
    role: "tool_call",
    name,
    payloadJson: JSON.stringify([{ id, name, args: { path: "ui-target.txt" } }]),
    createdAt: CREATED_AT,
  };
}

/** A native-shaped result row: the shape proven live by the D13 probe. */
function nativeToolResult(id = "call-1", name = "fs_write", ok = true) {
  return {
    id: 4,
    agentId: 1,
    seq: 4,
    role: "tool_result",
    name,
    payloadJson: JSON.stringify({ callId: id, name, result: { ok, elapsedMs: 7 } }),
    createdAt: CREATED_AT,
  };
}

/** A legacy/test-shaped row (the Rust field name) — still supported. */
function legacyToolCall(id = "call-legacy") {
  return { ...nativeToolCall(id), payloadJson: undefined, payload_json: nativeToolCall(id).payloadJson };
}

function legacyToolResult(id = "call-legacy") {
  return { ...nativeToolResult(id), payloadJson: undefined, payload_json: nativeToolResult(id).payloadJson };
}

/** A row from a shape this build does not understand: valid JSON, no calls, no callId. */
function unreadableToolRow(role = "tool_call") {
  return {
    id: 9,
    agentId: 1,
    seq: 9,
    role,
    name: "mystery_tool",
    payload: { unexpected: "shape" },
    createdAt: CREATED_AT,
  };
}

function installIpc({ messages = [], pendingApprovals = [] } = {}) {
  window.careerflow = {
    projectMode: {
      getAgent: vi.fn(async () => ({
        id: 1, projectId: 1, objective: "x", state: "running",
        planJson: "[]", tokensIn: 0, tokensOut: 0, createdAt: CREATED_AT, updatedAt: CREATED_AT,
      })),
      listMessages: vi.fn(async () => messages),
      listPendingApprovals: vi.fn(async () => ({ ok: true, approvals: pendingApprovals })),
    },
  };
}

function resetStore() {
  projectModeStore.projects = [];
  projectModeStore.activeProjectId = null;
  projectModeStore.activeAgentId = null;
  projectModeStore.activeRunId = null;
  projectModeStore.agent = null;
  projectModeStore.messages = [];
  projectModeStore.plan = [];
  projectModeStore.toolActivity = [];
  projectModeStore.pendingApprovals = [];
  projectModeStore.loadedProfileId = null;
}

/** A live tool row as the sanitized event stream delivers it during a run. */
function pushLiveToolRow(callId = "live-1", tool = "fs_write") {
  projectModeStore.activeProjectId = 1;
  projectModeStore.activeAgentId = 1;
  applyAgentEvent({ type: "agent.tool.started", agentId: 1, projectId: 1, tool, callId });
}

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  window.careerflow = undefined;
  resetStore();
  vi.restoreAllMocks();
});

describe("D13 — tool activity is rebuilt from NATIVE (camelCase) rows", () => {
  it("reconstructs a running row from a `payloadJson` tool_call (the real runtime shape)", async () => {
    installIpc({ messages: [nativeToolCall()] });
    await loadAgent(1, 1);

    expect(projectModeStore.toolActivity).toHaveLength(1);
    expect(projectModeStore.toolActivity[0]).toMatchObject({
      id: "call-1",
      name: "fs_write",
      status: "running",
      startedAt: CREATED_AT,
    });
  });

  it("completes the row from a `payloadJson` tool_result", async () => {
    installIpc({ messages: [nativeToolCall(), nativeToolResult()] });
    await loadAgent(1, 1);

    expect(projectModeStore.toolActivity).toHaveLength(1);
    expect(projectModeStore.toolActivity[0]).toMatchObject({
      id: "call-1", name: "fs_write", status: "completed", elapsedMs: 7,
    });
  });

  it("reads a tool result whose call id is not in the transcript at all", async () => {
    installIpc({ messages: [nativeToolResult("orphan-9", "fs_read", false)] });
    await loadAgent(1, 1);

    expect(projectModeStore.toolActivity).toHaveLength(1);
    expect(projectModeStore.toolActivity[0]).toMatchObject({
      id: "orphan-9", name: "fs_read", status: "failed",
    });
  });
});

describe("D13 — legacy (snake_case) rows remain supported", () => {
  it("still reconstructs from `payload_json` fixtures", async () => {
    installIpc({ messages: [legacyToolCall(), legacyToolResult()] });
    await loadAgent(1, 1);

    expect(projectModeStore.toolActivity).toHaveLength(1);
    expect(projectModeStore.toolActivity[0]).toMatchObject({
      id: "call-legacy", name: "fs_write", status: "completed",
    });
  });
});

describe("D13 — a rebuild must not erase live state it cannot reconstruct", () => {
  it("keeps the live tool row when the transcript's tool rows have an unknown shape", async () => {
    pushLiveToolRow("live-1");
    expect(projectModeStore.toolActivity.map((t) => t.id)).toEqual(["live-1"]);

    installIpc({ messages: [unreadableToolRow("tool_call"), unreadableToolRow("tool_result")] });
    await loadAgent(1, 1);

    // THE regression: before D13 this was an empty list, so the running tool
    // vanished from the UI while the run was healthy.
    expect(projectModeStore.toolActivity).toHaveLength(1);
    expect(projectModeStore.toolActivity[0]).toMatchObject({ id: "live-1", status: "running" });
  });

  it("still CLEARS live rows when the transcript honestly has no tool rows", async () => {
    pushLiveToolRow("live-1");

    installIpc({ messages: [{ id: 1, agentId: 1, role: "user", content: "hi", createdAt: CREATED_AT }] });
    await loadAgent(1, 1);

    // The guard must not over-correct: "no tool rows" IS a valid reconstruction.
    expect(projectModeStore.toolActivity).toEqual([]);
  });

  it("replaces live rows once the transcript IS readable again", async () => {
    pushLiveToolRow("live-1");

    installIpc({ messages: [nativeToolCall("call-2")] });
    await loadAgent(1, 1);

    expect(projectModeStore.toolActivity.map((t) => t.id)).toEqual(["call-2"]);
  });

  it("leaves an empty trace empty when nothing can be read (nothing to protect)", async () => {
    installIpc({ messages: [unreadableToolRow()] });
    await loadAgent(1, 1);

    expect(projectModeStore.toolActivity).toEqual([]);
  });
});
