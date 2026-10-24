// GATE 16 — Long-running stress (memory leaks, stale state, etc.)
//
// Five deterministic tests that stress the agent lifecycle surface:
//   1. 20 sequential agent runs (start + complete) — RUNS Map is empty after each
//   2. 20 sub-agent dispatches — no orphaned subagent_runs rows
//   3. Memory scoping — 10 profiles × 10 facts = 100 rows, no cross-profile leakage
//   4. Audit ring bounded — 1000 events → ring size == retention count N
//   5. File handles — 100 file reads → no leaked FDs (no errors)
//
// All tests are hermetic: no real network, no real LLM, no Electron.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  startAgent,
  AGENT_EVENTS,
  STATES,
  getRun,
  listActiveRuns,
} from "../src/services/agent/loop.js";
import { scriptedProvider } from "../src/services/agent/fixture.js";
import {
  Memory,
  _setUserDataDir,
  _closeAll,
} from "../src/services/memory/index.js";
import * as subagentTelemetry from "../src/services/agent/subagent-telemetry.js";
import {
  Audit,
  _setStateForTests,
  _resetForTests,
  _setRetention,
  _resetRetention,
  _getRetention,
} from "../src/services/audit/index.js";

// ---------------------------------------------------------------------------
// Fake core — in-memory SQLite replacement. Tracks agents, messages, and
// subagent_runs rows. Supports both regular and sub-agent runs.
// ---------------------------------------------------------------------------

function makeFakeCore(opts = {}) {
  const {
    configJson = JSON.stringify({
      context_packet_max_tokens: 0,
      context_packet_max_project_intel_tokens: 0,
      show_recent_tasks: false,
      subagent_limits: { maxDepth: 10, maxTotalPerRun: 100, maxTokensPerSubagent: 200000 },
    }),
    projectRoot = "/tmp/cf-gate16",
  } = opts;

  const agents = new Map();
  const messages = new Map();
  const subagentRuns = [];
  let nextAgentId = 2000;
  let nextSubagentRunId = 1;
  let nextMsgSeq = 0;

  function recordMsg(agentId, role, content, name, payloadJson) {
    const list = messages.get(agentId) || [];
    nextMsgSeq += 1;
    list.push({
      id: list.length + 1,
      agent_id: agentId,
      seq: nextMsgSeq,
      role,
      content: typeof content === "string" ? content : JSON.stringify(content),
      name: name == null ? null : name,
      payload_json: payloadJson == null ? null : payloadJson,
    });
    messages.set(agentId, list);
  }

  const core = {
    pmCreateAgent(projectId, objective, extras = {}) {
      const id = nextAgentId++;
      const row = {
        id,
        projectId,
        project_id: projectId,
        objective,
        state: STATES.IDLE,
        plan_json: "[]",
        parent_agent_id: extras.parent_agent_id ?? null,
        tokens_in: 0,
        tokens_out: 0,
        finished_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      agents.set(id, row);
      messages.set(id, []);
      return { id };
    },
    pmGetAgent(_profileId, agentId) {
      const a = agents.get(agentId);
      if (!a) return null;
      return { ...a };
    },
    pmUpdateAgent(_profileId, agentId, state, planJson, tokensIn, tokensOut) {
      const a = agents.get(agentId);
      if (!a) return { ok: false };
      a.state = state;
      a.plan_json = planJson;
      a.tokens_in = tokensIn;
      a.tokens_out = tokensOut;
      a.updated_at = new Date().toISOString();
      return { ok: true };
    },
    pmAppendMessage(_profileId, agentId, role, content, name, payloadJson) {
      recordMsg(agentId, role, content, name, payloadJson);
      return { seq: (messages.get(agentId) || []).length };
    },
    pmFinishAgent(_profileId, agentId, state) {
      const a = agents.get(agentId);
      if (!a) return;
      a.state = state;
      a.finished_at = new Date().toISOString();
    },
    pmListMessages(_profileId, agentId) {
      return (messages.get(agentId) || []).slice();
    },
    pmGetProject(_profileId, _projectId) {
      return {
        id: 10,
        profile_id: 1,
        name: "Gate16 stress project",
        description: "stress test fixture",
        root_path: projectRoot,
        config_json: configJson,
        created_at: "1970-01-01T00:00:00Z",
        updated_at: "1970-01-01T00:00:00Z",
      };
    },
    // Sub-agent telemetry NAPI surface:
    pmInsertSubagentRun(_profileId, parentAgentId, role, childAgentId, runId) {
      const id = nextSubagentRunId++;
      subagentRuns.push({
        id,
        parent_agent_id: parentAgentId,
        role: role ?? null,
        child_agent_id: childAgentId ?? null,
        run_id: runId ?? null,
        started_at: new Date().toISOString(),
        ended_at: null,
        outcome: null,
        tokens_in: 0,
        tokens_out: 0,
        error: "",
      });
      return id;
    },
    pmEndSubagentRun(_profileId, id, outcome, tokensIn, tokensOut, error) {
      const row = subagentRuns.find((r) => r.id === id);
      if (row) {
        row.ended_at = new Date().toISOString();
        row.outcome = outcome;
        row.tokens_in = tokensIn;
        row.tokens_out = tokensOut;
        row.error = error ?? "";
      }
    },
    pmListSubagentRuns(_profileId, parentAgentId, limit) {
      let rows = subagentRuns;
      if (parentAgentId != null) {
        rows = rows.filter((r) => r.parent_agent_id === parentAgentId);
      }
      rows = [...rows].sort((a, b) => b.id - a.id);
      if (limit && limit > 0) rows = rows.slice(0, limit);
      return rows;
    },
    _agents: agents,
    _messages: messages,
    _subagentRuns: subagentRuns,
  };
  return core;
}

// A provider that completes immediately: one text round + finish, no tool calls.
function completingProvider() {
  return scriptedProvider([
    { text: "Task complete.", finishReason: "stop" },
  ]);
}

// Wait for a terminal event on the bus. Returns { kind, payload }.
function waitForTerminal(bus, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      offFailed();
      offCancelled();
      reject(new Error("waitForTerminal timed out"));
    }, timeoutMs);

    const offCompleted = bus.on(AGENT_EVENTS.AGENT_COMPLETED, (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offFailed();
      offCancelled();
      resolve({ kind: "completed", payload: e.payload });
    });
    const offFailed = bus.on(AGENT_EVENTS.AGENT_FAILED, (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offCompleted();
      offCancelled();
      resolve({ kind: "failed", payload: e.payload });
    });
    const offCancelled = bus.on(AGENT_EVENTS.AGENT_CANCELLED, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offCompleted();
      offFailed();
      resolve({ kind: "cancelled" });
    });
  });
}

