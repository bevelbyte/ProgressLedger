import { describe, it, expect } from "vitest";
import {
  patternMarkSummary,
  formatPatternMarks,
  patternPercent,
  semesterProgress,
  semesterTimeline,
  yearFilters,
  filterSemestersByYear,
  validateSubjectForm,
} from "../src/features/cgpa/cgpa-view.js";

const pattern = (subjects) => ({ subjects });

describe("patternMarkSummary / formatPatternMarks / patternPercent", () => {
  it("sums only subjects that have marks", () => {
    const p = pattern([
      { maxMarks: 100, marksObtained: 80 },
      { maxMarks: 50, marksObtained: 25 },
      { maxMarks: null, marksObtained: null },
    ]);
    expect(patternMarkSummary(p)).toEqual({ obtained: 105, max: 150, hasGraded: true });
    expect(formatPatternMarks(p)).toBe("105 / 150");
    expect(patternPercent(p)).toBe("70.00");
  });

  it("returns -- when nothing graded", () => {
    const p = pattern([{ maxMarks: 100, marksObtained: null }]);
    expect(formatPatternMarks(p)).toBe("--");
  });

  it("handles empty/undefined pattern", () => {
    expect(formatPatternMarks(null)).toBe("--");
    expect(patternMarkSummary(undefined)).toEqual({ obtained: 0, max: 0, hasGraded: false });
  });
});

describe("semesterProgress", () => {
  it("is the graded fraction of the Semester Exam subjects", () => {
    const sem = { patterns: { "Semester Exam": pattern([
      { marksObtained: 50 }, { marksObtained: null }, { marksObtained: 60 }, { marksObtained: null },
    ]) } };
    expect(semesterProgress(sem)).toBe(50);
  });
  it("is 0 with no subjects", () => {
    expect(semesterProgress({ patterns: { "Semester Exam": pattern([]) } })).toBe(0);
  });
});

describe("semesterTimeline", () => {
  it("maps odd/even semesters to Jul-Dec / Jan-May windows", () => {
    expect(semesterTimeline(1)).toBe("Jul - Dec 2024");
    expect(semesterTimeline(2)).toBe("Jan - May 2025");
    expect(semesterTimeline(3)).toBe("Jul - Dec 2025");
  });
});

describe("yearFilters / filterSemestersByYear", () => {
  it("produces year labels for a semester count", () => {
    expect(yearFilters(8)).toEqual(["All Semesters", "1st Year", "2nd Year", "3rd Year", "4th Year"]);
  });
  it("filters semesters to the selected year", () => {
    const sems = [1, 2, 3, 4].map((n) => ({ number: n }));
    expect(filterSemestersByYear(sems, "2nd Year").map((s) => s.number)).toEqual([3, 4]);
    expect(filterSemestersByYear(sems, "All Semesters")).toHaveLength(4);
  });
});

describe("validateSubjectForm", () => {
  it("accepts valid marks + credits and normalizes to numbers", () => {
    const r = validateSubjectForm({ name: "Maths", obtainedRaw: "85", maxRaw: "100", creditsRaw: "4" });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ obtained: 85, max: 100, credits: 4 });
  });
  it("requires a name", () => {
    expect(validateSubjectForm({ name: "  " }).ok).toBe(false);
  });
  it("requires max when obtained is given", () => {
    expect(validateSubjectForm({ name: "X", obtainedRaw: "40", maxRaw: "" }).error).toMatch(/Maximum Marks/);
  });
  it("rejects obtained > max", () => {
    expect(validateSubjectForm({ name: "X", obtainedRaw: "120", maxRaw: "100" }).error).toMatch(/cannot exceed/);
  });
  it("rejects negative credits", () => {
    expect(validateSubjectForm({ name: "X", creditsRaw: "-1" }).error).toMatch(/Credits/);
  });
  it("allows a name-only subject (no marks/credits)", () => {
    const r = validateSubjectForm({ name: "Seminar" });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ obtained: null, max: null, credits: null });
  });
});
