import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * CGPA persistence lifecycle: create a degree + graded course in one app run,
 * then relaunch a SECOND app instance against the SAME workspace and assert the
 * course + computed SGPA survive. This is the "SQLite is the source of truth"
 * guarantee — a localStorage-only model would lose data across the fresh
 * renderer profile of the second launch.
 */
test("CGPA courses persist across an application restart", async () => {
  // Isolated workspace both launches share via PROGRESSLEDGER_V2_E2E userData.
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-persist-"));
  const launch = () =>
    electron.launch({
      args: [projectRoot, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1" },
    });

  // ---- First run: create profile, degree, graded course ----
  let app = await launch();
  let win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();

  const name = `Persist Student ${Date.now()}`;
  await win.getByPlaceholder(/New profile name/i).fill(name);
  await win.getByRole("button", { name: "Add", exact: true }).click();
  await expect(win.locator(".profile-card", { hasText: name })).toBeVisible();
  await win.waitForTimeout(1000);

  await win.locator("button.nav-item", { hasText: "Degree" }).click();
  await win.getByRole("button", { name: /Add Degree/i }).click();
  await win.getByPlaceholder(/e.g. B.Tech/i).fill("Persist Degree");
  await win.getByRole("button", { name: "Create", exact: true }).click();

  await win.getByRole("button", { name: "Add Subject" }).click();
  await win.getByPlaceholder(/e.g. Engineering Mathematics I/i).fill("Data Structures");
  // Fill marks + credits so a real SGPA is computed by the Rust engine.
  await win.getByText("Obtained Marks").locator("xpath=following-sibling::input").fill("85");
  await win.getByText("Max Marks").locator("xpath=following-sibling::input").fill("100");
  await win.getByText("Credits").locator("xpath=following-sibling::input").fill("4");
  await win.getByRole("button", { name: "Save", exact: true }).click();
  await win.waitForTimeout(500);

  // Read the persisted CGPA straight from the core to assert the value stored.
  const cgpaAfterCreate = await win.evaluate(async () => {
    const profiles = await window.progressLedger.profiles.list();
    const pid = profiles[profiles.length - 1].id;
    return window.progressLedger.courses.cgpa(pid);
  });
  expect(cgpaAfterCreate.cgpa).toBeGreaterThan(8.9); // 85% -> grade point 9.0
  await app.close();

  // ---- Second run: same workspace, verify data survived ----
  app = await launch();
  win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();

  const reloaded = await win.evaluate(async () => {
    const profiles = await window.progressLedger.profiles.list();
    const pid = profiles[profiles.length - 1].id;
    const courses = await window.progressLedger.courses.list(pid, null);
    const cgpa = await window.progressLedger.courses.cgpa(pid);
    return { courses, cgpa };
  });

  const course = reloaded.courses.find((c) => c.courseName === "Data Structures");
  expect(course).toBeTruthy();
  expect(course.credits).toBe(4);
  expect(course.marksObtained).toBe(85);
  expect(course.maxMarks).toBe(100);
  expect(reloaded.cgpa.cgpa).toBeCloseTo(cgpaAfterCreate.cgpa, 5);

  await app.close();
});
