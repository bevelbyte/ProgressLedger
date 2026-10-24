import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * Career -> Subject linking, end to end through the REAL stack: the link /
 * unlink / relink steps are driven through the actual CareerPlan UI (Degree ->
 * Career tab), which calls the service -> preload -> IPC -> Rust write path
 * added for schema v13. Nothing is mocked.
 *
 * Covers: link appears, deep-links into the subject workspace, unlink/relink,
 * restart persistence, cross-profile rejection (IPC-level: the UI can never
 * offer another profile's subject), missing-reference honesty after the
 * subject is deleted, and that the project link is untouched throughout.
 */
test("career milestone links a subject through the UI, persists, rejects cross-profile, survives deletion", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-career-subject-"));
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

  // Seed Profile A (subject + goal + milestone + project link) over real IPC.
  const seed = await win.evaluate(async () => {
    const p = await window.careerflow.profiles.add("Link Ada", `link-ada-${Date.now()}`);
    const trackId = await window.careerflow.academic.addTrack(p.id, "B.Tech");
    const semId = await window.careerflow.academic.addSemester(p.id, trackId, "Semester 1");
    const msId = await window.careerflow.academic.addMilestone(p.id, semId, "Subjects");
    const subjectId = await window.careerflow.academic.addSubject(p.id, msId, "Algorithms", null);
    const goalId = await window.careerflow.career.addGoal({ profileId: p.id, title: "Backend Engineer", isPrimary: true });
    const milestoneId = await window.careerflow.career.addMilestone({ profileId: p.id, goalId, title: "Learn SQL" });
    const projectId = await window.careerflow.projects.add(p.id, "API Project", "mini", null, "");
    await window.careerflow.career.setMilestoneProject(p.id, milestoneId, projectId);
    return { pid: p.id, subjectId, goalId, milestoneId, projectId };
  });

  // Activate the profile through the UI, open Degree -> Career.
  const openCareerTab = async () => {
    await win.reload();
    await win.waitForLoadState("domcontentloaded");
    await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();
    const card = win.locator(".profile-card", { hasText: "Link Ada" });
    await expect(card).toBeVisible();
    await card.click();
    await win.waitForTimeout(700);
    await win.locator(".nav-item", { hasText: "Degree" }).click();
    await win.locator(".section-tab-btn", { hasText: "Career" }).click();
    await expect(win.locator(".milestone", { hasText: "Learn SQL" })).toBeVisible();
  };
  await openCareerTab();

  // Lazy so it rebinds after an app restart creates a new window.
  const row = () => win.locator(".milestone", { hasText: "Learn SQL" });

  // 1+2. Link milestone -> Algorithms through the picker UI.
  await expect(row().getByText("API Project")).toBeVisible(); // project link already present
  await row().getByRole("button", { name: /Link Subject/ }).click();
  await row().locator("select").selectOption({ label: "B.Tech › Semester 1 › Algorithms" });
  await row().locator(".link-picker").getByRole("button", { name: "Save" }).click();
  await win.waitForTimeout(500); // toast + reload
  await expect(row().getByRole("button", { name: "Algorithms" })).toBeVisible();
  // The row now has two Remove-link buttons (project + subject); scope to the
  // subject one.
  const subjectUnlink = () => row().locator(".m-link-subject").getByTitle("Remove link");
  await expect(subjectUnlink()).toBeVisible();

  // 3. Open the linked subject -> deep-links into the subject workspace.
  await row().getByRole("button", { name: "Algorithms" }).click();
  await expect(win.getByRole("heading", { level: 2, name: /Algorithms/ })).toBeVisible();

  // Back to the roadmap; still linked.
  await win.locator(".nav-item", { hasText: "Degree" }).click();
  await win.locator(".section-tab-btn", { hasText: "Career" }).click();
  await expect(row().getByRole("button", { name: "Algorithms" })).toBeVisible();

  // 4+5. Unlink -> honest unlinked state.
  await subjectUnlink().click();
  await win.waitForTimeout(500);
  await expect(row().getByRole("button", { name: /Link Subject/ })).toBeVisible();

  // 6. Relink.
  await row().getByRole("button", { name: /Link Subject/ }).click();
  await row().locator("select").selectOption({ label: "B.Tech › Semester 1 › Algorithms" });
  await row().locator(".link-picker").getByRole("button", { name: "Save" }).click();
  await win.waitForTimeout(500);
  await expect(row().getByRole("button", { name: "Algorithms" })).toBeVisible();

  await app.close();

  // 7+8. Restart -> the link persisted.
  app = await launch();
  win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();
  await openCareerTab();
  await expect(row().getByRole("button", { name: "Algorithms" })).toBeVisible();
  await expect(row().getByText("API Project")).toBeVisible(); // project link survived too

  // 9+10+11. Cross-profile link attempt is rejected by Rust, not the UI
  // (the UI can never offer another profile's subject).
  const crossProfile = await win.evaluate(async ({ pid, milestoneId }) => {
    const b = await window.careerflow.profiles.add("Link Bea", `link-bea-${Date.now()}`);
    const trackId = await window.careerflow.academic.addTrack(b.id, "B.Tech");
    const semId = await window.careerflow.academic.addSemester(b.id, trackId, "Semester 1");
    const msId = await window.careerflow.academic.addMilestone(b.id, semId, "Subjects");
    const bSubjectId = await window.careerflow.academic.addSubject(b.id, msId, "Zoology", null);
    try {
      await window.careerflow.career.setMilestoneSubject(pid, milestoneId, bSubjectId);
      return { rejected: false, message: "" };
    } catch (e) {
      return { rejected: true, message: String(e?.message ?? e) };
    }
  }, seed);
  expect(crossProfile.rejected).toBe(true);
  expect(crossProfile.message).toMatch(/different profile/i);

  const afterCross = await win.evaluate(async ({ pid, goalId, milestoneId, subjectId }) => {
    const ms = await window.careerflow.career.milestones(pid, goalId);
    const m = ms.find((x) => x.id === milestoneId);
    return { linkedSubjectId: m.linkedSubjectId, linkedSubjectName: m.linkedSubjectName, expected: subjectId };
  }, seed);
  expect(afterCross.linkedSubjectId).toBe(afterCross.expected); // unchanged by rejected attempt

  // 12+13. Delete the linked subject -> honest missing-reference state.
  await win.evaluate(async ({ pid, subjectId }) => {
    await window.careerflow.academic.deleteSubject(pid, subjectId);
  }, seed);
  // CareerPlan reloads on mount, so navigate away and back.
  await win.locator(".nav-item", { hasText: "Home" }).click();
  await win.locator(".nav-item", { hasText: "Degree" }).click();
  await win.locator(".section-tab-btn", { hasText: "Career" }).click();
  await expect(row().getByText("Linked subject no longer exists")).toBeVisible();
  await expect(row().getByText("API Project")).toBeVisible(); // project link unaffected

  // Unlinking a dangling reference still works (clear path needs no subject).
  await row().locator(".m-link-subject").getByTitle("Remove link").click();
  await win.waitForTimeout(500);
  await expect(row().getByRole("button", { name: /Link Subject/ })).toBeVisible();

  await app.close();
});
