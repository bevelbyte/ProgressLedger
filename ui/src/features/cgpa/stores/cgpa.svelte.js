/**
 * CGPA feature store (Svelte 5 runes). Single owner of the CGPA feature's
 * reactive state and the ONLY place that talks to persistence.
 *
 * State categories (kept deliberately separate):
 *   - domain/server state: `degrees` (rebuilt from SQLite) and `summary`
 *     (SGPA/CGPA computed by Rust). Never persisted to localStorage.
 *   - feature state: `activeDegreeId`, `saving`.
 * Local UI state (open modals, form fields, selected semester, menus) does NOT
 * live here — it stays in the components that own it.
 *
 * Persistence goes through degree-mapper -> courses API -> IPC -> Rust -> SQLite.
 * There is NO localStorage persistence except the one-time legacy import.
 */
import { buildDegreesFromDb, persistDegreesToDb } from "../degree-mapper.js";
import { cgpaService } from "../services/cgpa.service.js";
import { EVALUATION_PATTERNS } from "../cgpa-view.js";

export const cgpaStore = $state({
  degrees: [],
  activeDegreeId: "",
  summary: { cgpa: 0, semesters: [] },
  saving: false,

  get activeDegree() {
    return this.degrees.find((d) => d.id === this.activeDegreeId) ?? null;
  },
});

function emptyPatterns() {
  return {
    "Internal - I": { subjects: [] },
    "Internal - II": { subjects: [] },
    "Semester Exam": { subjects: [] },
  };
}

const DEFAULT_ROADMAP = () => [
  { step: 1, title: "Foundation Phase", status: "Completed", description: "Strengthen fundamentals in Mathematics, Physics and Programming." },
  { step: 2, title: "Core Learning Phase", status: "In Progress", description: "Learn core subjects and build strong conceptual understanding." },
  { step: 3, title: "Skill Building Phase", status: "Upcoming", description: "Work on projects, develop technical skills and explore domains." },
  { step: 4, title: "Placement Preparation", status: "Upcoming", description: "Prepare for placements, aptitude, coding and interviews." },
];

// ---- Load / persist -------------------------------------------------------

/** Rebuild degrees from SQLite (after a one-time legacy import) and refresh CGPA. */
export async function loadCgpa(profileId) {
  if (!profileId) {
    cgpaStore.degrees = [];
    cgpaStore.activeDegreeId = "";
    cgpaStore.summary = { cgpa: 0, semesters: [] };
    return;
  }
  await migrateLegacyIfNeeded(profileId);
  cgpaStore.degrees = await buildDegreesFromDb(window.careerflow, profileId);
  cgpaStore.activeDegreeId = cgpaStore.degrees.length > 0 ? cgpaStore.degrees[0].id : "";
  await refreshSummary(profileId);
}

export async function refreshSummary(profileId) {
  if (!profileId) return;
  try {
    cgpaStore.summary = await cgpaService.cgpa(profileId);
  } catch (e) {
    console.error("CGPA calculation failed:", e);
  }
}

/**
 * Persist current degrees to SQLite and recompute CGPA. Broadcasts
 * "cf:data-changed" so Subjects (and others) refresh from the same DB.
 * Returns true on success.
 */
export async function persist(profileId) {
  if (!profileId) return false;
  cgpaStore.saving = true;
  try {
    await persistDegreesToDb(window.careerflow, profileId, cgpaStore.degrees);
    await refreshSummary(profileId);
    window.dispatchEvent(new Event("cf:data-changed"));
    return true;
  } catch (e) {
    console.error("Failed to persist CGPA data:", e);
    return false;
  } finally {
    cgpaStore.saving = false;
  }
}

/**
 * One-time, non-destructive import of the legacy localStorage degree blob into
 * SQLite. Guarded per-profile; original blob renamed to `.migrated`, never
 * deleted. This is the ONLY sanctioned localStorage read in the feature.
 */
