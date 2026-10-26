// Real-data guard wiring probe (test-only, not shipped).
// Launches the app in test mode with PROGRESSLEDGER_V2_E2E_USER_DATA set
// to the real data folder path — computed from APPDATA, never read or
// written — and requires the app to refuse to start (no window appears).
// The app exits with code 1 before creating any window, database, or log
// file, so this test takes no further action after the launch attempt.
//
// Two refusal shapes are accepted, because Playwright reports them
// differently: the launch itself rejects (the app exits before the CDP
// connection yields a window), or the launch resolves and firstWindow
// rejects (the app exits without ever creating a window). A launch
// failure WITHOUT the guard's REFUSING message is a real launch problem
// and fails the test, so a broken binary cannot masquerade as a refusal.
import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

test.setTimeout(120_000);

test("test mode refuses the real data folder", async () => {
  const appData = process.env.APPDATA;
  expect(appData, "APPDATA is required to compute the real data path").toBeTruthy();
  const realDir = join(appData, "progress-ledger-v2");
  let app = null;
  let refusedAtLaunch = false;
  try {
    app = await electron.launch({
      args: [projectRoot, `--user-data-dir=${realDir}`],
      env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1", PROGRESSLEDGER_V2_E2E_USER_DATA: realDir },
    });
  } catch (e) {
    refusedAtLaunch = String(e?.message ?? e).includes("REFUSING TO START");
    expect(refusedAtLaunch, `launch failed without the guard message: ${String(e?.message ?? e).slice(0, 300)}`).toBe(true);
  }
  if (app) {
    let windowAppeared = false;
    try {
      await app.firstWindow({ timeout: 20_000 });
      windowAppeared = true;
    } catch {
      // Expected: the app exited without creating a window.
    }
    if (windowAppeared) {
      await app.close().catch(() => {});
    }
    expect(windowAppeared, "guard failed: a window appeared while pointed at real data").toBe(false);
    await app.close().catch(() => {});
  }
});
