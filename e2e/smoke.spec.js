import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

test("creates a profile, configures a degree, adds a subject, and verifies sync to Subjects Hub", async () => {
  const app = await electron.launch({
    args: [projectRoot],
    env: { ...process.env, CAREERFLOW_E2E: "1" }, // load static ui/dist, skip vite
  });

  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");

  // Bypass onboarding for E2E testing to prevent overlay intercepting clicks
  await win.evaluate(() => localStorage.setItem('careerflow_onboarding_complete', 'true'));
  await win.reload();
  await win.waitForLoadState("domcontentloaded");

  // Rust core should be online.
  await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();

  // --- Create a profile ---
  const name = `E2E Student ${Date.now()}`;
  await win.getByPlaceholder(/New profile name/i).fill(name);
  await win.getByRole("button", { name: "Add", exact: true }).click();

  const card = win.locator(".profile-card", { hasText: name });
  await expect(card).toBeVisible();
  // New profiles auto-select.
  await expect(card.locator(".badge")).toHaveText("Active");

  // Wait for automatic view transition to Subjects (currentView = 'tree' triggered by profile selection after 500ms)
  await win.waitForTimeout(1000);

  // --- Navigate to Degree Planner to add a degree ---
  // Scope to the NavRail item and match the label exactly. A bare
  // `button:has-text("Degree")` also matches the Desk's "Open Degree planner"
  // call-to-action, so it became a strict-mode violation once Atlas gave the
  // dashboard its own Degree entry point.
  const degreeNav = win.locator("button.nav-item").filter({ hasText: /^\s*Degree\s*$/ });
  await expect(degreeNav).toBeVisible();
  await degreeNav.click();

  // --- Add a degree in the CGPA/Degree Planner ---
  await win.getByRole("button", { name: /Add Degree/i }).click();
  await win.getByPlaceholder(/e.g. B.Tech/i).fill("Computer Science BSc");
  await win.getByRole("button", { name: "Create", exact: true }).click();

  // --- Add a subject to Semester 1 ---
  await win.getByRole("button", { name: "Add Subject" }).click();
  await win.getByPlaceholder(/e.g. Engineering Mathematics I/i).fill("Computer Networks");
  await win.getByRole("button", { name: "Save", exact: true }).click();

  // --- Navigate back to Subjects view and verify the degree track was synced ---
  // Same exact-label discipline as the Degree nav item above: "Subjects" must
  // resolve to the NavRail entry, not to any "Subjects Hub" text node.
  const subjectsNav = win.locator("button.nav-item").filter({ hasText: /^\s*Subjects\s*$/ });
  await expect(subjectsNav).toBeVisible();
  await subjectsNav.click();
  
  // The Subjects view should now render a tab/heading for "Computer Science BSc" and the subject card/row
  await expect(win.getByText("Computer Science BSc (Current)")).toBeVisible();
  await expect(win.getByText("Computer Networks")).toBeVisible();

  await app.close();
});