/**
 * Goal Mode UI tests — Phase 16.
 *
 * Phase 16 root cause (proven by minimal reproduction):
 *   The original test file's IPC mocks read `goalsStore.goals` /
 *   `goalsStore.events` SYNCHRONOUSLY inside the component's
 *   `$effect` execution. In Svelte 5 runes, a synchronous read of a
 *   `$state` field during effect execution registers that field as a
 *   reactive dependency of the effect. `loadGoals()` then WRITES
 *   `state.goals` (replacing the array), which re-fires the effect,
 *   which reads again, which writes again — an infinite reactive
 *   loop that exhausts the stack and kills the vitest worker
 *   ("Worker exited unexpectedly" from tinypool).
 *
 *   Production is NOT affected: `window.progressLedger.goals.list` is
 *   `ipcRenderer.invoke(...)` — an always-async promise, so the
 *   store is never read synchronously during the effect body.
 *
 *   The fix: mocks are made genuinely async — any store read is
 *   deferred past an `await Promise.resolve()` so it lands outside
 *   the effect's synchronous tracking window. This mirrors the
 *   production IPC contract exactly.
 *
 * All 12 required scenarios are covered below.
 */

import { render, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import GoalsPanel from "../src/features/goals/components/GoalsPanel.svelte";
import { goalsStore } from "../src/features/goals/stores/goals.svelte.js";
import { toastState } from "../src/shared/stores/toasts.svelte.js";

/**
 * The composer is a dialog rather than a permanently open form (the list is
 * now the surface), and cancel/delete use the product's own confirmation
 * dialog rather than `window.confirm()` — a native confirm blocks the
 * renderer, cannot be themed, and focuses the destructive action first.
 *
 * Both are presentation changes; the behavioural contracts below (the IPC
 * payload, the grouping, the state transitions, and "nothing happens until
 * the user explicitly confirms") are unchanged and still asserted.
 */
async function openComposer() {
  const btn = document.querySelector('[data-testid="goal-new-button"]');
  expect(btn).toBeTruthy();
  await fireEvent.click(btn);
  await tick();
}

function makeGoal(over = {}) {
  return {
    id: 1,
    profileId: 1,
    projectId: 1,
    title: "Refactor auth",
    objective: "Refactor the auth module to use AuthService",
    kind: "code_change",
    state: "created",
    priority: "normal",
    requireVerification: true,
    linkedAgentId: null,
    failureReason: "",
    resultText: "",
    planStepCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    startedAt: null,
    updatedAt: "2026-01-01T00:00:00Z",
    completedAt: null,
    ...over,
  };
}

// Local, non-reactive backing array. Mocks read this AFTER an await so
// the store is never read synchronously inside an effect.
let backingGoals = [];

let cancelCalls = [];
let startCalls = [];
let reconcileCalls = [];

function setupIpc(goals = []) {
  cancelCalls = [];
  startCalls = [];
  reconcileCalls = 0;
  backingGoals = goals.map((g) => ({ ...g }));
  goalsStore.__testSeed(goals);
  globalThis.confirm = vi.fn(() => true);
  // Assign the IPC namespace onto the REAL jsdom window instead of replacing
  // `window` wholesale. Replacing it strips addEventListener/removeEventListener,
  // which every overlay in the product legitimately needs (Modal, the keyboard
  // reference, the command palette) — so a wholesale swap turned a dialog or
  // key-handling regression into a harness error rather than a real failure.
  globalThis.window.progressLedger = {
    goals: {
        list: vi.fn(async () => {
          await Promise.resolve();
          return backingGoals.slice();
        }),
        get: vi.fn(async (pid, gid) => {
          await Promise.resolve();
          return backingGoals.find((g) => g.id === gid) || null;
        }),
        create: vi.fn(async (input) => {
          await Promise.resolve();
          const id = backingGoals.length + 100;
          backingGoals.push(makeGoal({ id, ...input }));
          goalsStore.__testSeed(backingGoals);
          return id;
        }),
        remove: vi.fn(async () => {
          await Promise.resolve();
          return { ok: true };
        }),
        start: vi.fn(async (pid, gid) => {
          startCalls.push({ pid, gid });
          await Promise.resolve();
          const g = backingGoals.find((g) => g.id === gid);
          if (g) g.state = "running";
          goalsStore.__testSeed(backingGoals);
          return { ok: true, runId: "r1" };
        }),
        cancel: vi.fn(async (pid, gid) => {
          cancelCalls.push({ pid, gid });
          await Promise.resolve();
          const g = backingGoals.find((g) => g.id === gid);
          if (g) g.state = "cancelled";
          goalsStore.__testSeed(backingGoals);
          return { ok: true };
        }),
        listEvents: vi.fn(async () => {
          await Promise.resolve();
          return [];
        }),
        getAgentId: vi.fn(async () => {
          await Promise.resolve();
          return null;
        }),
        reconcile: vi.fn(async () => {
          reconcileCalls += 1;
          await Promise.resolve();
          return { ok: true };
        }),
        onEvent: vi.fn(() => () => {}),
    },
  };
}

function tick() {
  return new Promise((r) => setTimeout(r, 30));
}

describe("GoalsPanel — orchestration/dashboard view", () => {
  afterEach(() => cleanup());

  it("1. renders the goals panel, and the composer on demand", async () => {
    setupIpc();
    render(GoalsPanel, { profileId: 1, projectId: 1 });
    await tick();
    expect(document.querySelector('[data-testid="goals-panel"]')).toBeTruthy();

    // The surface leads with the goals; the form is not permanently open.
    expect(document.querySelector('[data-testid="goal-create-form"]')).toBeFalsy();
    expect(document.querySelector('[data-testid="goal-new-button"]')).toBeTruthy();

    await openComposer();
    expect(document.querySelector('[data-testid="goal-create-form"]')).toBeTruthy();
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it("2. renders the empty state when no goals exist", async () => {
    setupIpc([]);
    render(GoalsPanel, { profileId: 1, projectId: 1 });
    await tick();
    // Empty state renders the "No active goals." / "No finished goals
    // yet." paragraphs instead of list elements.
    expect(document.body.textContent).toContain("No active goals.");
    expect(document.body.textContent).toContain("No finished goals yet.");
    expect(document.querySelector('[data-testid="goal-list-active"]')).toBeFalsy();
    expect(document.querySelector('[data-testid="goal-list-finished"]')).toBeFalsy();
  });

  it("3. create goal invokes progressLedger.goals.create with the form payload", async () => {
    setupIpc();
    render(GoalsPanel, { profileId: 1, projectId: 1 });
    await tick();
    await openComposer();
    const title = document.querySelector('[data-testid="goal-title-input"]');
    const objective = document.querySelector('[data-testid="goal-objective-input"]');
    expect(title).toBeTruthy();
    expect(objective).toBeTruthy();
    // Fill the form.
    await fireEvent.input(title, { target: { value: "Fix the parser" } });
    await fireEvent.input(objective, { target: { value: "Make the parser handle CRLF" } });
    await tick();
    const form = document.querySelector('[data-testid="goal-create-form"]');
    await fireEvent.submit(form);
    await tick();
    expect(window.progressLedger.goals.create).toHaveBeenCalled();
    const payload = window.progressLedger.goals.create.mock.calls[0][0];
    expect(payload.title).toBe("Fix the parser");
    expect(payload.objective).toBe("Make the parser handle CRLF");
    expect(payload.projectId).toBe(1);
  });

  it("4. lists goals grouped into active + finished sections", async () => {
    setupIpc([
      makeGoal({ id: 1, title: "Refactor auth", state: "created" }),
      makeGoal({ id: 2, title: "Research X", state: "running" }),
      makeGoal({ id: 3, title: "Done thing", state: "completed" }),
      makeGoal({ id: 4, title: "Broken thing", state: "failed" }),
    ]);
    render(GoalsPanel, { profileId: 1, projectId: 1 });
    await tick();
    const rows = document.querySelectorAll('[data-testid="goal-row"]');
    expect(rows.length).toBe(4);
    const activeList = document.querySelector('[data-testid="goal-list-active"]');
    expect(activeList.textContent).toContain("Refactor auth");
    expect(activeList.textContent).toContain("Research X");
    expect(activeList.textContent).not.toContain("Done thing");
    const finishedList = document.querySelector('[data-testid="goal-list-finished"]');
    expect(finishedList.textContent).toContain("Done thing");
    expect(finishedList.textContent).toContain("Broken thing");
  });

  it("5. start goal invokes progressLedger.goals.start and reflects running state", async () => {
    setupIpc([makeGoal({ id: 7, state: "created" })]);
    render(GoalsPanel, { profileId: 1, projectId: 1 });
    await tick();
    const btn = document.querySelector('[data-testid="goal-start-button"]');
    expect(btn).toBeTruthy();
    await fireEvent.click(btn);
    await tick();
    expect(startCalls.length).toBeGreaterThanOrEqual(1);
    expect(startCalls[0]).toEqual({ pid: 1, gid: 7 });
    // After start, the goal moves to the active section as running.
    const row = document.querySelector('[data-testid="goal-row"][data-state="running"]');
    expect(row).toBeTruthy();
  });

  it("6. running state renders a cancel affordance and no start affordance", async () => {
    setupIpc([makeGoal({ id: 9, state: "running" })]);
    render(GoalsPanel, { profileId: 1, projectId: 1 });
    await tick();
    expect(document.querySelector('[data-testid="goal-start-button"]')).toBeFalsy();
    const cancelBtn = document.querySelector('[data-testid="goal-cancel-button"]');
    expect(cancelBtn).toBeTruthy();
    const row = document.querySelector('[data-testid="goal-row"][data-state="running"]');
    expect(row).toBeTruthy();
  });

  it("7. cancellation invokes progressLedger.goals.cancel after explicit confirmation", async () => {
    setupIpc([makeGoal({ id: 9, state: "running" })]);
    render(GoalsPanel, { profileId: 1, projectId: 1 });
    await tick();
    const cancelBtn = document.querySelector('[data-testid="goal-cancel-button"]');
    expect(cancelBtn).toBeTruthy();
    await fireEvent.click(cancelBtn);
    await tick();

    // The product's own dialog is requested, and it is a destructive one.
    expect(toastState.confirm).toBeTruthy();
    expect(toastState.confirm.title).toMatch(/Cancel this goal/i);
    expect(toastState.confirm.danger).toBe(true);
    // Nothing is cancelled until the user commits.
    expect(cancelCalls.length).toBe(0);

    toastState.confirm.resolve(true);
    await tick();
    expect(cancelCalls.length).toBeGreaterThanOrEqual(1);
    expect(cancelCalls[0]).toEqual({ pid: 1, gid: 9 });
    const row = document.querySelector('[data-testid="goal-row"][data-state="cancelled"]');
    expect(row).toBeTruthy();
  });

  it("7b. declining the confirmation leaves the goal running", async () => {
    setupIpc([makeGoal({ id: 21, state: "running" })]);
    render(GoalsPanel, { profileId: 1, projectId: 1 });
    await tick();
    await fireEvent.click(document.querySelector('[data-testid="goal-cancel-button"]'));
    await tick();

    expect(toastState.confirm).toBeTruthy();
    toastState.confirm.resolve(false);
    await tick();

    expect(cancelCalls.length).toBe(0);
    expect(document.querySelector('[data-testid="goal-row"][data-state="running"]')).toBeTruthy();
  });

  it("7c. deleting a finished goal also requires explicit confirmation", async () => {
    setupIpc([makeGoal({ id: 31, state: "completed" })]);
    render(GoalsPanel, { profileId: 1, projectId: 1 });
    await tick();
    const btn = document.querySelector('[data-testid="goal-remove-button"]');
    expect(btn).toBeTruthy();
    await fireEvent.click(btn);
    await tick();

    expect(toastState.confirm).toBeTruthy();
    expect(toastState.confirm.title).toMatch(/Delete this goal/i);
    // The remove IPC is only reached after the commit.
    expect(window.progressLedger.goals.remove).not.toHaveBeenCalled();
    toastState.confirm.resolve(true);
    await tick();
    expect(window.progressLedger.goals.remove).toHaveBeenCalledWith(1, 31);
  });

  it("8. completed state renders in the finished section with no actions", async () => {
    setupIpc([makeGoal({ id: 11, state: "completed", resultText: "All done" })]);
    render(GoalsPanel, { profileId: 1, projectId: 1 });
    await tick();
    // The list row shows the completed state; the result text is
    // rendered by GoalDetailView (covered in goal-detail.test.js).
    const finishedList = document.querySelector('[data-testid="goal-list-finished"]');
    expect(finishedList).toBeTruthy();
    expect(finishedList.textContent).toContain("Refactor auth");
    expect(document.querySelector('[data-testid="goal-start-button"]')).toBeFalsy();
    expect(document.querySelector('[data-testid="goal-cancel-button"]')).toBeFalsy();
    const row = document.querySelector('[data-testid="goal-row"][data-state="completed"]');
    expect(row).toBeTruthy();
  });

  it("9. failed state renders in the finished section", async () => {
    setupIpc([makeGoal({ id: 12, state: "failed", failureReason: "tests timed out" })]);
    render(GoalsPanel, { profileId: 1, projectId: 1 });
    await tick();
    // The list row shows the failed state; the failure reason is
    // rendered by GoalDetailView (covered in goal-detail.test.js).
    const finishedList = document.querySelector('[data-testid="goal-list-finished"]');
    expect(finishedList).toBeTruthy();
    expect(finishedList.textContent).toContain("Refactor auth");
    const row = document.querySelector('[data-testid="goal-row"][data-state="failed"]');
    expect(row).toBeTruthy();
  });

  it("10. selecting a goal loads its timeline events via listEvents", async () => {
    setupIpc([makeGoal({ id: 13, state: "created" })]);
    render(GoalsPanel, { profileId: 1, projectId: 1 });
    await tick();
    // The row's main button carries the selection handler.
    const rowBtn = document.querySelector(".goal-row-main");
    expect(rowBtn).toBeTruthy();
    await fireEvent.click(rowBtn);
    await tick();
    // Selecting a goal asks the IPC layer for its timeline events.
    expect(window.progressLedger.goals.listEvents).toHaveBeenCalledWith(1, 13, 100);
  });

  it("11. progress is derived from the linked agent snapshot (not invented)", async () => {
    setupIpc([
      makeGoal({
        id: 14,
        state: "running",
        linkedAgentId: 42,
        planStepCount: 4,
      }),
    ]);
    // Provide the agent snapshot via the store so progressFor() can
    // derive the plan.
    goalsStore.__testSeed([
      makeGoal({ id: 14, state: "running", linkedAgentId: 42, planStepCount: 4 }),
    ]);
    // The store loads agent snapshots from projectMode.getAgent; wire it.
    globalThis.window.progressLedger.projectMode = {
      getAgent: async () => ({
        id: 42,
        state: "executing_tool",
        planJson: JSON.stringify([
          { id: "s1", status: "done" },
          { id: "s2", status: "done" },
          { id: "s3", status: "running" },
          { id: "s4", status: "pending" },
        ]),
        tokensIn: 10,
        tokensOut: 20,
      }),
    };
    render(GoalsPanel, { profileId: 1, projectId: 1 });
    await tick();
    // The progress computation is validated by the progress unit tests;
    // here we assert the store-level contract: progressFor reads the
    // agent snapshot and derives 50% (2/4 done).
    const p = goalsStore.progressFor(goalsStore.goals[0]);
    expect(p.phase).toBe("executing");
    expect(p.percent).toBe(50);
    expect(p.total).toBe(4);
    expect(p.percentReliable).toBe(true);
  });

  it("12. reconcile/refresh is invoked on mount and re-lists goals", async () => {
    setupIpc([makeGoal({ id: 15, state: "created" })]);
    render(GoalsPanel, { profileId: 1, projectId: 1 });
    await tick();
    expect(window.progressLedger.goals.reconcile).toHaveBeenCalledWith(1);
    expect(window.progressLedger.goals.list).toHaveBeenCalled();
  });
});