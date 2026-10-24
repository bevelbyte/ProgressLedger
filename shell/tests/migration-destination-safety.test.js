import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDestinationOccupied } from "../src/security/migration-safety.js";

// Helper to create an isolated disposable directory inside os.tmpdir()
function makeTempDir(prefix = "cf-mig-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// 1. Destination Safety Checker Unit Tests
// ---------------------------------------------------------------------------

test("isDestinationOccupied returns false for genuinely empty directory", () => {
  const dir = makeTempDir("cf-empty-");
  try {
    assert.equal(isDestinationOccupied(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isDestinationOccupied returns false for non-existent path", () => {
  const nonExistent = join(tmpdir(), `cf-nonexistent-${Date.now()}`);
  assert.equal(isDestinationOccupied(nonExistent), false);
});

test("isDestinationOccupied returns false when directory contains only harmless OS metadata", () => {
  const dir = makeTempDir("cf-os-meta-");
  try {
    writeFileSync(join(dir, "desktop.ini"), "[.ShellClassInfo]\r\nIconResource=...");
    assert.equal(isDestinationOccupied(dir), false);
    writeFileSync(join(dir, "Thumbs.db"), "binary cache data");
    assert.equal(isDestinationOccupied(dir), false);
    writeFileSync(join(dir, ".DS_Store"), "macOS metadata");
    assert.equal(isDestinationOccupied(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isDestinationOccupied returns true for a file path (not directory)", () => {
  const dir = makeTempDir("cf-file-target-");
  const filePath = join(dir, "target.txt");
  writeFileSync(filePath, "not a directory");
  try {
    assert.equal(isDestinationOccupied(filePath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TEST A — occupied database destination: isDestinationOccupied detects existing progress-ledger-v2.db", () => {
  const dir = makeTempDir("cf-db-target-");
  try {
    writeFileSync(join(dir, "progress-ledger-v2.db"), "SQLITE_HEADER_SENTINEL_BYTES");
    assert.equal(isDestinationOccupied(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TEST B — occupied attachment destination: isDestinationOccupied detects existing attachments or files", () => {
  const dir = makeTempDir("cf-attach-target-");
  try {
    const attachDir = join(dir, "attachments");
    mkdirSync(attachDir, { recursive: true });
    writeFileSync(join(attachDir, "user_photo.jpg"), "SENTINEL_USER_PHOTO");
    assert.equal(isDestinationOccupied(dir), true);

    const dir2 = makeTempDir("cf-sentinel-file-");
    try {
      writeFileSync(join(dir2, "sentinel.txt"), "DO_NOT_OVERWRITE");
      assert.equal(isDestinationOccupied(dir2), true);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TEST C — occupied workspace metadata: isDestinationOccupied detects existing workspace.json", () => {
  const dir = makeTempDir("cf-ws-target-");
  try {
    writeFileSync(join(dir, "workspace.json"), JSON.stringify({ schemaVersion: 1, workspaceId: "sentinel-ws" }));
    assert.equal(isDestinationOccupied(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Failure Ordering & Code Inspection Verification in main.js
// ---------------------------------------------------------------------------

test("TEST E — failure ordering: isDestinationOccupied executes before checkpointing, writes, copies, and activation in main.js", () => {
  const mainSource = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");

  const guardIndex = mainSource.indexOf("if (isDestinationOccupied(targetPath))");
  assert.ok(guardIndex >= 0, "isDestinationOccupied guard must exist in main.js");

  const mkdirIndex = mainSource.indexOf("mkdirSync(targetPath", guardIndex);
  assert.ok(mkdirIndex > guardIndex, "destination guard must precede mkdirSync");

  const checkpointIndex = mainSource.indexOf("core.checkpointDb(legacyDbPath)", guardIndex);
  assert.ok(checkpointIndex > guardIndex, "destination guard must precede SQLite checkpoint");

  const copyDbIndex = mainSource.indexOf("await cp(legacyDbPath, targetDbPath)", guardIndex);
  assert.ok(copyDbIndex > guardIndex, "destination guard must precede database copy");

  const copyAttachIndex = mainSource.indexOf("await cp(legacyAttachments, targetAttachments", guardIndex);
  assert.ok(copyAttachIndex > guardIndex, "destination guard must precede attachments copy");

  const writeWsIndex = mainSource.indexOf("await writeFile(", guardIndex);
  assert.ok(writeWsIndex > guardIndex, "destination guard must precede workspace.json write");

  const setActiveWsIndex = mainSource.indexOf("setActiveWorkspace(targetPath)", guardIndex);
  assert.ok(setActiveWsIndex > guardIndex, "destination guard must precede setActiveWorkspace");

  const switchWsIndex = mainSource.indexOf("switchWorkspace(targetPath)", guardIndex);
  assert.ok(switchWsIndex > guardIndex, "destination guard must precede switchWorkspace");
});

// ---------------------------------------------------------------------------
// 3. Simulated Full Handler Workflow Tests on Disposable Fixtures
// ---------------------------------------------------------------------------

async function simulateMigrationHandler({
  targetPath,
  selectedMigrationPath,
  legacyUserDataPath,
  isSender = true,
  checkpointDbFn = () => {},
  verifyDbFn = () => ({ success: true }),
  setActiveWorkspaceFn = () => {},
  switchWorkspaceFn = () => {},
}) {
  const isMigrationSender = isSender;
  if (!isMigrationSender) return { ok: false, reason: "unauthorized-sender" };

  if (typeof targetPath !== "string" || !targetPath.trim()) {
    return { ok: false, reason: "invalid-target-path" };
  }

  const { realpathSync, renameSync, existsSync: exists } = await import("node:fs");
  const { cp, writeFile } = await import("node:fs/promises");
  const { join, resolve: resolvePath } = await import("node:path");
  const { randomUUID } = await import("node:crypto");

  let canonicalTargetPath;
  try {
    canonicalTargetPath = realpathSync(resolvePath(targetPath));
  } catch {
    return { ok: false, reason: "workspace-path-not-selected" };
  }

  if (!selectedMigrationPath || canonicalTargetPath !== selectedMigrationPath) {
    return { ok: false, reason: "workspace-path-not-selected" };
  }

  targetPath = canonicalTargetPath;

  // --- THE DESTINATION SAFETY GUARD ---
  if (isDestinationOccupied(targetPath)) {
    return { ok: false, reason: "destination-occupied" };
  }

  mkdirSync(targetPath, { recursive: true });

  const legacyDbPath = join(legacyUserDataPath, "progress-ledger-v2.db");
  const hasLegacyData = exists(legacyDbPath);

  if (hasLegacyData) {
    checkpointDbFn(legacyDbPath);
    const targetDbPath = join(targetPath, "progress-ledger-v2.db");
    await cp(legacyDbPath, targetDbPath);

    const verifyRes = verifyDbFn(targetDbPath);
    if (!verifyRes.success) {
      throw new Error(`Database verification failed: ${verifyRes.message}`);
    }

    const legacyAttachments = join(legacyUserDataPath, "attachments");
    const targetAttachments = join(targetPath, "attachments");
    if (exists(legacyAttachments)) {
      await cp(legacyAttachments, targetAttachments, { recursive: true });
    }
  }

  const wsJsonPath = join(targetPath, "workspace.json");
  await writeFile(
    wsJsonPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        workspaceId: randomUUID(),
        createdAt: new Date().toISOString(),
        appVersion: "0.1.0",
      },
      null,
      2
    )
  );

  setActiveWorkspaceFn(targetPath);
  switchWorkspaceFn(targetPath);

  if (hasLegacyData) {
    const getUniqueMigratedPath = (originalPath) => {
      let target = `${originalPath}.migrated`;
      let counter = 1;
      while (exists(target)) {
        target = `${originalPath}.migrated-${counter++}`;
      }
      return target;
    };
    renameSync(legacyDbPath, getUniqueMigratedPath(legacyDbPath));
  }

  return { ok: true };
}

test("TEST A (workflow) — occupied database destination: migration rejected and sentinel untouched", async () => {
  const sourceDir = makeTempDir("cf-src-");
  const destDir = makeTempDir("cf-dest-");
  try {
    // Setup source with legacy DB
    const sourceDbPath = join(sourceDir, "progress-ledger-v2.db");
    const sourceDbContent = "ORIGINAL_SOURCE_DATABASE_CONTENT_BYTES_12345";
    writeFileSync(sourceDbPath, sourceDbContent);

    // Setup destination with sentinel DB
    const destDbPath = join(destDir, "progress-ledger-v2.db");
    const destSentinelContent = "PREEXISTING_TARGET_DATABASE_SENTINEL_98765";
    writeFileSync(destDbPath, destSentinelContent);

    let checkpointCalled = false;
    let activated = false;

    const result = await simulateMigrationHandler({
      targetPath: destDir,
      selectedMigrationPath: destDir,
      legacyUserDataPath: sourceDir,
      checkpointDbFn: () => { checkpointCalled = true; },
      setActiveWorkspaceFn: () => { activated = true; },
      switchWorkspaceFn: () => { activated = true; },
    });

    // 1. Result must be deterministic rejection
    assert.deepEqual(result, { ok: false, reason: "destination-occupied" });

    // 2. Destination sentinel must remain byte-for-byte identical
    assert.equal(readFileSync(destDbPath, "utf8"), destSentinelContent);

    // 3. Source DB must remain unchanged and NOT renamed to .migrated
    assert.equal(readFileSync(sourceDbPath, "utf8"), sourceDbContent);
    assert.equal(existsSync(`${sourceDbPath}.migrated`), false);

    // 4. No checkpoint or activation must have occurred
    assert.equal(checkpointCalled, false, "checkpointDb must not be called on rejection");
    assert.equal(activated, false, "workspace activation must not occur on rejection");

    // 5. No workspace.json created in destination
    assert.equal(existsSync(join(destDir, "workspace.json")), false);
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(destDir, { recursive: true, force: true });
  }
});

test("TEST B (workflow) — occupied attachment destination: migration rejected and attachments untouched", async () => {
  const sourceDir = makeTempDir("cf-src-");
  const destDir = makeTempDir("cf-dest-");
  try {
    // Source data
    const sourceDbPath = join(sourceDir, "progress-ledger-v2.db");
    writeFileSync(sourceDbPath, "SOURCE_DB");
    const sourceAttach = join(sourceDir, "attachments");
    mkdirSync(sourceAttach, { recursive: true });
    writeFileSync(join(sourceAttach, "source_note.pdf"), "SOURCE_NOTE_PDF");

    // Destination with preexisting attachment
    const destAttach = join(destDir, "attachments");
    mkdirSync(destAttach, { recursive: true });
    const destSentinelAttach = join(destAttach, "preexisting_receipt.pdf");
    const destSentinelBytes = "IMPORTANT_USER_RECEIPT_DO_NOT_OVERWRITE";
    writeFileSync(destSentinelAttach, destSentinelBytes);

    let checkpointCalled = false;
    let activated = false;

    const result = await simulateMigrationHandler({
      targetPath: destDir,
      selectedMigrationPath: destDir,
      legacyUserDataPath: sourceDir,
      checkpointDbFn: () => { checkpointCalled = true; },
      setActiveWorkspaceFn: () => { activated = true; },
      switchWorkspaceFn: () => { activated = true; },
    });

    assert.deepEqual(result, { ok: false, reason: "destination-occupied" });
    assert.equal(readFileSync(destSentinelAttach, "utf8"), destSentinelBytes);
    assert.equal(existsSync(join(destDir, "progress-ledger-v2.db")), false);
    assert.equal(existsSync(join(destDir, "workspace.json")), false);
    assert.equal(checkpointCalled, false);
    assert.equal(activated, false);
    assert.equal(existsSync(`${sourceDbPath}.migrated`), false);
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(destDir, { recursive: true, force: true });
  }
});

test("TEST C (workflow) — occupied workspace metadata: migration rejected and workspace.json untouched", async () => {
  const sourceDir = makeTempDir("cf-src-");
  const destDir = makeTempDir("cf-dest-");
  try {
    const sourceDbPath = join(sourceDir, "progress-ledger-v2.db");
    writeFileSync(sourceDbPath, "SOURCE_DB");

    // Destination already has workspace.json
    const wsJsonPath = join(destDir, "workspace.json");
    const preexistingWsContent = JSON.stringify({
      schemaVersion: 1,
      workspaceId: "existing-user-workspace-id-12345",
      customSetting: "keep-me",
    });
    writeFileSync(wsJsonPath, preexistingWsContent);

    let activated = false;

    const result = await simulateMigrationHandler({
      targetPath: destDir,
      selectedMigrationPath: destDir,
      legacyUserDataPath: sourceDir,
      setActiveWorkspaceFn: () => { activated = true; },
      switchWorkspaceFn: () => { activated = true; },
    });

    assert.deepEqual(result, { ok: false, reason: "destination-occupied" });
    assert.equal(readFileSync(wsJsonPath, "utf8"), preexistingWsContent);
    assert.equal(existsSync(join(destDir, "progress-ledger-v2.db")), false);
    assert.equal(activated, false);
    assert.equal(existsSync(`${sourceDbPath}.migrated`), false);
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(destDir, { recursive: true, force: true });
  }
});

test("TEST D (workflow) — genuinely empty destination permits successful migration", async () => {
  const sourceDir = makeTempDir("cf-src-");
  const destDir = makeTempDir("cf-dest-");
  try {
    // Setup source with legacy DB and attachments
    const sourceDbPath = join(sourceDir, "progress-ledger-v2.db");
    const sourceDbContent = "REAL_SOURCE_SQLITE_DATA";
    writeFileSync(sourceDbPath, sourceDbContent);

    const sourceAttach = join(sourceDir, "attachments");
    mkdirSync(sourceAttach, { recursive: true });
    writeFileSync(join(sourceAttach, "essay.pdf"), "ESSAY_CONTENT");

    let checkpointCalled = false;
    let activatedPath = null;

    const result = await simulateMigrationHandler({
      targetPath: destDir,
      selectedMigrationPath: destDir,
      legacyUserDataPath: sourceDir,
      checkpointDbFn: () => { checkpointCalled = true; },
      setActiveWorkspaceFn: (p) => { activatedPath = p; },
      switchWorkspaceFn: (p) => { activatedPath = p; },
    });

    // 1. Result is success
    assert.deepEqual(result, { ok: true });

    // 2. Checkpoint was executed
    assert.equal(checkpointCalled, true);

    // 3. Destination DB has source content
    const destDbPath = join(destDir, "progress-ledger-v2.db");
    assert.equal(readFileSync(destDbPath, "utf8"), sourceDbContent);

    // 4. Destination attachments copied
    assert.equal(readFileSync(join(destDir, "attachments", "essay.pdf"), "utf8"), "ESSAY_CONTENT");

    // 5. Destination workspace.json created
    assert.equal(existsSync(join(destDir, "workspace.json")), true);

    // 6. Destination was activated
    assert.equal(activatedPath, destDir);

    // 7. Source DB renamed to .migrated
    assert.equal(existsSync(`${sourceDbPath}.migrated`), true);
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(destDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. TEST F — UI / IPC Rejection Contract Verification
// ---------------------------------------------------------------------------

test("TEST F — UI/IPC contract: migration rejection is caught and presented as user-facing error", () => {
  const migrationScript = readFileSync(new URL("../src/migration.js", import.meta.url), "utf8");

  // Verify that migration.js checks the returned result and maps 'destination-occupied' to a clear error
  assert.match(migrationScript, /const res = await window\.migration\.start\(selectedPath\);/);
  assert.match(migrationScript, /if \(res && res\.ok === false\)/);
  assert.match(migrationScript, /res\.reason === ["']destination-occupied["']/);
  assert.match(migrationScript, /The selected directory is not empty/);
  assert.match(migrationScript, /errBox\.textContent = err\.message/);
  assert.match(migrationScript, /errBox\.style\.display = ['"]block['"]/);
});
