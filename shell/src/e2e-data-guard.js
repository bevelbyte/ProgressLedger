// Real-data guard for test mode (Stage 2.5).
//
// Test mode (PROGRESSLEDGER_V2_E2E=1 or PROGRESSLEDGER_V2_MIGRATION_TEST=1)
// must never run against the user's real data folder: past test runs wrote
// workspace profiles (e.g. "Browser Phase Two") into the real app data
// because a driver launched the app without PROGRESSLEDGER_V2_E2E_USER_DATA
// (main ignores Chromium's --user-data-dir for app.getPath("userData")).
// This module is pure (no Electron dependency) so the shell tests can
// prove the comparison without launching the app.
//
// Rule: refuse when the resolved test data path EQUALS the real data
// folder, or sits INSIDE it (a nested test dir would still pollute the
// user's tree). A sibling (progress-ledger-v2-other) or an unrelated
// folder is allowed. On Windows the comparison is case-insensitive and
// ignores trailing separators.
import { resolve, sep } from "node:path";

export function isRealDataPath(requested, realDir) {
  if (typeof requested !== "string" || requested.length === 0) return false;
  if (typeof realDir !== "string" || realDir.length === 0) return false;
  const normalize = (p) => {
    let s = resolve(p);
    if (process.platform === "win32") s = s.toLowerCase();
    return s.replace(/[\\/]+$/, "");
  };
  const want = normalize(requested);
  const real = normalize(realDir);
  if (want === real) return true;
  return want.startsWith(real + sep);
}