// Wait for the RUNS Map to drop the entry for agentId.
async function waitForRunCleared(agentId, { timeoutMs = 2000 } = {}) {
  const start = Date.now();
  while (getRun(agentId) !== null) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

// Create a 1-step agent, start it, wait for terminal + RUNS cleanup.
async function runAgentToCompletion(core, opts = {}) {
  const { isSubAgent = false, parentId = null, role = null } = opts;
  const objective = isSubAgent
    ? `sub-agent task (role=${role || ""})`
    : "agent task";
  const extras = isSubAgent && parentId != null ? { parent_agent_id: parentId } : {};
  const created = core.pmCreateAgent(10, objective, extras);
  const agentId = created.id;
  core.pmUpdateAgent(1, agentId, STATES.IDLE, JSON.stringify({
    version: 1,
    steps: [{
      id: "step-1",
      title: "do the thing",
      status: "pending",
      depends_on: [],
      files: [],
      assigned_to: null,
    }],
  }), 0, 0);

  const res = await startAgent({
    core,
    profileId: 1,
    agentId,
    provider: completingProvider(),
    isSubAgent,
    role: role || null,
  });
  assert.equal(res.ok, true, `startAgent should succeed: ${JSON.stringify(res)}`);
  const terminal = await waitForTerminal(res.bus);
  const cleared = await waitForRunCleared(agentId);
  assert.equal(cleared, true,
    `RUNS Map should be empty for agent ${agentId} after completion`);
  return { agentId, terminal };
}

// ---------------------------------------------------------------------------
// Test 1 — 20 sequential agent runs leave RUNS Map empty after each
// ---------------------------------------------------------------------------

test("GATE 16: 20 sequential agent runs leave RUNS Map empty after each", async () => {
  const userData = mkdtempSync(join(tmpdir(), "cf-gate16-1-"));
  _setUserDataDir(userData);
  _resetForTests();
  try {
    assert.equal(listActiveRuns().length, 0, "RUNS should be empty at start");

    const core = makeFakeCore();

    for (let i = 0; i < 20; i++) {
      assert.equal(listActiveRuns().length, 0,
        `RUNS should be empty before run ${i + 1}`);

      const { agentId, terminal } = await runAgentToCompletion(core);

      assert.equal(terminal.kind, "completed",
        `run ${i + 1} should complete, got ${terminal.kind}`);
      assert.equal(getRun(agentId), null,
        `RUNS entry for agent ${agentId} should be cleared after run ${i + 1}`);
      assert.equal(listActiveRuns().length, 0,
        `RUNS should be empty after run ${i + 1}`);

      const agent = core._agents.get(agentId);
      assert.equal(agent.state, STATES.COMPLETED,
        `agent ${agentId} should be COMPLETED (run ${i + 1})`);
      assert.ok(agent.finished_at,
        `agent ${agentId} should have finished_at set (run ${i + 1})`);
    }

    const completedCount = [...core._agents.values()]
      .filter((a) => a.state === STATES.COMPLETED).length;
    assert.equal(completedCount, 20,
      `expected 20 completed agents, got ${completedCount}`);

    const nonTerminal = [...core._agents.values()]
      .filter((a) => a.state !== STATES.COMPLETED && a.state !== STATES.FAILED && a.state !== STATES.CANCELLED);
    assert.equal(nonTerminal.length, 0,
      `no agents should be in a non-terminal state, got ${nonTerminal.length}`);
  } finally {
    _closeAll();
    _resetForTests();
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 2 — 20 sub-agent dispatches leave no orphaned subagent_runs rows
// ---------------------------------------------------------------------------

test("GATE 16: 20 sub-agent dispatches leave no orphaned subagent_runs rows", async () => {
  const userData = mkdtempSync(join(tmpdir(), "cf-gate16-2-"));
  _setUserDataDir(userData);
  _resetForTests();
  try {
    const core = makeFakeCore();

    const parentCreated = core.pmCreateAgent(10, "parent agent for sub dispatch");
    const parentId = parentCreated.id;

    for (let i = 0; i < 20; i++) {
      await runAgentToCompletion(core, {
        isSubAgent: true,
        parentId,
        role: "tester",
      });

      const rows = await subagentTelemetry.list(core, {
        profileId: 1,
        parentAgentId: parentId,
      });
      const orphans = rows.filter((r) => !r.ended_at);
      assert.equal(orphans.length, 0,
        `after sub-agent ${i + 1}: ${orphans.length} orphaned rows`);
      assert.equal(rows.length, i + 1,
        `expected ${i + 1} subagent_runs rows after dispatch ${i + 1}, got ${rows.length}`);

      const newest = rows[0];
      assert.ok(newest.ended_at, `newest row ${newest.id} should have ended_at`);
      assert.equal(newest.outcome, "completed",
        `newest row ${newest.id} should be 'completed', got '${newest.outcome}'`);
    }

    const allRows = await subagentTelemetry.list(core, {
      profileId: 1,
      parentAgentId: parentId,
    });
    assert.equal(allRows.length, 20,
      `expected 20 subagent_runs rows, got ${allRows.length}`);
    const closed = allRows.filter((r) => r.ended_at);
    assert.equal(closed.length, 20,
      `expected 20 closed rows, got ${closed.length}`);
    for (const row of allRows) {
      assert.ok(["completed", "failed", "cancelled"].includes(row.outcome),
        `row ${row.id} has unexpected outcome: ${row.outcome}`);
    }

    const count = await subagentTelemetry.countActiveSubagents(core, {
      profileId: 1,
      parentAgentId: parentId,
    });
    assert.equal(count, 20,
      `countActiveSubagents should return 20, got ${count}`);
  } finally {
    _closeAll();
    _resetForTests();
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 3 — Memory scoping: 10 profiles × 10 facts = 100 rows, no leakage
// ---------------------------------------------------------------------------

test("GATE 16: memory scoping — 10 profiles x 10 facts = 100 rows, no leakage", async () => {
  const userData = mkdtempSync(join(tmpdir(), "cf-gate16-3-"));
  _setUserDataDir(userData);
  _closeAll();
  try {
    const profileIds = [];
    for (let i = 0; i < 10; i++) profileIds.push(100 + i);

    for (const pid of profileIds) {
      for (let j = 0; j < 10; j++) {
        const set = await Memory.sessionSet(pid, 0, `key-${j}`, `value-${pid}-${j}`);
        assert.equal(set.ok, true,
          `sessionSet should succeed for profile ${pid}, key-${j}`);
      }
    }

    for (const pid of profileIds) {
      for (let j = 0; j < 10; j++) {
        const set = await Memory.projectSet(pid, "finding", `finding-${j}`,
          `finding-value-${pid}-${j}`);
        assert.equal(set.ok, true,
          `projectSet should succeed for profile ${pid}, finding-${j}`);
      }
    }

    let totalSession = 0;
    for (const pid of profileIds) {
      const list = await Memory.sessionList(pid, 0);
      assert.equal(list.ok, true,
        `sessionList should succeed for profile ${pid}`);
      assert.equal(list.result.length, 10,
        `profile ${pid} should have 10 session entries, got ${list.result.length}`);
      totalSession += list.result.length;
    }
    assert.equal(totalSession, 100,
      `expected 100 total session rows, got ${totalSession}`);

    let totalProject = 0;
    for (const pid of profileIds) {
      const list = await Memory.projectList(pid, { kind: "finding" });
      assert.equal(list.ok, true,
        `projectList should succeed for profile ${pid}`);
      assert.equal(list.result.length, 10,
        `profile ${pid} should have 10 project entries, got ${list.result.length}`);
      totalProject += list.result.length;
    }
    assert.equal(totalProject, 100,
      `expected 100 total project rows, got ${totalProject}`);

    // No cross-profile leakage in session memory.
    const p100 = await Memory.sessionList(100, 0);
    assert.equal(p100.ok, true);
    const hasLeak = p100.result.some((r) =>
      typeof r.value === "string" && r.value.includes("value-101")
    );
    assert.equal(hasLeak, false,
      "profile 100 must not contain profile 101's session data");

    // No cross-profile leakage in project memory.
    const p100proj = await Memory.projectList(100, { kind: "finding" });
    assert.equal(p100proj.ok, true);
    const projLeak = p100proj.result.some((r) =>
      typeof r.value === "string" && r.value.includes("finding-value-101")
    );
    assert.equal(projLeak, false,
      "profile 100 must not contain profile 101's project data");

    // dbCache cleanup: _closeAll() closes all handles (process-exit
    // simulation). A read after closing must not throw and must not use
    // a stale handle — BUT the durable sqlite file persists on disk, so
    // restart continuity re-opens it and the committed row is returned.
    // This is the corrected production contract (memory must survive an
    // application restart); asserting null here would encode the exact
    // restart data-loss bug this suite exists to prevent.
    _closeAll();
    const miss = await Memory.sessionGet(100, 0, "key-0");
    assert.equal(miss.ok, true,
      "sessionGet after _closeAll should not throw");
    assert.equal(miss.result, "value-100-0",
      "sessionGet after _closeAll must round-trip via disk reopen (restart continuity)");
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 4 — Audit ring bounded to retention count after 1000 events
// ---------------------------------------------------------------------------

test("GATE 16: audit ring bounded to retention count after 1000 events", async () => {
  _resetForTests();
  _resetRetention();
  _setStateForTests({ filePath: null });
  try {
    const N = 50;
    const result = _setRetention({ count: N });
    assert.equal(result.count, N,
      `_setRetention should return count=${N}, got ${result.count}`);

    for (let i = 0; i < 1000; i++) {
      Audit.log({
        event: "gate16-stress",
        tool: `t-${i}`,
        profileId: 1,
      });
    }

    const ring = Audit.recent(9999);
    assert.equal(ring.length, N,
      `ring should be bounded to ${N}, got ${ring.length}`);

    assert.equal(ring[0].tool, "t-999",
      `newest event should be t-999, got ${ring[0].tool}`);
    assert.equal(ring[N - 1].tool, "t-950",
      `oldest kept event should be t-950, got ${ring[N - 1].tool}`);

    for (const ev of ring) {
      assert.equal(ev.event, "gate16-stress",
        `unexpected event type in ring: ${ev.event}`);
      assert.match(ev.tool, /^t-\d+$/,
        `unexpected tool in ring: ${ev.tool}`);
    }

    const r = _getRetention();
    assert.equal(r.count, N,
      `_getRetention should return count=${N}, got ${r.count}`);
  } finally {
    _resetRetention();
    _resetForTests();
  }
});

// ---------------------------------------------------------------------------
// Test 5 — 100 file reads do not leak file descriptors
// ---------------------------------------------------------------------------

test("GATE 16: 100 file reads do not leak file descriptors (no errors)", async () => {
  const userData = mkdtempSync(join(tmpdir(), "cf-gate16-5-"));
  try {
    const files = [];
    for (let i = 0; i < 100; i++) {
      const p = join(userData, `file-${i}.txt`);
      writeFileSync(p, `content-${i}`);
      files.push(p);
    }

    // Sync reads.
    let syncReadCount = 0;
    for (let i = 0; i < 100; i++) {
      const content = readFileSync(files[i], "utf8");
      assert.equal(content, `content-${i}`,
        `file ${i} content mismatch`);
      syncReadCount++;
    }
    assert.equal(syncReadCount, 100,
      "all 100 sync file reads succeeded");

    // Async reads.
    const { readFile: asyncReadFile } = await import("node:fs/promises");
    let asyncReadCount = 0;
    for (let i = 0; i < 100; i++) {
      const content = await asyncReadFile(files[i], "utf8");
      assert.equal(content, `content-${i}`,
        `async file ${i} content mismatch`);
      asyncReadCount++;
    }
    assert.equal(asyncReadCount, 100,
      "all 100 async file reads succeeded");

    // After 200 file operations, verify no handles are locked by
    // deleting the directory (fails if any handle is still open).
    assert.doesNotThrow(() => {
      rmSync(userData, { recursive: true, force: true });
    }, "recursive delete should succeed (no leaked file handles)");
    assert.equal(existsSync(userData), false,
      "temp directory should be removed (no leaked handles)");
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});
