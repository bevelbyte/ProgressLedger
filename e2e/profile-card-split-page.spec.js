// Focus-hypothesis repro for the Runs -> Profiles "second card does nothing"
// report.
//
// The card click's only visible outcome for the already-active profile is
// App.svelte's 500 ms landing, which is gated on
// ws.currentView() === "profiles" — the FOCUSED pane's active tab. In a
// single-pane window the focused pane is the Profiles pane, so the landing
// fires (proven by profile-card-select.spec.js, which passes). If the user
// has a SPLIT layout where Profiles is visible in one pane while another
// pane holds focus, the guard fails and the click is a visible no-op.
//
// This spec constructs exactly that shape: split the Profiles pane, focus
// the original pane, open Home there, then click the ACTIVE card in the
// unfocused Profiles pane. Desired behaviour (asserted): the click still
// lands out of the chooser. Pre-fix this is expected to FAIL with the
// heading still visible, which pins the focus guard as the root cause.
//
// Fresh throwaway user-data dir: no real user data is touched.
import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

async function launch(userDataDir) {
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1", PROGRESSLEDGER_V2_E2E_USER_DATA: userDataDir },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
  await reloadShell(win);
  return { app, win };
}

async function reloadShell(win) {
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible({ timeout: 60_000 });
}

async function addWorkspaceProfile(win, name) {
  const id = await win.evaluate(async (profileName) => {
    const slug = profileName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const created = await window.progressLedger.profiles.add(profileName, slug);
    const p = created?.profile || created;
    return p?.id ?? p?.profileId ?? (typeof created === "number" ? created : null);
  }, name);
  expect(id, "profile creation returned no id").not.toBe(null);
  return Number(id);
}

async function gotoProfiles(win) {
  await win.getByRole("button", { name: "Profiles", exact: true }).first().click();
  await expect(win.getByRole("heading", { name: "Student Profiles" })).toBeVisible({ timeout: 30_000 });
}

async function headingVisible(win) {
  return win
    .getByRole("heading", { name: "Student Profiles" })
    .isVisible()
    .catch(() => false);
}

async function tabDiagnostics(win) {
  return win.evaluate(() => {
    const tabs = [...document.querySelectorAll('button.tab')].map((t) => ({
      view: t.getAttribute("data-view"),
      label: t.querySelector(".tab-label")?.textContent?.trim() ?? null,
      selected: t.getAttribute("aria-selected"),
    }));
    const splitButtons = document.querySelectorAll('button[aria-label="Split pane vertically"]').length;
    const cardButtons = document.querySelectorAll("button.profile-main").length;
    return { tabs, splitButtons, cardButtons };
  });
}

test.describe("Runs -> Profiles card selection under split focus (page pane)", () => {
  test.setTimeout(300_000);

  test("clicking the active card in an unfocused Profiles pane still lands", async () => {
    const { app, win } = await launch(mkdtempSync(join(tmpdir(), "cf-split-")));
    try {
      const alphaId = await addWorkspaceProfile(win, "Card Alpha");
      const betaId = await addWorkspaceProfile(win, "Card Beta");
      expect(alphaId).not.toBe(betaId);
      await reloadShell(win);

      // Activate Beta through the real UI path, then reload so Beta is the
      // restored active profile with a saved snapshot on Profiles.
      await gotoProfiles(win);
      await expect(win.locator("button.profile-main")).toHaveCount(2, { timeout: 30_000 });
      await win.getByRole("button", { name: "Select Card Beta" }).click();
      await win.waitForTimeout(1200);
      await reloadShell(win);
      await gotoProfiles(win);
      await expect(win.locator("button.profile-main")).toHaveCount(2, { timeout: 30_000 });
      await win.waitForTimeout(600);

      // --- Build the split shape. ---
      // Split the Profiles pane vertically: the new pane seeds with the
      // current view (Profiles), so both panes now show Profiles.
      await win.getByRole("button", { name: "Split pane vertically" }).first().click();
      await expect(win.getByRole("button", { name: "Split pane vertically" })).toHaveCount(2, {
        timeout: 30_000,
      });
      // Open a web page tab in the second pane via its own "+" menu
      // (openPageTab targets that pane, so no context switch can collapse
      // the split the way a rail navigation did). The new page tab becomes
      // that pane's active tab; clicking it focuses the page pane, leaving
      // the first pane showing Profiles while focus sits on the page.
      await win.getByRole("button", { name: "New tab" }).nth(1).click();
      await win.getByText("New web page").click();
      await expect(win.locator('button.tab[data-view="page"]')).toHaveCount(1, { timeout: 30_000 });
      await win.locator('button.tab[data-view="page"]').click();
      await win.waitForTimeout(1000);
      const diag = await tabDiagnostics(win);
      // eslint-disable-next-line no-console
      console.log(`split layout diagnostics: ${JSON.stringify(diag)}`);
      // Exactly one Profiles pane must remain, with Beta's card clickable.
      expect(diag.cardButtons, "one Profiles pane with two cards must remain").toBe(2);
      expect(
        diag.tabs.some((t) => t.view === "profiles"),
        "a Profiles tab must still be open",
      ).toBe(true);

      // --- THE HYPOTHESIS TEST: click the active card in the Profiles pane. ---
      await win.getByRole("button", { name: "Select Card Beta" }).click();
      const samples = [];
      for (let i = 0; i < 13; i++) {
        samples.push(await headingVisible(win));
        await win.waitForTimeout(200);
      }
      // eslint-disable-next-line no-console
      console.log(`heading visible samples after active-card click (split): ${samples.join(",")}`);
      expect(
        await headingVisible(win),
        "clicking the active card must land out of the Profiles view even when its pane is not focused",
      ).toBe(false);
    } finally {
      await app.close();
    }
  });
});
