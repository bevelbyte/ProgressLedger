import { describe, it, expect } from "vitest";
import {
  formatStudyTime,
  formatGrade,
  formatCredits,
  statusLabel,
  cleanTrackName,
  formatLastStudied,
} from "../src/features/subjects/subject-view.js";

describe("formatStudyTime", () => {
  it("formats hours/minutes", () => {
    expect(formatStudyTime(0)).toBe("0m");
    expect(formatStudyTime(45)).toBe("45m");
    expect(formatStudyTime(60)).toBe("1h");
    expect(formatStudyTime(135)).toBe("2h 15m");
  });
});

describe("formatGrade", () => {
  it("returns 'Not graded' when no grade point", () => {
    expect(formatGrade(null)).toBe("Not graded");
    expect(formatGrade({ percentage: null, gradePoint: null })).toBe("Not graded");
  });
  it("formats marks, percentage, grade point and label", () => {
    const ov = { marksObtained: 85, maxMarks: 100, percentage: 85, gradePoint: 9, gradeLabel: "A+" };
    expect(formatGrade(ov)).toBe("85 / 100 · 85.0% · 9.0 (A+)");
  });
  it("omits marks when absent", () => {
    expect(formatGrade({ marksObtained: null, maxMarks: null, percentage: 70, gradePoint: 8, gradeLabel: "A" }))
      .toBe("70.0% · 8.0 (A)");
  });
});

describe("formatCredits / statusLabel / cleanTrackName", () => {
  it("formats credits with em dash fallback", () => {
    expect(formatCredits(null)).toBe("—");
    expect(formatCredits(4)).toBe("4");
  });
  it("maps status keys to labels", () => {
    expect(statusLabel("pending")).toBe("Pending");
    expect(statusLabel("in_progress")).toBe("In Progress");
    expect(statusLabel("done")).toBe("Done");
    expect(statusLabel("weird")).toBe("Pending");
  });
  it("strips specialization from a track name", () => {
    expect(cleanTrackName("B.Tech (CSE)")).toBe("B.Tech");
    expect(cleanTrackName("B.Sc Physics")).toBe("B.Sc Physics");
  });
});

describe("formatLastStudied", () => {
  it("returns an em dash when there is no session (never fabricates)", () => {
    expect(formatLastStudied(null)).toBe("—");
    expect(formatLastStudied(undefined)).toBe("—");
    expect(formatLastStudied("")).toBe("—");
  });
  it("returns an em dash for unparseable input", () => {
    expect(formatLastStudied("not-a-date")).toBe("—");
  });
  it("formats SQLite and ISO timestamps to a short local date", () => {
    expect(formatLastStudied("2026-01-15 10:30:00")).toMatch(/Jan/);
    expect(formatLastStudied("2026-01-15T10:30:00")).toMatch(/Jan/);
  });
});
