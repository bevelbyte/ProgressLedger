import { describe, it, expect } from "vitest";
import {
  goalStatusLabel, primaryGoal, isComplete, milestoneProgress,
  progressText, nextMilestone, formatTargetDate, moveItem, milestoneDateState,
  linkedSubjectState,
} from "../src/features/career/career-view.js";

describe("goalStatusLabel", () => {
  it("maps statuses and falls back to Active", () => {
    expect(goalStatusLabel("active")).toBe("Active");
    expect(goalStatusLabel("achieved")).toBe("Achieved");
    expect(goalStatusLabel("paused")).toBe("Paused");
    expect(goalStatusLabel("???")).toBe("Active");
  });
});

describe("primaryGoal", () => {
  it("prefers the flagged primary, else the first, else null", () => {
    expect(primaryGoal(null)).toBeNull();
    expect(primaryGoal([])).toBeNull();
    expect(primaryGoal([{ id: 1, isPrimary: false }, { id: 2, isPrimary: true }]).id).toBe(2);
    expect(primaryGoal([{ id: 3, isPrimary: false }]).id).toBe(3);
  });
});

describe("isComplete / milestoneProgress / progressText", () => {
  const ms = [
    { id: 1, completedAt: "2026-01-01 09:00:00" },
    { id: 2, completedAt: null },
    { id: 3, completedAt: null },
  ];
  it("detects completion by timestamp", () => {
    expect(isComplete(ms[0])).toBe(true);
    expect(isComplete(ms[1])).toBe(false);
  });
  it("counts honest progress", () => {
    expect(milestoneProgress(ms)).toEqual({ done: 1, total: 3 });
    expect(progressText(ms)).toBe("1 of 3 milestones complete");
  });
  it("says 'No milestones yet' when empty", () => {
    expect(progressText([])).toBe("No milestones yet");
    expect(milestoneProgress([])).toEqual({ done: 0, total: 0 });
  });
});

describe("nextMilestone", () => {
  it("returns the first incomplete milestone in order", () => {
    const ms = [
      { id: 1, title: "A", completedAt: "x" },
      { id: 2, title: "B", completedAt: null },
      { id: 3, title: "C", completedAt: null },
    ];
    expect(nextMilestone(ms).id).toBe(2);
  });
  it("returns null when all complete or none", () => {
    expect(nextMilestone([{ id: 1, completedAt: "x" }])).toBeNull();
    expect(nextMilestone([])).toBeNull();
  });
});

describe("formatTargetDate / moveItem", () => {
  it("formats a date and handles empty", () => {
    expect(formatTargetDate(null)).toBe("");
    expect(formatTargetDate("2026-01-05")).not.toBe("");
  });
  it("moves an item and is bounds-safe", () => {
    expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveItem([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
    expect(moveItem([1, 2, 3], 0, 9)).toEqual([1, 2, 3]); // out of range → unchanged
  });
});

describe("milestoneDateState", () => {
  const today = "2026-01-15";
  const m = (targetDate, completedAt = null) => ({ targetDate, completedAt });
  it("classifies by local date", () => {
    expect(milestoneDateState(m("2026-01-14"), today)).toBe("overdue");
    expect(milestoneDateState(m("2026-01-15"), today)).toBe("today");
    expect(milestoneDateState(m("2026-01-20"), today)).toBe("soon");
    expect(milestoneDateState(m("2026-01-22"), today)).toBe("soon"); // within 7
    expect(milestoneDateState(m("2026-01-23"), today)).toBe("upcoming"); // 8 days
  });
  it("returns 'none' with no date", () => {
    expect(milestoneDateState(m(null), today)).toBe("none");
  });
  it("completion overrides date (never overdue)", () => {
    expect(milestoneDateState(m("2020-01-01", "2026-01-10 09:00:00"), today)).toBe("none");
  });
});

describe("linkedSubjectState", () => {
  it("reports 'none' when no link is set (null or undefined)", () => {
    expect(linkedSubjectState({})).toEqual({ state: "none", id: null, name: "" });
    expect(linkedSubjectState({ linkedSubjectId: null })).toEqual({ state: "none", id: null, name: "" });
    expect(linkedSubjectState(null)).toEqual({ state: "none", id: null, name: "" });
  });
  it("reports 'linked' with the backend-provided name", () => {
    expect(linkedSubjectState({ linkedSubjectId: 7, linkedSubjectName: "Algorithms" }))
      .toEqual({ state: "linked", id: 7, name: "Algorithms" });
  });
  it("reports 'missing' when the id is set but the subject no longer resolves", () => {
    expect(linkedSubjectState({ linkedSubjectId: 7, linkedSubjectName: null }))
      .toEqual({ state: "missing", id: 7, name: "" });
  });
});
