import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * Subject Workspace: opening a subject aggregates its academic grade, study
 * time, upcoming deadlines, resources, flashcards and mistakes in one call.
 * Verified through the real IPC surface (subjects:overview + per-feature APIs),
 * proving the Subject acts as the central connected entity.
 */
test("subject overview aggregates connected data for one subject", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-subjectws-"));
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1" },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();

  const result = await win.evaluate(async () => {
    const p = await window.progressLedger.profiles.add("WS Student", `ws-${Date.now()}`);
    const pid = p.id;
    const trackId = await window.progressLedger.academic.addTrack(pid, "B.Tech (CSE)");
    const semId = await window.progressLedger.academic.addSemester(pid, trackId, "Semester 1");
    const msId = await window.progressLedger.academic.addMilestone(pid, semId, "Subjects");
    const subjectId = await window.progressLedger.academic.addSubject(pid, msId, "Algorithms", "CS201");

    // Graded course (80% on the default 10-point scale -> 9.0).
    await window.progressLedger.courses.add({
      profileId: pid, semesterLabel: "Semester 1", courseName: "Algorithms",
      credits: 4, grade: null, gradePoints: null, marksObtained: 80, maxMarks: 100, isHypothetical: false,
    });
    // Study time.
    await window.progressLedger.sessions.add(pid, subjectId, 50, null, null, "");
    // Upcoming deadline.
    const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    await window.progressLedger.deadlines.add(pid, subjectId, future, "exam", "Midterm", "");
    // A note, a flashcard, a mistake.
    await window.progressLedger.resources.addNote(pid, subjectId, "Notes", "content");
    await window.progressLedger.cards.create(pid, subjectId, "Q1", "A1");
    await window.progressLedger.mistakes.add(pid, subjectId, "why?", "conceptual", "because", "");

    return window.progressLedger.resources.overview({ profileId: pid, subjectId });
  });

  expect(result.name).toBe("Algorithms");
  expect(result.code).toBe("CS201");
  expect(result.credits).toBe(4);
  expect(result.percentage).toBeCloseTo(80, 5);
  expect(result.gradePoint).toBeCloseTo(9.0, 5);
  expect(result.studyMinutesTotal).toBe(50);
  expect(result.studyMinutesToday).toBe(50);
  expect(result.upcomingDeadlineCount).toBe(1);
  expect(result.noteCount).toBe(1);
  expect(result.flashcardTotal).toBe(1);
  expect(result.mistakeCount).toBe(1);

  // Quick-log study from the workspace path (sessions service, same engine)
  // must increment the subject's study totals in the overview.
  const afterQuickLog = await win.evaluate(async () => {
    const profiles = await window.progressLedger.profiles.list();
    const pid = profiles[profiles.length - 1].id;
    const tree = await window.progressLedger.academic.tree(pid);
    const subjectId = tree[0].semesters[0].milestones[0].subjects[0].id;
    await window.progressLedger.sessions.add(pid, subjectId, 25);
    return window.progressLedger.resources.overview({ profileId: pid, subjectId });
  });
  expect(afterQuickLog.studyMinutesTotal).toBe(75);
  expect(afterQuickLog.studySessionCount).toBe(2);

  await app.close();
});
