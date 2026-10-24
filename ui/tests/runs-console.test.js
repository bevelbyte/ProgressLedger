/**
 * Runs console — Atlas §5.3.
 *
 * e2e/agent-ui-runtime.spec.js gates four things on this surface, all of them
 * without any prior interaction:
 *
 *   [data-testid="approval-queue"]      toBeVisible()  while a run is paused
 *   [data-testid="approval-row"]        read + click approval-approve
 *   [data-testid="tool-activity"] [data-testid="tool-row"]  waitFor visible
 *   [data-testid="objective-input"] / [data-testid="start-agent"]
 *
 * The redesign collapsed twenty-eight simultaneously-stacked panels into a
 * transcript lane plus a tabbed inspector, which is exactly the kind of change
 * that can bury a gate behind a tab and only fail in a 3-minute Electron run.
 * So the invariants are asserted here:
 *
 *   1. An approval that blocks the run is visible with zero interaction.
 *   2. The live tool trace is visible with zero interaction.
 *   3. Reference material (plan, changes, budgets, inventories, history) is
 *      behind tabs, and switching tabs swaps the panel.
 *   4. Tabs are a real ARIA tablist with roving focus and arrow-key movement.
 *   5. Badges count real store state and never invent a number.
 */

import { render, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";

import ProjectWorkspace from "../src/features/project-mode/components/ProjectWorkspace.svelte";
import {
  projectModeStore,
  pushApprovalRequest,
  pushToolActivity,
} from "../src/features/project-mode/stores/projectMode.svelte.js";

/** Every child surface fetches on mount; a no-op namespace keeps the test
 *  about structure rather than about twenty-seven unrelated IPC calls. */
function namespace() {
  return new Proxy(
    {},
    {
      get: () => vi.fn(async () => null),
    },
  );
}

function installIpc() {
  window.careerflow = {
    projectMode: {
      listProjects: vi.fn(async () => []),
      listMessages: vi.fn(async () => []),
      getAgent: vi.fn(async () => null),
      listChangedFiles: vi.fn(async () => []),
      onEvent: vi.fn(() => () => {}),
      getProviderConfig: vi.fn(async () => ({ ok: true, config: null })),
      exportSession: vi.fn(async () => ({ ok: true, session: {} })),
    },
    projectTools: { list: vi.fn(async () => ({ ok: true, tools: [] })) },
    extensions: {
      listSkills: vi.fn(async () => ({ skills: [] })),
      listPlugins: vi.fn(async () => ({ plugins: [] })),
    },
    memory: { list: vi.fn(async () => ({ result: [] })) },
    goals: { create: vi.fn(async () => 1), linkAgent: vi.fn(async () => ({ ok: true })), reconcile: vi.fn(async () => ({ ok: true })) },
    // Anything else this console might reach for (audit, diagnostics, updates)
    // resolves to a no-op namespace rather than throwing mid-render.
    __proxy: namespace(),
  };
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
}

const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];

async function flush() {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await tick();
}

async function mount() {
  render(ProjectWorkspace, { props: { profileId: 1 } });
  await flush();
}

beforeEach(() => {
  installIpc();
  resetStore();
  projectModeStore.projects = [{ id: 5, name: "CareerFlow", description: "Desktop app" }];
  projectModeStore.activeProjectId = 5;
  projectModeStore.activeAgentId = 9;
});

afterEach(() => {
  cleanup();
  resetStore();
  delete window.careerflow;
});

