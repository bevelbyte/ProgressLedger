import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

test("migration destination safety: rejects occupied destination and preserves sentinel bytes in real Electron app", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-e2e-mig-user-"));
  const destDir = mkdtempSync(join(tmpdir(), "cf-e2e-mig-dest-"));

  try {
    // 1. Prepare legacy source data
    const sourceDb = join(userDataDir, "progress-ledger-v2.db");
    const sourceContent = "SQLITE_SOURCE_DATA_LEGACY_V0_ABC123";
    writeFileSync(sourceDb, sourceContent);

    // 2. Prepare occupied destination with sentinel database and attachments
    const destDb = join(destDir, "progress-ledger-v2.db");
    const destSentinelDb = "PREEXISTING_DATABASE_SENTINEL_DO_NOT_TOUCH";
    writeFileSync(destDb, destSentinelDb);

    const destAttach = join(destDir, "attachments");
    mkdirSync(destAttach, { recursive: true });
    const destSentinelAttach = join(destAttach, "important_file.pdf");
    const destSentinelAttachContent = "PREEXISTING_ATTACHMENT_DO_NOT_OVERWRITE";
    writeFileSync(destSentinelAttach, destSentinelAttachContent);

    // 3. Launch Electron in migration-test mode pointing to disposable paths
    const app = await electron.launch({
      args: [projectRoot, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        PROGRESSLEDGER_V2_MIGRATION_TEST: "1",
        PROGRESSLEDGER_V2_E2E_USER_DATA: userDataDir,
        PROGRESSLEDGER_V2_MIGRATION_TEST_TARGET: destDir,
      },
    });

    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");

    // Verify migration wizard is on screen
    await expect(win.locator("#screen-welcome h1")).toHaveText("Welcome to Progress Ledger");

    // Click Browse (resolves immediately to target via test hook)
    await win.locator("#btn-browse").click();
    await expect(win.locator("#dir-input")).toHaveValue(destDir);
    await expect(win.locator("#btn-continue")).toBeEnabled();

    // Click Continue to attempt migration
    await win.locator("#btn-continue").click();

    // Migration must be REJECTED with clear error message on the welcome screen
    const errBox = win.locator("#error-message");
    await expect(errBox).toBeVisible();
    await expect(errBox).toContainText("The selected directory is not empty");

    // Verify destination sentinels are completely untouched
    assertBytesIdentical(destDb, destSentinelDb);
    assertBytesIdentical(destSentinelAttach, destSentinelAttachContent);
    expect(existsSync(join(destDir, "workspace.json"))).toBe(false);

    // Verify source data is completely untouched and not renamed to .migrated
    assertBytesIdentical(sourceDb, sourceContent);
    expect(existsSync(`${sourceDb}.migrated`)).toBe(false);

    await app.close();
  } finally {
    cleanupDir(userDataDir);
    cleanupDir(destDir);
  }
});

test("migration destination safety: permits genuinely empty destination in real Electron app", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-e2e-empty-user-"));
  const destDir = mkdtempSync(join(tmpdir(), "cf-e2e-empty-dest-"));

  try {
    // 1. Prepare valid legacy SQLite source database
    const sourceDb = join(userDataDir, "progress-ledger-v2.db");
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(sourceDb);
    db.exec("CREATE TABLE legacy_items (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO legacy_items VALUES (1, 'migrated note');");
    db.close();

    // 2. Launch Electron in migration-test mode pointing to genuinely empty destination
    const app = await electron.launch({
      args: [projectRoot, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        PROGRESSLEDGER_V2_MIGRATION_TEST: "1",
        PROGRESSLEDGER_V2_E2E_USER_DATA: userDataDir,
        PROGRESSLEDGER_V2_MIGRATION_TEST_TARGET: destDir,
      },
    });

    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");

    // Click Browse
    await win.locator("#btn-browse").click();
    await expect(win.locator("#dir-input")).toHaveValue(destDir);
    await expect(win.locator("#btn-continue")).toBeEnabled();

    // Click Continue
    await win.locator("#btn-continue").click();

    // Expect progress screen and completion
    await expect(win.locator("#status-text")).toHaveText("Done!", { timeout: 10000 });
    await expect(win.locator("#progress-fill")).toHaveCSS("width", /.+/);

    // Destination should now contain the migrated files
    const migratedDb = join(destDir, "progress-ledger-v2.db");
    const migratedWs = join(destDir, "workspace.json");

    expect(existsSync(migratedDb)).toBe(true);
    expect(existsSync(migratedWs)).toBe(true);

    const checkDb = new Database(migratedDb);
    const row = checkDb.prepare("SELECT note FROM legacy_items WHERE id = 1").get();
    checkDb.close();
    expect(row.note).toBe("migrated note");

    await app.close();
  } finally {
    cleanupDir(userDataDir);
    cleanupDir(destDir);
  }
});

function cleanupDir(dir) {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
}

function assertBytesIdentical(filePath, expectedContent) {
  const actual = readFileSync(filePath, "utf8");
  if (actual !== expectedContent) {
    throw new Error(`File content mismatch at ${filePath}: expected "${expectedContent}", got "${actual}"`);
  }
}

