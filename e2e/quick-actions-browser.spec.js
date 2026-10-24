// Phase 8: Quick Actions × Browser Manager 14-step E2E.
//
// Drives the real Electron app against the CAREERFLOW_E2E_DONUT_STUB seam
// (no real Donut backend, no ports, no processes). The renderer uses
// window.careerflow.browserManager.* to drive the same IPC paths the
// BrowserManagerPanel + QuickActionsPanel click handlers call, so the spec
// exercises the FULL stack: Svelte component -> preload -> ipcMain ->
// browser-manager.js -> core.addBrowserProfile / listPinnedBrowserShortcuts
// / openBrowserProfile -> managerOps -> in-main-process stub recorder.
//
// Steps map 1:1 to the Phase-8 brief.
//
// Stability:
//   * the app is launched with a fresh --user-data-dir per test, so DB
//     state never leaks between cases
//   * CAREERFLOW_E2E_DONUT_STUB=1 means donut transport is a recorder
//   * CAREERFLOW_E2E_DONUT_MODE controls the stub's behaviour:
//       - donut-ok   : runs succeed, donutProfileCreations grow, opens go
//                      through Donut
//       - crash      : start succeeds then subsequent open returns
//                      run-failed; the next launch recovers

import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

async function launchWithMode(mode) {
  const userDataDir = mkdtempSync(join(tmpdir(), `cf-qa-bm-${mode || "prod"}-`));
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      CAREERFLOW_E2E: "1",
      CAREERFLOW_E2E_DONUT_STUB: "1",
      ...(mode ? { CAREERFLOW_E2E_DONUT_MODE: mode } : {}),
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  return { app, win };
}

async function e2eCalls(app) {
  return app.evaluate(() => globalThis.__cfDonutE2E);
}

async function makeCfProfile(win, name) {
  return win.evaluate(async (n) => {
    const created = await window.careerflow.profiles.add(n, `${n}-${Date.now()}`);
    return String(created.id);
  }, name);
}

// Make the named profile the ACTIVE one on the renderer. The IPC
// `profiles.add` does not set the active profile, so we must reload so the
// profile store picks up the IPC-created row, then drive the Profiles view's
// selector card. The active profile is the one the QuickActionsPanel and
// BrowserManagerPanel derive `cfId` from.
async function selectCfProfile(win, name) {
  await win.evaluate(() => localStorage.setItem("careerflow_onboarding_complete", "true"));
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/CareerFlow core online/i)).toBeVisible({ timeout: 15000 });
  await win.locator(".nav-item", { hasText: "Profiles" }).click();
  const card = win.locator(".profile-card", { hasText: name });
  await expect(card).toBeVisible();
  await card.click();
  await win.waitForTimeout(400);
  // The reload resets the right sidebar; reopen it so QA panel steps work.
  const rightToggle = win.locator('button.right-sidebar-toggle');
  if (await rightToggle.isVisible().catch(() => false)) {
    await rightToggle.click();
    await win.locator("aside.right-sidebar.open").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  }
}

async function navigateBrowser(win) {
  // The same dispatcher the QuickActionsPanel uses.
  await win.evaluate(() => {
    window.dispatchEvent(new CustomEvent("cf:navigate", { detail: { view: "browser" } }));
  });
  // Give Svelte a tick to switch views.
  await win.waitForTimeout(50);
}

async function addBrowserProfile(win, cfId, name) {
  return win.evaluate(
    ([cf, n]) =>
      window.careerflow.browserManager.add(Number(cf), `bp-${Date.now()}-${Math.random()}`, n),
    [Number(cfId), name]
  );
}

async function addShortcut(win, cfId, localId, label, url) {
  return win.evaluate(
    ([cf, lid, l, u]) =>
      window.careerflow.browserManager.addShortcut(Number(cf), lid, l, u),
    [Number(cfId), localId, label, url]
  );
}

async function setActiveProfile(win, cfId) {
  // profileStore lives in renderer; set active via the same Svelte store
  // the app uses on its first selection. The renderer keeps the active
  // profile in window-bound state but reads it from the same store the
  // panel does, so re-render-after-cfId-change is automatic.
  await win.evaluate((id) => {
    // The store is module-scoped, not on window. Use the IPC command the
    // rest of the renderer uses to switch: profiles.list + emit a custom
    // 'cf:data-changed' so dependent panels reload.
    const evt = new CustomEvent("cf:set-active-profile", { detail: { id: Number(id) } });
    window.dispatchEvent(evt);
  }, cfId);
  // Fall back to driving the dashboard refresh — the active profile id is
  // resolved on the panel's $effect(cfId) and we re-trigger it.
  await win.evaluate(async (id) => {
    // Re-render BM/QA: re-read the profile list so the panels re-derive.
    await window.careerflow.profiles.list();
  }, cfId);
}

