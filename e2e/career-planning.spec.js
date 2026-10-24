import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * Career Planning lifecycle + profile isolation, through the real IPC surface:
 * create goal, add/reorder/complete/reopen milestones, next-milestone logic,
 * restart persistence, and zero cross-profile leakage.
 */
test("career goal + roadmap lifecycle persists and isolates by profile", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-career-"));
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
    const a = await window.progressLedger.profiles.add("Ada", `ada-${Date.now()}`);
    const b = await window.progressLedger.profiles.add("Bea", `bea-${Date.now()}`);
    // Profile A goal + 3 milestones.
    const gA = await window.progressLedger.career.addGoal({ profileId: a.id, title: "Backend Engineer", targetRole: "Backend Engineer", isPrimary: true });
    const m1 = await window.progressLedger.career.addMilestone({ profileId: a.id, goalId: gA, title: "Learn SQL" });
    const m2 = await window.progressLedger.career.addMilestone({ profileId: a.id, goalId: gA, title: "Build API" });
    const m3 = await window.progressLedger.career.addMilestone({ profileId: a.id, goalId: gA, title: "Internship" });
    // Profile B goal (isolation).
    const gB = await window.progressLedger.career.addGoal({ profileId: b.id, title: "Researcher", isPrimary: true });
    await window.progressLedger.career.addMilestone({ profileId: b.id, goalId: gB, title: "Read papers" });
    return { aId: a.id, bId: b.id, gA, gB, m1, m2, m3 };
  });

  // Reorder A's milestones to reverse; complete the (new) first; check next.
  const afterOps = await win.evaluate(async ({ aId, gA, m1, m2, m3 }) => {
    await window.progressLedger.career.reorderMilestones(aId, gA, [m3, m2, m1]);
    await window.progressLedger.career.setMilestoneCompletion(aId, m3, true); // complete the first-in-order
    const list = await window.progressLedger.career.milestones(aId, gA);
    const firstIncomplete = list.find((m) => !m.completedAt);
    return { order: list.map((m) => m.id), firstIncompleteId: firstIncomplete?.id, firstCompleted: !!list[0].completedAt };
  }, setup);
  expect(afterOps.order).toEqual([setup.m3, setup.m2, setup.m1]); // reorder persisted
  expect(afterOps.firstCompleted).toBe(true);
  expect(afterOps.firstIncompleteId).toBe(setup.m2); // next actionable is m2

  // Reopen m3.
  await win.evaluate(({ aId, m3 }) => window.progressLedger.career.setMilestoneCompletion(aId, m3, false), setup);

  // Profile isolation: A sees only its goal, B only its own.
  const isolation = await win.evaluate(async ({ aId, bId }) => {
    const aGoals = await window.progressLedger.career.goals(aId);
    const bGoals = await window.progressLedger.career.goals(bId);
    return { aTitles: aGoals.map((g) => g.title), bTitles: bGoals.map((g) => g.title) };
  }, setup);
  expect(isolation.aTitles).toEqual(["Backend Engineer"]);
  expect(isolation.bTitles).toEqual(["Researcher"]);

  // Adversarial read: profile B cannot enumerate profile A's roadmap by goal id.
  await expect(win.evaluate(({ bId, gA }) => window.progressLedger.career.milestones(bId, gA), setup))
    .rejects.toThrow(/not.?owned|profile/i);

  // Multiple goals + primary switching for profile A (single-primary invariant).
  const multi = await win.evaluate(async ({ aId, gA }) => {
    const g2 = await window.progressLedger.career.addGoal({ profileId: aId, title: "Data Engineer", isPrimary: false });
    await window.progressLedger.career.setPrimaryGoal(aId, g2);
    const goals = await window.progressLedger.career.goals(aId);
    const primaries = goals.filter((g) => g.isPrimary);
    return {
      count: goals.length,
      primaryCount: primaries.length,
      primaryTitle: primaries[0]?.title,
      gAStillPrimary: goals.find((g) => g.id === gA)?.isPrimary,
    };
  }, setup);
  expect(multi.count).toBe(2);
  expect(multi.primaryCount).toBe(1); // single-primary invariant preserved
  expect(multi.primaryTitle).toBe("Data Engineer");
  expect(multi.gAStillPrimary).toBe(false); // previous primary demoted

  await app.close();

  // Restart: career data persists.
  app = await launch();
  win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();

  const reloaded = await win.evaluate(async () => {
    const profiles = await window.progressLedger.profiles.list();
    const ada = profiles.find((p) => p.name === "Ada");
    const goals = await window.progressLedger.career.goals(ada.id);
    // After the primary switch, "Data Engineer" is primary; find the roadmap goal by title.
    const backend = goals.find((g) => g.title === "Backend Engineer");
    const primary = goals.find((g) => g.isPrimary);
    const ms = await window.progressLedger.career.milestones(ada.id, backend.id);
    return {
      goalCount: goals.length,
      primaryTitle: primary?.title,
      milestoneCount: ms.length,
      order: ms.map((m) => m.title),
      allActive: ms.every((m) => !m.completedAt),
    };
  });
  expect(reloaded.goalCount).toBe(2);            // both goals persisted
  expect(reloaded.primaryTitle).toBe("Data Engineer"); // primary switch persisted
  expect(reloaded.milestoneCount).toBe(3);
  expect(reloaded.order).toEqual(["Internship", "Build API", "Learn SQL"]); // reversed order survived
  expect(reloaded.allActive).toBe(true); // m3 reopen survived

  await app.close();
});
