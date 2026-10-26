// Runs -> Profiles card selection — regression spec for the reported bug:
//
// In the packaged app, clicking the SECOND profile card (the already-active
// profile) does nothing visible. Clicking a card must land the user out of
// the chooser: the app's own selectProfile (App.svelte) restores the
// profile's workspace and, if the user is still on the profiles view after
// 500 ms, navigates to the tree view. For the already-active profile the
// workspace restore is a no-op (the saved snapshot already shows Profiles),
// so the 500 ms landing navigation is the ONLY visible outcome — and in
// the reported bug it never happens.
//
// This spec reproduces that exact shape: two workspace profiles, the
// second one active, a saved workspace snapshot whose current tab IS the
// Profiles view (the user's real-data shape), then a click on the active
// card. It also covers the inactive-card control (badge must move) and
// re-selecting the second card once it is inactive again.
//
// PACKAGED variant: launches release/win-unpacked/Progress Ledger v2.exe
// (the exact build the user runs) with a fresh throwaway user-data dir
// via PROGRESSLEDGER_V2_E2E_USER_DATA, so no real user data is touched
// and no profile is deleted. Guard: the run aborts before creating
// anything unless the fresh dir starts with zero profiles.
import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const packagedExe = resolve(projectRoot, "release", "win-unpacked", "Progress Ledger v2.exe");

async function launch(userDataDir) {
  const app = await electron.launch({
    executablePath: packagedExe,
    args: [`--user-data-dir=${userDataDir}`],
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
  await expect(win.locator("button.profile-main")).toHaveCount(2, { timeout: 30_000 });
}

async function badgeOwner(win) {
  return win.evaluate(() => {
    const cards = [...document.querySelectorAll("article.profile-card")];
    const active = cards.find((c) => c.querySelector(".badge"));
    return active ? active.querySelector(".name")?.textContent?.trim() ?? null : null;
  });
}

async function headingVisible(win) {
  return win
    .getByRole("heading", { name: "Student Profiles" })
    .isVisible()
    .catch(() => false);
}

async function snapshotFocusedView(win, profileId) {
  return win.evaluate((pid) => {
    try {
      const raw = localStorage.getItem(`cf.workspace.state.v1.profile_${pid}`);
      if (!raw) return "no-snapshot";
      const s = JSON.parse(raw);
      const ctx = s.contexts.find((c) => c.id === s.activeContextId);
      if (!ctx) return "no-active-context";
      const pane = ctx.panes[ctx.focusedPaneId];
      if (!pane) return "no-focused-pane";
      const tab = pane.tabs.find((t) => t.id === pane.activeTabId);
      return tab ? tab.view : "no-active-tab";
    } catch (e) {
      return `error:${e.message}`;
    }
  }, profileId);
}

async function lastActiveId(win) {
  return win.evaluate(() => localStorage.getItem("progressledger_v2_last_active_profile_id"));
}

test.describe("Runs -> Profiles card selection (packaged)", () => {
  test.setTimeout(300_000);

  test("clicking the already-active second card leaves the Profiles view", async () => {
    const { app, win } = await launch(mkdtempSync(join(tmpdir(), "cf-card-pkg-")));
    try {
      // Guard: abort before creating anything if this is not a fresh dir
      // (i.e. if the launch somehow attached to real user data).
      const initial = await win.evaluate(() => window.progressLedger.profiles.list());
      expect(Array.isArray(initial) && initial.length, "fresh dir must start with zero profiles").toBe(0);
      const alphaId = await addWorkspaceProfile(win, "Card Alpha");
      const betaId = await addWorkspaceProfile(win, "Card Beta");
      expect(alphaId).not.toBe(betaId);

      // NOTE: the bridge add() above creates DB rows only — it does NOT
      // touch the app's profile store. Only an App mount (loadProfiles)
      // populates the store, so reload first, then activate Beta through
      // the real UI path (card click), exactly as a user would, then
      // reload again so the store restores Beta from the persisted
      // last-active id. After this, Beta is the active second card,
      // matching the user's reported setup.
      await reloadShell(win);
      await gotoProfiles(win);
      await win.getByRole("button", { name: "Select Card Beta" }).click();
      await win.waitForTimeout(1200);
      await reloadShell(win);

      // Active profile after the setup click + reload is Beta (second card).
      await gotoProfiles(win);
      expect(await badgeOwner(win)).toBe("Card Beta");

      // Let the workspace snapshot persist WITH the Profiles tab current,
      // matching the user's real-data shape (long idle on Profiles).
      await win.waitForTimeout(600);
      const snapView = await snapshotFocusedView(win, betaId);
      // Record, do not assert: the click behaviour below is the assertion.
      // eslint-disable-next-line no-console
      console.log(`saved snapshot focused view for Beta: ${snapView}`);
      expect(await lastActiveId(win)).toBe(String(betaId));

      // --- THE REPORTED BUG: click the active (second) card. ---
      await win.getByRole("button", { name: "Select Card Beta" }).click();
      const samples = [];
      for (let i = 0; i < 13; i++) {
        samples.push(await headingVisible(win));
        await win.waitForTimeout(200);
      }
      // eslint-disable-next-line no-console
      console.log(`heading visible samples after active-card click: ${samples.join(",")}`);
      expect(
        await headingVisible(win),
        "clicking the already-active card must land out of the Profiles view (tree landing)",
      ).toBe(false);
      // Badge lives on the Profiles page: return there to read selection.
      await gotoProfiles(win);
      expect(await badgeOwner(win)).toBe("Card Beta");
      expect(await lastActiveId(win)).toBe(String(betaId));

      // --- Control: clicking the inactive first card must switch selection. ---
      await win.getByRole("button", { name: "Select Card Alpha" }).click();
      await win.waitForTimeout(1200);
      await gotoProfiles(win);
      expect(await badgeOwner(win)).toBe("Card Alpha");
      expect(await lastActiveId(win)).toBe(String(alphaId));

      // --- Control: re-selecting Beta once inactive must switch back. ---
      await win.getByRole("button", { name: "Select Card Beta" }).click();
      await win.waitForTimeout(1200);
      await gotoProfiles(win);
      expect(await badgeOwner(win)).toBe("Card Beta");
      expect(await lastActiveId(win)).toBe(String(betaId));
    } finally {
      await app.close();
    }
  });
});
