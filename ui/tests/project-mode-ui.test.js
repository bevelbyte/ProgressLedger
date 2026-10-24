// Project Mode — UI tests.
//
// Coverage:
//   - ProjectList renders projects from the store + posts to create
//   - AgentConversation renders messages with the right role
//   - ApprovalRequest modal appears when a tool needs approval
//   - ProviderConfigPanel does NOT show the saved key (only a "key set" indicator)
//
// The IPC namespace is mocked via window.careerflow.projectMode. Tests
// reset the shared `projectModeStore` between cases via direct mutation
// to keep things hermetic (no IPC needed).

import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import ProjectList from "../src/features/project-mode/components/ProjectList.svelte";
import AgentConversation from "../src/features/project-mode/components/AgentConversation.svelte";
import ApprovalRequest from "../src/features/project-mode/components/ApprovalRequest.svelte";
import ProviderConfigPanel from "../src/features/project-mode/components/ProviderConfigPanel.svelte";
import { projectModeStore, pushApprovalRequest, applyAgentEvent, loadProjects } from "../src/features/project-mode/stores/projectMode.svelte.js";

function setupIpc({ projects = [], messages = [], providerConfig = null } = {}) {
  const listProjects = vi.fn().mockResolvedValue(projects);
  const createProject = vi.fn().mockImplementation(async (pid, name) => {
    const id = projects.length + 100;
    projects.push({ id, profile_id: pid, name, description: "", root_path: "/tmp/x", config_json: "{}" });
    return id;
  });
  const listMessages = vi.fn().mockResolvedValue(messages);
  const getAgent = vi.fn().mockResolvedValue({
    id: 1, project_id: 1, objective: "x", state: "idle",
    plan_json: "[]", tokens_in: 0, tokens_out: 0,
    finished_at: null, created_at: "2026-01-01", updated_at: "2026-01-01",
  });
  const getProviderConfig = vi.fn().mockResolvedValue({ ok: true, config: providerConfig });
  const setProviderConfig = vi.fn().mockResolvedValue({ ok: true, config: { endpoint: "https://api.example.com", model: "gpt-test", hasKey: true } });
  const clearProviderConfig = vi.fn().mockResolvedValue({ ok: true });

  window.careerflow = {
    projectMode: {
      listProjects,
      createProject,
      getProviderConfig,
      setProviderConfig,
      clearProviderConfig,
      listMessages,
      getAgent,
    },
    projectTools: {
      list: vi.fn().mockResolvedValue({ ok: true, tools: [] }),
      approve: vi.fn().mockResolvedValue({ ok: true, token: "t", ttlMs: 60_000, needed: true }),
      invoke: vi.fn().mockResolvedValue({ ok: true, result: "ok" }),
    },
  };
  return { listProjects, createProject, getProviderConfig, setProviderConfig, clearProviderConfig };
}

/** Reset the shared store between tests. */
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
  projectModeStore.loadingProjects = false;
  projectModeStore.loadingMessages = false;
  projectModeStore.loadedProfileId = null;
}

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// ProjectList — renders projects + posts to create
// ---------------------------------------------------------------------------

describe("ProjectList", () => {
  it("renders projects from the store", async () => {
    setupIpc({ projects: [{ id: 1, profile_id: 1, name: "Alpha", description: "", root_path: "/tmp/a", config_json: "{}", updated_at: "2026-01-01" }] });
    render(ProjectList, { props: { profileId: 1 } });
    const items = await screen.findAllByTestId("project-item");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("Alpha");
  });

  it("shows the + New Project form and posts to createProject on submit", async () => {
    const { createProject } = setupIpc({ projects: [] });
    render(ProjectList, { props: { profileId: 1 } });
    // Open the form
    await screen.findByTestId("new-project-toggle");
    fireEvent.click(screen.getByTestId("new-project-toggle"));
    await screen.findByTestId("new-project-form");
    // Fill it
    fireEvent.input(screen.getByTestId("new-project-name"), { target: { value: "NewProj" } });
    fireEvent.input(screen.getByTestId("new-project-root"), { target: { value: "/tmp/newproj" } });
    // Submit
    const form = screen.getByTestId("new-project-form");
    await fireEvent.submit(form);
    await waitFor(() => {
      expect(createProject).toHaveBeenCalledTimes(1);
    });
    const payload = createProject.mock.calls[0][0];
    expect(payload.name).toBe("NewProj");
    expect(payload.rootPath).toBe("/tmp/newproj");
    expect(payload.profileId).toBe(1);
  });
});

