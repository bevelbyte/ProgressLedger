// Security audit log tests.
//
// Exercises the core contract of the audit log:
//   - log() appends and recent() returns the event
//   - the in-memory ring caps at 50k entries (older ones shift out)
//   - list() filters by event name and profileId
//   - redaction strips API keys / Bearer tokens from input_summary
//     and detail at the log() boundary
//   - persistence across restart: start() re-loads the JSONL file so a
//     second start() returns the same data

import testFn from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Audit, _resetForTests, _setStateForTests, _INTERNAL } from "../src/services/audit/index.js";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "progressledger-audit-"));
}

async function withTempDir(fn) {
  const dir = makeTempDir();
  try {
    return await fn(dir);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// log() / recent() / list()
// ---------------------------------------------------------------------------

testFn("log() appends an event; recent() returns it", () => {
  _resetForTests();
  _setStateForTests({ filePath: null });
  Audit.log({
    event: "tool.invoked",
    profileId: 1,
    projectId: 2,
    agentId: 3,
    tool: "exec_run",
    input_summary: "exec_run",
    result: null,
    durationMs: null,
    detail: null,
  });
  const r = Audit.recent(10);
  assert.equal(r.length, 1);
  assert.equal(r[0].event, "tool.invoked");
  assert.equal(r[0].profileId, 1);
  assert.equal(r[0].projectId, 2);
  assert.equal(r[0].agentId, 3);
  assert.equal(r[0].tool, "exec_run");
  // Most recent first.
  assert.equal(r[0].ts <= Date.now(), true);
  _resetForTests();
});

// ---------------------------------------------------------------------------
// ring cap rotation
// ---------------------------------------------------------------------------

testFn("ring cap rotates oldest events off the in-memory ring", () => {
  _resetForTests();
  _setStateForTests({ filePath: null, ring: [], lineCount: 0 });
  // Push 3 more events than the cap. The first 3 should be shifted
  // out of the ring; only the most recent MAX_LINES entries remain.
  const over = 3;
  for (let i = 0; i < _INTERNAL.MAX_LINES + over; i++) {
    Audit.log({ event: "tool.invoked", tool: `t-${i}` });
  }
  const r = Audit.recent(_INTERNAL.MAX_LINES + 10);
  assert.equal(r.length, _INTERNAL.MAX_LINES);
  // Oldest kept should be `t-over`; newest should be the final one.
  assert.equal(r[r.length - 1].tool, `t-${over}`);
  assert.equal(r[0].tool, `t-${_INTERNAL.MAX_LINES + over - 1}`);
  _resetForTests();
});

// ---------------------------------------------------------------------------
// filtering
// ---------------------------------------------------------------------------

testFn("list() filters by event name", () => {
  _resetForTests();
  _setStateForTests({ filePath: null });
  Audit.log({ event: "tool.invoked", tool: "a" });
  Audit.log({ event: "tool.completed", tool: "a" });
  Audit.log({ event: "tool.invoked", tool: "b" });
  const invoked = Audit.list({ event: "tool.invoked" });
  assert.equal(invoked.length, 2);
  for (const ev of invoked) assert.equal(ev.event, "tool.invoked");
  _resetForTests();
});

testFn("list() filters by profileId", () => {
  _resetForTests();
  _setStateForTests({ filePath: null });
  Audit.log({ event: "tool.invoked", profileId: 1, tool: "a" });
  Audit.log({ event: "tool.invoked", profileId: 2, tool: "b" });
  Audit.log({ event: "tool.invoked", profileId: 1, tool: "c" });
  const p1 = Audit.list({ profileId: 1 });
  assert.equal(p1.length, 2);
  for (const ev of p1) assert.equal(ev.profileId, 1);
  _resetForTests();
});

// ---------------------------------------------------------------------------
// redaction
// ---------------------------------------------------------------------------

testFn("redaction strips apiKey / Bearer tokens from input_summary + detail", () => {
  _resetForTests();
  _setStateForTests({ filePath: null });
  const SECRET = "sk-1234567890abcdefghijklmnopqrstuvwxyz";
  Audit.log({
    event: "provider.call",
    tool: "streamChat",
    input_summary: `apiKey=${SECRET} payload=hello`,
    detail: "Bearer " + SECRET + " used",
  });
  const r = Audit.recent(1);
  assert.equal(r.length, 1);
  // The raw secret must never appear in the persisted event.
  assert.equal(r[0].input_summary.includes(SECRET), false, "input_summary must not contain the raw secret");
  assert.equal(r[0].detail.includes(SECRET), false, "detail must not contain the raw secret");
  assert.equal(r[0].input_summary.includes("<redacted>"), true);
  _resetForTests();
});

testFn("redaction strips stray Bearer token from detail", () => {
  _resetForTests();
  _setStateForTests({ filePath: null });
  Audit.log({
    event: "auth.failed",
    tool: null,
    detail: "request rejected because Bearer abc.def.ghi was expired",
  });
  const r = Audit.recent(1);
  assert.equal(r.length, 1);
  assert.equal(r[0].detail.includes("abc.def.ghi"), false);
  assert.equal(r[0].detail.includes("Bearer <redacted>"), true);
  _resetForTests();
});

testFn("redaction strips OpenAI sk- key from input_summary", () => {
  _resetForTests();
  _setStateForTests({ filePath: null });
  const OPENAI = "sk-abcdefghijklmnopqrstuv"; // 22 chars after sk-
  Audit.log({
    event: "provider.call",
    tool: "streamChat",
    input_summary: `using key ${OPENAI} for chat`,
  });
  const r = Audit.recent(1);
  assert.equal(r.length, 1);
  assert.equal(r[0].input_summary.includes(OPENAI), false, "raw OpenAI key must be redacted");
  assert.equal(r[0].input_summary.includes("sk-<redacted>"), true);
  _resetForTests();
});

testFn("redaction strips GitHub ghp_ token from detail", () => {
  _resetForTests();
  _setStateForTests({ filePath: null });
  const GHP = "ghp_" + "a".repeat(36); // exactly 36 alnum after the prefix
  Audit.log({
    event: "tool.invoked",
    tool: "gh",
    detail: `auth header: ${GHP}`,
  });
  const r = Audit.recent(1);
  assert.equal(r.length, 1);
  assert.equal(r[0].detail.includes(GHP), false, "raw GitHub PAT must be redacted");
  assert.equal(r[0].detail.includes("ghp_<redacted>"), true);
  _resetForTests();
});

testFn("redaction strips AWS AKIA access key", () => {
  _resetForTests();
  _setStateForTests({ filePath: null });
  const AWS = "AKIA" + "1A2B3C4D5E6F7G8H"; // AKIA + 16 uppercase alnum
  Audit.log({
    event: "provider.call",
    tool: "s3",
    input_summary: `aws_key=${AWS} bucket=foo`,
  });
  const r = Audit.recent(1);
  assert.equal(r.length, 1);
  assert.equal(r[0].input_summary.includes(AWS), false, "raw AWS key must be redacted");
  assert.equal(r[0].input_summary.includes("AKIA<redacted>"), true);
  _resetForTests();
});

testFn("redaction strips Stripe sk_live_ secret key", () => {
  _resetForTests();
  _setStateForTests({ filePath: null });
  const STRIPE = "sk_live_" + "x".repeat(24); // 24 chars after the prefix
  Audit.log({
    event: "provider.call",
    tool: "stripe",
    input_summary: `stripe key ${STRIPE} was used`,
  });
  const r = Audit.recent(1);
  assert.equal(r.length, 1);
  assert.equal(r[0].input_summary.includes(STRIPE), false, "raw Stripe key must be redacted");
  assert.equal(r[0].input_summary.includes("sk_live_<redacted>"), true);
  _resetForTests();
});

testFn("redaction strips password field value", () => {
  _resetForTests();
  _setStateForTests({ filePath: null });
  Audit.log({
    event: "tool.invoked",
    tool: "login",
    input_summary: "password=hunter2 user=alice",
  });
  const r = Audit.recent(1);
  assert.equal(r.length, 1);
  assert.equal(r[0].input_summary.includes("hunter2"), false, "raw password must be redacted");
  assert.equal(r[0].input_summary.includes("password: <redacted>"), true);
  _resetForTests();
});

testFn("redaction strips Authorization: Bearer in any string field", () => {
  _resetForTests();
  _setStateForTests({ filePath: null });
  Audit.log({
    event: "tool.invoked",
    tool: "exec_run",
    input_summary: "Authorization: Bearer ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", // not a real ghp_, just a token
    detail: "request used Authorization: Bearer someLongTokenValue123",
  });
  const r = Audit.recent(1);
  assert.equal(r.length, 1);
  assert.equal(r[0].input_summary.includes("Bearer ghp_zzzzz"), false);
  assert.equal(r[0].detail.includes("someLongTokenValue123"), false);
  assert.equal(r[0].input_summary.includes("<redacted>"), true);
  assert.equal(r[0].detail.includes("<redacted>"), true);
  _resetForTests();
});

testFn("redaction strips URL query params carrying secrets", () => {
  _resetForTests();
  _setStateForTests({ filePath: null });
  const URL = "https://api.example.com/v1/echo?token=abc123def456&api_key=sk-zzzzzzzzzzzzzzzzzzzz&secret=topsecret&page=2";
  Audit.log({
    event: "tool.invoked",
    tool: "http_get",
    input_summary: `fetched ${URL}`,
  });
  const r = Audit.recent(1);
  assert.equal(r.length, 1);
  const s = r[0].input_summary;
  assert.equal(s.includes("abc123def456"), false, "raw token must be redacted");
  assert.equal(s.includes("sk-zzzzzzzzzzzzzzzzzzzz"), false, "raw api_key must be redacted");
  assert.equal(s.includes("topsecret"), false, "raw secret must be redacted");
  assert.equal(s.includes("page=2"), true, "non-secret params must be preserved");
  assert.equal(s.includes("token=<redacted>"), true);
  assert.equal(s.includes("secret=<redacted>"), true);
  _resetForTests();
});

testFn("redaction handles combo: input_summary has Bearer + detail has apiKey", () => {
  _resetForTests();
  _setStateForTests({ filePath: null });
  const SECRET = "sk-1234567890abcdefghij"; // 20 chars after sk-, plain sk- pattern
  Audit.log({
    event: "provider.call",
    tool: "streamChat",
    input_summary: `Authorization: Bearer longTokenString1234 sent`,
    detail: `apiKey=${SECRET} payload=hello`,
  });
  const r = Audit.recent(1);
  assert.equal(r.length, 1);
  assert.equal(r[0].input_summary.includes("longTokenString1234"), false, "Bearer token must be redacted");
  assert.equal(r[0].detail.includes(SECRET), false, "apiKey value must be redacted");
  assert.equal(r[0].input_summary.includes("Authorization: <redacted>"), true);
  assert.equal(r[0].detail.includes("apiKey: <redacted>"), true);
  _resetForTests();
});

// ---------------------------------------------------------------------------
// persistence across restart
// ---------------------------------------------------------------------------

testFn("persistence: start() twice returns the same ring", async () => {
  _resetForTests();
  await withTempDir(async (dir) => {
    const filePath = join(dir, "audit-log.jsonl");
    // First run: log 2 events, then stop (which flushes the ring to disk).
    await Audit.start(filePath);
    Audit.log({ event: "tool.invoked", tool: "x" });
    Audit.log({ event: "tool.completed", tool: "x" });
    await Audit.flush();

    // The file MUST exist after flush() awaits the in-flight writes.
    const { existsSync } = await import("node:fs");
    if (!existsSync(filePath)) {
      assert.fail(`file never created; dir=${dir}`);
    }

    // Second run: read back from disk, expect 2 events.
    await Audit.start(filePath);
    const r = Audit.recent(10);
    assert.equal(r.length >= 2, true, `expected at least 2 events after reload, got ${r.length}`);
    const events = r.map((e) => e.event);
    assert.equal(events.includes("tool.invoked"), true);
    assert.equal(events.includes("tool.completed"), true);
    await Audit.stop();
  });
  _resetForTests();
});

// ---------------------------------------------------------------------------
// constants sanity
// ---------------------------------------------------------------------------

testFn("cap constant matches the spec (50_000)", () => {
  assert.equal(_INTERNAL.MAX_LINES, 50_000);
  assert.equal(typeof _INTERNAL.ROTATED_NAME, "string");
  assert.equal(typeof _INTERNAL.LIVE_NAME, "string");
});