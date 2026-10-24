// Audit retention policy tests.
//
// Exercises the configurable retention layer added on top of the ring
// buffer:
//   - default retention is 30 days / 50_000 events
//   - _setRetention() updates the live cap immediately
//   - a smaller count cap drops older events on the next push
//   - prune() removes events older than retention.days
//   - prune() is a no-op when nothing needs pruning
//   - _resetRetention() restores the defaults

import testFn from "node:test";
import assert from "node:assert/strict";

import {
  Audit,
  _resetForTests,
  _setStateForTests,
  _getRetention,
  _setRetention,
  _resetRetention,
  prune,
  _INTERNAL,
} from "../src/services/audit/index.js";

// ---------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------

testFn("default retention is 30 days / 50_000 count", () => {
  _resetForTests();
  _resetRetention();
  const r = _getRetention();
  assert.equal(r.days, 30);
  assert.equal(r.count, 50_000);
  _resetForTests();
});

// ---------------------------------------------------------------------------
// setRetention updates the live cap
// ---------------------------------------------------------------------------

testFn("_setRetention updates days and count; _getRetention reflects it", () => {
  _resetForTests();
  _resetRetention();
  const next = _setRetention({ days: 7, count: 1_000 });
  assert.equal(next.days, 7);
  assert.equal(next.count, 1_000);
  const got = _getRetention();
  assert.equal(got.days, 7);
  assert.equal(got.count, 1_000);
  _resetRetention();
  _resetForTests();
});

testFn("_setRetention clamps out-of-range values to safe defaults", () => {
  _resetForTests();
  _resetRetention();
  // Zero / negative / NaN should fall back to current values.
  const r1 = _setRetention({ days: 0, count: -5 });
  assert.equal(r1.days, 30);
  assert.equal(r1.count, 50_000);
  // Sanity upper bounds.
  const r2 = _setRetention({ days: 99_999, count: 99_999_999 });
  assert.equal(r2.days, 3650);
  assert.equal(r2.count, 1_000_000);
  _resetRetention();
  _resetForTests();
});

// ---------------------------------------------------------------------------
// smaller cap drops events faster
// ---------------------------------------------------------------------------

testFn("shrinking the count cap drops excess events on the next push", () => {
  _resetForTests();
  _resetRetention();
  _setStateForTests({ filePath: null, ring: [], lineCount: 0 });
  // Fill the ring with the default 50_000 cap.
  for (let i = 0; i < 200; i++) {
    Audit.log({ event: "tool.invoked", tool: `t-${i}` });
  }
  assert.equal(Audit.recent(9999).length, 200);
  // Shrink the cap to 100. The ring should immediately trim to 100.
  _setRetention({ count: 100 });
  assert.equal(Audit.recent(9999).length, 100);
  // Oldest kept should be t-100 (the 101st event, index 100).
  const kept = Audit.recent(9999);
  assert.equal(kept[kept.length - 1].tool, "t-100");
  assert.equal(kept[0].tool, "t-199");
  _resetRetention();
  _resetForTests();
});

// ---------------------------------------------------------------------------
// prune: removes events older than retention.days
// ---------------------------------------------------------------------------

testFn("prune() removes events older than retention.days", async () => {
  _resetForTests();
  _resetRetention();
  _setStateForTests({ filePath: null, ring: [], lineCount: 0 });
  // 1-day retention window. (_setRetention floors days to an integer,
  // so sub-1 values collapse to 0 and prune everything.)
  _setRetention({ days: 1, count: 99999 });
  const now = Date.now();
  // One stale event first (2 days old, so it lands at ring[0] and the
  // prune guard sees an out-of-window oldest entry and proceeds).
  Audit.log({ event: "tool.invoked", tool: "stale", ts: now - 2 * 86_400_000 });
  // One fresh event (ts assigned by normalize() = ~now).
  Audit.log({ event: "tool.invoked", tool: "fresh" });
  assert.equal(Audit.recent(10).length, 2);
  const removed = await prune();
  // The stale event (2 days old) is past the 1-day window; fresh is kept.
  assert.equal(removed, 1);
  const kept = Audit.recent(10);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].tool, "fresh");
  _resetRetention();
  _resetForTests();
});

// ---------------------------------------------------------------------------
// prune: no-op when nothing to prune
// ---------------------------------------------------------------------------

testFn("prune() is a no-op when the ring is empty", async () => {
  _resetForTests();
  _resetRetention();
  _setStateForTests({ filePath: null, ring: [], lineCount: 0 });
  const removed = await prune();
  assert.equal(removed, 0);
  assert.equal(Audit.recent(10).length, 0);
  _resetRetention();
  _resetForTests();
});

testFn("prune() is a no-op when all events are within retention window", async () => {
  _resetForTests();
  _resetRetention();
  _setStateForTests({ filePath: null, ring: [], lineCount: 0 });
  // 365-day retention; all events are fresh.
  _setRetention({ days: 365, count: 99999 });
  Audit.log({ event: "tool.invoked", tool: "a" });
  Audit.log({ event: "tool.invoked", tool: "b" });
  const removed = await prune();
  assert.equal(removed, 0);
  assert.equal(Audit.recent(10).length, 2);
  _resetRetention();
  _resetForTests();
});

// ---------------------------------------------------------------------------
// resetRetention restores defaults
// ---------------------------------------------------------------------------

testFn("_resetRetention() restores the default 30 days / 50_000 count", () => {
  _resetForTests();
  _resetRetention();
  _setRetention({ days: 90, count: 500 });
  _resetRetention();
  const r = _getRetention();
  assert.equal(r.days, 30);
  assert.equal(r.count, 50_000);
  _resetForTests();
});