export async function migrateLegacyIfNeeded(profileId) {
  const flagKey = `careerflow_cgpa_migrated_${profileId}`;
  if (localStorage.getItem(flagKey) === "1") return;

  const legacyKey = `careerflow_degree_data_${profileId}`;
  const raw = localStorage.getItem(legacyKey);
  if (!raw) {
    localStorage.setItem(flagKey, "1");
    return;
  }
  try {
    let parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      parsed = parsed.filter((d) => d.id !== "deg_1" && d.id !== "deg_2");
      const normalized = parsed
        .filter((d) => d && d.name && Array.isArray(d.semesters))
        .map((d) => ({
          ...d,
          specialization: d.specialization || "",
          semestersCount: d.semestersCount || d.semesters.length,
        }));
      if (normalized.length > 0) {
        await persistDegreesToDb(window.careerflow, profileId, normalized);
      }
    }
    localStorage.setItem(`${legacyKey}.migrated`, raw);
    localStorage.removeItem(legacyKey);
    localStorage.setItem(flagKey, "1");
  } catch (e) {
    console.error("Legacy CGPA migration failed (leaving localStorage intact):", e);
  }
}

// ---- Degree mutations -----------------------------------------------------

/** Create or edit a degree. `input` = {name, specialization, semestersCount}. */
export function saveDegree(input, editingId = null) {
  const semCount = input.semestersCount || 8;
  if (editingId) {
    cgpaStore.degrees = cgpaStore.degrees.map((d) => {
      if (d.id !== editingId) return d;
      let sems = [...d.semesters];
      if (semCount > sems.length) {
        const extra = Array.from({ length: semCount - sems.length }, (_, i) => ({
          number: sems.length + i + 1,
          status: "Upcoming",
          patterns: emptyPatterns(),
        }));
        sems = [...sems, ...extra];
      } else if (semCount < sems.length) {
        sems = sems.slice(0, semCount);
      }
      return { ...d, name: input.name, specialization: input.specialization, semestersCount: semCount, semesters: sems };
    });
    return editingId;
  }
  const newId = "deg_" + Date.now();
  cgpaStore.degrees = [
    ...cgpaStore.degrees,
    {
      id: newId,
      name: input.name,
      specialization: input.specialization,
      semestersCount: semCount,
      semesters: Array.from({ length: semCount }, (_, i) => ({
        number: i + 1,
        status: i === 0 ? "In Progress" : "Upcoming",
        patterns: emptyPatterns(),
      })),
      roadmap: DEFAULT_ROADMAP(),
    },
  ];
  cgpaStore.activeDegreeId = newId;
  return newId;
}

export function deleteDegree(id) {
  cgpaStore.degrees = cgpaStore.degrees.filter((d) => d.id !== id);
  if (cgpaStore.activeDegreeId === id) {
    cgpaStore.activeDegreeId = cgpaStore.degrees[0]?.id || "";
  }
}

// ---- Semester mutations ---------------------------------------------------

function mutateActiveDegree(fn) {
  cgpaStore.degrees = cgpaStore.degrees.map((d) => (d.id === cgpaStore.activeDegreeId ? fn(d) : d));
}

export function addSemester() {
  const deg = cgpaStore.activeDegree;
  if (!deg) return null;
  const nextNum = deg.semesters.reduce((m, s) => Math.max(m, s.number), 0) + 1;
  mutateActiveDegree((d) => ({
    ...d,
    semestersCount: d.semesters.length + 1,
    semesters: [...d.semesters, { number: nextNum, status: "Upcoming", patterns: emptyPatterns() }],
  }));
  return nextNum;
}

