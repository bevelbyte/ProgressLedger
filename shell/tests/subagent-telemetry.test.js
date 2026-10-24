// Sub-agent run telemetry tests.
//
// Covers the shell-side wrapper around the pm_insert_subagent_run /
// pm_end_subagent_run / pm_list_subagent_runs NAPI surface. The
// service is pure JS over a fake `core` so the tests do not need a
// real SQLite database.
//
// Tested contract:
//   - start() inserts a row with ended_at NULL, outcome NULL
//   - end() updates the row with outcome + tokens + error
//   - list() returns rows newest-first by started_at
//   - failed runs recorded with the supplied error
//   - cancelled runs recorded with outcome = 'cancelled'
//   - multiple concurrent runs for the same parent all recorded
//
// Pure node:test, no IPC, no Electron.

import test from "node:test";
import assert from "node:assert/strict";

import {
  start as telemetryStart,
  end as telemetryEnd,
  list as telemetryList,
} from "../src/services/agent/subagent-telemetry.js";

// ---------------------------------------------------------------------------
// helpers — an in-memory fake `core` that mirrors the NAPI surface.
// Every call mutates a `rows` Map keyed by id, so tests can assert on
// the persisted state.
// ---------------------------------------------------------------------------

function makeFakeCore({ ownershipFailIds = new Set() } = {}) {
  let nextId = 1;
  const rows = new Map(); // id -> { id, parentAgentId, role, childAgentId, runId, startedAt, endedAt, outcome, tokensIn, tokensOut, error }

  function failIfOwned(parentAgentId) {
    if (ownershipFailIds.has(parentAgentId)) {
      const e = new Error("Sub-agent run not found in this profile");
      e.code = "NOT_OWNED";
      throw e;
    }
  }

  return {
    rows, // exposed for tests
    _seedParent(_profileId, parentAgentId) {
      // Used by tests that wire ownership enforcement.
      // No-op in this fake: we trust the caller's parentAgentId.
      return parentAgentId;
    },
    async pmInsertSubagentRun(profileId, parentAgentId, role, childAgentId, runId) {
      failIfOwned(parentAgentId);
      const id = nextId++;
      const row = {
        id,
        parentAgentId,
        role: role || null,
        childAgentId: childAgentId == null ? null : childAgentId,
        runId: runId || null,
        startedAt: new Date().toISOString(),
        endedAt: null,
        outcome: null,
        tokensIn: null,
        tokensOut: null,
        error: "",
      };
      rows.set(id, row);
      return id;
    },
    async pmEndSubagentRun(_profileId, id, outcome, tokensIn, tokensOut, error) {
      const row = rows.get(id);
      if (!row) throw new Error("not found");
      if (row.endedAt !== null) {
        const e = new Error("Sub-agent run already ended");
        e.code = "INVALID_INPUT";
        throw e;
      }
      row.endedAt = new Date().toISOString();
      row.outcome = outcome;
      row.tokensIn = tokensIn;
      row.tokensOut = tokensOut;
      row.error = error || "";
    },
    async pmListSubagentRuns(_profileId, parentAgentId, limit) {
      const cap = Math.max(1, Math.min(limit == null ? 200 : limit, 1000));
      const out = [];
      for (const r of rows.values()) {
        if (parentAgentId != null && r.parentAgentId !== parentAgentId) continue;
        out.push({ ...r });
      }
      out.sort((a, b) => {
        if (a.startedAt === b.startedAt) return b.id - a.id;
        return a.startedAt < b.startedAt ? 1 : -1;
      });
      return out.slice(0, cap);
    },
  };
}

// ---------------------------------------------------------------------------
// 1) start() — records row with ended_at NULL
// ---------------------------------------------------------------------------

test("telemetry: start() inserts a row with endedAt null and outcome null", async () => {
  const core = makeFakeCore();
  const id = await telemetryStart(core, {
    profileId: 1,
    parentAgentId: 100,
    role: "researcher",
    childAgentId: 200,
    runId: "run-abc",
  });
  assert.equal(typeof id, "number");
  const row = core.rows.get(id);
  assert.ok(row, "row should be persisted");
  assert.equal(row.parentAgentId, 100);
  assert.equal(row.role, "researcher");
  assert.equal(row.childAgentId, 200);
  assert.equal(row.runId, "run-abc");
  assert.ok(row.startedAt, "startedAt should be stamped");
  assert.equal(row.endedAt, null);
  assert.equal(row.outcome, null);
  assert.equal(row.tokensIn, null);
  assert.equal(row.tokensOut, null);
  assert.equal(row.error, "");
});

// ---------------------------------------------------------------------------
// 2) end() — updates row with outcome + tokens
// ---------------------------------------------------------------------------

test("telemetry: end() updates the row with outcome + token counts", async () => {
  const core = makeFakeCore();
  const id = await telemetryStart(core, {
    profileId: 1,
    parentAgentId: 100,
    role: "coder",
    childAgentId: 201,
    runId: "run-coder",
  });
  const ok = await telemetryEnd(core, {
    profileId: 1,
    id,
    outcome: "completed",
    tokensIn: 1234,
    tokensOut: 567,
  });
  assert.equal(ok, true);
  const row = core.rows.get(id);
  assert.equal(row.outcome, "completed");
  assert.equal(row.tokensIn, 1234);
  assert.equal(row.tokensOut, 567);
  assert.ok(row.endedAt, "endedAt should be stamped");
  assert.equal(row.error, "");
});

