import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * Deadline completion lifecycle: an overdue deadline contributes to Today
 * attention; marking it complete removes it from active attention (Today,
 * Subject overview) WITHOUT deleting it (it remains as history); reopening
 * makes it active/overdue again; and completion persists across a restart.
 * A completed past-dated deadline must NOT read as overdue. Real IPC surface.
 */
test("deadline completion excludes from attention, preserves history, persists", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-dlcomplete-"));
  const launch = () =>
    electron.launch({
      args: [projectRoot, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, CAREERFLOW_E2E: "1" },
    });

  let app = await launch();
  let win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();

  const ids = await win.evaluate(async () => {
    const p = await window.careerflow.profiles.add("DL Complete", `dlc-${Date.now()}`);
    const pid = p.id;
    const trackId = await window.careerflow.academic.addTrack(pid, "B.Tech");
    const semId = await window.careerflow.academic.addSemester(pid, trackId, "Semester 1");
    const msId = await window.careerflow.academic.addMilestone(pid, semId, "Subjects");
    const subjectId = await window.careerflow.academic.addSubject(pid, msId, "Algorithms", null);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const dlId = await window.careerflow.deadlines.add(pid, subjectId, yesterday, "assignment", "Lab Report", "");
    return { pid, semId, subjectId, dlId };
  });

  // Active + overdue: shows in subject overview count and semester overdue.
  const before = await win.evaluate(async ({ pid, subjectId, semId }) => {
    const s = await window.careerflow.resources.overview({ profileId: pid, subjectId });
    const sem = await window.careerflow.resources.semesterOverview({ profileId: pid, semesterId: semId });
    return { subjUpcoming: s.upcomingDeadlineCount, semOverdue: sem.deadlines.overdue };
  }, ids);
  // Overdue (yesterday) → not "upcoming" for the subject, but counts as semester overdue.
  expect(before.semOverdue).toBe(1);

  // Mark complete.
  await win.evaluate(({ pid, dlId }) => window.careerflow.deadlines.setCompletion(pid, dlId, true), ids);

  const afterComplete = await win.evaluate(async ({ pid, semId, dlId }) => {
    const list = await window.careerflow.deadlines.list(pid);
    const sem = await window.careerflow.resources.semesterOverview({ profileId: pid, semesterId: semId });
    const row = list.find((d) => d.id === dlId);
    return { stillExists: !!row, completedAt: row?.completedAt ?? null, semOverdue: sem.deadlines.overdue };
  }, ids);
  expect(afterComplete.stillExists).toBe(true);          // history preserved
  expect(afterComplete.completedAt).toBeTruthy();          // timestamp set
  expect(afterComplete.semOverdue).toBe(0);                // no longer overdue despite past date

  // Reopen → overdue again.
  await win.evaluate(({ pid, dlId }) => window.careerflow.deadlines.setCompletion(pid, dlId, false), ids);
  const afterReopen = await win.evaluate(async ({ pid, semId }) => {
    const sem = await window.careerflow.resources.semesterOverview({ profileId: pid, semesterId: semId });
    return sem.deadlines.overdue;
  }, ids);
  expect(afterReopen).toBe(1);

  // Complete again, then restart and confirm persistence.
  await win.evaluate(({ pid, dlId }) => window.careerflow.deadlines.setCompletion(pid, dlId, true), ids);
  await app.close();

  app = await launch();
  win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();

  const afterRestart = await win.evaluate(async () => {
    const profiles = await window.careerflow.profiles.list();
    const pid = profiles[profiles.length - 1].id;
    const tree = await window.careerflow.academic.tree(pid);
    const semId = tree[0].semesters[0].id;
    const list = await window.careerflow.deadlines.list(pid);
    const sem = await window.careerflow.resources.semesterOverview({ profileId: pid, semesterId: semId });
    return { completedAt: list[0]?.completedAt ?? null, semOverdue: sem.deadlines.overdue };
  });
  expect(afterRestart.completedAt).toBeTruthy();  // completion survived restart
  expect(afterRestart.semOverdue).toBe(0);

  await app.close();
});
