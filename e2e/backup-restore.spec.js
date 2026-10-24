import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * Whole-profile backup/restore (bundle format v2) through the REAL UI flow:
 * seed a rich profile over IPC -> Backup Vault "Backup Active Profile" ->
 * delete the profile -> Restore from the vault -> RESTART Electron ->
 * deep-verify every domain came back with relationships intact
 * (courses.subject_id remapped, career links resolved, SM-2 state preserved).
 */
test("backup exports the complete profile and restore brings every domain back", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-backup-"));
  const backupDir = join(userDataDir, "vault");
  mkdirSync(backupDir, { recursive: true });

  const launch = () =>
    electron.launch({
      args: [projectRoot, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, CAREERFLOW_E2E: "1" },
    });

  let app = await launch();
  let win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.evaluate(() => localStorage.setItem("careerflow_onboarding_complete", "true"));
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();

  // Point the backup vault at our temp folder (same file the shell reads).
  const wsDir = await app.evaluate(({ app: a }) => a.getPath("userData"));
  console.log("[e2e] userData =", wsDir);
  const settingsPath = join(wsDir, "backup-settings.json");
  writeFileSync(settingsPath, JSON.stringify({
      backupDir,
      lastBackups: {},
      automation: { enabled: false, intervalMinutes: 60, target: "local", retentionKeep: 5 },
    }));
  const readback = await win.evaluate(() => window.careerflow.backups.get());
  console.log("[e2e] backups:get =>", JSON.stringify(readback));
  if (!readback.backupDir) {
    throw new Error("backup settings not visible to shell; settingsPath=" + settingsPath);
  }

  // Seed a rich profile over real IPC.
  const seed = await win.evaluate(async () => {
    const p = await window.careerflow.profiles.add("Backup Ada", `backup-ada-${Date.now()}`);
    const trackId = await window.careerflow.academic.addTrack(p.id, "B.Tech");
    const semId = await window.careerflow.academic.addSemester(p.id, trackId, "Semester 1");
    await window.careerflow.academic.setSemesterStatus(p.id, semId, "In Progress");
    const msId = await window.careerflow.academic.addMilestone(p.id, semId, "Subjects");
    const subjectId = await window.careerflow.academic.addSubject(p.id, msId, "Distributed Systems", "CS301");

    await window.careerflow.sessions.add(p.id, subjectId, 40);
    await window.careerflow.cards.create(p.id, subjectId, "Q1", "A1");
    await window.careerflow.cards.review(p.id, (await window.careerflow.cards.all(p.id))[0].id, 5);
    await window.careerflow.mistakes.add(p.id, subjectId, "q", "conceptual", "a", "[\"race\"]");
    await window.careerflow.resources.addNote(p.id, subjectId, "Lecture 1", "lamport clocks");
    await window.careerflow.deadlines.add(p.id, subjectId, "2026-09-15", "exam", "Midterm", "");
    await window.careerflow.labs.add(p.id, subjectId, 1, "Lab1");
    await window.careerflow.formulas.add(p.id, subjectId, "Clock", "\\\\clock", "distributed");

    // Graded course, structurally linked (migration 014 world).
    await window.careerflow.courses.add({
      profileId: p.id, semesterLabel: "Semester 1", courseName: "Distributed Systems",
      credits: 4, marksObtained: 91, maxMarks: 100, isHypothetical: false, subjectId,
    });

    await window.careerflow.projects.add(p.id, "Raft Clone", "major", "2026-12-01", "raft");
    const projects = await window.careerflow.projects.list(p.id);
    await window.careerflow.projectTasks.add(p.id, projects[0].id, "Leader election", "high", null);

    const goalId = await window.careerflow.career.addGoal({ profileId: p.id, title: "Systems Engineer", isPrimary: true });
    const milestoneId = await window.careerflow.career.addMilestone({ profileId: p.id, goalId, title: "Build Raft" });
    await window.careerflow.career.setMilestoneSubject(p.id, milestoneId, subjectId);
    await window.careerflow.career.setMilestoneProject(p.id, milestoneId, projects[0].id);

    return {
      pid: p.id, slug: p.slug, subjectId, goalId, milestoneId,
      projectId: projects[0].id, cardId: (await window.careerflow.cards.all(p.id))[0].id,
    };
  });

  // Snapshot pre-delete state we expect to see again after restore.
  const snapshotBefore = await win.evaluate(async ({ pid, subjectId, milestoneId }) => {
    const cgpa = await window.careerflow.courses.cgpa(pid);
    const cards = await window.careerflow.cards.all(pid);
    const card = cards.find((c) => c.subjectId === subjectId);
    const milestones = await window.careerflow.career.milestones(
      pid,
      (await window.careerflow.career.goals(pid)).find((g) => g.isPrimary).id
    );
    const m = milestones.find((x) => x.id === milestoneId);
    return {
      cgpaValue: cgpa.cgpa,
      cardEf: card.easeFactor, cardInterval: card.intervalDays, cardReps: card.repetitions,
      careerProjectName: m.linkedProjectName, careerSubjectName: m.linkedSubjectName,
    };
  }, seed);

  // Reload so the UI profile list picks up the IPC-created profile.
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();

  // BACKUP through the UI: activate the profile first (the vault backs up the
  // ACTIVE profile), then Settings -> Backup Vault -> Backup Active Profile.
  await win.locator(".nav-item", { hasText: "Profiles" }).click();
  await win.locator(".profile-card", { hasText: "Backup Ada" })
    .locator(".profile-main").click();
  await win.waitForTimeout(700);
  await win.locator(".nav-item", { hasText: "Settings" }).click();
  win.on("console", (m) => { if (m.type() === "error") console.log("[renderer]", m.text()); });
  await win.locator("button.primary", { hasText: "Backup Active Profile" }).click();
  await win.waitForTimeout(1500);
  const vault = await win.evaluate(() => window.careerflow.backups.get());
  console.log("[e2e] vault after backup =>", JSON.stringify(vault.backups));
  await expect(win.locator(".backup-row").first()).toBeVisible();

  // DELETE the profile through the UI (confirm dialog).
  await win.locator(".nav-item", { hasText: "Profiles" }).click();
  // Scoped to the card itself. The old `[class*=profile]` catch-all also matched
  // the shell's profile chip in the title bar, which sits earlier in the DOM and
  // carries the same profile name — so `.first()` resolved to chrome that has no
  // Delete button. The behaviour under test (delete a profile from the Profiles
  // view) is unchanged; only the locator was over-broad.
  const delCard = win.locator("article.profile-card", { hasText: "Backup Ada" }).first();
  await expect(delCard).toBeVisible();
  await delCard.getByRole("button", { name: "Delete" }).click();
  const modal = win.locator(".cf-modal");
  await expect(modal).toBeVisible();
  await modal.locator("button.danger, button.primary").last().click();
  await win.waitForTimeout(600);
  await expect(win.getByText(/Delete this profile|Everything inside/i)).toHaveCount(0); // dialog closed

  const goneCheck = await win.evaluate(async ({ pid }) => {
    const profiles = await window.careerflow.profiles.list();
    return profiles.some((p) => p.id === pid);
  }, seed);
  expect(goneCheck).toBe(false);

  // RESTORE from the vault through the UI directly from ZERO PROFILES.
  // The BackupVault fix ensures valid backup bundles and .restore-btn remain
  // visible and operational when 0 local profiles exist (no placeholder needed).
  const profilesBeforeRestore = await win.evaluate(async () => {
    return await window.careerflow.profiles.list();
  });
  expect(profilesBeforeRestore.length).toBe(0);
  console.log("[e2e] confirmed 0 profiles before restore =>", JSON.stringify(profilesBeforeRestore));

  await win.locator(".nav-item", { hasText: "Settings" }).click();
  await expect(win.locator(".restore-btn").first()).toBeVisible();
  await win.locator(".restore-btn").first().click();
  const rmodal = win.locator(".cf-modal");
  await expect(rmodal).toBeVisible();
  await rmodal.locator("button.danger, button.primary").last().click();
  await win.waitForTimeout(900);

  const restored = await win.evaluate(async ({ slugPrefix }) => {
    const profiles = await window.careerflow.profiles.list();
    const mine = profiles.find((p) => p.slug.startsWith(slugPrefix));
    return { found: !!mine, pid: mine?.id };
  }, { slugPrefix: "backup-ada" });
  expect(restored.found).toBe(true);
  expect(restored.pid).not.toBe(seed.pid); // NEW ids — remapping happened

  await app.close();

  // RESTART and deep-verify the restored profile.
  app = await launch();
  win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();

  const after = await win.evaluate(async ({ pid: _old, slugPrefix, subjectName, milestoneTitle, projectName }) => {
    const profiles = await window.careerflow.profiles.list();
    const me = profiles.find((p) => p.slug.startsWith(slugPrefix));
    if (!me) return { found: false };

    const tree = await window.careerflow.academic.tree(me.id);
    const subjects = tree[0].semesters[0].milestones[0].subjects;
    const subj = subjects.find((s) => s.name === subjectName);

    const courses = await window.careerflow.courses.list(me.id, null);
    const course = courses.find((c) => c.subjectId === subj?.id);

    const cgpa = await window.careerflow.courses.cgpa(me.id);
    const goals = await window.careerflow.career.goals(me.id);
    const primary = goals.find((g) => g.isPrimary) ?? goals[0];
    const milestones = primary ? await window.careerflow.career.milestones(me.id, primary.id) : [];
    const ms = milestones.find((m) => m.title === milestoneTitle);

    const sessions = (await window.careerflow.sessions.list(me.id, 500)).filter(
      (s) => s.subjectId === subj?.id
    );
    const deadlines = (await window.careerflow.deadlines.list(me.id)).filter(
      (d) => d.subjectId === subj?.id
    );
    // `pid` is deliberately NOT the pre-restore id: restore remaps every row
    // id, so the deep verification must run against the profile id resolved
    // from the slug in THIS process (me.id), exactly like every other domain
    // above. Passing the stale id here made the whole deep-verify block throw
    // `ReferenceError: pid is not defined` before a single assertion ran.
    const mistakes = await window.careerflow.mistakes.list({ profileId: me.id, subjectId: subj?.id });
    const resources = await window.careerflow.resources.list({ profileId: me.id, subjectId: subj?.id });
    const labs = await window.careerflow.labs.list(me.id, subj?.id);
    const formulas = await window.careerflow.formulas.list(me.id, subj?.id, null);
    const projects = await window.careerflow.projects.list(me.id);
    const tasks = projects.length ? await window.careerflow.projectTasks.list(me.id, projects[0].id) : [];
    const semStatus = tree[0].semesters[0].status;

    return {
      found: true, profileId: me.id, slug: me.slug,
      subjectCount: subjects.length, subjectCode: subj?.code ?? null,
      courseLinked: !!(course && course.subjectId === subj?.id),
      courseCredits: course?.credits ?? null,
      cgpaValue: cgpa.cgpa,
      sessionMinutes: sessions.reduce((a, s) => a + s.durationMinutes, 0),
      deadlineCount: deadlines.length,
      mistakeTags: mistakes[0]?.tags ?? null,
      noteTitle: resources.find((r) => r.kind === "note")?.title ?? null,
      labCount: labs.length, formulaCount: formulas.length,
      projectName: projects[0]?.name ?? null, taskCount: tasks.length,
      careerGoalTitle: primary?.title ?? null,
      careerSubjectLink: ms?.linkedSubjectName ?? null,
      careerProjectLink: ms?.linkedProjectName ?? null,
      semStatus,
    };
  }, { pid: seed.pid, slugPrefix: "backup-ada", subjectName: "Distributed Systems", milestoneTitle: "Build Raft", projectName: "Raft Clone" });

  expect(after.found).toBe(true);
  expect(after.subjectCount).toBe(1);
  expect(after.subjectCode).toBe("CS301");
  expect(after.courseLinked).toBe(true); // structural link survived remap
  expect(after.courseCredits).toBe(4);
  expect(after.cgpaValue).toBeCloseTo(snapshotBefore.cgpaValue, 5);
  expect(after.sessionMinutes).toBe(40);
  expect(after.deadlineCount).toBe(1);
  expect(JSON.parse(after.mistakeTags)).toEqual(["race"]);
  expect(after.noteTitle).toBe("Lecture 1");
  expect(after.labCount).toBe(1);
  expect(after.formulaCount).toBe(1);
  expect(after.projectName).toBe("Raft Clone");
  expect(after.taskCount).toBe(1);
  expect(after.careerGoalTitle).toBe("Systems Engineer");
  expect(after.careerSubjectLink).toBe("Distributed Systems");
  expect(after.careerProjectLink).toBe("Raft Clone");
  expect(after.semStatus).toBe("In Progress");
  expect(snapshotBefore.cardReps).toBe(1); // sanity: review registered

  await app.close();
});
