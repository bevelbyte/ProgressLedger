// Actual Progress Ledger application — malformed credential store, explained and
// repaired through the SUPPORTED provider-configuration path.
//
// Context (defect D-1): when <userData>/pm-secrets.json exists but is not valid
// JSON (the state the user's real store is in), the credentials store produces a
// SANITIZED diagnostic { code: "credential-store-malformed", reason } and
// `project:get-provider-config` returns it at `config.diagnostic`. The panel used
// to discard it, so the user saw an empty panel with no explanation. The panel now
// surfaces it and points at the action that repairs the store (Save).
//
// This spec drives the REAL Electron app with an ISOLATED userData dir and proves,
// through the actual application:
//   1. a malformed store is reported (warning rendered; sanitized diagnostic over
//      IPC; no store content leaked into the renderer DOM)
//   2. saving through the supported UI repairs the store to valid JSON, clears the
//      warning, and reads back sanitized ({ endpoint, model, hasKey:true })
//   3. after a real application RESTART on the same userData the configuration is
//      still available through the same supported mechanism (no warning, key set)
//
// Classification: ELECTRON (actual application + real IPC + real store file).
// No provider network leg is exercised: the endpoint/model/key planted here are
// synthetic fixtures in a temp dir, NOT secrets, and nothing is sent anywhere.
// REAL-PROVIDER through the actual application credential path remains a separate
// gate and is NOT claimed by this spec.

import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

// Synthetic fixtures — clearly non-secret, never real credentials.
const FIXTURE_KEY = "sk-E2E-D1-FIXTURE-NOT-A-SECRET";
const MALFORMED_KEY = "sk-E2E-D1-MALFORMED-FIXTURE-NOT-A-SECRET";
const ENDPOINT = "https://api.example.com/v1";
const MODEL = "e2e-d1-model";

// Deliberately not JSON: a plain-text triplet file, which is exactly the shape
// the user's real store was found to have. Must NOT be reconstructed by guessing
// field order — it only exists here to simulate a corrupt store.
const MALFORMED_CONTENT = [
  `endpoint=${ENDPOINT}`,
  `key=${MALFORMED_KEY}`,
  `model=${MODEL}`,
].join("\n");

async function launchIsolated(userDataDir) {
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PROGRESSLEDGER_V2_E2E: "1",
      PROGRESSLEDGER_V2_E2E_DISABLE_SYSTEM_FALLBACK: "1",
      PROGRESSLEDGER_V2_E2E_USER_DATA: userDataDir,
    },
    timeout: 60_000,
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForLoadState("networkidle");
  return { app, win };
}

async function dismissOnboarding(win) {
  const overlay = win.locator(".onboarding-overlay");
  await overlay.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  const skipBtn = win.locator('button.skip-btn:has-text("Skip Tutorial")');
  if (await skipBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await skipBtn.click();
  }
}

// Open the Project workspace for a project id via the real navigation.
async function openProjectWorkspace(win, projectId) {
  await win.locator("button.nav-item", { hasText: /^\s*Project\s*$/ }).click();
  const tourSkip = win.locator('[data-testid="onboarding-tour-skip"]');
  if (await tourSkip.isVisible().catch(() => false)) await tourSkip.click();
  await win
    .locator(`[data-testid="project-item"][data-project-id="${projectId}"] button.item-main`)
    .click();
  await win.locator('[data-testid="project-workspace"]').waitFor({ state: "visible", timeout: 20_000 });
  // Provider config lives in the inspector's Budget tab. The run console used to
  // render twenty-eight panels at once, all equally loud, which buried the run's
  // live state (transcript, tool trace, approvals); configuration moved into a
  // tab. The behaviour under test is unchanged — only its address is.
  await openInspectorTab(win, "Budget");
  await expect(win.locator('[data-testid="provider-config-panel"]')).toBeVisible({ timeout: 20_000 });
}

