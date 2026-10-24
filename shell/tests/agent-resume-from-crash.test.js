// Regression test — resume from persisted mid-execution phases.
//
// Contract (Phase 15 restart/recovery): a crash can leave the agent
// persisted in ANY non-terminal state (planning, executing_tool,
// waiting_for_approval, ...). `resumeAgent` -> `startAgent(isResume)`
// must accept ALL of them: the loop re-enters at `planning` and the
// stall-classifier rolls any stuck `running` step back to `failed`.
//
// The live-loop transition table intentionally does NOT contain
// executing_tool -> planning for normal flow (that path goes through
// observing); the resume entry edge is the only legal user of it.
//
// Reproduces the historical defect: `executing_tool -> planning` was
// not in VALID_TRANSITIONS, so startAgent threw
// "invalid agent state transition" on resume-from-crash while the
// recovery sweep advertised the same row as `safe-resume`.
//
// No network, no real SQLite, deterministic via scripted provider.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  startAgent,
  resumeAgent,
  getRun,
  STATES,
  canTransition,
} from "../src/services/agent/loop.js";
import { scriptedProvider } from "../src/services/agent/fixture.js";
import { _setUserDataDir, _closeAll } from "../src/services/memory/index.js";

function withTempUserData(fn) {
  const dir = mkdtempSync(join(tmpdir(), "cf-resume-crash-"));
  _setUserDataDir(dir);
  return Promise.resolve(fn()).finally(() => {
    try { _closeAll(); } catch (_e) {}
    try { _setUserDataDir(null); } catch (_e) {}
    try { rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
  });
}

function makeFakeCore() {
  const agents = new Map();
  const messages = new Map();
  let nextAgentId = 30_001;

  const core = {
    pmCreateAgent(projectId, objective) {
      const id = nextAgentId++;
      agents.set(id, {
        id,
        project_id: projectId,
        objective,
        state: STATES.IDLE,
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
      // No test_command -> verification trivially passes.
      return {
        id: 10,
        profile_id: 1,
        name: "resume-crash fixture",
        description: "deterministic",
        root_path: "/tmp/resume-crash",
        config_json: "{}",
      };
    },
    _agents: agents,
    _messages: messages,
  };
  return core;
}

// Persist a mid-run plan (step-1 done, step-2 running/stuck, step-3
// pending) in the given non-terminal state, exactly as a crash would
// have left it (transition() writes the phase durably before the crash).
function seedCrashState(core, agentId, state) {
  const plan = {
    version: 1,
    steps: [
      { id: "step-1", title: "Step one", status: "done", depends_on: [], files: [], assigned_to: null },
      { id: "step-2", title: "Step two", status: "running", depends_on: ["step-1"], files: [], assigned_to: null },
      { id: "step-3", title: "Step three", status: "pending", depends_on: ["step-2"], files: [], assigned_to: null },
    ],
  };
  const a = core._agents.get(agentId);
  a.state = state;
  a.plan_json = JSON.stringify(plan);
}

async function waitTerminal(agentId, { timeoutMs = 5000 } = {}) {
  const start = Date.now();
  while (getRun(agentId) !== null) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

const CRASH_STATES = ["planning", "executing_tool", "waiting_for_tool", "waiting_for_approval", "observing"];

test("transition table admits resume entry edges from persisted mid-execution phases", () => {
  // planning -> planning is intentionally NOT an edge: startAgent's
  // resume path skips the transition when the persisted state is
  // already planning (see "Resume safety" in loop.js).
  for (const s of ["executing_tool", "waiting_for_tool", "waiting_for_approval", "observing"]) {
    assert.ok(canTransition(s, "planning"),
      `resume entry edge missing: ${s} -> planning`);
  }
  // Terminal states remain sealed.
  for (const t of ["completed", "failed", "cancelled"]) {
    assert.equal(canTransition(t, "planning"), false);
  }
});

for (const crashState of CRASH_STATES) {
  test(`resumeAgent accepts a crash persisted in ${crashState} and completes the run`, async () => {
    await withTempUserData(async () => {
      const core = makeFakeCore();
      const profileId = 1;
      const agentId = core.pmCreateAgent(10, "resume from crash").id;
      seedCrashState(core, agentId, crashState);

      const r = await resumeAgent({ core, profileId, agentId });
      assert.equal(r.ok, true,
        `resumeAgent rejected a ${crashState} crash state: ${JSON.stringify(r)}`);

      const cleared = await waitTerminal(agentId);
      assert.ok(cleared, "run must terminate and free the registry slot");

      const agent = core.pmGetAgent(profileId, agentId);
      assert.ok(
        [STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED].includes(agent.state),
        `agent.state=${agent.state}`
      );
      // Idempotent resume + crash-rollback contract (mirrors
      // agent-recovery.test.js): the pre-crash done step must NOT be
      // re-executed, and the step that was stuck `running` at crash
      // time is rolled back to `failed` (the model may retry it; the
      // no-tool scripted provider does not). No tool_result rows at
      // all means zero duplicate tool execution.
      const plan = JSON.parse(agent.plan_json);
      assert.equal(plan.steps[0].status, "done", "pre-crash completed step must stay done");
      assert.equal(plan.steps[1].status, "failed",
        "stuck running step must be rolled back to failed per the recovery contract");
      const msgs = core.pmListMessages(profileId, agentId);
      assert.equal(msgs.filter((m) => m.role === "tool_result").length, 0,
        "resume must not re-execute pre-crash tool work");
    });
  });
}

test("startAgent with isResume=true takes the same entry edge (resume parity)", async () => {
  await withTempUserData(async () => {
    const core = makeFakeCore();
    const profileId = 1;
    const agentId = core.pmCreateAgent(10, "direct isResume start").id;
    seedCrashState(core, agentId, "executing_tool");

    const started = await startAgent({ core, profileId, agentId, isResume: true, provider: scriptedProvider([{ text: "resumed" }]) });
    assert.equal(started.ok, true, `startAgent(isResume): ${JSON.stringify(started)}`);

    const cleared = await waitTerminal(agentId);
    assert.ok(cleared, "run must terminate");
    const agent = core.pmGetAgent(profileId, agentId);
    assert.ok([STATES.COMPLETED, STATES.FAILED].includes(agent.state), `agent.state=${agent.state}`);
  });
});
