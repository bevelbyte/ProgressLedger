// Supported credential-store path (real Electron app, real IPC, real store file).
//
// Proves the user-facing path the REAL-PROVIDER gates depend on:
//   ProviderConfigPanel (UI) -> projectModeService.setProviderConfig(pid, projid, cfg)
//     -> preload setProviderConfig(profileId, projectId, config)  [POSITIONAL]
//       -> project:set-provider-config -> credentialsStore.writeProviderConfig
//         -> <userData>/pm-secrets.json
//   and the read-back boundary: get-provider-config returns the SANITIZED view
//   ({ endpoint, model, hasKey }) — the apiKey NEVER reaches the renderer DOM.
//
// This spec exists because a renderer argument-contract defect collapsed the
// payload into a single object argument, which the main-process ownership check
// rejected — the UI could never save a provider credential and the agent fell
// back to the mock provider. The fix + unit lock live in
// ui/src/features/project-mode/services/projectMode.service.js and
// ui/tests/credential-ipc-contract.test.js.
//
// Classification: ELECTRON. No provider network leg is exercised — no credential
// is sent anywhere; the planted key is a fixture value, never a secret.

import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

const FIXTURE_KEY = "sk-E2E-CREDENTIAL-PATH-FIXTURE-NOT-A-SECRET";
const ENDPOINT = "https://api.example.com";
const MODEL = "e2e-cred-model";

async function launchIsolated(userDataDir) {
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      CAREERFLOW_E2E: "1",
      CAREERFLOW_E2E_DISABLE_SYSTEM_FALLBACK: "1",
      CAREERFLOW_E2E_USER_DATA: userDataDir,
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

test("credential store path: UI save writes the store and reads back sanitized; clear removes it", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-credpath-ud-"));
  const projectRootPath = mkdtempSync(join(tmpdir(), "cf-credpath-proj-"));
  const secretsFile = join(userDataDir, "pm-secrets.json");

  const { app, win } = await launchIsolated(userDataDir);
  try {
    await dismissOnboarding(win);

    // Profile created through the REAL UI form so it also becomes the
    // renderer's active profile (a bare IPC add leaves profile-gated
    // navigation disabled).
    await win.locator('button.nav-item:has-text("Profiles")').click();
    await win.locator('input[placeholder^="New profile name"]').fill("Cred Path");
    await win.locator('form.add-form button[type="submit"]:has-text("Add")').click();
    await win.locator("article.profile-card.active").waitFor({ state: "visible", timeout: 15_000 });
    // selectProfile() schedules a 500ms view-flip to Subjects — wait it out.
    await win.waitForTimeout(900);
    const profileId = await win.evaluate(() =>
      window.careerflow.profiles.list().then((rows) => Math.max(...rows.map((r) => r.id))),
    );
    expect(profileId).toBeGreaterThan(0);

    const created = await win.evaluate(([pid, rootPath]) =>
      window.careerflow.projectMode.createProject({
        profileId: pid,
        name: "Cred Path",
        description: "credential path e2e",
        rootPath,
        configJson: "{}",
      }), [profileId, projectRootPath]);
    const projectId = typeof created === "number" ? created : (created && created.id);
    expect(projectId).toBeGreaterThan(0);

    // Fresh project: nothing stored yet -> config is null (not an error).
    const before = await win.evaluate(([pid, prid]) =>
      window.careerflow.projectMode.getProviderConfig(pid, prid), [profileId, projectId]);
    expect(before.ok).toBe(true);
    expect(before.config).toBeNull();

    // Open the project workspace so ProviderConfigPanel is mounted.
    await win.locator("button.nav-item", { hasText: /^\s*Project\s*$/ }).click();
    const tourSkip = win.locator('[data-testid="onboarding-tour-skip"]');
    if (await tourSkip.isVisible().catch(() => false)) await tourSkip.click();
    await win.locator(`[data-testid="project-item"][data-project-id="${projectId}"] button.item-main`).click();
    await win.locator('[data-testid="project-workspace"]').waitFor({ state: "visible", timeout: 20_000 });

    // Provider config lives in the inspector's Budget tab now: the run console
    // stopped stacking twenty-eight panels at once, and configuration is
    // reference material rather than live run state. Same behaviour, new address.
    const budgetTab = win.getByRole("tab", { name: "Budget", exact: true });
    await budgetTab.click();
    await expect(budgetTab).toHaveAttribute("aria-selected", "true");

    const panel = win.locator('[data-testid="provider-config-panel"]');
    await expect(panel).toBeVisible({ timeout: 20_000 });

    // Drive the REAL UI save.
    await win.locator('[data-testid="provider-endpoint"]').fill(ENDPOINT);
    await win.locator('[data-testid="provider-model"]').fill(MODEL);
    await win.locator('[data-testid="provider-key"]').fill(FIXTURE_KEY);
    await win.locator('[data-testid="provider-save"]').click();

    // The panel reports "key set" only after the IPC confirms { ok: true }.
    await expect(win.locator('[data-testid="provider-key-set"]')).toBeVisible({ timeout: 15_000 });

    // The credential was written to the SUPPORTED store file.
    expect(existsSync(secretsFile)).toBe(true);
    const stored = JSON.parse(readFileSync(secretsFile, "utf8"));
    expect(stored[`${profileId}:${projectId}`]).toBeTruthy();
    expect(stored[`${profileId}:${projectId}`].endpoint).toBe(ENDPOINT);
    expect(stored[`${profileId}:${projectId}`].model).toBe(MODEL);
    expect(stored[`${profileId}:${projectId}`].apiKey).toBe(FIXTURE_KEY);

    // Read-back boundary: sanitized view only — no apiKey anywhere.
    const after = await win.evaluate(([pid, prid]) =>
      window.careerflow.projectMode.getProviderConfig(pid, prid), [profileId, projectId]);
    expect(after.ok).toBe(true);
    expect(after.config.endpoint).toBe(ENDPOINT);
    expect(after.config.model).toBe(MODEL);
    expect(after.config.hasKey).toBe(true);
    expect(after.config.apiKey).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain(FIXTURE_KEY);

    // The renderer DOM never holds the key.
    const html = await win.content();
    expect(html).not.toContain(FIXTURE_KEY);

    // Clear removes the stored credential (UI action + disk + read-back).
    await win.locator('[data-testid="provider-clear"]').click();
    await expect(win.locator('[data-testid="provider-key-set"]')).toHaveCount(0, { timeout: 15_000 });
    const cleared = await win.evaluate(([pid, prid]) =>
      window.careerflow.projectMode.getProviderConfig(pid, prid), [profileId, projectId]);
    expect(cleared.config == null || cleared.config.hasKey === false).toBe(true);
    if (existsSync(secretsFile)) {
      expect(readFileSync(secretsFile, "utf8")).not.toContain(FIXTURE_KEY);
    }
  } finally {
    await app.close().catch(() => {});
  }
});
