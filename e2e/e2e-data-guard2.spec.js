// Real-data guard entry-point probes, follow-up round (test-only, not shipped).
//
// The Stage 2.5 spec proved one entry point: E2E mode with the env var
// pointed at real data refuses. This file proves the rest, so no entry
// point can silently fall back to the real folder:
//   1. E2E mode with NEITHER the env var NOR --user-data-dir refuses
//      (the old fall-through shape that wrote "Browser Phase Two").
//   2. E2E mode with ONLY --user-data-dir honours the flag: the app
//      starts, reaches core online, and its data lands in the flag's
//      folder (checked after close) — never the real folder.
//   3. Migration-test mode with the env var pointed at real data refuses.
//   4. The PACKAGED app with the test flag refuses real data (the
//      packaged build carries the same guard; skipped if the packaged
//      folder is absent).
// Refusal is accepted in either Playwright shape (launch rejects with
// REFUSING, or firstWindow rejects with no window). A window appearing
// while pointed at real data fails the test. Real data is never read or
// written: its path is computed from APPDATA only.
import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const PACKAGED_EXE = join(projectRoot, "release", "win-unpacked-95dc1a1", "Progress Ledger v2.exe");

test.setTimeout(180_000);

async function expectRefusal(launchArgs, env) {
  let app = null;
  try {
    app = await electron.launch({ args: launchArgs, env: { ...process.env, ...env } });
  } catch (e) {
    const refused = String(e?.message ?? e).includes("REFUSING TO START");
    expect(refused, `launch failed without the guard message: ${String(e?.message ?? e).slice(0, 300)}`).toBe(true);
    return;
  }
  let windowAppeared = false;
  try {
    await app.firstWindow({ timeout: 20_000 });
    windowAppeared = true;
  } catch {
    // Expected: the app exited without creating a window.
  }
  if (windowAppeared) await app.close().catch(() => {});
  expect(windowAppeared, "guard failed: a window appeared while pointed at real data").toBe(false);
  await app.close().catch(() => {});
}

test("test mode with no data folder at all refuses", async () => {
  await expectRefusal([projectRoot], { PROGRESSLEDGER_V2_E2E: "1" });
});

test("migration test mode with the env var at real data refuses", async () => {
  const appData = process.env.APPDATA;
  expect(appData, "APPDATA is required to compute the real data path").toBeTruthy();
  const realDir = join(appData, "progress-ledger-v2");
  await expectRefusal([projectRoot], {
    PROGRESSLEDGER_V2_MIGRATION_TEST: "1",
    PROGRESSLEDGER_V2_E2E_USER_DATA: realDir,
  });
});

test("packaged app with the test flag refuses real data", async () => {
  test.skip(!existsSync(PACKAGED_EXE), "packaged 95dc1a1 build not present");
  const appData = process.env.APPDATA;
  expect(appData, "APPDATA is required to compute the real data path").toBeTruthy();
  const realDir = join(appData, "progress-ledger-v2");
  let app = null;
  try {
    app = await electron.launch({
      executablePath: PACKAGED_EXE,
      args: [`--user-data-dir=${realDir}`],
      env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1", PROGRESSLEDGER_V2_E2E_USER_DATA: realDir },
    });
  } catch (e) {
    const refused = String(e?.message ?? e).includes("REFUSING TO START");
    expect(refused, `packaged launch failed without the guard message: ${String(e?.message ?? e).slice(0, 300)}`).toBe(true);
    return;
  }
  let windowAppeared = false;
  try {
    await app.firstWindow({ timeout: 20_000 });
    windowAppeared = true;
  } catch {
    // Expected.
  }
  if (windowAppeared) await app.close().catch(() => {});
  expect(windowAppeared, "packaged guard failed: a window appeared while pointed at real data").toBe(false);
  await app.close().catch(() => {});
});

test("test mode honours --user-data-dir without the env var", async () => {
  const flagDir = mkdtempSync(join(tmpdir(), "pl-v2-guard-cli-"));
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${flagDir}`],
    env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1" },
  });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
    await win.reload();
    await win.waitForLoadState("domcontentloaded");
    await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible({ timeout: 60_000 });
  } finally {
    await app.close().catch(() => {});
  }
  // The app ran with the flag's folder: something it owns must be there.
  const entries = readdirSync(flagDir);
  expect(entries.length, "flag folder is empty after a full app start").toBeGreaterThan(0);
  const storageLike = entries.some((e) => /db|storage|cache|logs|local/i.test(e));
  expect(storageLike, `flag folder has no app data entries: ${entries.slice(0, 10).join(", ")}`).toBe(true);
});
