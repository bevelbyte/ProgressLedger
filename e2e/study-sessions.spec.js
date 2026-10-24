import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * Study-session workflow: log study time against a subject, verify it persists
 * across an app restart, contributes to session stats, and counts toward the
 * dashboard study streak. Driven through the real IPC surface.
 */
test("study sessions persist across restart and feed stats + streak", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-sessions-"));
  const launch = () =>
    electron.launch({
      args: [projectRoot, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1" },
    });

  // ---- Run 1: build a subject, log two sessions today ----
  let app = await launch();
  let win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();

  const setup = await win.evaluate(async () => {
    const p = await window.progressLedger.profiles.add("Session Student", `sess-${Date.now()}`);
    const pid = p.id;
    const trackId = await window.progressLedger.academic.addTrack(pid, "B.Tech");
    const semId = await window.progressLedger.academic.addSemester(pid, trackId, "Semester 1");
    const msId = await window.progressLedger.academic.addMilestone(pid, semId, "Subjects");
    const subjectId = await window.progressLedger.academic.addSubject(pid, msId, "Algorithms", null);

    await window.progressLedger.sessions.add(pid, subjectId, 45, null, null, "focus");
    await window.progressLedger.sessions.add(pid, subjectId, 30, null, null, "");

    const stats = await window.progressLedger.sessions.stats(pid);
    const dash = await window.progressLedger.dashboard.stats(pid);
    return { pid, stats, streak: dash.currentStreak };
  });

  expect(setup.stats.totalSessions).toBe(2);
  expect(setup.stats.totalMinutes).toBe(75);
  expect(setup.stats.minutesToday).toBe(75);
  expect(setup.stats.activeDays).toBe(1);
  // A session logged today makes the streak at least 1.
  expect(setup.streak).toBeGreaterThanOrEqual(1);
  await app.close();

  // ---- Run 2: same workspace — sessions survived restart ----
  app = await launch();
  win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();

  const reloaded = await win.evaluate(async () => {
    const profiles = await window.progressLedger.profiles.list();
    const pid = profiles[profiles.length - 1].id;
    const list = await window.progressLedger.sessions.list(pid, 50);
    const stats = await window.progressLedger.sessions.stats(pid);
    return { count: list.length, total: stats.totalMinutes, first: list[0] };
  });

  expect(reloaded.count).toBe(2);
  expect(reloaded.total).toBe(75);
  expect(reloaded.first.subjectName).toBe("Algorithms");
  await app.close();
});
