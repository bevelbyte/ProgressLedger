/**
 * Degree <-> SQLite mapper for the CGPA feature.
 *
 * This is the persistence boundary that replaces the old
 * localStorage["careerflow_degree_data_<profileId>"] blob. SQLite is now
 * authoritative, split across two real domain stores:
 *
 *   structure (degree/semester/subject)  -> academic tree tables
 *   marks + credits + grade              -> courses table
 *
 * IDENTITY INVARIANT (migration 014): subjects.id is the permanent identity of
 * a subject. Hydrated planner rows carry that real id; persist reconciles BY
 * ID via planSubjectReconciliation(), so a rename updates the same row and can
 * never delete-and-recreate it. Name equality survives here only as (a) the
 * one-time legacy fallback when linking still-unlinked course rows and (b) an
 * ambiguity detector that PRESERVES data instead of guessing.
 *
 * The CgpaPlanner component keeps its in-memory `degrees` shape as pure UI
 * state; this module rebuilds that shape from the database on load and writes
 * both stores on save. Fields with no domain home in SQLite are handled as:
 *   - roadmap: static boilerplate, regenerated (never persisted)
 *   - semester status: PERSISTED on the semesters row (user-declared; read back
 *     directly, never re-derived from marks)
 *   - Internal-I / Internal-II mark tabs: session-only scratch, NOT persisted
 *     as separate structure (they union into the same subject rows); only the
 *     graded "Semester Exam" mark + credits per course drive SGPA.
 */

import { planSubjectReconciliation } from "./subject-reconcile.js";

const EMPTY_PATTERNS = () => ({
  "Internal - I": { subjects: [] },
  "Internal - II": { subjects: [] },
  "Semester Exam": { subjects: [] },
});

const DEFAULT_ROADMAP = () => [
  { step: 1, title: "Foundation Phase", status: "Completed", description: "Strengthen fundamentals in Mathematics, Physics and Programming." },
  { step: 2, title: "Core Learning Phase", status: "In Progress", description: "Learn core subjects and build strong conceptual understanding." },
  { step: 3, title: "Skill Building Phase", status: "Upcoming", description: "Work on projects, develop technical skills and explore domains." },
  { step: 4, title: "Placement Preparation", status: "Upcoming", description: "Prepare for placements, aptitude, coding and interviews." },
];

/** "B.Tech (CSE)" -> { name: "B.Tech", specialization: "CSE" }; plain names pass through. */
export function splitTrackName(trackName) {
  const m = trackName.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (m) return { name: m[1].trim(), specialization: m[2].trim() };
  return { name: trackName, specialization: "" };
}

export function composeTrackName(name, specialization) {
  return specialization ? `${name} (${specialization})` : name;
}

