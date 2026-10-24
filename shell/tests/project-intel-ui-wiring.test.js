// Project Intelligence — production wiring for the new indexing control.
//
// WHY THIS TEST EXISTS
//   The ChangedFilesPanel has always rendered the hint
//     "Times come from the file index; re-index to timestamp every row."
//   while providing no way to re-index. `indexProject` is reachable only through
//   `project:intel:index`, and no renderer surface ever called it, so in the
//   running app the index was never built and the "written at" column was
//   permanently an em-dash. That is recorded as P-1 in CAPABILITY-MATRIX.md.
//
//   The fix added an "Index project" control. This test exists so that the
//   promise the UI makes cannot silently become unfulfillable again — the same
//   reason marketplace-production-wiring.test.js and
//   skills-production-wiring.test.js exist for their subsystems. A UI control
//   with no registered channel, or a registered channel no UI calls, is exactly
//   the defect that was just fixed.
//
// WHAT IS *NOT* ASSERTED HERE
//   Filesystem authority. That the renderer cannot choose which directory gets
//   walked is a separate, already-proven property, and it is deliberately not
//   re-implemented here:
//     * shell/tests/project-intel-ownership.test.js:36 statically pins that the
//       preload does not let a rootPath through project:intel:index;
//     * project-intel-ownership.test.js:42 passes a hostile
//       `rootPath: "C:\\foreign"` in the payload and asserts the resolved root
//       is the AUTHORIZED project's stored root.
//
//   Duplicating that here would add a second place to keep in sync without
//   adding evidence.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const IPC = readFileSync(
  new URL("../src/ipc/project-intel.js", import.meta.url),
  "utf8",
);
const PRELOAD = readFileSync(
  new URL("../src/preload.cjs", import.meta.url),
  "utf8",
);
const PANEL = readFileSync(
  new URL(
    "../../ui/src/features/project-mode/components/ChangedFilesPanel.svelte",
    import.meta.url,
  ),
  "utf8",
);

test("project:intel:index is registered and backed by the real indexer", () => {
  assert.match(IPC, /safeHandle\(\s*["']project:intel:index["']/);
  // It must reach the service, not be a stub.
  assert.match(IPC, /indexProject\(/);
  assert.match(IPC, /reindexDelta\(/);
  // And it must authorize before doing anything.
  const start = IPC.indexOf('"project:intel:index"');
  const body = IPC.slice(start, IPC.indexOf("safeHandle(", start + 12));
  assert.ok(
    body.indexOf("authorized(payload)") < body.indexOf("indexProject("),
    "project:intel:index must authorize before indexing",
  );
});

test("the preload exposes index to the renderer, ids and mode only", () => {
  assert.match(PRELOAD, /projectIntel:\s*\{/);
  assert.match(PRELOAD, /index:\s*\(\s*profileId\s*,\s*projectId\s*,\s*mode\s*\)/);
  assert.match(PRELOAD, /ipcRenderer\.invoke\(\s*["']project:intel:index["']/);
  // The renderer must not be able to name a filesystem root through this call.
  const start = PRELOAD.indexOf('"project:intel:index"');
  assert.ok(
    !/rootPath|root_path/.test(PRELOAD.slice(start, start + 300)),
    "project:intel:index must not accept a renderer-supplied root",
  );
});

test("the panel actually calls the index API, so the hint is not a dead promise", () => {
  // The control exists...
  assert.match(PANEL, /data-testid="changed-files-index"/);
  // ...and it is wired to the real API rather than a local no-op.
  assert.match(
    PANEL,
    /window\.progressLedger\.projectIntel\s*\.\s*index\s*\(/,
    "the Index project control must call projectIntel.index",
  );
  // The hint that depends on it names it, so the instruction is followable.
  assert.match(PANEL, /data-testid="changed-files-mtime-hint"/);
  assert.match(PANEL, /Index project/);
});

test("a refused index is never reported as a success", () => {
  // The dishonesty that matters: if the main process refuses (ownership,
  // root-mismatch, walk error) the panel must show the failure, not claim the
  // project was indexed.
  const start = PANEL.indexOf("async function runIndex");
  assert.ok(start > 0, "runIndex must exist");
  const body = PANEL.slice(start, PANEL.indexOf("\n  }", start));
  assert.match(body, /ok\s*!==\s*true/, "must branch on the real ok flag");
  assert.match(body, /indexError\s*=/, "must record the failure");
  assert.match(body, /indexedAt\s*=/, "success must be set separately from failure");
  // Success is only set on the success path.
  const okBranch = body.indexOf("ok !== true");
  const setOk = body.indexOf("indexedAt =");
  assert.ok(setOk > okBranch, "indexedAt must only be set after the ok check");
});
