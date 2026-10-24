import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const packagedExe = resolve(projectRoot, "release", "acceptance-test", "win-unpacked", "Progress Ledger.exe");

function cleanupDir(dir) {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
}

function sha256(filePath) {
  const buf = readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

test.describe("Packaged Application Acceptance", () => {
  test("packaged binary: clean install & first-run acceptance", async () => {
    expect(existsSync(packagedExe), `Packaged executable must exist at ${packagedExe}`).toBe(true);

    const userDataDir = mkdtempSync(join(tmpdir(), "cf-pkg-clean-"));

    try {
      // 1. Launch the actual packaged binary
      let app = await electron.launch({
        executablePath: packagedExe,
        args: [`--user-data-dir=${userDataDir}`],
        env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1" },
      });

      let win = await app.firstWindow();
      await win.waitForLoadState("domcontentloaded");

      // Verify onboarding / startup
      await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
      await win.reload();
      await win.waitForLoadState("domcontentloaded");

      // 2. Verify core initialization
      await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();
      const pingRes = await win.evaluate(() => window.progressLedger.ping());
      expect(pingRes).toBeTruthy();

      // 3. Verify native N-API addon is loaded in packaged app
      const initialProfiles = await win.evaluate(() => window.progressLedger.profiles.list());
      expect(Array.isArray(initialProfiles)).toBe(true);
      expect(initialProfiles.length).toBe(0);

      // 4. Verify UI composition in packaged runtime
      await expect(win.locator("nav.rail")).toBeVisible();
      await expect(win.locator(".statusbar")).toBeVisible();


      // 5. Create a student profile
      const newProfile = await win.evaluate(async () => {
        return await window.progressLedger.profiles.add("Packaged Ada", `pkg-ada-${Date.now()}`);
      });
      expect(newProfile.id).toBeDefined();

      // 6. Navigate to Settings -> Data & Vault -> Backup Vault
      await win.locator(".nav-item", { hasText: "Settings" }).click();
      await expect(win.getByText("Data and vault")).toBeVisible();
      await expect(win.getByText("Backup Vault")).toBeVisible();

      // 7. Verify embedded browser surface initialized
      const browserState = await win.evaluate(async () => {
        return await window.progressLedger.browser.state();
      });
      expect(browserState).toBeDefined();


      // 8. Verify security boundary: no direct CDP in renderer
      const hasCdp = await win.evaluate(() => typeof window.progressLedger.cdp !== "undefined");
      expect(hasCdp).toBe(false);

      // 9. Graceful shutdown
      await app.close();

      // 10. Relaunch against the same userDataDir and verify persistence
      app = await electron.launch({
        executablePath: packagedExe,
        args: [`--user-data-dir=${userDataDir}`],
        env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1" },
      });
      win = await app.firstWindow();
      await win.waitForLoadState("domcontentloaded");
      await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();

      const persistedProfiles = await win.evaluate(() => window.progressLedger.profiles.list());
      expect(persistedProfiles.some((p) => p.name === "Packaged Ada")).toBe(true);

      await app.close();
    } finally {
      cleanupDir(userDataDir);
    }
  });

  test("packaged binary: migration destination safety guard rejects occupied destination", async () => {
    expect(existsSync(packagedExe)).toBe(true);

    const userDataDir = mkdtempSync(join(tmpdir(), "cf-pkg-mig-user-"));
    const destDir = mkdtempSync(join(tmpdir(), "cf-pkg-mig-dest-"));

    try {
      // 1. Prepare legacy source data
      const sourceDb = join(userDataDir, "progress-ledger-v2.db");
      writeFileSync(sourceDb, "LEGACY_SOURCE_DATA_TEST_PACKAGED_V0");

      // 2. Prepare occupied destination with sentinel files
      const destDb = join(destDir, "progress-ledger-v2.db");
      const sentinelDbContent = "DESTINATION_SENTINEL_DB_PACKAGED_DO_NOT_TOUCH";
      writeFileSync(destDb, sentinelDbContent);

      const destAttach = join(destDir, "attachments");
      mkdirSync(destAttach, { recursive: true });
      const destSentinelAttach = join(destAttach, "sentinel_report.pdf");
      const sentinelAttachContent = "DESTINATION_ATTACHMENT_SENTINEL_DO_NOT_OVERWRITE";
      writeFileSync(destSentinelAttach, sentinelAttachContent);

      const destDbHashBefore = sha256(destDb);
      const destAttachHashBefore = sha256(destSentinelAttach);
      const sourceDbHashBefore = sha256(sourceDb);

      // 3. Launch packaged binary in migration-test mode
      const app = await electron.launch({
        executablePath: packagedExe,
        args: [`--user-data-dir=${userDataDir}`],
        env: {
          ...process.env,
          PROGRESSLEDGER_V2_MIGRATION_TEST: "1",
          PROGRESSLEDGER_V2_E2E_USER_DATA: userDataDir,
          PROGRESSLEDGER_V2_MIGRATION_TEST_TARGET: destDir,
        },
      });

      const win = await app.firstWindow();
      await win.waitForLoadState("domcontentloaded");

      // Verify migration wizard is presented
      await expect(win.locator("#screen-welcome h1")).toHaveText("Welcome to Progress Ledger");

      // Browse to the occupied directory and attempt migration
      await win.locator("#btn-browse").click();
      await expect(win.locator("#dir-input")).toHaveValue(destDir);
      await expect(win.locator("#btn-continue")).toBeEnabled();

      await win.locator("#btn-continue").click();

      // Must be rejected with clear error message
      const errBox = win.locator("#error-message");
      await expect(errBox).toBeVisible();
      await expect(errBox).toContainText("The selected directory is not empty");

      // Verify all sentinels are byte-for-byte identical (SHA256 unchanged)
      expect(sha256(destDb)).toBe(destDbHashBefore);
      expect(sha256(destSentinelAttach)).toBe(destAttachHashBefore);
      expect(sha256(sourceDb)).toBe(sourceDbHashBefore);

      await app.close();
    } finally {
      cleanupDir(userDataDir);
      cleanupDir(destDir);
    }
  });

  test("packaged binary: migration succeeds to empty destination and survives restart", async () => {
    expect(existsSync(packagedExe)).toBe(true);

    const userDataDir = mkdtempSync(join(tmpdir(), "cf-pkg-mig-user-"));
    const destDir = mkdtempSync(join(tmpdir(), "cf-pkg-mig-dest-"));

    try {
      // 1. Prepare valid legacy database using SQLite
      const sourceDbPath = join(userDataDir, "progress-ledger-v2.db");
      const db = new Database(sourceDbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
        INSERT INTO schema_version (version) VALUES (1);
        CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, title TEXT, note TEXT);
        INSERT INTO notes (title, note) VALUES ('legacy title', 'migrated note in packaged app');
      `);
      db.close();

      // Prepare legacy attachments
      const sourceAttach = join(userDataDir, "attachments");
      mkdirSync(sourceAttach, { recursive: true });
      writeFileSync(join(sourceAttach, "legacy_file.txt"), "legacy attachment bytes in packaged app");

      // 2. Launch packaged binary in migration-test mode targeting genuinely empty destination
      const app = await electron.launch({
        executablePath: packagedExe,
        args: [`--user-data-dir=${userDataDir}`],
        env: {
          ...process.env,
          PROGRESSLEDGER_V2_MIGRATION_TEST: "1",
          PROGRESSLEDGER_V2_E2E_USER_DATA: userDataDir,
          PROGRESSLEDGER_V2_MIGRATION_TEST_TARGET: destDir,
        },
      });

      const win = await app.firstWindow();
      await win.waitForLoadState("domcontentloaded");

      await expect(win.locator("#screen-welcome h1")).toHaveText("Welcome to Progress Ledger");

      await win.locator("#btn-browse").click();
      await expect(win.locator("#dir-input")).toHaveValue(destDir);
      await expect(win.locator("#btn-continue")).toBeEnabled();

      await win.locator("#btn-continue").click();

      // Expect progress screen and completion
      await expect(win.locator("#status-text")).toHaveText("Done!", { timeout: 15000 });


      // Verify destination filesystem
      const targetDb = join(destDir, "progress-ledger-v2.db");
      const targetWs = join(destDir, "workspace.json");
      const targetAttach = join(destDir, "attachments", "legacy_file.txt");

      expect(existsSync(targetDb)).toBe(true);
      expect(existsSync(targetWs)).toBe(true);
      expect(existsSync(targetAttach)).toBe(true);
      expect(readFileSync(targetAttach, "utf8")).toBe("legacy attachment bytes in packaged app");

      // Verify database integrity in target
      const readDb = new Database(targetDb, { readonly: true });
      const row = readDb.prepare("SELECT note FROM notes WHERE title = 'legacy title'").get();
      readDb.close();
      expect(row.note).toBe("migrated note in packaged app");

      await app.close();
    } finally {
      cleanupDir(userDataDir);
      cleanupDir(destDir);
    }
  });
});
