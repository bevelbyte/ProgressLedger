import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * Today / Daily Focus workflow: seed a subject with an overdue deadline, a due
 * flashcard, and a study session; open the Dashboard; confirm the Today section
 * surfaces the urgent items and that clicking a Today deadline deep-links into
 * that subject's workspace. Verifies the compose-and-navigate model end to end.
 */
test("Today surfaces urgent items and deep-links a deadline to the subject workspace", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-today-"));
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1" },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();

  // Seed data through the real IPC surface, then note the subject name.
  const info = await win.evaluate(async () => {
    const p = await window.progressLedger.profiles.add("Today Student", `today-${Date.now()}`);
    const pid = p.id;
    const trackId = await window.progressLedger.academic.addTrack(pid, "B.Tech");
    const semId = await window.progressLedger.academic.addSemester(pid, trackId, "Semester 1");
    const msId = await window.progressLedger.academic.addMilestone(pid, semId, "Subjects");
    const subjectId = await window.progressLedger.academic.addSubject(pid, msId, "Algorithms", null);

    // Overdue deadline (yesterday), a due flashcard, and a study session.
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await window.progressLedger.deadlines.add(pid, subjectId, yesterday, "assignment", "Lab Report", "");
    await window.progressLedger.cards.create(pid, subjectId, "Q1", "A1"); // new cards are due immediately
    await window.progressLedger.sessions.add(pid, subjectId, 20);
    return { pid, subjectId };
  });

  // Home in the rail is addressed the same way every other spec in this suite
  // addresses the rail: `button.nav-item`, exact label. A bare `button` filter
  // used to be unique, but the Atlas pane header also renders a real tab for
  // every open view, so once Home is open the label matches two buttons and
  // Playwright's strict mode refuses to guess between the rail and the tab.
  const homeNav = () => win.locator("button.nav-item").filter({ hasText: /^\s*Home\s*$/ });

  // Activate the profile and go Home (Dashboard). Reload so the UI profile
  // list picks up the IPC-created profile, then select it.
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();

  const card = win.locator(".profile-card", { hasText: "Today Student" });
  await expect(card).toBeVisible();
  await card.click();
  await win.waitForTimeout(700);
  await homeNav().click();

  // Today section shows the overdue deadline and the due-flashcard CTA.
  // Scope to the .today panel: the same overdue deadline also renders in the
  // "This Week" (Overdue) column, so a whole-page getByText would be ambiguous.
  const todaySection = win.locator(".today");
  await expect(todaySection.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await expect(todaySection.getByText("Lab Report")).toBeVisible();
  await expect(todaySection.getByText(/flashcard.*due/i)).toBeVisible();
  // Study minutes surfaced (20m today) — also surfaces in This Week focus, so
  // scope to the Today panel to keep this assertion unambiguous.
  await expect(todaySection.getByText(/20m/)).toBeVisible();

  // Clicking the overdue deadline item deep-links into the subject workspace.
  await todaySection.getByText("Lab Report").click();
  await expect(win.getByRole("heading", { level: 2, name: /Algorithms/ })).toBeVisible();
  // Subject workspace shows its sections.
  await expect(win.getByText("Upcoming Deadlines")).toBeVisible();

  // --- CTA destinations: flashcards + study reach their existing features ---
  await homeNav().click();
  await expect(win.getByRole("heading", { name: "Today", exact: true })).toBeVisible();

  // Flashcards "Review" CTA reaches the Recall Deck feature.
  // Scope to the Today panel: the new "Focus Now" panel also surfaces
  // flashcard-due text and would match the same selector at the page level.
  await todaySection.getByText(/flashcard.*due/i).click();
  await expect(win.getByRole("heading", { name: "Recall Deck" })).toBeVisible();

  // Study CTA reaches the Study Sessions feature.
  await homeNav().click();
  await expect(win.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await win.getByText(/Log more|Start a session/).click();
  await expect(win.getByRole("heading", { name: "Study Sessions" })).toBeVisible();

  // --- Return to Dashboard reflects updated state (log more study) ---
  const before = await win.evaluate(async () => {
    const profiles = await window.progressLedger.profiles.list();
    const pid = profiles[profiles.length - 1].id;
    return (await window.progressLedger.sessions.stats(pid)).minutesToday;
  });
  await win.evaluate(async () => {
    const profiles = await window.progressLedger.profiles.list();
    const pid = profiles[profiles.length - 1].id;
    const tree = await window.progressLedger.academic.tree(pid);
    const subjectId = tree[0].semesters[0].milestones[0].subjects[0].id;
    await window.progressLedger.sessions.add(pid, subjectId, 15);
    window.dispatchEvent(new Event("cf:data-changed"));
  });
  await homeNav().click();
  await expect(win.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  // 20m + 15m = 35m studied today now surfaced.
  // Scope to Today: This Week focus also surfaces study minutes for the subject.
  await expect(todaySection.getByText(/35m/)).toBeVisible();
  expect(before).toBe(20);

  await app.close();
});
