import { describe, it, expect } from "vitest";
import {
  formatDuration,
  formatSessionStart,
  flattenSubjects,
  elapsedMinutes,
} from "../src/features/study-sessions/sessions-view.js";

describe("formatDuration", () => {
  it("formats hours and minutes", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(45)).toBe("45m");
    expect(formatDuration(60)).toBe("1h");
    expect(formatDuration(105)).toBe("1h 45m");
    expect(formatDuration(-5)).toBe("0m");
  });
});

describe("elapsedMinutes", () => {
  it("floors to whole minutes and never goes negative", () => {
    const start = 1_000_000;
    expect(elapsedMinutes(start, start + 90_000)).toBe(1); // 90s -> 1m
    expect(elapsedMinutes(start, start + 59_000)).toBe(0);
    expect(elapsedMinutes(start, start - 10_000)).toBe(0);
  });
});

describe("flattenSubjects", () => {
  it("flattens the academic tree into id/label picker options", () => {
    const tree = [
      {
        name: "B.Tech",
        semesters: [
          {
            name: "Semester 1",
            milestones: [{ subjects: [{ id: 7, name: "Maths" }, { id: 8, name: "Physics" }] }],
          },
        ],
      },
    ];
    const out = flattenSubjects(tree);
    expect(out).toEqual([
      { id: 7, label: "Maths — B.Tech / Semester 1" },
      { id: 8, label: "Physics — B.Tech / Semester 1" },
    ]);
  });

  it("handles an empty/undefined tree", () => {
    expect(flattenSubjects(undefined)).toEqual([]);
    expect(flattenSubjects([])).toEqual([]);
  });
});

describe("formatSessionStart", () => {
  it("returns a non-empty label for a SQLite datetime and empty for null", () => {
    expect(formatSessionStart(null)).toBe("");
    expect(formatSessionStart("2024-01-01 10:00:00")).not.toBe("");
  });
});
