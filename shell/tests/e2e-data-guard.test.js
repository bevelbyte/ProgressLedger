import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { isRealDataPath, resolveTestDataDir } from "../src/e2e-data-guard.js";

// Paths are written Windows-style; on this dev machine (Windows) the
// comparison is case-insensitive. The sibling/child cases are separator
// based, so they hold on any platform.
const REAL = "C:\\Users\\Asus\\AppData\\Roaming\\progress-ledger-v2";
const TMP = "C:\\Users\\Asus\\AppData\\Local\\Temp\\pl-v2-test-123";

test("refuses the real folder itself", () => {
  assert.equal(isRealDataPath(REAL, REAL), true);
});

test("refuses the real folder with different case and trailing separator", () => {
  assert.equal(isRealDataPath("c:\\users\\asus\\appdata\\roaming\\PROGRESS-LEDGER-V2\\", REAL), true);
});

test("refuses a folder inside the real folder", () => {
  assert.equal(isRealDataPath(join(REAL, "Local Storage"), REAL), true);
  assert.equal(isRealDataPath(join(REAL, "crash-logs", "x.log"), REAL), true);
});

test("allows a sibling folder and an unrelated folder", () => {
  assert.equal(isRealDataPath(`${REAL}-other`, REAL), false);
  assert.equal(isRealDataPath(TMP, REAL), false);
  assert.equal(isRealDataPath("C:\\Users\\Asus\\AppData\\Roaming\\progress-ledger", REAL), false);
});

test("empty or non-string inputs never refuse", () => {
  assert.equal(isRealDataPath("", REAL), false);
  assert.equal(isRealDataPath(REAL, ""), false);
  assert.equal(isRealDataPath(null, REAL), false);
});

test("resolve: env var wins over the flag, and a good dir is allowed", () => {
  const r = resolveTestDataDir({ isTestMode: true, envDir: TMP, cliDir: "C:\\other\\dir", realDir: REAL });
  assert.equal(r.dir, TMP);
  assert.equal(r.refused, false);
});

test("resolve: the --user-data-dir flag is honoured when no env var is set", () => {
  const r = resolveTestDataDir({ isTestMode: true, envDir: undefined, cliDir: TMP, realDir: REAL });
  assert.equal(r.dir, TMP);
  assert.equal(r.refused, false);
});

test("resolve: test mode with neither input falls back to the real folder and refuses", () => {
  const r = resolveTestDataDir({ isTestMode: true, envDir: undefined, cliDir: "", realDir: REAL });
  assert.equal(r.dir, REAL);
  assert.equal(r.refused, true);
});

test("resolve: the real folder refuses through either input", () => {
  assert.equal(resolveTestDataDir({ isTestMode: true, envDir: REAL, cliDir: TMP, realDir: REAL }).refused, true);
  assert.equal(resolveTestDataDir({ isTestMode: true, envDir: undefined, cliDir: REAL, realDir: REAL }).refused, true);
  assert.equal(
    resolveTestDataDir({ isTestMode: true, envDir: join(REAL, "nested"), cliDir: TMP, realDir: REAL }).refused,
    true,
  );
});

test("resolve: production mode always uses the real folder and never refuses", () => {
  const r = resolveTestDataDir({ isTestMode: false, envDir: REAL, cliDir: TMP, realDir: REAL });
  assert.equal(r.dir, REAL);
  assert.equal(r.refused, false);
});