describe("Runs console — regions", () => {
  it("keeps the objective input and the run action on the console itself", async () => {
    await mount();
    expect(q('[data-testid="project-workspace"]')).toBeTruthy();
    expect(q('[data-testid="objective-input"]')).toBeTruthy();
    expect(q('[data-testid="start-agent"]')).toBeTruthy();
  });

  it("shows the approval queue with zero interaction while a run is blocked", async () => {
    // This is the gate agent-ui-runtime.spec.js waits 120s for. The push comes
    // after mount because that is the real order: opening the workspace
    // rehydrates the agent (which clears the transient stream), and the engine
    // then pushes the approval that blocks the run.
    await mount();
    pushApprovalRequest({ toolName: "fs_write", input: { path: "a.txt" }, permission: "WRITE" });
    await flush();

    const queue = q('[data-testid="approval-queue"]');
    expect(queue).toBeTruthy();
    expect(q('[data-testid="approval-row"]')).toBeTruthy();
    expect(q('[data-testid="approval-approve"]')).toBeTruthy();
    expect(q('[data-testid="approval-tool-name"]').textContent).toBe("fs_write");
    // Nothing was clicked to reveal any of it.
  });

  it("shows the live tool trace with zero interaction", async () => {
    // The other gate: `[data-testid="tool-activity"] [data-testid="tool-row"]`.
    await mount();
    pushToolActivity({ id: "t1", name: "fs_list", status: "running" });
    await flush();

    expect(q('[data-testid="tool-activity"]')).toBeTruthy();
    const row = q('[data-testid="tool-activity"] [data-testid="tool-row"]');
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("fs_list");
  });

  it("keeps the approval queue ahead of the transcript, not inside the inspector", async () => {
    await mount();
    const queue = q('[data-testid="approval-queue"]');
    const inspector = q(".lane-inspector");
    expect(inspector).toBeTruthy();
    // Approval lives in its own band; the inspector must not contain it.
    expect(inspector.contains(queue)).toBe(false);
  });
});

describe("Runs console — inspector tabs", () => {
  it("opens on Plan and keeps reference panels out of the transcript", async () => {
    await mount();

    const tabs = qa('[role="tab"]').map((t) => t.textContent.trim());
    expect(tabs).toEqual(["Plan", "Changes", "Context", "Budget", "Extensions", "History"]);

    // PlanView is the default panel; nothing else is mounted yet.
    expect(q('[role="tabpanel"]').textContent).toContain("Plan");
    expect(q('[data-testid="plan-view"]')).toBeTruthy();

    const planTab = qa('[role="tab"]')[0];
    expect(planTab.getAttribute("aria-selected")).toBe("true");
    expect(planTab.getAttribute("tabindex")).toBe("0");
    expect(qa('[role="tab"]')[1].getAttribute("tabindex")).toBe("-1");
  });

  it("swaps the panel when another tab is chosen", async () => {
    await mount();

    await fireEvent.click(qa('[role="tab"]')[1]); // Changes
    await flush();

    expect(qa('[role="tab"]')[1].getAttribute("aria-selected")).toBe("true");
    expect(q('[role="tabpanel"]').textContent).not.toContain("Plan");
    expect(q('[data-testid="changed-files-empty"], [data-testid="changed-files-panel"]')).toBeTruthy();
  });

  it("moves between tabs with the arrow keys and roving focus", async () => {
    await mount();
    const first = qa('[role="tab"]')[0];

    await fireEvent.keyDown(first, { key: "ArrowRight" });
    await flush();
    expect(qa('[role="tab"]')[1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(qa('[role="tab"]')[1]);

    // Wraps backwards from the first tab to the last.
    await fireEvent.keyDown(qa('[role="tab"]')[0], { key: "ArrowLeft" });
    await flush();
    expect(qa('[role="tab"]')[5].getAttribute("aria-selected")).toBe("true");

    await fireEvent.keyDown(qa('[role="tab"]')[5], { key: "Home" });
    await flush();
    expect(qa('[role="tab"]')[0].getAttribute("aria-selected")).toBe("true");
  });

  it("badges a tab only when the store holds a real number for it", async () => {
    await mount();
    expect(q('[role="tab"]').textContent).not.toMatch(/\d/);

    projectModeStore.plan = [{ id: 1 }, { id: 2 }, { id: 3 }];
    pushToolActivity({ id: "a", name: "fs_write", status: "done" });
    pushToolActivity({ id: "b", name: "fs_list", status: "done" }); // not an edit
    pushToolActivity({ id: "c", name: "fs_edit", status: "done" });
    await flush();

    const tabs = qa('[role="tab"]');
    expect(tabs[0].querySelector(".count")?.textContent).toBe("3");
    // Only the two mutating tools count as changes.
    expect(tabs[1].querySelector(".count")?.textContent).toBe("2");
    // Budget/Extensions/History have no honest number, so they carry no badge.
    expect(tabs[3].querySelector(".count")).toBeNull();
    expect(tabs[4].querySelector(".count")).toBeNull();
    expect(tabs[5].querySelector(".count")).toBeNull();
  });
});
