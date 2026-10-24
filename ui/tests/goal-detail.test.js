/**
 * GoalDetailView UI tests — Phase 16.
 *
 * Phase 16 root cause: the original file assigned `goalsStore.events`
 * directly, but the runes store exposes getters only. The store now
 * ships `__testSeed(goals, events)` for hermetic seeding. All IPC
 * mocks are genuinely async (defer store reads past an await) so no
 * reactive loop fires inside the component's effects (see
 * goals-panel.test.js header for the full diagnosis).
 */

import { render, cleanup } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import GoalDetailView from "../src/features/goals/components/GoalDetailView.svelte";
import { goalsStore } from "../src/features/goals/stores/goals.svelte.js";

function makeGoal(over = {}) {
  return {
    id: 1,
    profileId: 1,
    projectId: 1,
    title: "Refactor auth",
    objective: "Refactor the auth module to use AuthService",
    kind: "code_change",
    state: "running",
    priority: "normal",
    requireVerification: true,
    linkedAgentId: 42,
    failureReason: "",
    resultText: "",
    planStepCount: 3,
    createdAt: "2026-01-01T00:00:00Z",
    startedAt: "2026-01-01T00:00:01Z",
    updatedAt: "2026-01-01T00:00:01Z",
    completedAt: null,
    ...over,
  };
}

function setupIpc(events = []) {
  globalThis.window = {
    careerflow: {
      goals: {
        listEvents: vi.fn(async () => {
          await Promise.resolve();
          return events.slice();
        }),
        get: vi.fn(async () => null),
      },
    },
  };
}

function tick() {
  return new Promise((r) => setTimeout(r, 30));
}

describe("GoalDetailView", () => {
  afterEach(() => cleanup());

  it("renders an empty state when no goal is provided", async () => {
    setupIpc();
    render(GoalDetailView, { goal: null });
    await tick();
    expect(document.querySelector(".empty")).toBeTruthy();
    expect(document.querySelector('[data-testid="goal-detail"]')).toBeFalsy();
  });

  it("renders goal metadata + state pill", async () => {
    setupIpc();
    const goal = makeGoal({ state: "running" });
    goalsStore.__testSeed([goal], []);
    render(GoalDetailView, { goal });
    await tick();
    const pill = document.querySelector('[data-testid="goal-state-pill"]');
    expect(pill).toBeTruthy();
    // phaseLabel() capitalizes the phase ("Executing").
    expect(pill.textContent.trim().toLowerCase()).toContain("executing");
    expect(document.querySelector('[data-testid="goal-detail"]')).toBeTruthy();
    expect(document.body.textContent).toContain("Refactor auth");
    expect(document.body.textContent).toContain("Refactor the auth module to use AuthService");
    // Linked agent button exists.
    expect(document.querySelector('[data-testid="open-agent-button"]')).toBeTruthy();
  });

  it("renders failure reason when present", async () => {
    setupIpc();
    const goal = makeGoal({ state: "failed", failureReason: "tests timed out" });
    goalsStore.__testSeed([goal], []);
    render(GoalDetailView, { goal });
    await tick();
    const reason = document.querySelector('[data-testid="goal-failure-reason"]');
    expect(reason).toBeTruthy();
    expect(reason.textContent).toContain("tests timed out");
  });

  it("renders result text when present", async () => {
    setupIpc();
    const goal = makeGoal({ state: "completed", resultText: "All tests pass" });
    goalsStore.__testSeed([goal], []);
    render(GoalDetailView, { goal });
    await tick();
    const result = document.querySelector('[data-testid="goal-result"]');
    expect(result).toBeTruthy();
    expect(result.textContent).toContain("All tests pass");
  });

  it("renders timeline events when provided", async () => {
    // The IPC layer returns events newest-first (created_at DESC).
    const newest = [
      { id: 2, goalId: 1, event: "state_changed", message: "created -> starting", payloadJson: null, createdAt: "2026-01-01T00:00:01Z" },
      { id: 1, goalId: 1, event: "created", message: "Goal created", payloadJson: null, createdAt: "2026-01-01T00:00:00Z" },
    ];
    setupIpc(newest);
    const goal = makeGoal({ state: "running" });
    goalsStore.__testSeed([goal], newest);
    render(GoalDetailView, { goal });
    await tick();
    const tl = document.querySelector('[data-testid="goal-timeline"]');
    expect(tl).toBeTruthy();
    const rows = tl.querySelectorAll(".timeline-row");
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("state changed");
    expect(rows[1].textContent).toContain("created");
  });

  it("renders truthful progress when the agent snapshot is loaded", async () => {
    setupIpc();
    const goal = makeGoal({
      id: 1,
      state: "running",
      linkedAgentId: 42,
      planStepCount: 4,
    });
    goalsStore.__testSeed([goal], []);
    // Agent snapshots are keyed by GOAL id (see refreshAgentSnapshot
    // in the store) — seed with goal.id = 1.
    goalsStore.__testSeedAgentSnapshot(1, {
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
    });
    render(GoalDetailView, { goal });
    await tick();
    const progress = document.querySelector('[data-testid="goal-progress"]');
    expect(progress).toBeTruthy();
    const pct = document.querySelector('[data-testid="goal-progress-percent"]');
    expect(pct.textContent).toContain("50");
    const done = document.querySelector('[data-testid="goal-progress-done"]');
    expect(done.textContent).toBe("2");
  });

  it("does not render a fake 100% on failed goals", async () => {
    setupIpc();
    const goal = makeGoal({
      id: 1,
      state: "failed",
      failureReason: "tests timed out",
      planStepCount: 4,
    });
    goalsStore.__testSeed([goal], []);
    goalsStore.__testSeedAgentSnapshot(1, {
      id: 42,
      state: "failed",
      planJson: JSON.stringify([
        { id: "s1", status: "done" },
        { id: "s2", status: "failed" },
      ]),
      tokensIn: 10,
      tokensOut: 20,
    });
    render(GoalDetailView, { goal });
    await tick();
    const pct = document.querySelector('[data-testid="goal-progress-percent"]');
    // 1 of 2 steps done = 50%, NOT forced to 100.
    expect(pct.textContent).toContain("50");
  });
});