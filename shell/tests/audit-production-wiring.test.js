// SF-3 follow-up — SECURITY AUDIT LOG PRODUCTION WIRING.
//
// THE DEFECT THIS LOCKS OUT
// `Audit.log()` is a silent no-op until `start()` has been called:
//
//     log(event) {
//       if (!state || !state.started) return;      // <-- bails out
//       ...
//     }
//
// and `list()` answers `[]` while `state` is null. Yet there are 25 production
// call sites — `project.create`, `project.delete`, `agent.create`, agent
// start/end, every project-tool invocation, shell execution, provider calls and
// the whole goal lifecycle — and `Audit.start()` had **zero** production
// callers. Only `shell/tests/audit.test.js` called it.
//
// The consequence in the real application was not a crash. It was worse: the
// security audit trail was completely inert. Nothing was written to
// `<userData>/audit-log.jsonl`, and `audit:list` / `audit:list-events` returned
// an empty array forever, so the Runs console and the Operator Console showed a
// permanently blank history while the ownership gate (SF-3) guarded nothing.
//
// This is the same class of defect as the Marketplace registry having no
// production caller: an integration only the unit tests exercised.
//
// A second, independent gap in the same subsystem: the AGENT path called
// `tool.execute()` directly (`services/agent/loop.js`) rather than through
// `runTool()`, which is the only writer of `tool.invoked` / `tool.completed` /
// `tool.failed`. So every tool the agent ran — including privileged,
// approval-gated `fs_write` / `exec_run` — produced no record at all.
//
// KNOWN, DELIBERATELY NOT CLOSED HERE: marketplace mutations, provider
// credential writes/clears, backup export/restore, and browser/Donut lifecycle
// + navigation are still unaudited. Reported as a remaining gap in
// _evidence_FINALVAL_remaining_gaps_20260926.txt, not claimed as covered.
//
// WHAT IS ASSERTED HERE
//   1. main.js imports the audit service and calls `Audit.start()` exactly once.
//   2. The path it starts is derived from the app's own userData, not a
//      hardcoded location.
//   3. The wiring sits inside `app.whenReady` (so it runs in the real app).
//   4. `will-quit` flushes the store so the last privileged action is durable.
//   5. Behavioural proof from the service itself: an unstarted store records
//      nothing and lists nothing, and a started store records and lists.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, existsSync, readFileSync as readSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Audit, _resetRetention } from "../src/services/audit/index.js";

test("main.js starts the audit log exactly once, from the app's own userData", () => {
  const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");

  assert.match(
    main,
    /import \{ Audit \} from "\.\/services\/audit\/index\.js"/,
    "main.js must import the audit service"
  );

  const starts = main.match(/Audit\.start\(/g) || [];
  assert.equal(starts.length, 1, `expected exactly one Audit.start() call site, got ${starts.length}`);

  assert.match(
    main,
    /Audit\.start\(auditPath\)/,
    "the audit store must be started with an explicit path"
  );
  assert.match(
    main,
    /const auditPath = join\(app\.getPath\("userData"\), "audit-log\.jsonl"\)/,
    "the audit path must come from app.getPath('userData'), not a hardcoded location"
  );

  // It must live inside the whenReady handler, which is the only thing that
  // runs in the real application.
  const readyIdx = main.indexOf("app.whenReady()");
  assert.ok(readyIdx > 0, "main.js must have an app.whenReady handler");
  const startIdx = main.indexOf("Audit.start(auditPath)");
  assert.ok(startIdx > readyIdx, "Audit.start() must be inside app.whenReady, not at module scope");

  // And the shutdown path must flush, so the final privileged action of a
  // session is durable rather than lost with the process.
  assert.match(main, /Audit\.stop\(\)/, "will-quit must stop (flush) the audit store");
});

test("an UNSTARTED audit store records nothing and lists nothing", async () => {
  // This is the exact production condition that made the trail inert.
  await Audit.stop();
  Audit.log({ event: "project.create", profileId: 1, projectId: 2 });
  assert.deepEqual(Audit.list({ profileId: 1 }), [], "an unstarted store must list nothing");
  assert.deepEqual(Audit.recent(10), [], "an unstarted store must have no recent events");
  assert.equal(Audit.filePath(), null, "an unstarted store has no file path");
});

test("a STARTED audit store records, lists, filters by profile, and persists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-audit-wiring-"));
  const file = join(dir, "audit-log.jsonl");
  try {
    _resetRetention();
    await Audit.start(file);
    assert.equal(Audit.filePath(), file, "a started store exposes its file path");

    Audit.log({ event: "project.create", profileId: 1, projectId: 10, result: "ok" });
    Audit.log({ event: "project.delete", profileId: 1, projectId: 10, result: "ok" });
    Audit.log({ event: "project.create", profileId: 2, projectId: 20, result: "ok" });

    const p1 = Audit.list({ profileId: 1 });
    assert.equal(p1.length, 2, "profile 1 sees only its own two events");
    assert.ok(p1.every((e) => e.profileId === 1));

    const p2 = Audit.list({ profileId: 2 });
    assert.equal(p2.length, 1, "profile 2 sees only its own event");
    assert.equal(p2[0].projectId, 20);

    // Newest first, per the documented contract.
    assert.equal(p1[0].event, "project.delete");

    // The file must actually exist and hold the JSONL lines.
    await Audit.flush();
    assert.ok(existsSync(file), "the audit log must be written to disk");
    const text = readSync(file, "utf8");
    assert.ok(text.includes('"project.create"'), "the JSONL must contain the recorded events");
    assert.equal(text.trim().split("\n").length, 3, "one JSONL line per event");
  } finally {
    await Audit.stop();
    _resetRetention();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a restarted store reloads the trail from disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-audit-restart-"));
  const file = join(dir, "audit-log.jsonl");
  try {
    _resetRetention();
    await Audit.start(file);
    Audit.log({ event: "agent.create", profileId: 7, projectId: 3, agentId: 5 });
    await Audit.flush();
    await Audit.stop();

    // A fresh process: the trail must come back.
    await Audit.start(file);
    const reloaded = Audit.list({ profileId: 7 });
    assert.equal(reloaded.length, 1, "the audit trail must survive an app restart");
    assert.equal(reloaded[0].event, "agent.create");
    assert.equal(reloaded[0].agentId, 5);
  } finally {
    await Audit.stop();
    _resetRetention();
    rmSync(dir, { recursive: true, force: true });
  }
});
