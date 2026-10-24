// SubAgentTree — UI tests.
//
// Coverage:
//   - renders the active parent agent with a derived role
//   - renders child agents returned from projectMode.getChildren
//   - renders an empty-state row when getChildren returns []
//
// The IPC namespace is mocked via window.progressLedger.projectMode. We
// only stub `getChildren` (and a minimal `getAgent`) since the tree
// component does not need the full suite.

import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import SubAgentTree from "../src/features/project-mode/components/SubAgentTree.svelte";
import { projectModeStore } from "../src/features/project-mode/stores/projectMode.svelte.js";

function makeChild(id, objective, state = "running") {
  return {
    id,
    project_id: 7,
    objective,
    state,
    plan_json: "[]",
    tokens_in: 0,
    tokens_out: 0,
    finished_at: null,
    created_at: "2026-08-30T10:00:00Z",
    updated_at: "2026-08-30T10:00:05Z",
    parent_agent_id: 1,
  };
}

function setupIpc({ children = [], getAgent = null } = {}) {
  const getChildren = vi.fn().mockResolvedValue(children);
  const fallbackAgent = {
    id: 1,
    project_id: 7,
    objective: "[researcher] survey the area",
    state: "running",
    plan_json: "[]",
    tokens_in: 0,
    tokens_out: 0,
    finished_at: null,
    created_at: "2026-08-30T09:00:00Z",
    updated_at: "2026-08-30T09:30:00Z",
    parent_agent_id: null,
  };
  window.progressLedger = {
    projectMode: {
      getChildren,
      getAgent: vi.fn().mockResolvedValue(getAgent || fallbackAgent),
      listMessages: vi.fn().mockResolvedValue([]),
    },
  };
  return { getChildren };
}

function resetStore() {
  projectModeStore.projects = [];
  projectModeStore.activeProjectId = null;
  projectModeStore.activeAgentId = null;
  projectModeStore.agent = null;
  projectModeStore.messages = [];
  projectModeStore.plan = [];
  projectModeStore.toolActivity = [];
  projectModeStore.pendingApprovals = [];
  projectModeStore.loadingProjects = false;
  projectModeStore.loadingMessages = false;
}

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// SubAgentTree
// ---------------------------------------------------------------------------

describe("SubAgentTree", () => {
  it("renders the parent agent with a derived role", async () => {
    setupIpc({ children: [] });
    projectModeStore.activeProjectId = 7;
    projectModeStore.activeAgentId = 1;
    projectModeStore.agent = {
      id: 1,
      project_id: 7,
      objective: "[researcher] survey the area",
      state: "running",
      plan_json: "[]",
      tokens_in: 0,
      tokens_out: 0,
      finished_at: null,
      created_at: "2026-08-30T09:00:00Z",
      updated_at: "2026-08-30T09:30:00Z",
      parent_agent_id: null,
    };
    render(SubAgentTree, { props: { profileId: 1, parentAgentId: 1 } });
    const parent = await screen.findByTestId("tree-parent");
    expect(parent).toBeInTheDocument();
    expect(parent).toHaveTextContent("researcher");
    expect(parent).toHaveTextContent("running");
  });

  it("renders children when getChildren returns a non-empty list", async () => {
    const { getChildren } = setupIpc({
      children: [
        makeChild(10, "[coder] implement foo", "running"),
        makeChild(11, "[tester] cover edge cases", "idle"),
      ],
    });
    projectModeStore.activeProjectId = 7;
    projectModeStore.activeAgentId = 1;
    projectModeStore.agent = {
      id: 1,
      project_id: 7,
      objective: "[reviewer] audit PR",
      state: "running",
      plan_json: "[]",
      tokens_in: 0,
      tokens_out: 0,
      finished_at: null,
      created_at: "2026-08-30T09:00:00Z",
      updated_at: "2026-08-30T09:30:00Z",
      parent_agent_id: null,
    };
    render(SubAgentTree, { props: { profileId: 1, parentAgentId: 1 } });
    await waitFor(() => {
      expect(getChildren).toHaveBeenCalled();
    });
    expect(await screen.findByTestId("tree-child-10")).toHaveTextContent("coder");
    expect(await screen.findByTestId("tree-child-11")).toHaveTextContent("tester");
  });

  it("renders an empty state when getChildren returns []", async () => {
    setupIpc({ children: [] });
    projectModeStore.activeProjectId = 7;
    projectModeStore.activeAgentId = 1;
    projectModeStore.agent = {
      id: 1,
      project_id: 7,
      objective: "lonely agent",
      state: "idle",
      plan_json: "[]",
      tokens_in: 0,
      tokens_out: 0,
      finished_at: null,
      created_at: "2026-08-30T09:00:00Z",
      updated_at: "2026-08-30T09:30:00Z",
      parent_agent_id: null,
    };
    render(SubAgentTree, { props: { profileId: 1, parentAgentId: 1 } });
    expect(await screen.findByTestId("tree-empty")).toHaveTextContent(/no sub-agents/i);
  });
});

// ---------------------------------------------------------------------------
// D13 — NATIVE (camelCase) child rows.
//
// `project:get-children` returns RAW napi rows (`projectId`, `updatedAt`); the
// fixtures above are the LEGACY snake_case shape. That is why
// `activeProjectId = agent.project_id` could set the workspace's project to
// `undefined` - i.e. opening a child's transcript CLEARED the project - on every
// real child, without one test noticing.
// ---------------------------------------------------------------------------

describe("SubAgentTree — native (camelCase) child rows", () => {
  it("renders a native child and opens its transcript with the REAL project id", async () => {
    setupIpc({
      children: [{
        id: 21,
        projectId: 7,
        objective: "[coder] native child",
        state: "running",
        planJson: "[]",
        tokensIn: 0,
        tokensOut: 0,
        createdAt: "2026-08-30T10:00:00Z",
        updatedAt: "2026-08-30T10:00:05Z",
        parentAgentId: 1,
      }],
    });
    projectModeStore.activeProjectId = 7;
    projectModeStore.activeAgentId = 1;
    projectModeStore.agent = {
      id: 1, projectId: 7, project_id: 7, objective: "[reviewer] audit",
      state: "running", planJson: "[]", plan_json: "[]",
    };

    render(SubAgentTree, { props: { profileId: 1, parentAgentId: 1 } });
    expect(await screen.findByTestId("tree-child-21")).toHaveTextContent("coder");

    await fireEvent.click(screen.getByTestId("open-child-21"));
    expect(projectModeStore.activeAgentId).toBe(21);
    expect(projectModeStore.activeProjectId).toBe(7);
  });
});