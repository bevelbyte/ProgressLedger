import { describe, it, expect } from "vitest";
import { validateBandsLocally } from "../src/features/grading-config/services/grading.service.js";

const ok = [
  { minPercent: 90, gradePoint: 10, label: "O" },
  { minPercent: 40, gradePoint: 5, label: "C" },
  { minPercent: 0, gradePoint: 0, label: "F" },
];

describe("validateBandsLocally (mirror of Rust GradeScale::validate)", () => {
  it("accepts a well-formed scale", () => {
    expect(validateBandsLocally(ok)).toBeNull();
  });

  it("rejects an empty scale", () => {
    expect(validateBandsLocally([])).toMatch(/at least one band/i);
  });

  it("rejects duplicate thresholds", () => {
    const bands = [
      { minPercent: 50, gradePoint: 6, label: "B" },
      { minPercent: 50, gradePoint: 5, label: "C" },
      { minPercent: 0, gradePoint: 0, label: "F" },
    ];
    expect(validateBandsLocally(bands)).toMatch(/same minimum percent/i);
  });

  it("rejects out-of-range percent", () => {
    const bands = [
      { minPercent: 120, gradePoint: 10, label: "O" },
      { minPercent: 0, gradePoint: 0, label: "F" },
    ];
    expect(validateBandsLocally(bands)).toMatch(/between 0 and 100/i);
  });

  it("rejects a negative grade point", () => {
    const bands = [
      { minPercent: 50, gradePoint: -1, label: "X" },
      { minPercent: 0, gradePoint: 0, label: "F" },
    ];
    expect(validateBandsLocally(bands)).toMatch(/cannot be negative/i);
  });

  it("requires a band starting at 0%", () => {
    const bands = [{ minPercent: 40, gradePoint: 5, label: "C" }];
    expect(validateBandsLocally(bands)).toMatch(/starting at 0%/i);
  });
});
