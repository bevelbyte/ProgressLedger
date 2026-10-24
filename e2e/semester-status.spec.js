import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * Semester status is the student's DECLARED academic state, persisted on the
 * semesters row — distinct from derived progress and computed SGPA. This test
 * proves, through the real IPC surface, that:
 *   - a new semester defaults to "Upcoming",
 *   - a declared status persists across an app restart,
 *   - the status is independent of course marks (adding/removing a graded
 *     course does not change it),
 *   - SGPA still computes independently from the same courses.
 */
test("semester status is declared, persisted, and independent of marks/SGPA", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-semstatus-"));
  const launch = () =>
    electron.launch({
      args: [projectRoot, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, CAREERFLOW_E2E: "1" },
    });

  // ---- Run 1: create a track+semester, declare Completed, then add a course ----
  let app = await launch();
  let win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();

  const first = await win.evaluate(async () => {
    const p = await window.careerflow.profiles.add("Sem Status", `semstatus-${Date.now()}`);
    const pid = p.id;
    const trackId = await window.careerflow.academic.addTrack(pid, "B.Tech (CSE)");
    const semId = await window.careerflow.academic.addSemester(pid, trackId, "Semester 1");

    // Default status straight after creation.
    let tree = await window.careerflow.academic.tree(pid);
    const defaultStatus = tree[0].semesters[0].status;

    // Declare "Completed" while the semester has NO graded courses yet.
    await window.careerflow.academic.setSemesterStatus(pid, semId, "Completed");

    // Now add a partially-graded course (40/100) — this would derive "In Progress".
    await window.careerflow.courses.add({
      profileId: pid,
      semesterLabel: "Semester 1",
      courseName: "Algorithms",
      credits: 4,
      grade: null,
      gradePoints: null,
      marksObtained: 40,
      maxMarks: 100,
      isHypothetical: false,
    });

    tree = await window.careerflow.academic.tree(pid);
    const afterCourse = tree[0].semesters[0].status;
    const sgpa = await window.careerflow.courses.sgpa(pid, "Semester 1");
    return { pid, semId, defaultStatus, afterCourse, sgpa: sgpa.sgpa };
  });

  expect(first.defaultStatus).toBe("Upcoming");
  // Declared status is NOT overwritten by the (would-be-derived) course data.
  expect(first.afterCourse).toBe("Completed");
  // SGPA is computed independently: 40% on the default 10-point scale -> 5.0.
  expect(first.sgpa).toBeCloseTo(5.0, 5);
  await app.close();

  // ---- Run 2: same workspace — status survived restart, still independent ----
  app = await launch();
  win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();

  const reloaded = await win.evaluate(async () => {
    const profiles = await window.careerflow.profiles.list();
    const pid = profiles[profiles.length - 1].id;
    const tree = await window.careerflow.academic.tree(pid);
    const sem = tree[0].semesters[0];
    // Remove the course (a course-data change) and re-read status.
    const courses = await window.careerflow.courses.list(pid, "Semester 1");
    for (const c of courses) await window.careerflow.courses.remove(pid, c.id);
    const tree2 = await window.careerflow.academic.tree(pid);
    return { persisted: sem.status, afterCourseRemoval: tree2[0].semesters[0].status };
  });

  expect(reloaded.persisted).toBe("Completed");
  expect(reloaded.afterCourseRemoval).toBe("Completed");
  await app.close();
});
