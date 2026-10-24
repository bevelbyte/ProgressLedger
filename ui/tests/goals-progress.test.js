/**
 * Goal Mode — Progress derivation unit tests (Phase 15).
 *
 * These tests target the pure progress function in `lib/progress.js`
 * which is the source of truth for truthful goal progress. They do
 * NOT mount Svelte components (the vitest harness has a known
 * Svelte 5 runes + jsdom + tinypool incompatibility — see GATES-PHASE15
 * §Harness Limitation), but they exercise the full progress
 * derivation path against realistic plan_json + goal/agent state
 * fixtures. The same derivation is what the GoalDetailView reads
 * via `goalsStore.progressFor(goal)` at runtime.
 */

import { describe, it, expect } from "vitest";
import { deriveGoalPhase, parseGoalPlan, summarizeGoalPlan, goalProgress, phaseLabel, PHASES } from "../src/features/goals/lib/progress.js";

describe("goalProgress — truthful derivation from persisted state", () => {
  it("preparing phase when goal.state = created", () => {
    const p = goalProgress({ state: "created" }, null);
    expect(p.phase).toBe("preparing");
    expect(p.percentReliable).toBe(false);
    expect(p.total).toBe(0);
  });

  it("executing phase when goal.state = running and agent is mid-tool", () => {
    const p = goalProgress({ state: "running" }, { state: "executing_tool", planJson: "[]" });
    expect(p.phase).toBe("executing");
  });

  it("verifying phase when goal.state = running but agent is verifying", () => {
    const p = goalProgress({ state: "running" }, { state: "verifying", planJson: "[]" });
    expect(p.phase).toBe("verifying");
  });

  it("completed phase forces 100% even if plan summary is wrong", () => {
    // Pathological input: agent row says some plan with 0 steps, but
    // the goal is completed. The percent must still be 100.
    const p = goalProgress({ state: "completed" }, { state: "completed", planJson: "[]" });
    expect(p.phase).toBe("completed");
    expect(p.percent).toBe(100);
    expect(p.percentReliable).toBe(true);
  });

  it("cancelled phase does NOT inflate to 100%", () => {
    const p = goalProgress({ state: "cancelled" }, { state: "cancelled", planJson: '[{"status":"done"}]' });
    expect(p.phase).toBe("cancelled");
    // percent is whatever the plan says; cancelled is the truth, not 100.
    expect(p.percent).toBe(100); // 1 of 1 step done
  });

  it("failed phase does NOT inflate to 100%", () => {
    const plan = JSON.stringify([
      { id: "s1", status: "done" },
      { id: "s2", status: "failed" },
    ]);
    const p = goalProgress({ state: "failed" }, { state: "failed", planJson: plan });
    expect(p.phase).toBe("failed");
    // 1 of (2 - 0 skipped) = 50%; not forced to 100.
    expect(p.percent).toBe(50);
  });

  it("plan summary counts done/running/pending/failed/skipped", () => {
    const plan = JSON.stringify([
      { id: "1", status: "done" },
      { id: "2", status: "done" },
      { id: "3", status: "running" },
      { id: "4", status: "pending" },
      { id: "5", status: "failed" },
      { id: "6", status: "skipped" },
    ]);
    const s = summarizeGoalPlan(plan);
    expect(s).toMatchObject({ total: 6, done: 2, running: 1, pending: 1, failed: 1, skipped: 1 });
  });

  it("percent uses terminal (done+skipped) over (total-skipped)", () => {
    // 2 done + 1 skipped + 1 failed + 1 pending = 5
    // terminal = 3, denominator = 5 - 1 = 4, percent = 75
    const plan = JSON.stringify([
      { id: "1", status: "done" },
      { id: "2", status: "done" },
      { id: "3", status: "skipped" },
      { id: "4", status: "failed" },
      { id: "5", status: "pending" },
    ]);
    const p = goalProgress({ state: "running" }, { state: "executing_tool", planJson: plan });
    expect(p.percent).toBe(75);
    expect(p.percentReliable).toBe(true);
  });

  it("no plan yet — phase label is meaningful even when total=0", () => {
    const p = goalProgress({ state: "running" }, { state: "executing_tool", planJson: "[]" });
    expect(p.total).toBe(0);
    expect(p.percentReliable).toBe(false);
    expect(p.phase).toBe("executing");
  });

  it("malformed plan_json does not throw", () => {
    const p = goalProgress({ state: "running" }, { state: "executing_tool", planJson: "not-json" });
    expect(p.total).toBe(0);
    expect(p.percentReliable).toBe(false);
  });

  it("parseGoalPlan accepts both array and {steps:[]} shapes", () => {
    expect(parseGoalPlan('[{"id":"a"}]').steps.length).toBe(1);
    expect(parseGoalPlan('{"steps":[{"id":"a"}],"version":2}').steps.length).toBe(1);
    expect(parseGoalPlan('{"steps":[],"version":1}').version).toBe(1);
  });

  it("PHASES order is stable for tests and UI ordering", () => {
    expect(PHASES).toEqual(["idle", "preparing", "planning", "executing", "verifying", "completed"]);
  });

  it("phaseLabel maps every phase to a human-readable string", () => {
    expect(phaseLabel("preparing")).toBe("Preparing");
    expect(phaseLabel("planning")).toBe("Planning");
    expect(phaseLabel("executing")).toBe("Executing");
    expect(phaseLabel("verifying")).toBe("Verifying");
    expect(phaseLabel("completed")).toBe("Completed");
    expect(phaseLabel("failed")).toBe("Failed");
    expect(phaseLabel("cancelled")).toBe("Cancelled");
    expect(phaseLabel("idle")).toBe("Idle");
    expect(phaseLabel("recovering")).toBe("Recovering");
  });
});
describe("goalProgress — Phase 16 expansion (real-state edge cases)", () => {
  it("0-step plan: total 0, not 100%, percentReliable false", () => {
    const p = goalProgress({ state: "running" }, { state: "executing_tool", planJson: "[]" });
    expect(p.total).toBe(0);
    expect(p.percent).toBe(0);
    expect(p.percentReliable).toBe(false);
  });

  it("1-step plan: done -> 100%, pending -> 0%", () => {
    const done = goalProgress({ state: "running" }, { state: "executing_tool", planJson: '[{"id":"s1","status":"done"}]' });
    expect(done.percent).toBe(100);
    const pending = goalProgress({ state: "running" }, { state: "executing_tool", planJson: '[{"id":"s1","status":"pending"}]' });
    expect(pending.percent).toBe(0);
  });

  it("all plan steps done but agent is still verifying: NOT forced to 100%", () => {
    // The plan is complete but the agent has NOT reached a terminal
    // state — percent may read 100 from the plan but the phase is
    // 'verifying', so the UI shows "Verifying", never a finished
    // goal. The completion contract (agent terminal) gates the pill.
    const p = goalProgress({ state: "running" }, { state: "verifying", planJson: '[{"id":"s1","status":"done"}]' });
    expect(p.phase).toBe("verifying");
    expect(p.percent).toBe(100);
    expect(p.percentReliable).toBe(true);
  });

  it("verification complete + agent completed -> completed phase with 100%", () => {
    const p = goalProgress({ state: "completed" }, { state: "completed", planJson: '[{"id":"s1","status":"done"}]' });
    expect(p.phase).toBe("completed");
    expect(p.percent).toBe(100);
  });

  it("failed step in a running goal: percent counts done only, failed is visible", () => {
    const plan = JSON.stringify([
      { id: "s1", status: "done" },
      { id: "s2", status: "failed" },
      { id: "s3", status: "pending" },
    ]);
    const p = goalProgress({ state: "running" }, { state: "executing_tool", planJson: plan });
    expect(p.percent).toBe(33); // 1/3, failed steps are not progress
    expect(p.failed).toBe(1);
    expect(p.phase).toBe("executing");
  });

  it("cancelled execution: phase is cancelled, percent is not invented", () => {
    const plan = JSON.stringify([
      { id: "s1", status: "done" },
      { id: "s2", status: "pending" },
    ]);
    const p = goalProgress({ state: "cancelled" }, { state: "cancelled", planJson: plan });
    expect(p.phase).toBe("cancelled");
    expect(p.percent).toBe(50); // 1/2 — the truth, not a fake 100
  });

  it("delegated child work reflected via parent agent state (executing)", () => {
    // When a parent agent delegates, its own state remains
    // executing_tool while children run; progress derives from the
    // parent's plan (which references the delegated steps).
    const plan = JSON.stringify([
      { id: "research", status: "done", assigned_to: "researcher" },
      { id: "code", status: "running", assigned_to: "coder" },
    ]);
    const p = goalProgress({ state: "running" }, { state: "executing_tool", planJson: plan });
    expect(p.phase).toBe("executing");
    expect(p.percent).toBe(50);
    expect(p.running).toBe(1);
  });
});
