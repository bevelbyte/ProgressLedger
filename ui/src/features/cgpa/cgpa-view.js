/**
 * Pure, framework-free display/validation helpers for the CGPA feature.
 *
 * NOTHING here computes SGPA/CGPA — those come from the Rust domain via the
 * courses API. These functions only summarize raw marks for display and
 * validate the subject form. Keeping them pure makes them unit-testable and
 * keeps the Svelte components presentational.
 */

const MARK_PATTERNS = ["Internal - I", "Internal - II", "Semester Exam"];
export const EVALUATION_PATTERNS = MARK_PATTERNS;

/** Sum obtained/max marks across a pattern's subjects. */
export function patternMarkSummary(pattern) {
  if (!pattern || !pattern.subjects || pattern.subjects.length === 0) {
    return { obtained: 0, max: 0, hasGraded: false };
  }
  let obtained = 0;
  let max = 0;
  let hasGraded = false;
  for (const sub of pattern.subjects) {
    if (sub.maxMarks !== null && sub.maxMarks !== undefined) {
      max += Number(sub.maxMarks);
      if (sub.marksObtained !== null && sub.marksObtained !== undefined) {
        obtained += Number(sub.marksObtained);
        hasGraded = true;
      }
    }
  }
  return { obtained, max, hasGraded };
}

/** "obtained / max" or "--" when there is nothing graded. */
export function formatPatternMarks(pattern) {
  const { obtained, max, hasGraded } = patternMarkSummary(pattern);
  if (max === 0 || !hasGraded) return "--";
  return `${obtained} / ${max}`;
}

/** Percentage string for a pattern (display only; not used in CGPA math). */
export function patternPercent(pattern) {
  const { obtained, max } = patternMarkSummary(pattern);
  return max > 0 ? ((obtained / max) * 100).toFixed(2) : "0.00";
}

/** Fraction (0-100) of a semester's graded subjects, from its Semester Exam pattern. */
export function semesterProgress(semester) {
  const subjects = semester?.patterns?.["Semester Exam"]?.subjects || [];
  if (subjects.length === 0) return 0;
  const graded = subjects.filter((s) => s.marksObtained !== null && s.marksObtained !== undefined).length;
  return Math.round((graded / subjects.length) * 100);
}

/** Human semester timeline label, e.g. "Jul - Dec 2024". Pure/deterministic. */
export function semesterTimeline(semNum, startYear = 2024) {
  const year = startYear + Math.floor((semNum - 1) / 2);
  return semNum % 2 !== 0 ? `Jul - Dec ${year}` : `Jan - May ${year + 1}`;
}

/** Year-filter labels ("All Semesters", "1st Year", ...) for a semester count. */
export function yearFilters(semesterCount) {
  const years = ["All Semesters"];
  const maxYear = Math.ceil(semesterCount / 2);
  for (let y = 1; y <= maxYear; y++) {
    const suffix = y === 1 ? "st" : y === 2 ? "nd" : y === 3 ? "rd" : "th";
    years.push(`${y}${suffix} Year`);
  }
  return years;
}

/** Semesters within the selected year filter. */
export function filterSemestersByYear(semesters, yearFilter) {
  if (!semesters) return [];
  if (yearFilter === "All Semesters") return semesters;
  const m = yearFilter.match(/(\d+)/);
  if (!m) return semesters;
  const yearNum = parseInt(m[1], 10);
  const start = (yearNum - 1) * 2 + 1;
  const end = yearNum * 2;
  return semesters.filter((s) => s.number >= start && s.number <= end);
}

/**
 * Validate the subject form. Returns { ok, error, value }.
 * value = { obtained, max, credits } normalized to numbers|null.
 */
export function validateSubjectForm({ name, obtainedRaw, maxRaw, creditsRaw }) {
  if (!name || !name.trim()) {
    return { ok: false, error: "Subject name is required." };
  }
  const obtained = obtainedRaw !== null && obtainedRaw !== "" && obtainedRaw !== undefined ? Number(obtainedRaw) : null;
  const max = maxRaw !== null && maxRaw !== "" && maxRaw !== undefined ? Number(maxRaw) : null;
  const credits = creditsRaw !== null && creditsRaw !== "" && creditsRaw !== undefined ? Number(creditsRaw) : null;

  if (obtained !== null && max === null) {
    return { ok: false, error: "Please specify Maximum Marks if Obtained Marks are entered." };
  }
  if (obtained !== null && obtained < 0) {
    return { ok: false, error: "Obtained marks cannot be negative." };
  }
  if (max !== null && max <= 0) {
    return { ok: false, error: "Maximum marks must be greater than zero." };
  }
  if (obtained !== null && max !== null && obtained > max) {
    return { ok: false, error: "Obtained marks cannot exceed Maximum marks." };
  }
  if (credits !== null && credits < 0) {
    return { ok: false, error: "Credits cannot be negative." };
  }
  return { ok: true, error: null, value: { obtained, max, credits } };
}
