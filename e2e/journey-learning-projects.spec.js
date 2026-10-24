import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * JOURNEY B+C — Learning & Projects, with RESTART persistence.
 *
 * These two journeys had no end-to-end coverage: flashcard review scheduling,
 * mistakes, labs, formulas, notes, projects/tasks all persisted, plus a
 * project→career-milestone link surviving a restart.
 *
 * Mutations go over the real IPC→Rust→SQLite surface inside the running
 * Electron app (the same path the UI services use); key surfaces are then
 * verified through the actual UI before and after an application restart.
 */
test("learning + project data persists across an application restart", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-journey-bc-"));
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

  const seed = await win.evaluate(async () => {
    const p = await window.careerflow.profiles.add("Journey Kim", `journey-${Date.now()}`);
    const trackId = await window.careerflow.academic.addTrack(p.id, "B.Tech");
    const semId = await window.careerflow.academic.addSemester(p.id, trackId, "Semester 1");
    const msId = await window.careerflow.academic.addMilestone(p.id, semId, "Subjects");
    const subjectId = await window.careerflow.academic.addSubject(p.id, msId, "Operating Systems", "CS401");

    // Learning domain.
    await window.careerflow.resources.addNote(p.id, subjectId, "Lecture 4", "scheduling algorithms");
    await window.careerflow.cards.create(p.id, subjectId, "What is a deadlock?", "Circular wait");
    await window.careerflow.mistakes.add(p.id, subjectId, "wrong wait order", "conceptual", "lock ordering", "[\"sync\"]");
    await window.careerflow.labs.add(p.id, subjectId, 2, "Xv6 scheduler lab");
    await window.careerflow.formulas.add(p.id, subjectId, "Turnaround", "T = finish - arrive", "metrics");

    // Review the card once (Good) so SM-2 leaves its initial state.
    const cardId = (await window.careerflow.cards.all(p.id))[0].id;
    await window.careerflow.cards.review(p.id, cardId, 3);

    // Projects domain.
    await window.careerflow.projects.add(p.id, "Xv6 Extensions", "major", "2026-12-20", "course capstone");
    const projects = await window.careerflow.projects.list(p.id);
    const projectId = projects[0].id;
    await window.careerflow.projectTasks.add(p.id, projectId, "Syscall harness", "high", null);
    const tasks = await window.careerflow.projectTasks.list(p.id, projectId);

    // Career link: milestone -> this project.
    const goalId = await window.careerflow.career.addGoal({ profileId: p.id, title: "Kernel Engineer", isPrimary: true });
    const milestoneId = await window.careerflow.career.addMilestone({ profileId: p.id, goalId, title: "Finish Xv6 work" });
    await window.careerflow.career.setMilestoneProject(p.id, milestoneId, projectId);

    return {
      pid: p.id, slug: p.slug, subjectId, projectId, taskId: tasks[0].id,
      goalId, milestoneId, cardId,
    };
  });

  // Complete the project task (status transition) before restart.
  await win.evaluate(async ({ pid, taskId }) => {
    await window.careerflow.projectTasks.update(pid, taskId, "Syscall harness", "done", "high", null, null);
  }, seed);

  // Pre-restart snapshot of everything we expect to survive.
  const before = await win.evaluate(async ({ pid, subjectId, projectId, milestoneId }) => {
    const cards = await window.careerflow.cards.all(pid);
    const card = cards.find((c) => c.subjectId === subjectId);
    const mistakes = await window.careerflow.mistakes.list({ profileId: pid, subjectId });
    const resources = await window.careerflow.resources.list({ profileId: pid, subjectId });
    const labs = await window.careerflow.labs.list(pid, subjectId);
    const formulas = await window.careerflow.formulas.list(pid, subjectId, null);
    const tasks = await window.careerflow.projectTasks.list(pid, projectId);
    const milestones = await window.careerflow.career.milestones(
      pid,
      (await window.careerflow.career.goals(pid)).find((g) => g.isPrimary).id
    );
    const ms = milestones.find((m) => m.title === "Finish Xv6 work");
    return {
      cardEase: card.easeFactor, cardInterval: card.interval,
      lastReviewed: card.lastReviewed,
      noteTitle: resources.find((r) => r.kind === "note")?.title,
      mistakeTags: mistakes[0]?.tags,
      labTitle: labs[0]?.title,
      formulaTitle: formulas[0]?.title,
      taskStatus: tasks[0]?.status,
      careerProjectName: ms?.linkedProjectName,
    };
  }, seed);

  // Activate the seeded profile so feature views bind to it.
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();
  await win.locator(".nav-item", { hasText: "Profiles" }).click();
  await win.locator(".profile-card", { hasText: "Journey Kim" }).locator(".profile-main").click();
  await win.waitForTimeout(700);

  // UI spot-checks BEFORE restart: Recall Deck shows the reviewed card state.
  await win.locator(".nav-item", { hasText: "Flashcards" }).click();
  await win.locator(".toggle-btn", { hasText: "All" }).click();
  await expect(win.locator(".card-item").first()).toContainText("deadlock");

  await app.close();

  // ---- RESTART ----
  app = await launch();
  win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();

  const afterRestart = await win.evaluate(async ({ pid, subjectId, projectId, milestoneId }) => {
    const cards = await window.careerflow.cards.all(pid);
    const card = cards.find((c) => c.subjectId === subjectId);
    const mistakes = await window.careerflow.mistakes.list({ profileId: pid, subjectId });
    const resources = await window.careerflow.resources.list({ profileId: pid, subjectId });
    const labs = await window.careerflow.labs.list(pid, subjectId);
    const formulas = await window.careerflow.formulas.list(pid, subjectId, null);
    const tasks = await window.careerflow.projectTasks.list(pid, projectId);
    const milestones = await window.careerflow.career.milestones(
      pid,
      (await window.careerflow.career.goals(pid)).find((g) => g.isPrimary).id
    );
    const ms = milestones.find((m) => m.title === "Finish Xv6 work");
    return {
      cardEase: card?.easeFactor, cardInterval: card?.interval,
      lastReviewed: card?.lastReviewed ?? null,
      noteTitle: resources.find((r) => r.kind === "note")?.title,
      mistakeTags: mistakes[0]?.tags,
      labTitle: labs[0]?.title,
      formulaTitle: formulas[0]?.title,
      taskStatus: tasks[0]?.status,
      careerProjectName: ms?.linkedProjectName,
    };
  }, seed);

  // SM-2 state survived EXACTLY (interval grew by design of quality=3 on first
  // review; reps advanced to 1; timestamp preserved).
  expect(afterRestart.cardEase).toBeCloseTo(before.cardEase, 9);
  expect(afterRestart.cardInterval).toBe(before.cardInterval);
  expect(afterRestart.lastReviewed).toBe(before.lastReviewed);
  expect(afterRestart.cardInterval).toBeGreaterThanOrEqual(1);

  expect(afterRestart.noteTitle).toBe(before.noteTitle);
  expect(JSON.parse(afterRestart.mistakeTags)).toEqual(["sync"]);
  expect(afterRestart.labTitle).toBe(before.labTitle);
  expect(afterRestart.formulaTitle).toBe(before.formulaTitle);
  expect(afterRestart.taskStatus).toBe("done");
  expect(afterRestart.careerProjectName).toBe(before.careerProjectName);

  // UI verification after restart: Recall Deck lists the reviewed card with
  // its SM-2 metadata; Mistake Ledger shows the entry.
  await win.locator(".profile-card", { hasText: "Journey Kim" }).locator(".profile-main").click();
  await win.waitForTimeout(700);
  await win.locator(".nav-item", { hasText: "Flashcards" }).click();
  await win.locator(".toggle-btn", { hasText: "All" }).click();
  await expect(win.locator(".card-item").first()).toContainText("deadlock");
  await expect(win.locator(".card-item").first()).toContainText(`Interval: ${before.cardInterval}d`);

  await win.locator(".nav-item", { hasText: "Mistakes" }).click();
  await expect(win.getByText("wrong wait order")).toBeVisible();

  await app.close();
});
