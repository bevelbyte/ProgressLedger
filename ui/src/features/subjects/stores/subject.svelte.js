import { subjectService } from "../services/subject.service.js";
import { sessionsService } from "../../study-sessions/services/sessions.service.js";
import { reportError } from "../../../shared/utils/errors.js";

// Global subject state (Svelte 5 runes).
//
// Honesty rule: everything here is persisted or derived-from-persisted data.
// There is NO localStorage-backed authoritative state (an earlier
// cf_subject_priorities map lived here and was removed — user "priority" was
// hash-fabricated decoration, not domain data).
export const subjectStore = $state({
  tree: [],
  allSubjects: [],
  // Course marks/credits keyed for O(1) lookup: "semesterLabel::subjectNameLower".
  courseMarks: {},
  // subjectId -> latest session started_at (from the profile's recent
  // sessions). Subjects with no recent session are simply absent.
  lastStudiedAt: {},

  get continueLearningCount() {
    return this.allSubjects.filter(s => s.status === "in_progress").length;
  }
});

/**
 * Load academic tree & subjects list
 */
export async function loadSubjectTree(profileId) {
  if (profileId == null) {
    subjectStore.tree = [];
    subjectStore.allSubjects = [];
    return;
  }
  try {
    const tree = await subjectService.getTree(profileId);
    subjectStore.tree = tree;

    // Flatten subjects
    const subjects = [];
    for (const track of tree) {
      for (const sem of track.semesters) {
        for (const ms of sem.milestones) {
          for (const subj of ms.subjects) {
            subjects.push({
              ...subj,
              trackName: track.name,
              semesterName: sem.name,
              semesterId: sem.id,
              milestoneName: ms.title,
            });
          }
        }
      }
    }
    subjectStore.allSubjects = subjects;
  } catch (e) {
    reportError(e, "Failed to load subjects");
  }
}

/**
 * Load course marks/credits from SQLite (via the courses API) and index them
 * for the Subjects views. This replaces the old dependency on CGPA Planner's
 * private localStorage["progressledger_v2_degree_data_*"] blob — Subjects now reads
 * persisted domain data through its own service, not another feature's internals.
 */
export async function loadCourseMarks(profileId) {
  if (!profileId) {
    subjectStore.courseMarks = {};
    return;
  }
  try {
    const courses = await subjectService.listCourses(profileId);
    const map = {};
    for (const c of courses) {
      // Structural link first (courses.subject_id); legacy name key kept only
      // for rows migration 014 could not deterministically link.
      const entry = {
        marksObtained: c.marksObtained ?? null,
        maxMarks: c.maxMarks ?? null,
        credits: c.credits ?? null,
      };
      if (c.subjectId != null) map[`sid:${c.subjectId}`] = entry;
      map[`${c.semesterLabel}::${c.courseName.trim().toLowerCase()}`] = entry;
    }
    subjectStore.courseMarks = map;
  } catch (e) {
    console.error("Failed to load course marks:", e);
    subjectStore.courseMarks = {};
  }
}

/**
 * Latest study timestamp per subject, from the profile's recent sessions
 * (single bounded IPC call; the list arrives newest-first, so the first row
 * seen per subject is that subject's most recent session). Absent = the
 * subject has no session in recent history — the UI shows an em dash, never a
 * fabricated date.
 */
export async function loadRecentSessions(profileId) {
  if (!profileId) {
    subjectStore.lastStudiedAt = {};
    return;
  }
  try {
    const sessions = await sessionsService.list(profileId, 500);
    const map = {};
    for (const s of sessions) {
      if (!s?.subjectId || !s?.startedAt) continue;
      if (!(s.subjectId in map)) map[s.subjectId] = s.startedAt;
    }
    subjectStore.lastStudiedAt = map;
  } catch (e) {
    console.error("Failed to load recent sessions:", e);
    subjectStore.lastStudiedAt = {};
  }
}

/**
 * Update subject status
 */
export async function updateSubjectStatus(profileId, subjectId, status) {
  try {
    await subjectService.setSubjectStatus(profileId, subjectId, status);
    await loadSubjectTree(profileId);
  } catch (e) {
    reportError(e, "Failed to update status");
    throw e;
  }
}