/** Select a tab in the run console's inspector. */
async function openInspectorTab(win, name) {
  const tab = win.getByRole("tab", { name, exact: true });
  await tab.waitFor({ state: "visible", timeout: 20_000 });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

test("actual app: malformed credential store is explained, repaired via the supported UI, and persists across restart", async () => {
  test.setTimeout(300_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-d1-ud-"));
  const projectRootPath = mkdtempSync(join(tmpdir(), "cf-d1-proj-"));
  const secretsFile = join(userDataDir, "pm-secrets.json");

  // Seed the corrupt store BEFORE the app starts.
  writeFileSync(secretsFile, MALFORMED_CONTENT, "utf8");

  let profileId = 0;
  let projectId = 0;

  // ---- Launch 1: malformed -> explained -> repaired ----------------------
  let { app, win } = await launchIsolated(userDataDir);
  try {
    await dismissOnboarding(win);

    // Profile through the REAL UI form so it is also the renderer's active profile.
    await win.locator('button.nav-item:has-text("Profiles")').click();
    await win.locator('input[placeholder^="New profile name"]').fill("D1 Store");
    await win.locator('form.add-form button[type="submit"]:has-text("Add")').click();
    await win.locator("article.profile-card.active").waitFor({ state: "visible", timeout: 15_000 });
    await win.waitForTimeout(900); // selectProfile() schedules a 500ms view flip
    profileId = await win.evaluate(() =>
      window.progressLedger.profiles.list().then((rows) => Math.max(...rows.map((r) => r.id))),
    );
    expect(profileId).toBeGreaterThan(0);

    const created = await win.evaluate(([pid, rootPath]) =>
      window.progressLedger.projectMode.createProject({
        profileId: pid,
        name: "D1 Store",
        description: "malformed store e2e",
        rootPath,
        configJson: "{}",
      }), [profileId, projectRootPath]);
    projectId = typeof created === "number" ? created : (created && created.id);
    expect(projectId).toBeGreaterThan(0);

    // The store is malformed, so the supported read path reports WHY instead of
    // looking merely empty.
    const malformedRead = await win.evaluate(([pid, prid]) =>
      window.progressLedger.projectMode.getProviderConfig(pid, prid), [profileId, projectId]);
    expect(malformedRead.ok).toBe(true);
    expect(malformedRead.config).toBeTruthy();
    expect(malformedRead.config.hasKey).toBe(false);
    expect(malformedRead.config.diagnostic).toEqual({
      code: "credential-store-malformed",
      reason: "unparseable-json",
    });
    // Sanitized: the diagnostic carries classification only, never store content.
    expect(JSON.stringify(malformedRead.config.diagnostic)).not.toContain("sk-");

    // Through the ACTUAL UI: the warning is rendered.
    await openProjectWorkspace(win, projectId);
    const warning = win.locator('[data-testid="provider-store-diagnostic"]');
    await expect(warning).toBeVisible({ timeout: 20_000 });
    await expect(win.locator('[data-testid="provider-store-diagnostic-code"]')).toHaveText(
      "credential-store-malformed",
    );
    await expect(win.locator('[data-testid="provider-key-set"]')).toHaveCount(0);

    // The corrupt store's contents never leak into the renderer.
    expect(await win.content()).not.toContain(MALFORMED_KEY);

    // Repair it through the supported UI (the action the warning names).
    await win.locator('[data-testid="provider-endpoint"]').fill(ENDPOINT);
    await win.locator('[data-testid="provider-model"]').fill(MODEL);
    await win.locator('[data-testid="provider-key"]').fill(FIXTURE_KEY);
    await win.locator('[data-testid="provider-save"]').click();

    await expect(win.locator('[data-testid="provider-key-set"]')).toBeVisible({ timeout: 15_000 });
    // The warning is gone, and the key input does not retain the typed value.
    await expect(warning).toHaveCount(0);
    await expect(win.locator('[data-testid="provider-key"]')).toHaveValue("");

    // The supported store file is now valid JSON keyed <profileId>:<projectId>.
    const stored = JSON.parse(readFileSync(secretsFile, "utf8"));
    expect(stored[`${profileId}:${projectId}`]).toBeTruthy();
    expect(stored[`${profileId}:${projectId}`].endpoint).toBe(ENDPOINT);
    expect(stored[`${profileId}:${projectId}`].model).toBe(MODEL);

    // Sanitized read-back over the real IPC boundary.
    const repaired = await win.evaluate(([pid, prid]) =>
      window.progressLedger.projectMode.getProviderConfig(pid, prid), [profileId, projectId]);
    expect(repaired.config.endpoint).toBe(ENDPOINT);
    expect(repaired.config.model).toBe(MODEL);
    expect(repaired.config.hasKey).toBe(true);
    expect(repaired.config.apiKey).toBeUndefined();
    expect(repaired.config.diagnostic).toBeUndefined();
    expect(JSON.stringify(repaired)).not.toContain(FIXTURE_KEY);
    expect(await win.content()).not.toContain(FIXTURE_KEY);
  } finally {
    await app.close().catch(() => {});
  }

  // ---- Launch 2: restart continuity of the credential mechanism ----------
  ({ app, win } = await launchIsolated(userDataDir));
  try {
    await dismissOnboarding(win);

    // The configuration (and its sanitized resolution) survives a real restart.
    const afterRestart = await win.evaluate(([pid, prid]) =>
      window.progressLedger.projectMode.getProviderConfig(pid, prid), [profileId, projectId]);
    expect(afterRestart.ok).toBe(true);
    expect(afterRestart.config).toBeTruthy();
    expect(afterRestart.config.hasKey).toBe(true);
    expect(afterRestart.config.diagnostic).toBeUndefined();
    expect(JSON.stringify(afterRestart)).not.toContain(FIXTURE_KEY);

    // And the renderer still shows the healthy state (no warning, key set).
    await openProjectWorkspace(win, projectId);
    await expect(win.locator('[data-testid="provider-key-set"]')).toBeVisible({ timeout: 20_000 });
    await expect(win.locator('[data-testid="provider-store-diagnostic"]')).toHaveCount(0);
    expect(await win.content()).not.toContain(FIXTURE_KEY);
    expect(await win.content()).not.toContain(MALFORMED_KEY);
  } finally {
    await app.close().catch(() => {});
  }

  // The store file remains valid JSON after the restart cycle.
  expect(existsSync(secretsFile)).toBe(true);
  expect(() => JSON.parse(readFileSync(secretsFile, "utf8"))).not.toThrow();
});