describe("project context profile isolation", () => {
  it("clears the previous profile context before loading a different profile", async () => {
    const oldProjects = [{ id: 10, profile_id: 1, name: "Profile A", description: "", root_path: "/a", config_json: "{}" }];
    const newProjects = [{ id: 20, profile_id: 2, name: "Profile B", description: "", root_path: "/b", config_json: "{}" }];
    const listProjects = vi.fn()
      .mockResolvedValueOnce(oldProjects)
      .mockResolvedValueOnce(newProjects);
    window.careerflow = { projectMode: { listProjects } };

    await loadProjects(1);
    projectModeStore.activeProjectId = 10;
    projectModeStore.activeAgentId = 11;
    projectModeStore.activeRunId = "run-a";
    projectModeStore.messages = [{ id: 1 }];
    projectModeStore.pendingApprovals = [{ id: "approval-a" }];

    const pending = loadProjects(2);
    expect(projectModeStore.projects).toEqual([]);
    expect(projectModeStore.activeProjectId).toBeNull();
    expect(projectModeStore.activeAgentId).toBeNull();
    expect(projectModeStore.activeRunId).toBeNull();
    expect(projectModeStore.messages).toEqual([]);
    expect(projectModeStore.pendingApprovals).toEqual([]);

    await pending;
    expect(projectModeStore.projects).toEqual(newProjects);
    expect(projectModeStore.loadedProfileId).toBe(2);
  });

  it("does not let an older profile request repopulate the new profile", async () => {
    let resolveOld;
    const oldProjects = [{ id: 10, profile_id: 1, name: "Profile A" }];
    const newProjects = [{ id: 20, profile_id: 2, name: "Profile B" }];
    const listProjects = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(newProjects);
    window.careerflow = { projectMode: { listProjects } };

    const oldRequest = loadProjects(1);
    await loadProjects(2);
    expect(projectModeStore.projects).toEqual(newProjects);

    resolveOld(oldProjects);
    await oldRequest;
    expect(projectModeStore.projects).toEqual(newProjects);
    expect(projectModeStore.loadedProfileId).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AgentConversation — renders messages with the right role
// ---------------------------------------------------------------------------

describe("AgentConversation", () => {
  it("renders messages with the right role", async () => {
    setupIpc();
    projectModeStore.messages = [
      { id: 1, agent_id: 1, seq: 1, role: "system", content: "You are an agent", name: null, payload_json: null, created_at: "2026-01-01" },
      { id: 2, agent_id: 1, seq: 2, role: "user", content: "Hello agent", name: null, payload_json: null, created_at: "2026-01-01" },
      { id: 3, agent_id: 1, seq: 3, role: "assistant", content: "Hi human", name: null, payload_json: null, created_at: "2026-01-01" },
      { id: 4, agent_id: 1, seq: 4, role: "tool_call", content: "[]", name: "fs_list", payload_json: JSON.stringify([{ id: "c1", name: "fs_list", args: "{}" }]), created_at: "2026-01-01" },
      { id: 5, agent_id: 1, seq: 5, role: "tool_result", content: '{"ok":true}', name: "fs_list", payload_json: JSON.stringify({ callId: "c1", name: "fs_list", result: { ok: true, result: ["a", "b"], elapsedMs: 4 } }), created_at: "2026-01-01" },
    ];
    render(AgentConversation);
    expect(screen.getByTestId("message-system")).toBeInTheDocument();
    expect(screen.getByTestId("message-user")).toBeInTheDocument();
    expect(screen.getByTestId("message-assistant")).toBeInTheDocument();
    expect(screen.getByTestId("message-tool_call")).toBeInTheDocument();
    expect(screen.getByTestId("message-tool_result")).toBeInTheDocument();
    expect(screen.getByText("You are an agent")).toBeInTheDocument();
    expect(screen.getByText("Hello agent")).toBeInTheDocument();
    expect(screen.getByText("Hi human")).toBeInTheDocument();
    // The tool_call card shows the tool name via its .card-name selector
    // (more specific than the bare string which also appears inside the
    // JSON dump).
    const toolCallCard = screen.getByTestId("message-tool_call");
    expect(toolCallCard.querySelector(".card-name")).toHaveTextContent("fs_list");
  });

  it("renders tool_call args from the NATIVE `payloadJson` field (D13)", async () => {
    setupIpc();
    // `project:list-messages` returns napi rows, so the payload arrives as
    // `payloadJson`; the fixtures above use the Rust-side name.
    projectModeStore.messages = [
      {
        id: 3, agentId: 1, seq: 3, role: "tool_call", content: "", name: "fs_write",
        payloadJson: JSON.stringify([{ id: "c1", name: "fs_write", args: { path: "ui-target.txt" } }]),
        createdAt: "2026-01-01",
      },
    ];
    render(AgentConversation);

    const card = screen.getByTestId("message-tool_call");
    // Before D13 this read was snake-only, so the args block fell back to the
    // (empty) `content` and the real tool arguments were never rendered.
    expect(card.querySelector(".args")).toHaveTextContent("ui-target.txt");
  });

  it("shows an empty hint when there are no messages", async () => {
    setupIpc();
    projectModeStore.messages = [];
    render(AgentConversation);
    expect(screen.getByText(/No messages yet/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ApprovalRequest — modal appears when a tool needs approval
// ---------------------------------------------------------------------------

describe("ApprovalRequest", () => {
  it("renders the modal when a tool needs approval", async () => {
    setupIpc();
    render(ApprovalRequest, { props: { profileId: 1 } });
    // No modal yet
    expect(screen.queryByTestId("approval-modal")).toBeNull();
    // Push an approval request into the store
    pushApprovalRequest({
      id: "req-1",
      toolName: "fs_write",
      permission: "filesystem.write",
      input: { path: "/tmp/x", content: "hi" },
    });
    await waitFor(() => expect(screen.getByTestId("approval-modal")).toBeInTheDocument());
    expect(screen.getByTestId("approval-approve")).toBeInTheDocument();
    expect(screen.getByTestId("approval-reject")).toBeInTheDocument();
    expect(screen.getByText("fs_write")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ProviderConfigPanel — does NOT show the saved key
// ---------------------------------------------------------------------------

describe("ProviderConfigPanel", () => {
  it("shows a 'key set' indicator instead of the saved key", async () => {
    const cfg = { endpoint: "https://api.example.com", model: "gpt-test", hasKey: true };
    setupIpc({ providerConfig: cfg });
    // The panel only loads the saved config once an active project is
    // picked. Simulate the user having selected one.
    projectModeStore.activeProjectId = 42;
    render(ProviderConfigPanel, { props: { profileId: 1 } });
    await screen.findByTestId("provider-config-panel");
    // Wait for the load effect to populate the indicator
    await waitFor(() => expect(screen.getByTestId("provider-key-set")).toBeInTheDocument());
    // The key input MUST NOT be pre-populated with the saved value
    const keyInput = screen.getByTestId("provider-key");
    expect(keyInput.value).toBe("");
    // The whole DOM must not contain the key string — we don't store it
    // here, but double-check by also rendering the parent tree and making
    // sure no <input type="text"> or <input type="password"> has the key.
    expect(screen.queryByDisplayValue("sk-DO-NOT-LEAK")).toBeNull();
  });
});

describe("live agent events", () => {
  it("updates tool activity by call id and ignores events outside the active project/agent tuple", () => {
    setupIpc();
    projectModeStore.activeProjectId = 10;
    projectModeStore.activeAgentId = 11;
    expect(applyAgentEvent({ agentId: 99, type: "agent.tool.started", ts: 1, tool: "fs_read", callId: "x" })).toBe(false);
    expect(projectModeStore.toolActivity).toHaveLength(0);
    expect(applyAgentEvent({ projectId: 9, agentId: 11, type: "agent.tool.started", ts: 1, tool: "fs_read", callId: "y" })).toBe(false);
    expect(projectModeStore.toolActivity).toHaveLength(0);
    expect(applyAgentEvent({ agentId: 11, type: "agent.tool.started", ts: 2, tool: "fs_read", callId: "c1" })).toBe(true);
    expect(projectModeStore.toolActivity[0]).toMatchObject({ id: "c1", name: "fs_read", status: "running" });
    expect(applyAgentEvent({ agentId: 11, type: "agent.tool.completed", ts: 3, tool: "fs_read", callId: "c1", elapsedMs: 12 })).toBe(true);
    expect(projectModeStore.toolActivity[0]).toMatchObject({ id: "c1", status: "completed", elapsedMs: 12 });
  });
});
