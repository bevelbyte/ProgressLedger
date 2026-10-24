// Sub-agent depth + cost limit tests.
//
// Covers the dispatch-time limits (maxDepth, maxTotalPerRun) and the
// runtime token limit (maxTokensPerSubagent) enforced on sub-agents.
// These are PRIORITY 4: prevent recursive runaway spawning, duplicate
// work, and uncontrolled resource usage.
//
// Tested contract:
//   - maxDepth: a sub-agent at depth N cannot spawn at depth N+1 if
//     N+1 > maxDepth (default 3).
//   - maxTotalPerRun: after 8 sub-agents for a parent, the 9th is
//     rejected (default 8).
//   - maxTokensPerSubagent: a sub-agent that exceeds 200K tokens is
//     terminated (default 200000).
//   - Limits are configurable per project via config_json.subagent_limits.
//   - Limit breach marks the sub-agent cancelled, not failed.
//   - Limit breach does not affect the parent agent's state.
//
// Pure node:test, no IPC, no Electron.

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseSubagentLimits,
  getDepth,
  countActiveSubagents,
  getTokenCount,
  shouldCancelForTokenLimit,
  checkLimits,
  cancelSubagentForLimit,
  DEFAULT_SUBAGENT_LIMITS,
  start as telemetryStart,
  end as telemetryEnd,
  list as telemetryList,
} from "../src/services/agent/subagent-telemetry.js";

// ---------------------------------------------------------------------------
// helpers — an in-memory fake `core` that mirrors the NAPI surface.
// ---------------------------------------------------------------------------

function makeFakeCore({ agents = {} } = {}) {
  let nextId = 1;
  const rows = new Map(); // subagent_runs rows
  const agentRows = new Map(); // pm_agents rows (for getDepth)

  for (const [id, a] of Object.entries(agents)) {
    agentRows.set(Number(id), { id: Number(id), ...a });
  }

  return {
    rows,
    agentRows,
    _seedAgent(id, data) {
      agentRows.set(id, { id, ...data });
    },
    async pmGetAgent(_profileId, agentId) {
      const a = agentRows.get(agentId);
      if (!a) throw new Error("agent not found");
      return { ...a };
    },
    async pmInsertSubagentRun(profileId, parentAgentId, role, childAgentId, runId) {
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
        throw Object.assign(new Error("already ended"), { code: "INVALID_INPUT" });
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
      return out.slice(0, cap);
    },
    async pmFinishAgent(_profileId, agentId, state) {
      const a = agentRows.get(agentId);
      if (a) {
        a.state = state;
        a.finished_at = new Date().toISOString();
      }
    },
    async pmGetProject(_profileId, _projectId) {
      return { name: "test", description: "", root_path: "/tmp", config_json: "{}" };
    },
  };
}

// ---------------------------------------------------------------------------
// 1) parseSubagentLimits — defaults when config is missing
// ---------------------------------------------------------------------------

test("limits: parseSubagentLimits returns defaults when config is null or missing", () => {
  assert.deepEqual(parseSubagentLimits(null), DEFAULT_SUBAGENT_LIMITS);
  assert.deepEqual(parseSubagentLimits(undefined), DEFAULT_SUBAGENT_LIMITS);
  assert.deepEqual(parseSubagentLimits(""), DEFAULT_SUBAGENT_LIMITS);
  assert.deepEqual(parseSubagentLimits({}), DEFAULT_SUBAGENT_LIMITS);
  assert.deepEqual(parseSubagentLimits({ subagent_limits: {} }), DEFAULT_SUBAGENT_LIMITS);
});

// ---------------------------------------------------------------------------
// 2) parseSubagentLimits — custom limits from config
// ---------------------------------------------------------------------------

test("limits: parseSubagentLimits reads custom values from config_json.subagent_limits", () => {
  const cfg = { subagent_limits: { maxDepth: 5, maxTotalPerRun: 20, maxTokensPerSubagent: 500000 } };
  assert.deepEqual(parseSubagentLimits(cfg), {
    maxDepth: 5,
    maxTotalPerRun: 20,
    maxTokensPerSubagent: 500000,
  });

  // Partial config: missing fields fall back to defaults independently.
  const partial = { subagent_limits: { maxDepth: 10 } };
  const p = parseSubagentLimits(partial);
  assert.equal(p.maxDepth, 10);
  assert.equal(p.maxTotalPerRun, DEFAULT_SUBAGENT_LIMITS.maxTotalPerRun);
  assert.equal(p.maxTokensPerSubagent, DEFAULT_SUBAGENT_LIMITS.maxTokensPerSubagent);

  // Malformed JSON falls back to defaults.
  assert.deepEqual(parseSubagentLimits("{bad json"), DEFAULT_SUBAGENT_LIMITS);
});

