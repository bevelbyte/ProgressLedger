import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * SUBJECT IDENTITY HARDENING (schema v14), end to end.
 *
 * The bug this pins: the Degree Planner used to reconcile subjects by NAME,
 * so renaming a subject deleted it and created a new one — silently destroying
 * study history, notes, cards, mistakes and detaching its grade. Now the
 * planner reconciles by subjects.id.
 *
 * Driven through the REAL stack: rename + delete happen via the planner UI
 * (Degree > My Degrees > Semester > Semester Exam > Edit/Delete Subject),
 * which exercises saveSubject -> persist -> degree-mapper -> IPC -> Rust.
 */
test("renaming a subject in the Degree Planner preserves its id and every dependent", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-subject-rename-"));
  const launch = () =>
    electron.launch({
      args: [projectRoot, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1" },
    });

  let app = await launch();
  let win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();

  // Seed Profile A with a fully-populated subject over real IPC. The course
  // row is deliberately legacy-shaped (no subject link) so we also prove the
  // mapper links it structurally on its first save.
  const seed = await win.evaluate(async () => {
    const p = await window.progressLedger.profiles.add("Rename Ada", `rename-ada-${Date.now()}`);
    const trackId = await window.progressLedger.academic.addTrack(p.id, "B.Tech");
    const semId = await window.progressLedger.academic.addSemester(p.id, trackId, "Semester 1");
    const msId = await window.progressLedger.academic.addMilestone(p.id, semId, "Subjects");
    const subjectId = await window.progressLedger.academic.addSubject(p.id, msId, "Algorithms", "CS301");
    await window.progressLedger.sessions.add(p.id, subjectId, 25);
    await window.progressLedger.cards.create(p.id, subjectId, "Q1", "A1");
    await window.progressLedger.mistakes.add(p.id, subjectId, "q", "conceptual", "a", "");
    await window.progressLedger.resources.addNote(p.id, subjectId, "Note", "body");
    await window.progressLedger.formulas.add(p.id, subjectId, "F", "x^2", "alg");
    await window.progressLedger.labs.add(p.id, subjectId, 1, "Exp");
    await window.progressLedger.deadlines.add(p.id, subjectId, new Date().toISOString().slice(0, 10), "exam", "Mid", "");
    // Legacy-shaped graded course (pre-014 style: no structural link yet).
    await window.progressLedger.courses.add({
      profileId: p.id, semesterLabel: "Semester 1", courseName: "Algorithms",
      credits: 4, marksObtained: 88, maxMarks: 100, isHypothetical: false,
    });
    const goalId = await window.progressLedger.career.addGoal({ profileId: p.id, title: "Backend Engineer", isPrimary: true });
    const milestoneId = await window.progressLedger.career.addMilestone({ profileId: p.id, goalId, title: "Learn SQL" });
    await window.progressLedger.career.setMilestoneSubject(p.id, milestoneId, subjectId);
    return { pid: p.id, subjectId, goalId, milestoneId };
  });

  const openPlannerSemester = async (expectedName) => {
    await win.locator(".nav-item", { hasText: "Degree" }).click();
    await expect(win.locator(".section-tab-btn", { hasText: "My Degrees" })).toBeVisible();
    await win.locator(".sem-row-card", { hasText: "Semester 1" }).click();
    await win.locator(".pattern-btn", { hasText: "Semester Exam" }).click();
    const panel = win.locator(".semester-details-panel");
    await expect(panel.getByText(expectedName)).toBeVisible();
    return panel;
  };

  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();
  const card = win.locator(".profile-card", { hasText: "Rename Ada" });
  await expect(card).toBeVisible();
  await card.click();
  await win.waitForTimeout(700);

  // RENAME through the actual planner UI.
  let panel = await openPlannerSemester("Algorithms");
  await panel.locator('[title="Edit Subject"]').first().click();
  const nameInput = win.locator("input[placeholder='e.g. Engineering Mathematics I']");
  await expect(nameInput).toHaveValue("Algorithms");
  await nameInput.fill("Distributed Systems");
  await win.locator("button.minimal-btn.primary-btn", { hasText: "Save" }).click();
  await win.waitForTimeout(600); // persist + toast

  // Everything survived under the SAME subject id — verified over real IPC.
  const afterRename = await win.evaluate(async ({ pid, subjectId, goalId }) => {
    const tree = await window.progressLedger.academic.tree(pid);
    const subs = tree[0].semesters[0].milestones[0].subjects;
    const courses = await window.progressLedger.courses.list(pid, null);
    const sessions = (await window.progressLedger.sessions.list(pid, 500)).filter((s) => s.subjectId === subjectId);
    const cards = (await window.progressLedger.cards.all(pid)).filter((c) => c.subjectId === subjectId);
    const mistakes = await window.progressLedger.mistakes.list({ profileId: pid, subjectId });
    const resources = await window.progressLedger.resources.list({ profileId: pid, subjectId });
    const formulas = await window.progressLedger.formulas.list(pid, subjectId, null);
    const labs = await window.progressLedger.labs.list(pid, subjectId);
    const deadlines = (await window.progressLedger.deadlines.list(pid)).filter((d) => d.subjectId === subjectId);
    const milestones = await window.progressLedger.career.milestones(pid, goalId);
    const overview = await window.progressLedger.resources.overview({ profileId: pid, subjectId });
    return {
      subjectCount: subs.length,
      subject: subs[0],
      course: courses[0] ?? null,
      sessionCount: sessions.length,
      cardCount: cards.length,
      mistakeCount: mistakes.length,
      noteCount: resources.filter((r) => r.kind === "note").length,
      formulaCount: formulas.length,
      labCount: labs.length,
      deadlineCount: deadlines.length,
      careerLink: milestones.find((m) => m.title === "Learn SQL"),
      overviewPct: overview.percentage,
      overviewName: overview.name,
    };
  }, seed);

  expect(afterRename.subjectCount).toBe(1); // exactly one subject — no fork
  expect(afterRename.subject.id).toBe(seed.subjectId); // SAME identity
  expect(afterRename.subject.name).toBe("Distributed Systems");
  expect(afterRename.course.subjectId).toBe(seed.subjectId); // legacy row linked structurally
  expect(afterRename.course.courseName).toBe("Distributed Systems");
  expect(afterRename.course.marksObtained).toBe(88);
  expect(afterRename.sessionCount).toBe(1);
  expect(afterRename.cardCount).toBe(1);
  expect(afterRename.mistakeCount).toBe(1);
  expect(afterRename.noteCount).toBe(1);
  expect(afterRename.formulaCount).toBe(1);
  expect(afterRename.labCount).toBe(1);
  expect(afterRename.deadlineCount).toBe(1);
  expect(afterRename.careerLink.linkedSubjectId).toBe(seed.subjectId);
  expect(afterRename.careerLink.linkedSubjectName).toBe("Distributed Systems");
  expect(afterRename.overviewPct).toBe(88); // grade resolves via subject_id post-rename
  expect(afterRename.overviewName).toBe("Distributed Systems");

  // Subjects hub reflects the rename; workspace opens by deep link.
  await win.locator(".nav-item", { hasText: "Subjects" }).click();
  await expect(win.locator(".subject-hub-v2").getByText("Distributed Systems")).toBeVisible();

  // RESTART: everything persists.
  await app.close();
  app = await launch();
  win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();
  const card2 = win.locator(".profile-card", { hasText: "Rename Ada" });
  await expect(card2).toBeVisible();
  await card2.click();
  await win.waitForTimeout(700);
  panel = await openPlannerSemester("Distributed Systems");
  await expect(panel.getByText("Distributed Systems")).toBeVisible();

  const afterRestart = await win.evaluate(async ({ pid, subjectId, goalId }) => {
    const tree = await window.progressLedger.academic.tree(pid);
    const subs = tree[0].semesters[0].milestones[0].subjects;
    const sessions = (await window.progressLedger.sessions.list(pid, 500)).filter((s) => s.subjectId === subjectId);
    const milestones = await window.progressLedger.career.milestones(pid, goalId);
    const courses = await window.progressLedger.courses.list(pid, null);
    return {
      id: subs[0]?.id, name: subs[0]?.name, count: subs.length,
      sessions: sessions.length,
      careerName: milestones.find((m) => m.title === "Learn SQL")?.linkedSubjectName,
      courseLinked: courses[0]?.subjectId === subjectId,
    };
  }, seed);
  expect(afterRestart.count).toBe(1);
  expect(afterRestart.id).toBe(seed.subjectId);
  expect(afterRestart.name).toBe("Distributed Systems");
  expect(afterRestart.sessions).toBe(1);
  expect(afterRestart.careerName).toBe("Distributed Systems");
  expect(afterRestart.courseLinked).toBe(true);

  // PROFILE ISOLATION: B's identically-named subject is untouched by A's
  // rename, and A's course can never be re-pointed at B's subject.
  const isolation = await win.evaluate(async ({ pid, subjectId, courseId }) => {
    const b = await window.progressLedger.profiles.add("Rename Bea", `rename-bea-${Date.now()}`);
    const trackId = await window.progressLedger.academic.addTrack(b.id, "B.Tech");
    const semId = await window.progressLedger.academic.addSemester(b.id, trackId, "Semester 1");
    const msId = await window.progressLedger.academic.addMilestone(b.id, semId, "Subjects");
    const bSubjectId = await window.progressLedger.academic.addSubject(b.id, msId, "Algorithms", "CS999");
    let crossProfileRejected = false;
    try {
      await window.progressLedger.courses.update({
        profileId: pid, courseId, courseName: "Algorithms", credits: 4,
        marksObtained: 0, maxMarks: 100, subjectId: bSubjectId,
      });
    } catch (e) {
      crossProfileRejected = /different profile/i.test(String(e?.message ?? e));
    }
    const bSubs = (await window.progressLedger.academic.tree(b.id))[0].semesters[0].milestones[0].subjects;
    return { crossProfileRejected, bSubject: bSubs[0], bPid: b.id, bSubjectId };
  }, { ...seed, courseId: afterRename.course.id });
  expect(isolation.crossProfileRejected).toBe(true);
  expect(isolation.bSubject.name).toBe("Algorithms"); // B untouched

  // REAL DELETE through the planner UI still removes the subject + dependents.
  await win.locator(".nav-item", { hasText: "Degree" }).click();
  await expect(win.locator(".section-tab-btn", { hasText: "My Degrees" })).toBeVisible();
  await win.locator(".sem-row-card", { hasText: "Semester 1" }).click();
  await win.locator(".pattern-btn", { hasText: "Semester Exam" }).click();
  panel = win.locator(".semester-details-panel");
  await expect(panel.getByText("Distributed Systems")).toBeVisible();
  await panel.locator('[title="Delete Subject"]').first().click();
  await win.getByRole("button", { name: "Delete", exact: true }).click();
  await win.waitForTimeout(600); // confirm dialog -> delete -> persist

  const afterDelete = await win.evaluate(async ({ pid, subjectId, goalId }) => {
    const tree = await window.progressLedger.academic.tree(pid);
    const subs = tree[0].semesters[0].milestones[0].subjects;
    const sessions = (await window.progressLedger.sessions.list(pid, 500)).filter((s) => s.subjectId === subjectId);
    const courses = await window.progressLedger.courses.list(pid, null);
    const milestones = await window.progressLedger.career.milestones(pid, goalId);
    const link = milestones.find((m) => m.title === "Learn SQL");
    return {
      count: subs.length,
      sessions: sessions.length,
      courseRows: courses.length,
      danglingCareer: link != null && link.linkedSubjectId === subjectId && link.linkedSubjectName == null,
    };
  }, seed);
  expect(afterDelete.count).toBe(0); // genuine deletion happened
  expect(afterDelete.sessions).toBe(0); // dependents destroyed as designed
  expect(afterDelete.courseRows).toBe(0); // linked course swept with its subject
  expect(afterDelete.danglingCareer).toBe(true); // honest missing-reference state

  // Bea's data is completely unaffected by A's delete/rename cycle.
  const bAfter = await win.evaluate(async ({ bPid }) => {
    const subs = (await window.progressLedger.academic.tree(bPid))[0].semesters[0].milestones[0].subjects;
    return { count: subs.length, name: subs[0]?.name };
  }, isolation);
  expect(bAfter).toEqual({ count: 1, name: "Algorithms" });

  await app.close();
});
