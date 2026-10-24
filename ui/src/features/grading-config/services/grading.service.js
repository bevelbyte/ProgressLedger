/**
 * Grading configuration service — the renderer's path to a profile's grade
 * scale. A grade scale is academic/profile configuration (it lives in Settings),
 * not a CGPA Planner concern; CGPA merely consumes the persisted scale.
 *
 * All calls route through window.progressLedger.courses.* -> IPC -> Rust. The Rust
 * layer owns the authoritative validation (GradeScale::validate); the client
 * helper below mirrors those rules only for instant inline feedback, and the
 * real save is still validated in Rust and rejected there if invalid.
 */
export const gradingService = {
  getScale(profileId) {
    return window.progressLedger.courses.getGradeScale(profileId);
  },
  getDefaultScale() {
    return window.progressLedger.courses.getDefaultGradeScale();
  },
  /** Server-side validation (authoritative). Returns { valid, error }. */
  validate(bands) {
    return window.progressLedger.courses.validateGradeScale(bands);
  },
  save(profileId, bands) {
    return window.progressLedger.courses.setGradeScale(profileId, bands);
  },
};

/**
 * Client-side mirror of GradeScale::validate (core/src/cgpa.rs) for instant
 * inline feedback. MUST stay in sync with the Rust rules; the Rust layer remains
 * the source of truth and re-validates on save. Returns a reason string or null.
 */
export function validateBandsLocally(bands) {
  if (!Array.isArray(bands) || bands.length === 0) {
    return "A grade scale needs at least one band.";
  }
  const seenMin = [];
  let hasZeroFloor = false;
  for (const b of bands) {
    const min = Number(b.minPercent);
    const gp = Number(b.gradePoint);
    if (Number.isNaN(min) || min < 0 || min > 100) {
      return `Band minimum percent must be between 0 and 100 (got ${b.minPercent}).`;
    }
    if (Number.isNaN(gp) || gp < 0) {
      return `Grade point cannot be negative (got ${b.gradePoint}).`;
    }
    if (seenMin.some((m) => Math.abs(m - min) < 1e-9)) {
      return `Two bands share the same minimum percent (${min}); thresholds must be distinct.`;
    }
    seenMin.push(min);
    if (Math.abs(min) < 1e-9) hasZeroFloor = true;
  }
  if (!hasZeroFloor) {
    return "A band starting at 0% is required so every mark maps to a grade point.";
  }
  return null;
}
