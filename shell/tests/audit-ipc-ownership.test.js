// SF-3 — audit IPC ownership boundary.
//
// Architecture trace (see shell/src/services/audit/index.js):
//   * the audit STORE is process-global by design — one JSONL file, one
//     in-memory ring, one module-scoped retention policy, one whole-file
//     `prune()`. Per-profile retention is NOT representable in that model and
//     is deliberately not invented.
//   * the audit EVENT surface IS profile-scoped — `audit:list` /
//     `audit:list-events` filter the ring by profileId after ownership proof.
//   * `export` / `get-retention` / `set-retention` carry no per-profile data,
//     but they are ownership-GATED anyway. Before SF-3 they were the only audit
//     channels with no ownership check, so a compromised renderer could shrink
//     the app-wide audit retention — destroying the audit trail — without
//     proving it drives any profile.
//
// These tests pin BOTH halves: the channel gate, and the process-global
// storage decision that makes a per-profile policy unnecessary.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const auditIpc = readFileSync(new URL("../src/ipc/audit.js", import.meta.url), "utf8");
const auditService = readFileSync(
  new URL("../src/services/audit/index.js", import.meta.url), "utf8",
);
const preload = readFileSync(new URL("../src/preload.cjs", import.meta.url), "utf8");

function bodyOf(channel) {
  const start = auditIpc.indexOf(`safeHandle("${channel}"`);
  assert.ok(start >= 0, `${channel} must be registered`);
  const end = auditIpc.indexOf("safeHandle(", start + 12);
  return auditIpc.slice(start, end < 0 ? auditIpc.length : end);
}

test("SF-3: every audit channel is ownership-gated, not just the event readers", () => {
  for (const channel of [
    "audit:list",
    "audit:list-events",
    "audit:export",
    "audit:get-retention",
    "audit:set-retention",
  ]) {
    const body = bodyOf(channel);
    assert.match(
      body,
      /assertProfileOwned\(ctx,\s*(options\??\.\s*profileId|profileId)\)/,
      `${channel} must require an owned profileId`,
    );
    // The ownership verdict must be checked BEFORE any store access.
    const gateAt = body.indexOf("assertProfileOwned");
    const checkAt = body.indexOf("if (!ownership.ok) return ownership;");
    assert.ok(gateAt >= 0 && checkAt > gateAt, `${channel} must reject on a failed ownership check`);
    for (const [name, token] of [
      ["Audit.filePath", "Audit.filePath("],
      ["_getRetention", "_getRetention()"],
      ["_setRetention", "_setRetention("],
      ["Audit.list", "Audit.list("],
    ]) {
      if (!body.includes(token)) continue;
      assert.ok(
        body.indexOf(token) > checkAt,
        `${channel} must not touch ${name} before ownership is proven`,
      );
    }
  }
});

test("SF-3: an unauthorized caller cannot rewrite the process-global retention policy", () => {
  const body = bodyOf("audit:set-retention");
  const gateAt = body.indexOf("if (!ownership.ok) return ownership;");
  const writeAt = body.indexOf("_setRetention(");
  assert.ok(gateAt >= 0 && writeAt > gateAt,
    "audit:set-retention must reject before mutating the global policy");
});

test("SF-3: the process-global storage decision is documented in the IPC module", () => {
  assert.match(auditIpc, /process-global/i,
    "the global-vs-scoped design decision must be documented, not implicit");
  assert.match(auditIpc, /not representable/i,
    "why per-profile retention is deliberately absent must be recorded");
  // The gate must be described as a channel gate, not a per-profile claim.
  assert.match(auditIpc, /gate is on the CHANNEL|CONTROL.*CHANNEL|on the \*\*CHANNEL\*\*/i);
});

test("SF-3: the audit store really is single-file / single-ring / single-policy", () => {
  // Pin the architectural facts the "process-global" decision rests on. If a
  // future change partitions these, the SF-3 rationale must be revisited.
  assert.match(auditService, /audit-log\.jsonl/, "one live JSONL file");
  assert.match(auditService, /const ROTATED_NAME = "audit-log\.jsonl\.1"/, "exactly one rotated backup");
  assert.match(auditService, /let retention = \{ \.\.\.DEFAULT_RETENTION \}/,
    "a single module-scoped retention policy, not a per-profile map");
  assert.doesNotMatch(auditService, /retentionByProfile|profileRetention/,
    "no per-profile retention system may be invented");
  // prune() rewrites the WHOLE file, which is why per-profile windows are not
  // representable over one log.
  assert.match(auditService, /await writeFile\(state\.filePath/, "prune rewrites the whole log");
});

test("SF-3: audit:export never discloses the absolute on-disk path", () => {
  const body = bodyOf("audit:export");
  // It may confirm a log exists, but must return a constant filename only.
  assert.match(body, /filename:\s*"audit-log\.jsonl"/);
  assert.doesNotMatch(body, /filename:\s*p\b|filename:\s*Audit\.filePath\(\)/,
    "audit:export must not return the absolute path to the renderer");
  assert.doesNotMatch(body, /return\s*\{[^}]*path:/,
    "no path field may be returned to the renderer");
});

test("SF-3: the preload bridge forwards profileId on the gated channels", () => {
  assert.match(preload, /export:\s*\(options = \{\}\) => ipcRenderer\.invoke\("audit:export", options \|\| \{\}\)/);
  assert.match(preload, /getRetention:\s*\(options = \{\}\) => ipcRenderer\.invoke\("audit:get-retention", options \|\| \{\}\)/);
  assert.match(preload, /setRetention:\s*\(options = \{\}\) => ipcRenderer\.invoke\("audit:set-retention", options \|\| \{\}\)/);
});

test("SF-3: legitimate audit behaviour is preserved (behavioural)", async () => {
  const { Audit, _getRetention, _setRetention, _resetRetention, _setStateForTests, _resetForTests } =
    await import("../src/services/audit/index.js");
  try {
    // Retention clamps still hold, so an authorized-but-misconfigured caller
    // cannot disable the audit trail.
    assert.deepEqual(_setRetention({ days: 0, count: -5 }), { days: 30, count: 50_000 });
    assert.deepEqual(_setRetention({ days: 99999, count: 99999999 }), { days: 3650, count: 1_000_000 });
    assert.deepEqual(_setRetention({ days: 60, count: 250_000 }), { days: 60, count: 250_000 });
    assert.deepEqual(_getRetention(), { days: 60, count: 250_000 });

    // Profile-scoped event reads still work off one global ring.
    _setStateForTests({ filePath: null });
    Audit.log({ event: "shell:exec", profileId: 1, detail: "a" });
    Audit.log({ event: "shell:exec", profileId: 2, detail: "b" });
    const p1 = Audit.list({ profileId: 1 });
    const p2 = Audit.list({ profileId: 2 });
    assert.equal(p1.length, 1);
    assert.equal(p1[0].detail, "a");
    assert.equal(p2.length, 1);
    assert.equal(p2[0].detail, "b");
  } finally {
    _resetRetention();
    _resetForTests();
  }
});
