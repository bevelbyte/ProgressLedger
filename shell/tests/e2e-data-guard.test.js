import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { isRealDataPath } from "../src/e2e-data-guard.js";

// Paths are written Windows-style; on this dev machine (Windows) the
// comparison is case-insensitive. The sibling/child cases are separator
// based, so they hold on any platform.
const REAL = "C:\\Users\\Asus\\AppData\\Roaming\\progress-ledger-v2";

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
  assert.equal(isRealDataPath("C:\\Users\\Asus\\AppData\\Local\\Temp\\pl-v2-test-123", REAL), false);
  assert.equal(isRealDataPath("C:\\Users\\Asus\\AppData\\Roaming\\progress-ledger", REAL), false);
});

test("empty or non-string inputs never refuse", () => {
  assert.equal(isRealDataPath("", REAL), false);
  assert.equal(isRealDataPath(REAL, ""), false);
  assert.equal(isRealDataPath(null, REAL), false);
});
