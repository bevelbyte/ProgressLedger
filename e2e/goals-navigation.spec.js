// Goal Mode real-UI navigation E2E (Phase 16).
//
// Validates that Goal Mode is reachable through the REAL CareerFlow
// navigation and that the GoalsView UI (project picker -> list +
// create form) works end to end in the built renderer:
//
//   create profile + project via IPC (seed) -> reload window
//   -> click "Goals" nav item -> pick the project
//   -> create a goal through the UI form -> goal appears in list

import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

async function launch() {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-goals-ui-"));
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, CAREERFLOW_E2E: "1" },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  return { app, win };
}

test("Goal Mode is reachable from the real navigation and the UI can create a goal", async () => {
  const { app, win } = await launch();
  test.setTimeout(120_000);
  try {
    // 1. Seed a profile + project through the real IPC.
    const profile = await win.evaluate(() => window.careerflow.profiles.add("Goals Nav E2E", `goals-nav-${Date.now()}`));
    expect(profile.id).toBeGreaterThan(0);
    const projectRootPath = process.cwd();
    const created = await win.evaluate(([pid, rootPath]) =>
      window.careerflow.projectMode.createProject({ profileId: pid, name: "Nav E2E Project", description: "nav", rootPath, configJson: "{}" }), [profile.id, projectRootPath]);
    const projectId = typeof created === "number" ? created : created && created.id;
    expect(projectId).toBeGreaterThan(0);

    // 2. Reload so the renderer picks up the seeded profile/project.
    await win.reload();
    await win.waitForLoadState("domcontentloaded");
    await new Promise((r) => setTimeout(r, 800));

    // Select the profile in the UI (App.svelte starts at 'profiles').
    // The profile card's select button is identified by aria-label.
    await win.evaluate((name) => {
      const btn = document.querySelector(`button[aria-label="Select ${name}"]`);
      if (btn) btn.click();
    }, "Goals Nav E2E");
    await new Promise((r) => setTimeout(r, 800));

    // 3. Click the "Goals" nav item.
    const clicked = await win.evaluate(() => {
      const btns = [...document.querySelectorAll("button")];
      const goalsBtn = btns.find((b) => b.textContent && b.textContent.trim() === "Goals");
      if (!goalsBtn) return false;
      goalsBtn.click();
      return true;
    });
    expect(clicked, "Goals nav item must exist").toBe(true);
    await new Promise((r) => setTimeout(r, 800));

    // 4. The Goals view shows the project picker (no project picked yet).
    const pickerVisible = await win.evaluate(() =>
      !!document.querySelector('[data-testid="goals-project-picker"]'));
    expect(pickerVisible, "project picker should render on first visit").toBe(true);

    // 5. Pick the project.
    const picked = await win.evaluate(() => {
      const row = document.querySelector('[data-testid="goals-pick-project"]');
      if (!row) return false;
      row.click();
      return true;
    });
    expect(picked, "project row must be clickable").toBe(true);
    await new Promise((r) => setTimeout(r, 800));

    // 6. The GoalsPanel renders, and the composer opens on demand.
    // The composer is a dialog: the surface leads with the goal list rather
    // than with a permanently open form, so creating is now one click first.
    const panelVisible = await win.evaluate(() =>
      !!document.querySelector('[data-testid="goals-panel"]'));
    expect(panelVisible, "GoalsPanel should render").toBe(true);

    const composerOpened = await win.evaluate(() => {
      const btn = document.querySelector('[data-testid="goal-new-button"]');
      if (!btn) return false;
      btn.click();
      return true;
    });
    expect(composerOpened, "New goal button must exist").toBe(true);
    await new Promise((r) => setTimeout(r, 300));

    const formVisible = await win.evaluate(() =>
      !!document.querySelector('[data-testid="goal-create-form"]'));
    expect(formVisible, "create form should open in a dialog").toBe(true);

    // 7. Create a goal through the UI form.
    await win.evaluate(() => {
      const title = document.querySelector('[data-testid="goal-title-input"]');
      const objective = document.querySelector('[data-testid="goal-objective-input"]');
      title.value = "UI-created goal";
      title.dispatchEvent(new Event("input", { bubbles: true }));
      objective.value = "Created through the real Goals UI form.";
      objective.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 100));
    await win.evaluate(() => {
      const form = document.querySelector('[data-testid="goal-create-form"]');
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await new Promise((r) => setTimeout(r, 800));

    // 8. The goal appears in the active list.
    const visibleInList = await win.evaluate(() =>
      document.body.textContent.includes("UI-created goal"));
    expect(visibleInList, "UI-created goal must appear in the list").toBe(true);
  } finally {
    await app.close();
  }
});
