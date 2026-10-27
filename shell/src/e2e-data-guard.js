// Real-data guard for test mode (Stage 2.5, extended in the follow-up round).
//
// Test mode (PROGRESSLEDGER_V2_E2E=1 or PROGRESSLEDGER_V2_MIGRATION_TEST=1)
// must never run against the user's real data folder: past test runs wrote
// workspace profiles (e.g. "Browser Phase Two") into the real app data
// because a driver launched the app without PROGRESSLEDGER_V2_E2E_USER_DATA.
// This module is pure (no Electron dependency) so the shell tests can
// prove the comparison without launching the app.
//
// Rule: refuse when the resolved test data path EQUALS the real data
// folder, or sits INSIDE it (a nested test dir would still pollute the
// user's tree). A sibling (progress-ledger-v2-other) or an unrelated
// folder is allowed. On Windows the comparison is case-insensitive and
// ignores trailing separators.
//
// Data-folder resolution (follow-up round): in test mode the app now
// honours the browser's data-folder flag explicitly. Chromium's
// --user-data-dir does NOT change app.getPath("userData") on its own, so
// main reads it back with app.commandLine.getSwitchValue and feeds it
// here. Precedence: the test env var wins, then the --user-data-dir flag,
// then (refusing) the real folder. Production mode ignores both inputs
// and always uses the real folder — that is the user's own app, not a
// test run.
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

/**
 * Resolve the data folder for one launch and say whether test mode must
 * refuse it. Pure: every entry point (dev run, E2E, migration test,
 * packaged app with the test flag) funnels through main, and main funnels
 * through this function, so the shell tests below cover all of them.
 *
 * @param {{isTestMode: boolean, envDir?: unknown, cliDir?: unknown, realDir: string}}
 * @returns {{dir: string, refused: boolean}}
 */
export function resolveTestDataDir({ isTestMode, envDir, cliDir, realDir }) {
  if (!isTestMode) return { dir: realDir, refused: false };
  const has = (v) => typeof v === "string" && v.length > 0;
  const candidate = has(envDir) ? envDir : has(cliDir) ? cliDir : realDir;
  return { dir: candidate, refused: isRealDataPath(candidate, realDir) };
}
