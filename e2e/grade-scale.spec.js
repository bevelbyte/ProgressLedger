import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * Grade-scale configuration lifecycle:
 *  - default scale is available,
 *  - a custom scale saves to SQLite and survives an app restart,
 *  - changing the scale changes a subsequent CGPA calculation,
 *  - existing courses are untouched,
 *  - an invalid scale is rejected by the Rust layer.
 * Driven through the real IPC surface (window.careerflow.courses.*) so it
 * exercises the same path the Settings UI uses.
 */
test("grade scale persists, drives CGPA, and rejects invalid input", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-scale-"));
  const launch = () =>
    electron.launch({
      args: [projectRoot, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, CAREERFLOW_E2E: "1" },
    });

  // ---- Run 1: profile + one 60% course, then install a custom scale ----
  let app = await launch();
  let win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();

  const setup = await win.evaluate(async () => {
    const p = await window.careerflow.profiles.add("Scale Student", `scale-${Date.now()}`);
    const pid = p.id;
    await window.careerflow.courses.add({
      profileId: pid,
      semesterLabel: "Semester 1",
      courseName: "Physics",
      credits: 4,
      grade: null,
      gradePoints: null,
      marksObtained: 60,
      maxMarks: 100,
      isHypothetical: false,
    });
    const defaultScale = await window.careerflow.courses.getDefaultGradeScale();
    const cgpaDefault = await window.careerflow.courses.cgpa(pid);
    return { pid, defaultLen: defaultScale.length, cgpaDefault: cgpaDefault.cgpa };
  });

  // Default 10-point scale: 60% -> band 60 -> grade point 7.
  expect(setup.defaultLen).toBeGreaterThan(0);
  expect(setup.cgpaDefault).toBeCloseTo(7.0, 5);

  // Invalid scale (duplicate threshold, no 0 floor) must be rejected by Rust.
  const invalid = await win.evaluate(async (pid) => {
    try {
      await window.careerflow.courses.setGradeScale(pid, [
        { minPercent: 50, gradePoint: 6, label: "B" },
        { minPercent: 50, gradePoint: 5, label: "C" },
      ]);
      return "accepted";
    } catch (e) {
      return "rejected";
    }
  }, setup.pid);
  expect(invalid).toBe("rejected");

  // Install a custom valid scale where 60% now earns 8 instead of 7.
  await win.evaluate(async (pid) => {
    await window.careerflow.courses.setGradeScale(pid, [
      { minPercent: 60, gradePoint: 8, label: "High" },
      { minPercent: 0, gradePoint: 4, label: "Base" },
    ]);
  }, setup.pid);

  const afterCustom = await win.evaluate((pid) => window.careerflow.courses.cgpa(pid), setup.pid);
  expect(afterCustom.cgpa).toBeCloseTo(8.0, 5);
  await app.close();

  // ---- Run 2: same workspace — custom scale + course survived restart ----
  app = await launch();
  win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();

  const reloaded = await win.evaluate(async () => {
    const profiles = await window.careerflow.profiles.list();
    const pid = profiles[profiles.length - 1].id;
    const scale = await window.careerflow.courses.getGradeScale(pid);
    const courses = await window.careerflow.courses.list(pid, null);
    const cgpa = await window.careerflow.courses.cgpa(pid);
    return { scale, courses, cgpa: cgpa.cgpa };
  });

  // Custom scale persisted (2 bands, not the default 7).
  expect(reloaded.scale.length).toBe(2);
  expect(reloaded.cgpa).toBeCloseTo(8.0, 5);
  // Existing course untouched by the scale change.
  const physics = reloaded.courses.find((c) => c.courseName === "Physics");
  expect(physics).toBeTruthy();
  expect(physics.marksObtained).toBe(60);
  expect(physics.credits).toBe(4);

  await app.close();
});
