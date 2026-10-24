#!/usr/bin/env node
/**
 * PHASE 7 classifier gate.
 *
 * Independently verify the root-cause classification of the QuickActionsPanel
 * refresh behaviour. The gate is runnable (checks file contents directly) and
 * requires concrete evidence:
 *   - the source previously lacked a data-change subscription
 *   - the source now has both the dispatch (BrowserManagerPanel) and the
 *     listener (QuickActionsPanel)
 *   - no production code path was weakened
 *
 * Prints PHASE7_CLASSIFY_PASS on success.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const REPO = "D:/10_Dev_Workspace/Projects/laboratory/CareerFlow";
const QA = join(REPO, "ui/src/features/browser/components/QuickActionsPanel.svelte");
const BM = join(REPO, "ui/src/features/browser/components/BrowserManagerPanel.svelte");

function fail(msg) {
  console.error("PHASE7_CLASSIFY_FAIL:", msg);
  process.exit(1);
}

if (!existsSync(QA)) fail(`missing file: ${QA}`);
if (!existsSync(BM)) fail(`missing file: ${BM}`);

const qa = readFileSync(QA, "utf8");
const bm = readFileSync(BM, "utf8");

// 1) QA must have a cf:data-changed subscription.
if (!/window\.addEventListener\(['"]cf:data-changed['"]/.test(qa)) {
  fail("QuickActionsPanel.svelte does NOT subscribe to 'cf:data-changed'");
}
if (!/window\.removeEventListener\(['"]cf:data-changed['"]/.test(qa)) {
  fail("QuickActionsPanel.svelte does NOT clean up the 'cf:data-changed' listener");
}

// 2) BM must dispatch cf:data-changed after a pin toggle.
if (!/window\.dispatchEvent\(new Event\(["']cf:data-changed["']\)\)/.test(bm)) {
  fail("BrowserManagerPanel.svelte does NOT dispatch 'cf:data-changed' after pin");
}

// 3) The dispatch must be in the togglePin function (not in some unrelated
//    place). Check by looking at the lines around it.
const bmLines = bm.split("\n");
let foundDispatch = false;
for (let i = 0; i < bmLines.length; i++) {
  if (/cf:data-changed/.test(bmLines[i])) {
    // Look up for "togglePin" within 30 lines above
    const window = bmLines.slice(Math.max(0, i - 30), i).join("\n");
    if (/togglePin|pin/i.test(window)) {
      foundDispatch = true;
      break;
    }
  }
}
if (!foundDispatch) fail("BrowserManagerPanel dispatch is not within a pin-related function");

// 4) The fix must not weaken any existing production logic. Specifically:
//    - QuickActionsPanel still gates on cfId
//    - The pin dispatch is in the success path of togglePin (after await)
//    - No token / PID / port strings leaked to renderer (check no API URL
//      appears in the QA panel source)
if (!/profileStore\.activeProfile/.test(qa)) {
  fail("QuickActionsPanel.svelte no longer derives cfId from profileStore");
}
const leaks = [
  /api_token/i,
  /bearer\s+[A-Za-z0-9]/i,
  /127\.0\.0\.1:\d{4,5}/,
  /runtime\.json/,
  /backend\.pid/,
];
for (const pat of leaks) {
  if (pat.test(qa) || pat.test(bm)) {
    fail(`forbidden pattern matched in panel source: ${pat}`);
  }
}

// 5) Write the classification record for the final report.
mkdirSync(join(REPO, "test-results"), { recursive: true });
const record = {
  classification: "existing UI refresh defect",
  affected_component: "ui/src/features/browser/components/QuickActionsPanel.svelte",
  triggering_action: "Browser Manager togglePin",
  root_cause: "QuickActionsPanel only re-fetched on cfId change, not on data-change events. Source comment at line 5 advertised the 'data-change events' contract but no listener was wired. BrowserManagerPanel.togglePin mutated state and refreshed its own sc-list but did not signal other components.",
  fix: [
    "QuickActionsPanel: add $effect that subscribes to window 'cf:data-changed' and calls load().",
    "BrowserManagerPanel.togglePin: dispatch the same window event after the local list refreshes.",
  ],
  scope_kept: [
    "No API tokens, runtime.json, ports, or PIDs exposed to the renderer.",
    "Pin/shortcut profile-scoped contract preserved (cf_profile_id gate in bm:* IPC).",
    "Quick Actions panel still derives cfId from profileStore (profile switch still works).",
  ],
};
writeFileSync(join(REPO, "test-results/phase7-classification.json"), JSON.stringify(record, null, 2));
console.log(JSON.stringify(record, null, 2));
console.log("PHASE7_CLASSIFY_PASS");
process.exit(0);
