import { describe, it, expect } from "vitest";
import {
  formatStudyTime, formatSgpa, gradedText, completedText,
  deadlineSummary, formatDeadlineDate, subjectStatusLabel,
} from "../src/features/semester/semester-view.js";

describe("formatStudyTime", () => {
  it("formats hours/minutes", () => {
    expect(formatStudyTime(0)).toBe("0m");
    expect(formatStudyTime(35)).toBe("35m");
    expect(formatStudyTime(60)).toBe("1h");
    expect(formatStudyTime(875)).toBe("14h 35m");
  });
});

describe("formatSgpa", () => {
  it("returns null (empty) when nothing graded", () => {
    expect(formatSgpa({ gradedCourseCount: 0, sgpa: 0 })).toBeNull();
    expect(formatSgpa(null)).toBeNull();
  });
  it("formats to 2dp when graded", () => {
    expect(formatSgpa({ gradedCourseCount: 2, sgpa: 8.25 })).toBe("8.25");
  });
});

describe("gradedText / completedText", () => {
  it("reports graded and completed counts honestly", () => {
    const c = { totalSubjects: 8, gradedSubjects: 6, doneSubjects: 5, inProgressSubjects: 2, pendingSubjects: 1 };
    expect(gradedText(c)).toBe("6 of 8 subjects graded");
    expect(completedText(c)).toBe("5 of 8 completed");
  });
  it("says 'No subjects yet' on an empty semester", () => {
    const c = { totalSubjects: 0, gradedSubjects: 0, doneSubjects: 0 };
    expect(gradedText(c)).toBe("No subjects yet");
    expect(completedText(c)).toBe("No subjects yet");
  });
});

describe("deadlineSummary", () => {
  it("joins only non-zero buckets", () => {
    expect(deadlineSummary({ overdue: 1, dueSoon: 2, upcoming: 0 })).toBe("1 overdue · 2 due this week");
    expect(deadlineSummary({ overdue: 0, dueSoon: 0, upcoming: 3 })).toBe("3 upcoming");
  });
  it("returns null when there are no deadlines", () => {
    expect(deadlineSummary({ overdue: 0, dueSoon: 0, upcoming: 0 })).toBeNull();
    expect(deadlineSummary(null)).toBeNull();
  });
});

describe("formatDeadlineDate / subjectStatusLabel", () => {
  it("formats a date and falls back on bad input", () => {
    expect(formatDeadlineDate(null)).toBe("");
    expect(formatDeadlineDate("2026-01-05")).not.toBe("");
  });
  it("maps status keys", () => {
    expect(subjectStatusLabel("in_progress")).toBe("In Progress");
    expect(subjectStatusLabel("done")).toBe("Done");
    expect(subjectStatusLabel("???")).toBe("Pending");
  });
});
