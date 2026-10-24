import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mainSource = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");

test("migration IPC binds privileged operations to the migration window sender", () => {
  assert.match(mainSource, /const isMigrationSender = \(event\) =>\s*event\?\.sender === migWindow\.webContents\s*&& event\?\.senderFrame === migWindow\.webContents\.mainFrame/s);
  assert.match(mainSource, /handle\("migration:select-dir", async \(event\) => \{\s*if \(!isMigrationSender\(event\)\)/s);
  assert.match(mainSource, /handle\("migration:cancel", \(event\) => \{\s*if \(!isMigrationSender\(event\)\)/s);
  assert.match(mainSource, /handle\("migration:start", async \(event, targetPath\) => \{\s*if \(!isMigrationSender\(event\)/s);
  assert.doesNotMatch(mainSource, /handleOnce\("migration:/);
});

test("migration:start validates the renderer-supplied workspace path before filesystem mutation", () => {
  assert.match(mainSource, /typeof targetPath !== "string" \|\| !targetPath\.trim\(\) \|\| !isAbsolute\(targetPath\)/);
  assert.match(mainSource, /targetPath = resolvePath\(targetPath\);/);
  const mkdirIndex = mainSource.indexOf("mkdirSync(targetPath");
  const validationIndex = mainSource.indexOf("isAbsolute(targetPath)");
  assert.ok(validationIndex >= 0 && validationIndex < mkdirIndex, "path validation must precede mkdirSync");
  assert.match(mainSource, /selectedMigrationPath = realpathSync\(resolvePath\(res\.filePaths\[0\]\)\)/);
  assert.match(mainSource, /canonicalTargetPath = realpathSync\(targetPath\)/);
  assert.match(mainSource, /if \(!selectedMigrationPath \|\| canonicalTargetPath !== selectedMigrationPath\)/);
  assert.match(mainSource, /targetPath = canonicalTargetPath;/);
  assert.match(mainSource, /core\.checkpointDb\(legacyDbPath\);/);
});

test("main renderer navigation is restricted to the packaged UI or Vite dev origin", () => {
  assert.match(mainSource, /const builtUiPath = resolvePath\(join\(__dirname, "\.\.\/\.\.\/ui\/dist\/index\.html"\)\)/);
  assert.match(mainSource, /url\.hostname === ""/);
  assert.match(mainSource, /resolvePath\(fileURLToPath\(url\)\) === builtUiPath/);
  assert.match(mainSource, /webContents\.on\("will-navigate", rejectUntrustedNavigation\)/);
  assert.match(mainSource, /webContents\.on\("will-redirect", rejectUntrustedNavigation\)/);
  assert.match(mainSource, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(mainSource, /url\.hostname === "127\.0\.0\.1"/);
  assert.match(mainSource, /url\.port === "5173"/);
});

test("migration handlers are persistent until explicit cleanup", () => {
  assert.doesNotMatch(mainSource, /handleOnce\("migration:/);
  assert.match(mainSource, /ipcMain\.removeHandler\("migration:select-dir"\)/);
  assert.match(mainSource, /ipcMain\.removeHandler\("migration:cancel"\)/);
  assert.match(mainSource, /ipcMain\.removeHandler\("migration:start"\)/);
});

test("closing migration is cancellation without an unhandled rejection", () => {
  assert.match(mainSource, /if \(migration\?\.cancelled\) return;/);
  assert.match(mainSource, /resolve\(\{ cancelled: true \}\);\s*app\.quit\(\);/s);
  assert.doesNotMatch(mainSource, /reject\(new Error\("Migration window closed before completing\."\)\)/);
});


test("migration wizard script is external so strict CSP does not block first-run controls", () => {
  const html = readFileSync(new URL("../src/migration.html", import.meta.url), "utf8");
  assert.match(html, /<script\s+src=["']migration\.js["']\s*><\/script>/);
  assert.doesNotMatch(html, /<script\s*>[\s\S]*window\.migration/);
  const migrationScript = readFileSync(new URL("../src/migration.js", import.meta.url), "utf8");
  assert.match(migrationScript, /window\.migration\.selectDirectory/);
  assert.match(migrationScript, /window\.migration\.start/);
  assert.match(migrationScript, /window\.migration\.onProgress/);
});
