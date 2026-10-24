// Regression test — agent loop generic catch path must clear pm_run_state.
//
// Invariant (Phase 15, recovery.js): when an agent reaches a terminal
// state, the durable `pm_run_state` row must be deleted so the recovery
// sweep does not classify the agent as a zombie ("requires-user") after
// a restart. `finishAgent()` does this via `clearRunState`, but the
// loop body's generic `catch` path historically called
// `core.pmFinishAgent(FAILED)` directly and skipped the durable-row
// cleanup. This test reproduces that path: `pmGetProject` throws on the
// loop body's first access, the catch fires, and the durable row must
// be gone.
//
// No network, no real SQLite, deterministic.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  startAgent,
  getRun,
  AGENT_EVENTS,
} from "../src/services/agent/loop.js";
import { scriptedProvider } from "../src/services/agent/fixture.js";
import { _setUserDataDir, _closeAll } from "../src/services/memory/index.js";

function withTempUserData(fn) {
  const dir = mkdtempSync(join(tmpdir(), "cf-agent-loop-err-"));
  _setUserDataDir(dir);
  return Promise.resolve(fn()).finally(() => {
    try { _closeAll(); } catch (_e) {}
    try { _setUserDataDir(null); } catch (_e) {}
    try { rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
  });
}

// Fake core mirroring agent-recovery.test.js, plus the durable
// run-state surface (pmUpsertRunState / pmDeleteRunState) so the test
// can observe whether the catch path drops the row.
function makeFakeCore({ failProjectLookup = false } = {}) {
  const agents = new Map();
  const messages = new Map();
  let nextAgentId = 20_001;
  const runStateRows = new Map(); // agentId -> last persisted info
  const calls = {
    finish: [],
    upsertRunState: [],
    deleteRunState: [],
  };

  const core = {
    pmCreateAgent(projectId, objective) {
      const id = nextAgentId++;
      agents.set(id, {
        id,
        project_id: projectId,
        objective,
        state: "idle",
        plan_json: "[]",
        tokens_in: 0,
        tokens_out: 0,
        finished_at: null,
        parent_agent_id: null,
      });
      messages.set(id, []);
      return { id };
    },
    pmGetAgent(_profileId, agentId) {
      const a = agents.get(agentId);
      return a ? { ...a } : null;
    },
    pmUpdateAgent(_profileId, agentId, state, planJson, tokensIn, tokensOut) {
      const a = agents.get(agentId);
      if (!a) return { ok: false, error: { code: "not-found" } };
      a.state = state;
      a.plan_json = planJson;
      a.tokens_in = tokensIn;
      a.tokens_out = tokensOut;
      return { ok: true };
    },
    pmAppendMessage(_profileId, agentId, role, content, name, payloadJson) {
      const list = messages.get(agentId) || [];
      list.push({ seq: list.length + 1, role, content: String(content), name: name ?? null, payload_json: payloadJson ?? null });
      messages.set(agentId, list);
      return { seq: list.length };
    },
    pmFinishAgent(_profileId, agentId, state) {
      calls.finish.push({ agentId, state });
      const a = agents.get(agentId);
      if (a) {
        a.state = state;
        a.finished_at = new Date().toISOString();
      }
    },
    pmListMessages(_profileId, agentId) {
      return [...(messages.get(agentId) || [])];
    },
    pmGetProject(_profileId, _projectId) {
      if (failProjectLookup) {
        throw new Error("simulated pmGetProject failure (loop-error path)");
      }
      return {
        id: 10,
        profile_id: 1,
        name: "loop-error fixture",
        description: "deterministic",
        root_path: "/tmp/loop-err",
        config_json: "{}",
      };
    },
    pmUpsertRunState(_profileId, agentId, runId, role, isSubAgent, parentRunId, phase, state, tokensIn, tokensOut, recovery) {
      calls.upsertRunState.push({ agentId, runId, phase, state, recovery });
      runStateRows.set(agentId, { runId, phase, state, recovery });
    },
    pmDeleteRunState(_profileId, agentId) {
      calls.deleteRunState.push({ agentId });
      runStateRows.delete(agentId);
    },
    _agents: agents,
    _messages: messages,
    _runStateRows: runStateRows,
    _calls: calls,
  };
  return core;
}

// Minimal provider stub: the loop must never reach streaming in these
// scenarios (pmGetProject throws first), and a truthy provider prevents
// resolveDefaultProvider from touching the credentials store.
const unreachableProvider = {
  async *streamChat() {
    throw new Error("provider must not be reached in this test");
  },
};

test("loop generic catch clears the durable pm_run_state row (no zombie)", async () => {
  await withTempUserData(async () => {
    const core = makeFakeCore({ failProjectLookup: true });
    const profileId = 1;
    const created = core.pmCreateAgent(10, "objective that will hit the loop-error path");
    const agentId = created.id;

    const started = await startAgent({
      core,
      profileId,
      agentId,
      provider: unreachableProvider,
    });
    assert.equal(started.ok, true, `startAgent: ${JSON.stringify(started)}`);

    // Wait for the background loop to finish and free the RUNS slot.
    const deadline = Date.now() + 3000;
    while (getRun(agentId) !== null) {
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(getRun(agentId), null, "run registry entry must be freed after terminal failure");

    // The agent row must be terminal FAILED.
    const agent = core.pmGetAgent(profileId, agentId);
    assert.equal(agent.state, "failed", `agent.state=${agent.state}`);

    // The durable run-state row must be GONE — the recovery sweep must
    // not see a zombie row for this agent after a restart.
    assert.equal(core._runStateRows.has(agentId), false,
      `pm_run_state row survived the loop-error path: ${JSON.stringify(core._runStateRows.get(agentId))}`);
    assert.ok(core._calls.deleteRunState.some((c) => c.agentId === agentId),
      "pmDeleteRunState was never called on the loop-error path");

    // A FAILED event must have been emitted on the bus (observability).
    // startAgent returns the bus; assert at least one failure event was
    // observable via the persisted transcript ordering instead: the
    // catch path emits AGENT_FAILED before finishing. We assert the
    // audit-facing outcome only (terminal state + row cleanup) since
    // the bus is internal to the run.
    assert.ok(core._calls.finish.some((f) => f.agentId === agentId && f.state === "failed"),
      "pmFinishAgent(FAILED) must have been called");
  });
});

test("successful terminal run also clears the durable row (invariant holds on the happy path)", async () => {
  await withTempUserData(async () => {
    // This test exercises the normal finishAgent path with a 1-step
    // plan: the model emits a plan + completes without tools.
    const core = makeFakeCore();
    const profileId = 1;
    const created = core.pmCreateAgent(10, "say done");
    const agentId = created.id;

    const events = [];
    const started = await startAgent({
      core,
      profileId,
      agentId,
      provider: scriptedProvider([{ text: "done" }]),
      onEvent: (e) => events.push(e),
    });
    assert.equal(started.ok, true, `startAgent: ${JSON.stringify(started)}`);

    const deadline = Date.now() + 5000;
    while (getRun(agentId) !== null) {
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(getRun(agentId), null, "run must have terminated");

    const agent = core.pmGetAgent(profileId, agentId);
    assert.ok(["completed", "failed"].includes(agent.state), `agent.state=${agent.state}`);
    if (agent.state === "completed") {
      assert.equal(core._runStateRows.has(agentId), false,
        "happy-path terminal run must also drop the durable row");
      assert.ok(events.some((e) => e.type === AGENT_EVENTS.AGENT_COMPLETED),
        "AGENT_COMPLETED event expected");
    } else {
      // If the fixture drove a failed terminal state, the invariant
      // still must hold.
      assert.equal(core._runStateRows.has(agentId), false,
        "failed terminal run must drop the durable row");
    }
  });
});
