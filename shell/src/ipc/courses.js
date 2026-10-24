import { safeHandle } from "../security/safe-handle.js";
import { ipcMain } from "electron";

export function register({ core }) {
  safeHandle("courses:list", (_e, { profileId, semesterLabel }) =>
    core.getCourses(profileId, semesterLabel ?? null)
  );
  safeHandle(
    "courses:add",
    (_e, { profileId, semesterLabel, courseName, credits, grade, gradePoints, marksObtained, maxMarks, isHypothetical, subjectId }) =>
      core.addCourse(
        profileId,
        semesterLabel,
        courseName,
        credits,
        grade ?? null,
        gradePoints ?? null,
        marksObtained ?? null,
        maxMarks ?? null,
        Boolean(isHypothetical),
        subjectId ?? null
      )
  );
  safeHandle("courses:update", (_e, { profileId, courseId, courseName, credits, grade, gradePoints, marksObtained, maxMarks, subjectId }) =>
    core.updateCourse(profileId, courseId, courseName, credits, grade ?? null, gradePoints ?? null, marksObtained ?? null, maxMarks ?? null, subjectId ?? null)
  );
  safeHandle("courses:delete", (_e, { profileId, courseId }) => core.deleteCourse(profileId, courseId));
  safeHandle("courses:sgpa", (_e, { profileId, semesterLabel }) =>
    core.calculateSgpa(profileId, semesterLabel)
  );
  safeHandle("courses:cgpa", (_e, profileId) => core.calculateCgpa(profileId));

  // Per-profile grade scale (percentage -> grade-point bands).
  safeHandle("courses:get-grade-scale", (_e, profileId) => core.getGradeScale(profileId));
  safeHandle("courses:get-default-grade-scale", () => core.getDefaultGradeScale());
  safeHandle("courses:validate-grade-scale", (_e, bands) => core.validateGradeScale(bands));
  safeHandle("courses:set-grade-scale", (_e, { profileId, bands }) =>
    core.setGradeScale(profileId, bands)
  );
}