test("Phase 8: Quick Actions × Browser Manager 14-step journey", async () => {
  const { app, win } = await launchWithMode("donut-ok");
  try {
    // ----- step 1: app starts and Dashboard is visible -----
    // Wait for the BootStatus marker that the rest of the suite uses.
    await expect(win.getByText(/CareerFlow core online/i)).toBeVisible({ timeout: 15000 });
    // Home view hosts the Dashboard; the nav button is the canonical entry.
    // The default view on a fresh launch is 'profiles' — click Home to make
    // sure the QA sidebar (QuickActionsPanel) is rendered.
    const homeBtn = win.locator('button.nav-item', { hasText: /Home/ });
    await expect(homeBtn).toBeVisible();
    await homeBtn.click();
    await expect(homeBtn).toHaveClass(/active/);

    // The right sidebar (QuickActionsPanel) is closed by default — open it.
    const rightToggle = win.locator('button.right-sidebar-toggle');
    await rightToggle.click();
    await expect(win.locator("aside.right-sidebar.open")).toBeVisible();

    // ----- step 2: create a CF profile -----
    const cfA = await makeCfProfile(win, "Phase 8 A");
    expect(cfA).toBeTruthy();
    // Activate it so the renderer derives a non-null `cfId`. The helper
    // reloads the window (reopening the right sidebar afterwards).
    await selectCfProfile(win, "Phase 8 A");

    // ----- step 3: navigate to Browser Manager view (via QA "Browser") -----
    // First land in home so QA panel is visible.
    await homeBtn.click();
    await expect(win.locator('[data-testid="qa-open-bm"]')).toBeVisible();
    await win.locator('[data-testid="qa-open-bm"]').click();
    // Atlas consolidated the Browser console into banded sections, so the
    // panel's own heading is "Saved places" and the panel root carries the
    // stable `browser-manager` identity. Assert BOTH the panel root and its
    // heading: that proves the Browser Manager view actually opened, which is
    // what this step is for, without depending on a pre-Atlas label.
    const bmPanel = win.locator("section.browser-manager");
    await expect(bmPanel).toBeVisible();
    await expect(bmPanel.getByRole("heading", { name: "Saved places" })).toBeVisible();

    // ----- step 4: the owned-backend lifecycle panel is GONE (Phase 2 of the
    // Donut ownership migration: CareerFlow no longer starts/stops Donut). -----
    await expect(win.locator("section.donut-lifecycle")).toHaveCount(0);

    // ----- step 5: click "New browser profile" — form appears; type "Study"; submit -----
    const newBpBtn = win.getByRole("button", { name: /New browser profile/ });
    await newBpBtn.click();
    const newNameInput = win.locator("#bm-new-name-input");
    await expect(newNameInput).toBeVisible();
    await newNameInput.fill("Study");
    await win.getByRole("button", { name: "Add", exact: true }).first().click();
    // The new row appears in the BP list with displayName "Study".
    await expect(win.locator("li.bp-card .bp-name", { hasText: "Study" })).toBeVisible();

    // Capture the Study profile's localId for later steps.
    const study = await win.evaluate(async (cf) => {
      const list = await window.careerflow.browserManager.list(Number(cf));
      return list.find((b) => b.displayName === "Study") ?? null;
    }, cfA);
    expect(study).toBeTruthy();
    const studyLocalId = study.localId;

    // ----- step 7: expand profile → Add shortcut → "Google" / "https://google.com" -----
    const studyCard = win.locator("li.bp-card", { hasText: "Study" });
    await studyCard.getByRole("button", { name: /Shortcuts \(0\)/ }).click();
    await studyCard.getByRole("button", { name: "Add shortcut" }).click();
    // Two inputs in the form (label + url).
    const labelInput = studyCard.locator("input[placeholder='Label']");
    const urlInput = studyCard.locator("input[placeholder='https://…']");
    await labelInput.fill("Google");
    await urlInput.fill("https://google.com");
    await studyCard.getByRole("button", { name: "Add", exact: true }).click();
    await expect(studyCard.locator(".sc-list .sc-row")).toHaveCount(1);
    await expect(studyCard.locator(".sc-list .link-btn", { hasText: "Google" })).toBeVisible();

    // ----- step 8: click Launch on Study — stub records a run -----
    const studyLaunchBtn = studyCard.getByRole("button", { name: "Launch", exact: true });
    await studyLaunchBtn.click();
    // Give the IPC roundtrip a moment.
    await win.waitForTimeout(150);
    const callsAfterLaunch = await e2eCalls(app);
    expect(callsAfterLaunch.donutProfileCreations).toContain(`bfc-${studyLocalId}`);
    expect(callsAfterLaunch.donutRuns.length).toBeGreaterThan(0);

    // Pin the Google shortcut for the QA panel to surface.
    const scA = await win.evaluate(
      ([cf, lid]) => window.careerflow.browserManager.listShortcuts(Number(cf), lid),
      [Number(cfA), studyLocalId]
    );
    expect(scA).toHaveLength(1);
    await win.evaluate(
      ([cf, scId]) => window.careerflow.browserManager.togglePin(Number(cf), scId, true),
      [Number(cfA), scA[0].id]
    );
    // The QA panel reloads on cf:data-changed (it has no other signal that
    // an IPC-side mutation happened).
    await win.evaluate(() => window.dispatchEvent(new Event("cf:data-changed")));
    await win.waitForTimeout(200);

    // ----- step 9: QA panel shows the Google shortcut; 5 toolbar buttons -----
    // QA panel is on the home view. Switch back.
    await homeBtn.click();
    const qaToolbar = win.locator('[role="toolbar"][aria-label="Browser quick actions"]');
    await expect(qaToolbar).toBeVisible();
    // Exactly 5 high-level actions.
    await expect(qaToolbar.locator("button")).toHaveCount(5);
    // The Google shortcut row is rendered.
    await expect(win.locator(".qa-item .qa-label", { hasText: "Google" })).toBeVisible();

    // ----- step 10: QA "Launch" button re-runs the first enabled profile -----
    const runsBeforeQaLaunch = (await e2eCalls(app)).donutRuns.length;
    await win.locator('[data-testid="qa-launch-bp"]').click();
    await win.waitForTimeout(150);
    const runsAfterQaLaunch = (await e2eCalls(app)).donutRuns.length;
    expect(runsAfterQaLaunch).toBeGreaterThan(runsBeforeQaLaunch);

    // ----- step 11: QA "Open" opens the first pinned shortcut -----
    const opensBefore = (await e2eCalls(app)).donutOpens.length;
    await win.locator('[data-testid="qa-open-shortcut"]').click();
    await win.waitForTimeout(150);
    const opensAfter = (await e2eCalls(app)).donutOpens.length;
    expect(opensAfter).toBeGreaterThan(opensBefore);
    // And: the open was for the Google shortcut URL — canonicalised with
    // the trailing slash by the URL crate.
    const opensList = (await e2eCalls(app)).donutOpens;
    expect(opensList).toContain("https://google.com/");

    // ----- step 12: QA "+ Profile" navigates to Browser Manager and opens add form -----
    await win.locator('[data-testid="qa-add-bp"]').click();
    // The BM panel's "New browser profile" form must be visible.
    await expect(win.locator("#bm-new-name-input")).toBeVisible();
    // Heading is rendered by the BM panel which is the 'browser' view.
    // Atlas banded the console, so the panel heading is "Saved places" and the
    // panel root carries the stable `browser-manager` identity (see step 3).
    const bmPanelAfterAdd = win.locator("section.browser-manager");
    await expect(bmPanelAfterAdd).toBeVisible();
    await expect(bmPanelAfterAdd.getByRole("heading", { name: "Saved places" })).toBeVisible();
    // Cancel the form so subsequent steps are not stuck inside it.
    await win.getByRole("button", { name: "Cancel", exact: true }).first().click();

    // ----- step 13: QA "Refresh" — re-queries without crashing -----
    // Go back to home so the QA toolbar is rendered.
    await homeBtn.click();
    await expect(qaToolbar).toBeVisible();
    // The Refresh button is always present and clickable (not while loading).
    const refreshBtn = win.locator('[data-testid="qa-refresh"]');
    await expect(refreshBtn).toBeEnabled();
    await refreshBtn.click();
    // The panel should still be rendered and Google still pinned.
    await expect(win.locator(".qa-item .qa-label", { hasText: "Google" })).toBeVisible();

    // ----- step 14: isolation — second CF profile, second browser profile, no leakage -----
    const cfB = await makeCfProfile(win, "Phase 8 B");
    expect(cfB).not.toBe(cfA);
    // Activate B so the renderer-side state matches the data we just wrote.
    await selectCfProfile(win, "Phase 8 B");
    const social = await addBrowserProfile(win, cfB, "Social");
    const scSocial = await addShortcut(win, cfB, social.localId, "Twitter", "https://twitter.com");
    // Pin Social's Twitter on B.
    await win.evaluate(
      ([cf, scId]) => window.careerflow.browserManager.togglePin(Number(cf), scId, true),
      [Number(cfB), scSocial.id]
    );

    // A's pinned list is exactly ["Google"].
    const pinnedA = (
      await win.evaluate(
        (cf) => window.careerflow.browserManager.listPinned(Number(cf)),
        Number(cfA)
      )
    ).map((r) => r.label);
    expect(pinnedA).toEqual(["Google"]);

    // B's pinned list is exactly ["Twitter"].
    const pinnedB = (
      await win.evaluate(
        (cf) => window.careerflow.browserManager.listPinned(Number(cf)),
        Number(cfB)
      )
    ).map((r) => r.label);
    expect(pinnedB).toEqual(["Twitter"]);

    // Cross-check: A's listing never includes Social's localId.
    const aListIds = (
      await win.evaluate(
        (cf) => window.careerflow.browserManager.list(Number(cf)),
        Number(cfA)
      )
    ).map((b) => b.localId);
    expect(aListIds).toContain(studyLocalId);
    expect(aListIds).not.toContain(social.localId);
  } finally {
    await app.close();
  }
});