// ---------------------------------------------------------------------------
// 3) list() — returns rows in started_at DESC order
// ---------------------------------------------------------------------------

test("telemetry: list() returns rows newest-first by started_at", async () => {
  const core = makeFakeCore();
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const id = await telemetryStart(core, {
      profileId: 1,
      parentAgentId: 100,
      role: "tester",
      childAgentId: 300 + i,
      runId: `run-${i}`,
    });
    ids.push(id);
    // Sleep one millisecond so the startedAt stamps are strictly
    // ordered. Cheap, deterministic.
    await new Promise((r) => setTimeout(r, 1));
  }
  const rows = await telemetryList(core, { profileId: 1, parentAgentId: 100 });
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 4);
  // Newest first: the last inserted id is at index 0.
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i].startedAt;
    const b = rows[i + 1].startedAt;
    assert.ok(a >= b, `row[${i}].startedAt (${a}) should be >= row[${i + 1}].startedAt (${b})`);
  }
  assert.equal(rows[0].id, ids[ids.length - 1]);
});

// ---------------------------------------------------------------------------
// 4) failed runs — recorded with error string
// ---------------------------------------------------------------------------

test("telemetry: failed runs are recorded with outcome='failed' and a non-empty error", async () => {
  const core = makeFakeCore();
  const id = await telemetryStart(core, {
    profileId: 1,
    parentAgentId: 100,
    role: "reviewer",
    childAgentId: 400,
    runId: "run-fail",
  });
  await telemetryEnd(core, {
    profileId: 1,
    id,
    outcome: "failed",
    tokensIn: 100,
    tokensOut: 50,
    error: "budget-exceeded",
  });
  const rows = await telemetryList(core, { profileId: 1, parentAgentId: 100 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "failed");
  assert.equal(rows[0].error, "budget-exceeded");
});

// ---------------------------------------------------------------------------
// 5) cancelled runs — outcome = 'cancelled'
// ---------------------------------------------------------------------------

test("telemetry: cancelled runs are recorded with outcome='cancelled'", async () => {
  const core = makeFakeCore();
  const id = await telemetryStart(core, {
    profileId: 1,
    parentAgentId: 100,
    role: "tester",
    childAgentId: 500,
    runId: "run-cancel",
  });
  await telemetryEnd(core, {
    profileId: 1,
    id,
    outcome: "cancelled",
    tokensIn: 10,
    tokensOut: 5,
    error: "",
  });
  const row = core.rows.get(id);
  assert.equal(row.outcome, "cancelled");
  assert.ok(row.endedAt, "endedAt should be stamped on cancel");
  assert.equal(row.error, "");
});

// ---------------------------------------------------------------------------
// 6) multiple concurrent runs for the same parent_agent_id — all recorded
// ---------------------------------------------------------------------------

test("telemetry: multiple concurrent runs for the same parent_agent_id are all recorded", async () => {
  const core = makeFakeCore();
  // Insert 5 rows in parallel, no end() calls — every row should be
  // visible to list() while still in flight.
  const inserts = [];
  for (let i = 0; i < 5; i++) {
    inserts.push(
      telemetryStart(core, {
        profileId: 1,
        parentAgentId: 100,
        role: "researcher",
        childAgentId: 600 + i,
        runId: `concurrent-${i}`,
      }),
    );
  }
  const ids = await Promise.all(inserts);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5, "ids should be unique");
  const rows = await telemetryList(core, { profileId: 1, parentAgentId: 100 });
  assert.equal(rows.length, 5);
  for (const r of rows) {
    assert.equal(r.parentAgentId, 100);
    assert.equal(r.endedAt, null, "concurrent run should still be in flight");
    assert.equal(r.outcome, null);
  }
});

// ---------------------------------------------------------------------------
// 7) end() is idempotent — a second end() on the same row is rejected
// ---------------------------------------------------------------------------

test("telemetry: a second end() on the same row is rejected (no double-close)", async () => {
  const core = makeFakeCore();
  const id = await telemetryStart(core, {
    profileId: 1,
    parentAgentId: 100,
    role: "coder",
    childAgentId: 700,
    runId: "run-once",
  });
  const first = await telemetryEnd(core, {
    profileId: 1,
    id,
    outcome: "completed",
    tokensIn: 1,
    tokensOut: 1,
  });
  assert.equal(first, true);
  const second = await telemetryEnd(core, {
    profileId: 1,
    id,
    outcome: "failed",
    tokensIn: 999,
    tokensOut: 999,
    error: "ignored",
  });
  assert.equal(typeof second, "object");
  assert.equal(second.ok, false, "double-end must return ok:false");
  // The original row's outcome is preserved.
  const row = core.rows.get(id);
  assert.equal(row.outcome, "completed", "first end() outcome must persist");
  assert.equal(row.tokensIn, 1, "first end() tokensIn must persist");
});