import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * Phase 8 E2E: drive the real Electron + real CareerFlow core, seed data
 * through the real IPC surface, and verify the Dashboard's "Focus Now"
 * section surfaces the right subject for the right reason.
 *
 * Coverage:
 *   1. Empty state ("Nothing urgent. Your current workload is under control.")
 *   2. Overdue deadline surfaces the subject with "X deadline Nd overdue"
 *   3. Adding a due flashcard adds a Review action and "N flashcards due"
 *   4. Study inactivity surfaces "no study in Nd"
 *   5. Subject deletion drops the recommendation
 *   6. Subject rename propagates to the recommendation
 *   7. Deadline completion removes the deadline reason
 *   8. Profile switch isolates recommendations (Phase 7 E2E evidence)
 *   9. Restart persistence: data survives, recommendation persists
 *
 * No mocks. Every test goes through the real shell + native addon.
 */

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
})();
const TEN_DAYS_AGO = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 10);
  return d.toISOString().slice(0, 10);
})();

async function launchApp() {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-"));
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, CAREERFLOW_E2E: "1" },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.evaluate(() => localStorage.setItem("careerflow_onboarding_complete", "true"));
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();
  return { app, win, userDataDir };
}

async function selectProfile(win, name) {
  // The profile selector lives in the Profiles view (sidebar -> Profiles).
  // We click there, then click the matching card.
  await win.locator(".nav-item", { hasText: "Profiles" }).click();
  const card = win.locator(".profile-card", { hasText: name });
  await expect(card).toBeVisible();
  await card.click();
  await win.waitForTimeout(700);
  await win.locator(".nav-item", { hasText: "Home" }).click();
  await expect(win.locator(".focus-now").first()).toBeVisible();
}