function semesterNumber(name) {
  const m = name.match(/Semester (\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

const VALID_STATUSES = ["Upcoming", "In Progress", "Completed"];
function normalizeStatus(status) {
  return VALID_STATUSES.includes(status) ? status : "Upcoming";
}

/**
 * Build the component's `degrees[]` UI model from SQLite.
 * @param {object} api  window.careerflow
 * @param {number} profileId
 */
export async function buildDegreesFromDb(api, profileId) {
  const tree = await api.academic.tree(profileId);
  const courses = await api.courses.list(profileId, null);

  // Structural link first (courses.subject_id, migration 014). The legacy
  // (semester_label, lower course_name) key remains ONLY as a fallback for
  // rows the deterministic backfill could not link.
  const courseById = new Map();
  const courseByKey = new Map();
  for (const c of courses) {
    if (c.subjectId != null && !courseById.has(c.subjectId)) courseById.set(c.subjectId, c);
    courseByKey.set(`${c.semesterLabel}::${c.courseName.trim().toLowerCase()}`, c);
  }

  const degrees = [];
  for (const track of tree) {
    const { name, specialization } = splitTrackName(track.name);
    const semesters = [];
    for (const sem of track.semesters || []) {
      const num = semesterNumber(sem.name);
      // Flatten all subjects under this semester's milestones.
      const flatSubjects = [];
      for (const ms of sem.milestones || []) {
        for (const subj of ms.subjects || []) flatSubjects.push(subj);
      }
      const semSubjects = flatSubjects.map((subj) => {
        const course =
          courseById.get(subj.id) ??
          courseByKey.get(`${sem.name}::${subj.name.trim().toLowerCase()}`) ?? null;
        return {
          id: `db_${subj.id}`,
          subjectId: subj.id,
          courseId: course?.id ?? null,
          name: subj.name,
          code: subj.code ?? null,
          status: subj.status,
          credits: course?.credits ?? null,
          marksObtained: course?.marksObtained ?? null,
          maxMarks: course?.maxMarks ?? null,
        };
      });
      const patterns = EMPTY_PATTERNS();
      patterns["Semester Exam"].subjects = semSubjects;
      semesters.push({
        number: num ?? semesters.length + 1,
        semesterId: sem.id,
        // User-declared status is now persisted on the semester row; read it
        // directly (never re-derive from subject marks).
        status: normalizeStatus(sem.status),
        patterns,
      });
    }
    semesters.sort((a, b) => a.number - b.number);
    degrees.push({
      id: `track_${track.id}`,
      trackId: track.id,
      name,
      specialization,
      semestersCount: semesters.length,
      semesters,
      roadmap: DEFAULT_ROADMAP(),
    });
  }
  return degrees;
}

/**
 * Persist the component's `degrees[]` UI model to SQLite:
 *   structure -> academic tree (create/rename/delete tracks, semesters, subjects)
 *   marks/credits -> courses table (upsert/delete linked by courses.subject_id)
 * Idempotent: safe to call after every edit.
 */
export async function persistDegreesToDb(api, profileId, degrees) {
  const tree = await api.academic.tree(profileId);

  for (const deg of degrees) {
    const trackName = composeTrackName(deg.name, deg.specialization);
    let dbTrack = tree.find((t) => t.name === trackName);
    let trackId = dbTrack ? dbTrack.id : await api.academic.addTrack(profileId, trackName);
    const dbSemesters = dbTrack ? dbTrack.semesters : [];

    for (const sem of deg.semesters) {
      const semesterName = `Semester ${sem.number}`;
      let dbSem = dbSemesters.find((s) => s.name === semesterName);
      let semesterId = dbSem ? dbSem.id : await api.academic.addSemester(profileId, trackId, semesterName);

      // Persist the user-declared status onto the semester row when it differs
      // from what the DB holds (new semesters default to 'Upcoming' in SQL).
      const desiredStatus = normalizeStatus(sem.status);
      if (!dbSem || dbSem.status !== desiredStatus) {
        await api.academic.setSemesterStatus(profileId, semesterId, desiredStatus);
      }

      const dbMilestones = dbSem ? dbSem.milestones : [];
      let dbMs = dbMilestones.find((m) => m.title === "Subjects");
      let milestoneId = dbMs ? dbMs.id : await api.academic.addMilestone(profileId, semesterId, "Subjects");
      const dbSubjects = dbMs ? dbMs.subjects : [];

      // A subject is a subject regardless of which mark tab it was entered under.
      // Union subjects across all patterns by name; marks/credits come from the
      // entry that has them (graded "Semester Exam" preferred, else any). The
      // hydrated identity (subjectId/courseId) travels with whichever entry
      // carried it so a rename never forks identity across tabs.
      const merged = new Map(); // lowerName -> entry
      for (const pName of ["Internal - I", "Internal - II", "Semester Exam"]) {
        const pat = sem.patterns?.[pName];
        if (!pat || !Array.isArray(pat.subjects)) continue;
        const graded = pName === "Semester Exam";
        for (const sub of pat.subjects) {
          const cleanName = (sub.name || "").trim();
          if (!cleanName) continue;
          const key = cleanName.toLowerCase();
          const prev = merged.get(key) ?? {
            name: cleanName,
            code: null,
            credits: null,
            marksObtained: null,
            maxMarks: null,
            subjectId: sub.subjectId ?? null,
            courseId: sub.courseId ?? null,
          };
          if (prev.subjectId == null && sub.subjectId != null) {
            prev.subjectId = sub.subjectId;
            prev.courseId = sub.courseId ?? prev.courseId;
          }
          if (!prev.code && sub.code && sub.code.trim()) prev.code = sub.code.trim();
          // Prefer graded-pattern marks/credits; otherwise take first non-null seen.
          if (graded || prev.marksObtained === null) {
            if (sub.marksObtained !== null && sub.marksObtained !== undefined) prev.marksObtained = sub.marksObtained;
            if (sub.maxMarks !== null && sub.maxMarks !== undefined) prev.maxMarks = sub.maxMarks;
          }
          if (graded || prev.credits === null) {
            if (sub.credits !== null && sub.credits !== undefined) prev.credits = sub.credits;
          }
          merged.set(key, prev);
        }
      }
      const uiSubjects = Array.from(merged.values());

      // Reconcile subjects BY ID (subjects.id is the permanent identity):
      //   rename  -> UPDATE the same row (dependents keep their subject_id)
      //   new     -> ADD
      //   removed -> genuine DELETE (existing destructive semantics)
      //   ambiguous -> PRESERVE and report; deletion is never guessed.
      const plan = planSubjectReconciliation(dbSubjects, uiSubjects);
      for (const u of plan.updates) {
        await api.academic.updateSubject(profileId, u.id, u.name, u.code);
      }
      for (const sub of plan.adds) {
        sub.subjectId = await api.academic.addSubject(profileId, milestoneId, sub.name, sub.code);
      }
      if (plan.preservedIds.length > 0) {
        console.warn(
          "[cgpa] ambiguous subject mapping — preserved without changes:",
          plan.preservedIds
        );
      }
      for (const id of plan.deleteIds) {
        await api.academic.deleteSubject(profileId, id);
      }

      // Courses carry credits + marks and link structurally to their subject.
      // Primary match: courses.subject_id. Legacy fallback: the old
      // (semester_label, name) match against rows still lacking a link — the
      // update below links them, after which name matching no longer applies.
      const semesterCourses = await api.courses.list(profileId, semesterName);
      for (const sub of uiSubjects) {
        const sid = sub.subjectId;
        let course =
          semesterCourses.find((c) => c.subjectId === sid) ??
          semesterCourses.find(
            (c) => c.subjectId == null && c.courseName.trim().toLowerCase() === sub.name.trim().toLowerCase()
          );
        const credits = Number(sub.credits) > 0 ? Number(sub.credits) : 0;
        const marksObtained = sub.marksObtained ?? null;
        const maxMarks = sub.maxMarks ?? null;

        if (course) {
          await api.courses.update({
            profileId,
            courseId: course.id,
            courseName: sub.name,
            credits,
            grade: null,
            gradePoints: null,
            marksObtained,
            maxMarks,
            subjectId: sid,
          });
        } else {
          await api.courses.add({
            profileId,
            semesterLabel: semesterName,
            courseName: sub.name,
            credits,
            grade: null,
            gradePoints: null,
            marksObtained,
            maxMarks,
            isHypothetical: false,
            subjectId: sid,
          });
        }
      }

      // Course sweep mirrors the subject decision exactly: a structurally
      // linked course is kept while its subject is claimed or ambiguity-
      // preserved; a legacy NULL-linked course survives only while its name
      // is still present in the planner.
      const keptIds = new Set(uiSubjects.map((s) => s.subjectId).filter((v) => v != null));
      const preservedSet = new Set(plan.preservedIds);
      const uiNamesLower = new Set(uiSubjects.map((s) => s.name.trim().toLowerCase()));
      const existingCourses = await api.courses.list(profileId, semesterName);
      for (const c of existingCourses) {
        if (c.subjectId != null) {
          if (!keptIds.has(c.subjectId) && !preservedSet.has(c.subjectId)) {
            await api.courses.remove(profileId, c.id);
          }
        } else if (!uiNamesLower.has(c.courseName.trim().toLowerCase())) {
          await api.courses.remove(profileId, c.id);
        }
      }
    }

    // Drop DB semesters beyond the UI's semester count.
    if (dbTrack) {
      for (const dbSem of dbTrack.semesters) {
        const n = semesterNumber(dbSem.name);
        if (n && n > deg.semestersCount) await api.academic.deleteSemester(profileId, dbSem.id);
      }
    }
  }

  // Delete DB tracks with no matching UI degree.
  for (const dbTrack of tree) {
    const matches = degrees.some((d) => composeTrackName(d.name, d.specialization) === dbTrack.name);
    if (!matches) await api.academic.deleteTrack(profileId, dbTrack.id);
  }
}