// ---------------------------------------------------------------------------
// 3) getDepth — top-level agent is depth 0
// ---------------------------------------------------------------------------

test("limits: getDepth returns 0 for a top-level agent (no parent_agent_id)", async () => {
  const core = makeFakeCore();
  core._seedAgent(100, { id: 100, state: "idle", parent_agent_id: null });
  const depth = await getDepth(core, { profileId: 1, agentId: 100 });
  assert.equal(depth, 0);
});

// ---------------------------------------------------------------------------
// 4) getDepth — sub-agent at depth 2
// ---------------------------------------------------------------------------

test("limits: getDepth walks the parent_agent_id chain and returns 2 for a depth-2 sub-agent", async () => {
  const core = makeFakeCore();
  // Chain: 1 (top-level, depth 0) -> 2 (depth 1) -> 3 (depth 2)
  core._seedAgent(1, { id: 1, state: "completed", parent_agent_id: null });
  core._seedAgent(2, { id: 2, state: "completed", parent_agent_id: 1 });
  core._seedAgent(3, { id: 3, state: "idle", parent_agent_id: 2 });

  const depth0 = await getDepth(core, { profileId: 1, agentId: 1 });
  assert.equal(depth0, 0, "top-level agent should be depth 0");

  const depth1 = await getDepth(core, { profileId: 1, agentId: 2 });
  assert.equal(depth1, 1, "direct child should be depth 1");

  const depth2 = await getDepth(core, { profileId: 1, agentId: 3 });
  assert.equal(depth2, 2, "grandchild should be depth 2");
});

// ---------------------------------------------------------------------------
// 5) checkLimits: depth-limit — a depth-3 sub-agent cannot spawn a depth-4
// ---------------------------------------------------------------------------