async function seedProfile(win, name) {
  return win.evaluate(
    async ([profileName, yesterday, tenDaysAgo]) => {
      const slug = `focus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const p = await window.careerflow.profiles.add(profileName, slug);
      const pid = p.id;
      const trackId = await window.careerflow.academic.addTrack(pid, "B.Tech");
      const semId = await window.careerflow.academic.addSemester(pid, trackId, "Semester 1");
      const msId = await window.careerflow.academic.addMilestone(pid, semId, "Subjects");
      return { pid, trackId, semId, msId };
    },
    [name, YESTERDAY, TEN_DAYS_AGO],
  );
}

async function addSubject(win, pid, msId, name) {
  return win.evaluate(
    async ([p, mid, n]) => window.careerflow.academic.addSubject(p, mid, n, null),
    [pid, msId, name],
  );
}

async function addDeadline(win, pid, subjectId, date, title) {
  return win.evaluate(
    async ([p, sid, d, t]) => window.careerflow.deadlines.add(p, sid, d, "exam", t, ""),
    [pid, subjectId, date, title],
  );
}

async function addCard(win, pid, subjectId) {
  return win.evaluate(
    async ([p, sid]) => window.careerflow.cards.create(p, sid, "Q", "A"),
    [pid, subjectId],
  );
}

async function logSession(win, pid, subjectId) {
  return win.evaluate(
    async ([p, sid]) => window.careerflow.sessions.add(p, sid, 20),
    [pid, subjectId],
  );
}

test("Focus Now: empty state when profile has no urgent work", async () => {
  const { app, win } = await launchApp();
  const { pid, msId } = await seedProfile(win, "Empty Student");
  await addSubject(win, pid, msId, "Peaceful Subject");
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await selectProfile(win, "Empty Student");

  const focus = win.locator(".focus-now");
  await expect(focus).toBeVisible();
  await expect(focus.getByText("Nothing urgent. Your current workload is under control.")).toBeVisible();
  await expect(focus.getByText(/No subjects need attention right now/)).toBeVisible();

  await app.close();
});

test("Focus Now: surfaces overdue deadline with explainable reason", async () => {
  const { app, win } = await launchApp();
  const { pid, msId } = await seedProfile(win, "Overdue Student");
  const subjectId = await addSubject(win, pid, msId, "Algorithms");
  await addDeadline(win, pid, subjectId, YESTERDAY, "Lab Report");
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await selectProfile(win, "Overdue Student");

  const focus = win.locator(".focus-now");
  await expect(focus).toBeVisible();
  // The reason is the exact phrase from the algorithm (1d overdue is the
  // minimum granularity we promise for "overdue" reasons).
  await expect(focus.getByText("Algorithms")).toBeVisible();
  await expect(focus.getByText(/1 deadline 1d overdue/)).toBeVisible();

  // The action button deep-links into the subject workspace.
  await focus.getByRole("button", { name: "Open" }).first().click();
  await expect(win.getByRole("heading", { level: 2, name: /Algorithms/ })).toBeVisible();

  await app.close();
});

test("Focus Now: due flashcard adds Review action and the correct reason", async () => {
  const { app, win } = await launchApp();
  const { pid, msId } = await seedProfile(win, "Flashcard Student");
  const subjectId = await addSubject(win, pid, msId, "OS");
  // Add a card; cards are due immediately, so this is a due-card signal
  // without any deadline pressure.
  await addCard(win, pid, subjectId);
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await selectProfile(win, "Flashcard Student");

  const focus = win.locator(".focus-now");
  await expect(focus).toBeVisible();
  await expect(focus.getByText("OS")).toBeVisible();
  await expect(focus.getByText("1 flashcard due")).toBeVisible();
  // The Review action must exist; clicking it must reach the Recall Deck.
  await focus.getByRole("button", { name: "Review" }).first().click();
  await expect(win.getByRole("heading", { name: "Recall Deck" })).toBeVisible();

  await app.close();
});

test("Focus Now: study inactivity surfaces 'no study in Nd' for stale subjects", async () => {
  const { app, win } = await launchApp();
  const { pid, msId } = await seedProfile(win, "Stale Student");
  const subjectId = await addSubject(win, pid, msId, "Stale Subject");
  // Insert a session 10 days ago directly — go through the real SQL
  // path so the "today" boundary is identical to what the user sees.
  await win.evaluate(
    async ([p, sid, tenDaysAgo]) => {
      // Use the same shape the shell writes; the dashboard sees the
      // session because datetime('now','localtime') honours the wall
      // clock the test runs on.
      const iso = `${tenDaysAgo} 10:00:00`;
      await window.careerflow.sessions.add(p, sid, 25, iso, null, "");
      // Add a second session on a different subject so the profile has
      // "hasAnySession" = true and the inactivity signal is meaningful.
      const profile = (await window.careerflow.profiles.list())[0];
      const tree = await window.careerflow.academic.tree(profile.id);
      const ms = tree[0].semesters[0].milestones[0];
      const otherId = await window.careerflow.academic.addSubject(p, ms.id, "Other Subj", null);
      await window.careerflow.sessions.add(p, otherId, 10, null, null, "");
    },
    [pid, subjectId, TEN_DAYS_AGO],
  );
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await selectProfile(win, "Stale Student");

  const focus = win.locator(".focus-now");
  await expect(focus).toBeVisible();
  await expect(focus.getByText("Stale Subject")).toBeVisible();
  // 10d (or 11d if the wall clock crossed midnight) — accept either.
  await expect(focus.getByText(/no study in 1[01]d/)).toBeVisible();

  await app.close();
});

test("Focus Now: subject deletion drops the recommendation", async () => {
  const { app, win } = await launchApp();
  const { pid, msId } = await seedProfile(win, "Deleter");
  const subjectId = await addSubject(win, pid, msId, "Doomed");
  await addDeadline(win, pid, subjectId, YESTERDAY, "Past");
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await selectProfile(win, "Deleter");

  const focus = win.locator(".focus-now");
  await expect(focus.getByText("Doomed")).toBeVisible();

  // Delete the subject and reload.
  await win.evaluate(async ([p, sid]) => window.careerflow.academic.deleteSubject(p, sid), [pid, subjectId]);
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await selectProfile(win, "Deleter");
  await expect(focus.getByText("Nothing urgent. Your current workload is under control.")).toBeVisible();

  await app.close();
});

test("Focus Now: subject rename propagates to the recommendation", async () => {
  const { app, win } = await launchApp();
  const { pid, msId } = await seedProfile(win, "Renamer");
  const subjectId = await addSubject(win, pid, msId, "OldName");
  await addDeadline(win, pid, subjectId, YESTERDAY, "Past");
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await selectProfile(win, "Renamer");

  const focus = win.locator(".focus-now");
  await expect(focus.getByText("OldName")).toBeVisible();

  // Rename via the existing academic API.
  await win.evaluate(
    async ([p, sid]) => window.careerflow.academic.updateSubject(p, sid, "NewName", null),
    [pid, subjectId],
  );
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await selectProfile(win, "Renamer");
  await expect(focus.getByText("NewName")).toBeVisible();
  await expect(focus.getByText("OldName")).toHaveCount(0);

  await app.close();
});

test("Focus Now: completing a deadline updates the recommendation", async () => {
  const { app, win } = await launchApp();
  const { pid, msId } = await seedProfile(win, "Completer");
  const subjectId = await addSubject(win, pid, msId, "Done");
  const deadlineId = await addDeadline(win, pid, subjectId, YESTERDAY, "Tidy");
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await selectProfile(win, "Completer");

  const focus = win.locator(".focus-now");
  await expect(focus.getByText("Done")).toBeVisible();
  await expect(focus.getByText(/1 deadline 1d overdue/)).toBeVisible();

  // Mark the deadline complete.
  await win.evaluate(
    async ([p, did]) => window.careerflow.deadlines.setCompletion(p, did, true),
    [pid, deadlineId],
  );
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await selectProfile(win, "Completer");
  // The deadline is gone — no more attention.
  await expect(focus.getByText("Nothing urgent. Your current workload is under control.")).toBeVisible();

  await app.close();
});

test("Focus Now: profile isolation — second profile's data does not influence the first", async () => {
  const { app, win } = await launchApp();
  // Profile A: no urgent work.
  const A = await seedProfile(win, "Profile A");
  await addSubject(win, A.pid, A.msId, "A-Subject");
  // Profile B: overdue deadline.
  const B = await seedProfile(win, "Profile B");
  const bSubj = await addSubject(win, B.pid, B.msId, "B-Critical");
  await addDeadline(win, B.pid, bSubj, YESTERDAY, "B-Overdue");

  // Reload, then check A is empty and B surfaces its subject.
  await win.reload();
  await win.waitForLoadState("domcontentloaded");

  // Select A first.
  await selectProfile(win, "Profile A");
  let focus = win.locator(".focus-now");
  await expect(focus.getByText("Nothing urgent. Your current workload is under control.")).toBeVisible();
  await expect(focus.getByText("B-Critical")).toHaveCount(0);
  await expect(focus.getByText("B-Overdue")).toHaveCount(0);

  // Now switch to B.
  await selectProfile(win, "Profile B");
  focus = win.locator(".focus-now");
  await expect(focus.getByText("B-Critical")).toBeVisible();
  await expect(focus.getByText("A-Subject")).toHaveCount(0);

  // Switch back to A — its empty state must hold.
  await selectProfile(win, "Profile A");
  focus = win.locator(".focus-now");
  await expect(focus.getByText("Nothing urgent. Your current workload is under control.")).toBeVisible();

  await app.close();
});

test("Focus Now: restart persistence — recommendation survives an Electron restart", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-focus-restart-"));

  // --- First launch: seed data, verify recommendation shows ---
  {
    const app = await electron.launch({
      args: [projectRoot, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, CAREERFLOW_E2E: "1" },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await win.evaluate(() => localStorage.setItem("careerflow_onboarding_complete", "true"));
    await win.reload();
    await win.waitForLoadState("domcontentloaded");
    await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();

    const { pid, msId } = await seedProfile(win, "Restart Student");
    const subjectId = await addSubject(win, pid, msId, "Persisted");
    await addDeadline(win, pid, subjectId, YESTERDAY, "Across Restart");
    await win.reload();
    await win.waitForLoadState("domcontentloaded");
    await selectProfile(win, "Restart Student");
    const focus = win.locator(".focus-now");
    await expect(focus.getByText("Persisted")).toBeVisible();
    await expect(focus.getByText(/1 deadline 1d overdue/)).toBeVisible();

    await app.close();
  }

  // --- Second launch: same userDataDir, recommendation should be back ---
  {
    const app = await electron.launch({
      args: [projectRoot, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, CAREERFLOW_E2E: "1" },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();
    await selectProfile(win, "Restart Student");
    const focus = win.locator(".focus-now");
    await expect(focus.getByText("Persisted")).toBeVisible();
    await expect(focus.getByText(/1 deadline 1d overdue/)).toBeVisible();
    await app.close();
  }
});
