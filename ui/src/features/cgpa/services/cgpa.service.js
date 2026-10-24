/**
 * CGPA feature service — the ONLY renderer path to course/grade-scale data.
 * Thin wrapper over the typed preload bridge (window.progressLedger.courses.*),
 * which routes through IPC to the Rust courses module and SQLite. No
 * calculation logic lives here or in the UI: SGPA/CGPA come from Rust.
 */
export const cgpaService = {
  listCourses(profileId, semesterLabel = null) {
    return window.progressLedger.courses.list(profileId, semesterLabel);
  },

  /**
   * @param {{profileId:number, semesterLabel:string, courseName:string,
   *   credits:number, grade?:string|null, gradePoints?:number|null,
   *   marksObtained?:number|null, maxMarks?:number|null, isHypothetical?:boolean}} input
   */
  addCourse(input) {
    return window.progressLedger.courses.add(input);
  },

  /**
   * @param {{profileId:number, courseId:number, courseName:string, credits:number,
   *   grade?:string|null, gradePoints?:number|null,
   *   marksObtained?:number|null, maxMarks?:number|null, subjectId?:number|null}} input
   */
  updateCourse(input) {
    return window.progressLedger.courses.update(input);
  },

  removeCourse(profileId, courseId) {
    return window.progressLedger.courses.remove(profileId, courseId);
  },

  sgpa(profileId, semesterLabel) {
    return window.progressLedger.courses.sgpa(profileId, semesterLabel);
  },

  cgpa(profileId) {
    return window.progressLedger.courses.cgpa(profileId);
  },

  getGradeScale(profileId) {
    return window.progressLedger.courses.getGradeScale(profileId);
  },

  setGradeScale(profileId, bands) {
    return window.progressLedger.courses.setGradeScale(profileId, bands);
  },
};