test("limits: checkLimits returns depth-limit when parent is at maxDepth (3)", async () => {
  const core = makeFakeCore();
  // Chain: 1 (depth 0) -> 2 (depth 1) -> 3 (depth 2) -> 4 (depth 3)
  core._seedAgent(1, { id: 1, state: "completed", parent_agent_id: null });
  core._seedAgent(2, { id: 2, state: "completed", parent_agent_id: 1 });
  core._seedAgent(3, { id: 3, state: "completed", parent_agent_id: 2 });
  core._seedAgent(4, { id: 4, state: "idle", parent_agent_id: 3 });

  // Parent at depth 3 trying to spawn: child would be depth 4 > maxDepth 3.
  const parentDepth = await getDepth(core, { profileId: 1, agentId: 4 });
  assert.equal(parentDepth, 3, "parent should be at depth 3");

  const res = await checkLimits(core, {
    profileId: 1,
    parentAgentId: 4,
    currentDepth: parentDepth,
    configJson: {},
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "depth-limit");
});

// ---------------------------------------------------------------------------
// 6) checkLimits: count-limit — after 8 sub-agents, the 9th is rejected
// ---------------------------------------------------------------------------

test("limits: checkLimits returns count-limit when maxTotalPerRun (8) is reached", async () => {
  const core = makeFakeCore();
  core._seedAgent(100, { id: 100, state: "idle", parent_agent_id: null });

  // Insert 8 sub-agent rows for parent 100.
  for (let i = 0; i < 8; i++) {
    await telemetryStart(core, {
      profileId: 1,
      parentAgentId: 100,
      role: "researcher",
      childAgentId: 200 + i,
      runId: `run-${i}`,
    });
  }

  const count = await countActiveSubagents(core, { profileId: 1, parentAgentId: 100 });
  assert.equal(count, 8, "should have 8 sub-agent rows");

  const res = await checkLimits(core, {
    profileId: 1,
    parentAgentId: 100,
    currentDepth: 0,
    configJson: {},
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "count-limit");

  // 9th is also rejected.
  const res2 = await checkLimits(core, {
    profileId: 1,
    parentAgentId: 100,
    currentDepth: 0,
    configJson: {},
  });
  assert.equal(res2.ok, false);
  assert.equal(res2.reason, "count-limit");
});

// ---------------------------------------------------------------------------
// 7) checkLimits: ok when under all limits
// ---------------------------------------------------------------------------

test("limits: checkLimits returns ok when depth and count are under limits", async () => {
  const core = makeFakeCore();
  core._seedAgent(100, { id: 100, state: "idle", parent_agent_id: null });

  // Insert 3 sub-agent rows (under the default 8 limit).
  for (let i = 0; i < 3; i++) {
    await telemetryStart(core, {
      profileId: 1,
      parentAgentId: 100,
      role: "coder",
      childAgentId: 300 + i,
      runId: `run-${i}`,
    });
  }

  const res = await checkLimits(core, {
    profileId: 1,
    parentAgentId: 100,
    currentDepth: 0, // top-level parent
    configJson: {},
  });
  assert.equal(res.ok, true);
});

// ---------------------------------------------------------------------------
// 8) Limits are configurable per project
// ---------------------------------------------------------------------------

test("limits: checkLimits respects per-project subagent_limits config", async () => {
  const core = makeFakeCore();
  core._seedAgent(100, { id: 100, state: "idle", parent_agent_id: null });

  // Configure maxTotalPerRun=2 (lower than default 8).
  const cfg = { subagent_limits: { maxTotalPerRun: 2 } };

  // Insert 2 sub-agent rows.
  for (let i = 0; i < 2; i++) {
    await telemetryStart(core, {
      profileId: 1,
      parentAgentId: 100,
      role: "researcher",
      childAgentId: 400 + i,
      runId: `run-${i}`,
    });
  }

  // With the default config (maxTotalPerRun=8), this should be ok.
  const resDefault = await checkLimits(core, {
    profileId: 1,
    parentAgentId: 100,
    currentDepth: 0,
    configJson: {},
  });
  assert.equal(resDefault.ok, true, "2 sub-agents should be ok under default limit of 8");

  // With the custom config (maxTotalPerRun=2), this should be count-limit.
  const resCustom = await checkLimits(core, {
    profileId: 1,
    parentAgentId: 100,
    currentDepth: 0,
    configJson: cfg,
  });
  assert.equal(resCustom.ok, false);
  assert.equal(resCustom.reason, "count-limit");

  // Also test custom maxDepth.
  const depthCfg = { subagent_limits: { maxDepth: 1 } };
  const resDepth = await checkLimits(core, {
    profileId: 1,
    parentAgentId: 100,
    currentDepth: 1, // parent at depth 1, child would be depth 2 > maxDepth 1
    configJson: depthCfg,
  });
  assert.equal(resDepth.ok, false);
  assert.equal(resDepth.reason, "depth-limit");
});

// ---------------------------------------------------------------------------
// 9) shouldCancelForTokenLimit — exceeds limit
// ---------------------------------------------------------------------------

test("limits: shouldCancelForTokenLimit returns true when tokens exceed the limit", () => {
  assert.equal(shouldCancelForTokenLimit(100001, 100000, 200000), true);
  assert.equal(shouldCancelForTokenLimit(200001, 0, 200000), true);
  assert.equal(shouldCancelForTokenLimit(0, 200001, 200000), true);
  assert.equal(shouldCancelForTokenLimit(200000, 1, 200000), true);
});

test("limits: shouldCancelForTokenLimit returns false when tokens are under or at the limit", () => {
  assert.equal(shouldCancelForTokenLimit(100000, 100000, 200000), false);
  assert.equal(shouldCancelForTokenLimit(100000, 99999, 200000), false);
  assert.equal(shouldCancelForTokenLimit(0, 0, 200000), false);
  // 0 means "no limit".
  assert.equal(shouldCancelForTokenLimit(999999999, 999999999, 0), false);
});

// ---------------------------------------------------------------------------
// 10) Limit breach marks the sub-agent cancelled, not failed
// ---------------------------------------------------------------------------

test("limits: cancelSubagentForLimit marks the sub-agent cancelled with the limit reason", async () => {
  const core = makeFakeCore();
  core._seedAgent(200, { id: 200, state: "idle", parent_agent_id: 100 });

  // Open a telemetry row first.
  const tid = await telemetryStart(core, {
    profileId: 1,
    parentAgentId: 100,
    role: "researcher",
    childAgentId: 200,
    runId: "run-cancel",
  });

  // Cancel with depth-limit reason.
  const result = await cancelSubagentForLimit(core, {
    profileId: 1,
    agentId: 200,
    reason: "depth-limit",
    telemetryRunId: tid,
  });
  assert.equal(result, true);

  // The pm_agents row should be cancelled (not failed).
  const agent = core.agentRows.get(200);
  assert.equal(agent.state, "cancelled");
  assert.ok(agent.finished_at, "finished_at should be stamped");

  // The telemetry row should be closed with outcome='cancelled' and
  // the limit reason in the error field.
  const row = core.rows.get(tid);
  assert.equal(row.outcome, "cancelled");
  assert.ok(row.endedAt, "endedAt should be stamped");
  assert.equal(row.error, "limit-depth-limit");
});

// ---------------------------------------------------------------------------
// 11) Limit breach does not affect the parent agent's state
// ---------------------------------------------------------------------------

test("limits: limit breach on a child does not affect the parent agent's state", async () => {
  const core = makeFakeCore();
  core._seedAgent(100, { id: 100, state: "executing_tool", parent_agent_id: null });
  core._seedAgent(200, { id: 200, state: "idle", parent_agent_id: 100 });

  // Open a telemetry row for the child.
  const tid = await telemetryStart(core, {
    profileId: 1,
    parentAgentId: 100,
    role: "researcher",
    childAgentId: 200,
    runId: "run-child",
  });

  // Cancel the child with a limit reason.
  await cancelSubagentForLimit(core, {
    profileId: 1,
    agentId: 200,
    reason: "count-limit",
    telemetryRunId: tid,
  });

  // The parent's state is unchanged (still executing_tool, not failed/cancelled).
  const parent = core.agentRows.get(100);
  assert.equal(parent.state, "executing_tool");
  assert.equal(parent.finished_at, undefined, "parent should not have finished_at");
});

// ---------------------------------------------------------------------------
// 12) getTokenCount — returns cumulative tokens for a run id
// ---------------------------------------------------------------------------

test("limits: getTokenCount returns tokens_in + tokens_out for a subagent run", async () => {
  const core = makeFakeCore();

  const id = await telemetryStart(core, {
    profileId: 1,
    parentAgentId: 100,
    role: "coder",
    childAgentId: 500,
    runId: "run-token",
  });

  // Before end(), tokens are null.
  const before = await getTokenCount(core, { profileId: 1, subagentRunId: "run-token" });
  assert.equal(before, 0);

  // End the run with token counts.
  await telemetryEnd(core, {
    profileId: 1,
    id,
    outcome: "completed",
    tokensIn: 150000,
    tokensOut: 60000,
  });

  const total = await getTokenCount(core, { profileId: 1, subagentRunId: "run-token" });
  assert.equal(total, 210000);

  // Unknown run id returns 0.
  const unknown = await getTokenCount(core, { profileId: 1, subagentRunId: "no-such-run" });
  assert.equal(unknown, 0);
});

// ---------------------------------------------------------------------------
// 13) countActiveSubagents — counts all rows for a parent
// ---------------------------------------------------------------------------

test("limits: countActiveSubagents counts all sub-agent rows for a parent (regardless of state)", async () => {
  const core = makeFakeCore();

  // Insert 3 rows, end 1 of them.
  for (let i = 0; i < 3; i++) {
    const id = await telemetryStart(core, {
      profileId: 1,
      parentAgentId: 100,
      role: "tester",
      childAgentId: 600 + i,
      runId: `run-count-${i}`,
    });
    if (i === 0) {
      await telemetryEnd(core, {
        profileId: 1,
        id,
        outcome: "completed",
        tokensIn: 10,
        tokensOut: 10,
      });
    }
  }

  // All 3 rows count (the ended one still counts towards the limit).
  const count = await countActiveSubagents(core, { profileId: 1, parentAgentId: 100 });
  assert.equal(count, 3);

  // A different parent has 0 rows.
  const other = await countActiveSubagents(core, { profileId: 1, parentAgentId: 999 });
  assert.equal(other, 0);
});
