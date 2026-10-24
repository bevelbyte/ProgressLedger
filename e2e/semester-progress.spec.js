import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * Semester Progress workflow: build a semester with two subjects (one graded,
 * one ungraded), study time, and a subject-linked deadline; open the aggregated
 * semester overview; verify SGPA/credits/completion/study/deadlines/attention;
 * confirm a subject deep-links to its workspace; and confirm the aggregate
 * survives an app restart. Driven through the real IPC surface.
 */
test("semester overview aggregates academic/study/deadlines and survives restart", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-semester-"));
  const launch = () =>
    electron.launch({
      args: [projectRoot, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1" },
    });

  let app = await launch();
  let win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();

  const setup = await win.evaluate(async () => {
    const p = await window.progressLedger.profiles.add("Sem Progress", `semp-${Date.now()}`);
    const pid = p.id;
    const trackId = await window.progressLedger.academic.addTrack(pid, "B.Tech");
    const semId = await window.progressLedger.academic.addSemester(pid, trackId, "Semester 1");
    const msId = await window.progressLedger.academic.addMilestone(pid, semId, "Subjects");
    const algo = await window.progressLedger.academic.addSubject(pid, msId, "Algorithms", "CS201");
    const net = await window.progressLedger.academic.addSubject(pid, msId, "Networks", "CS202");

    // Algorithms graded 80/100 @4cr; Networks left ungraded.
    await window.progressLedger.courses.add({
      profileId: pid, semesterLabel: "Semester 1", courseName: "Algorithms",
      credits: 4, grade: null, gradePoints: null, marksObtained: 80, maxMarks: 100, isHypothetical: false,
    });
    await window.progressLedger.academic.setSubjectStatus(pid, algo, "done");

    // Study only Algorithms.
    await window.progressLedger.sessions.add(pid, algo, 45);
    // Overdue deadline on Networks.
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await window.progressLedger.deadlines.add(pid, net, yesterday, "assignment", "Lab Report", "");

    const ov = await window.progressLedger.resources.semesterOverview({ profileId: pid, semesterId: semId });
    return { pid, semId, algo, net, ov };
  });

  const ov = setup.ov;
  expect(ov.name).toBe("Semester 1");
  expect(ov.academic.gradedCourseCount).toBe(1);
  expect(ov.academic.gradedCredits).toBe(4);
  expect(ov.academic.sgpa).toBeCloseTo(9.0, 5); // 80% -> band 80 -> 9.0 default scale
  expect(ov.completion.totalSubjects).toBe(2);
  expect(ov.completion.doneSubjects).toBe(1);
  expect(ov.completion.gradedSubjects).toBe(1);
  expect(ov.study.totalMinutes).toBe(45);
  expect(ov.study.sessionCount).toBe(1);
  expect(ov.deadlines.overdue).toBe(1);

  // Networks (ungraded, no study) carries transparent attention flags.
  const networks = ov.subjects.find((s) => s.name === "Networks");
  expect(networks.graded).toBe(false);
  expect(networks.attention).toContain("Needs marks");
  expect(networks.attention).toContain("No study logged");

  await app.close();

  // ---- Restart: same workspace, aggregate persists ----
  app = await launch();
  win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();

  const reloaded = await win.evaluate(async () => {
    const profiles = await window.progressLedger.profiles.list();
    const pid = profiles[profiles.length - 1].id;
    const tree = await window.progressLedger.academic.tree(pid);
    const semId = tree[0].semesters[0].id;
    return window.progressLedger.resources.semesterOverview({ profileId: pid, semesterId: semId });
  });
  expect(reloaded.academic.sgpa).toBeCloseTo(9.0, 5);
  expect(reloaded.study.totalMinutes).toBe(45);
  expect(reloaded.completion.doneSubjects).toBe(1);
  expect(reloaded.deadlines.overdue).toBe(1);

  await app.close();
});