/** Returns { ok, error } — refuses to delete a graded/in-progress semester. */
export function deleteSemester(semNumber) {
  const deg = cgpaStore.activeDegree;
  if (!deg || deg.semesters.length <= 1) return { ok: false, error: "At least one semester is required." };
  const target = deg.semesters.find((s) => s.number === semNumber);
  if (target && target.status !== "Upcoming") {
    return { ok: false, error: "Cannot delete a semester that is In Progress or Completed." };
  }
  mutateActiveDegree((d) => {
    const sems = d.semesters.filter((s) => s.number !== semNumber);
    return { ...d, semestersCount: sems.length, semesters: sems };
  });
  return { ok: true, error: null };
}

export function setSemesterStatus(semNumber, status) {
  mutateActiveDegree((d) => ({
    ...d,
    semesters: d.semesters.map((s) => (s.number === semNumber ? { ...s, status } : s)),
  }));
}

// ---- Subject mutations ----------------------------------------------------

/**
 * Add or edit a subject in the active semester/pattern.
 * `value` = { name, code, obtained, max, credits } (already validated).
 */
export function saveSubject({ semesterNum, patternName, editingSubject, value }) {
  const isEditing = !!editingSubject;
  mutateActiveDegree((d) => ({
    ...d,
    semesters: d.semesters.map((s) => {
      if (s.number !== semesterNum) return s;
      const updatedPatterns = {};
      for (const pName of EVALUATION_PATTERNS) {
        const pattern = s.patterns[pName];
        if (!pattern) continue;
        let subjects = pattern.subjects || [];
        if (isEditing) {
          subjects = subjects.map((sub) => {
            const matchesId = sub.id === editingSubject.id;
            const matchesName = editingSubject.name && sub.name.trim().toLowerCase() === editingSubject.name.trim().toLowerCase();
            if (matchesId || (pName !== patternName && matchesName)) {
              return {
                ...sub,
                name: value.name,
                code: value.code,
                ...(matchesId ? { marksObtained: value.obtained, maxMarks: value.max, credits: value.credits } : {}),
              };
            }
            return sub;
          });
        } else {
          subjects = subjects.map((sub) =>
            sub.name.trim().toLowerCase() === value.name.trim().toLowerCase() ? { ...sub, code: value.code } : sub
          );
          if (pName === patternName) {
            subjects = [
              ...subjects,
              {
                id: "sub_" + Date.now(),
                name: value.name,
                code: value.code,
                marksObtained: value.obtained,
                maxMarks: value.max,
                credits: value.credits,
              },
            ];
          }
        }
        updatedPatterns[pName] = { ...pattern, subjects };
      }
      return { ...s, patterns: { ...s.patterns, ...updatedPatterns } };
    }),
  }));
}

export function deleteSubject(semesterNum, patternName, subId) {
  mutateActiveDegree((d) => ({
    ...d,
    semesters: d.semesters.map((s) => {
      if (s.number !== semesterNum) return s;
      const pattern = s.patterns[patternName];
      return {
        ...s,
        patterns: { ...s.patterns, [patternName]: { ...pattern, subjects: pattern.subjects.filter((x) => x.id !== subId) } },
      };
    }),
  }));
}

/** Copy subjects from another pattern into the active one (marks cleared). */
export function copySubjectsFrom(semesterNum, targetPattern, sourcePatternName) {
  const deg = cgpaStore.activeDegree;
  const sem = deg?.semesters.find((s) => s.number === semesterNum);
  const source = sem?.patterns[sourcePatternName];
  if (!source || source.subjects.length === 0) return 0;
  const copied = source.subjects.map((s) => ({
    id: "sub_" + Date.now() + "_" + Math.random().toString(36).slice(2, 11),
    name: s.name,
    code: s.code || null,
    marksObtained: null,
    maxMarks: s.maxMarks,
    credits: s.credits ?? null,
  }));
  mutateActiveDegree((d) => ({
    ...d,
    semesters: d.semesters.map((s) =>
      s.number === semesterNum ? { ...s, patterns: { ...s.patterns, [targetPattern]: { subjects: copied } } } : s
    ),
  }));
  return copied.length;
}
