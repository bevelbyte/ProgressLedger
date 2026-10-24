// shell/tests/hooks-verification-cardinality.test.js
// ---------------------------------------------------------------------------
// Pins the RESOLVED answer to the one question FINALVAL6 left open:
//
//   "Does one verification completion produce one public hook event or two?"
//
// ANSWER: ONE. And this test proves it behaviourally, by driving a real
// verification to PASS through the real agent loop and counting the emissions.
//
// WHY THE QUESTION EXISTED
//   `shell/src/services/hooks/index.js` used to assert that "nothing clearly
//   corresponds to `verification.completed`", because the loop has no event
//   literally named "verification completed" — it reuses ONE event name,
//   `agent.verifying`, for both the START and the END of a pass:
//
//     loop.js:832   agent.verifying { agentId }                              start
//     loop.js:1017  agent.verifying { agentId }                              start
//     loop.js:1234  agent.verifying { agentId }                              start
//     loop.js:1452  agent.verifying { agentId, verified: true }             PASSED
//     loop.js:1472  agent.verifying { agentId, verified: false, exhausted }  exhausted
//     loop.js:1511  agent.verifying { agentId, verified: false, fixStepId } fix attempt
//
//   The apparent "two" was an artifact of the overloaded NAME, not of the
//   lifecycle. The `verified` field is the discriminator: it is ABSENT on the
//   start emissions and PRESENT on the completion.
//
//   So the correct public mapping is:
//
//     verification.completed  <-  agent.verifying with verified === true
//
//   and it must fire exactly ONCE per passing verification. If someone later
//   "helpfully" also maps the start emissions, or double-fires on completion,
//   a plugin would see two events for one verification — which is precisely the
//   semantic corruption the open question existed to prevent. That is what the
//   assertions below forbid.
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startAgent, AGENT_EVENTS, STATES } from "../src/services/agent/loop.js";
import { scriptedProvider, defaultE2ESequence } from "../src/services/agent/fixture.js";
import { getTool } from "../src/services/project-tools/index.js";
import { _setUserDataDir, _closeAll } from "../src/services/memory/index.js";
import { _resetForTests } from "../src/services/audit/index.js";

let nextAgentIdSeq = 1;
let nextSubagentRunSeq = 1;

// A deliberately small fake core: this test needs the agent row, the plan, the
// message log and the project config (which carries `test_command`, so the
// verify gate actually runs). Copied in the shape gate16-cancellation-stages
// already uses, so the loop sees exactly what it sees there.
function makeFakeCore({ configJson = "{}" } = {}) {
  const agents = new Map();
  const messages = new Map();

  function recordMessage(agentId, role, content, name, payloadJson) {
    const list = messages.get(agentId) || [];
    list.push({
      id: list.length + 1,
      agent_id: agentId,
      seq: list.length + 1,
      role,
      content: typeof content === "string" ? content : JSON.stringify(content),
      name: name == null ? null : name,
      payload_json: payloadJson == null ? null : payloadJson,
    });
    messages.set(agentId, list);
    return list.length;
  }

  return {
    pmCreateAgent(projectId, objective, parentAgentId) {
      const id = nextAgentIdSeq++;
      agents.set(id, {
        id,
        projectId,
        project_id: projectId,
        objective,
        state: STATES.IDLE,
        plan_json: "[]",
        tokens_in: 0,
        tokens_out: 0,
        finished_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        parent_agent_id: typeof parentAgentId === "number" ? parentAgentId : null,
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
      if (planJson !== undefined) a.plan_json = planJson;
      if (tokensIn !== undefined) a.tokens_in = tokensIn;
      if (tokensOut !== undefined) a.tokens_out = tokensOut;
      a.updated_at = new Date().toISOString();
      return { ok: true };
    },
    pmAppendMessage(_profileId, agentId, role, content, name, payloadJson) {
      return { seq: recordMessage(agentId, role, content, name, payloadJson) };
    },
    pmFinishAgent(_profileId, agentId, state) {
      const a = agents.get(agentId);
      if (!a) return { ok: false };
      a.state = state;
      a.finished_at = new Date().toISOString();
      return { ok: true };
    },
    pmListMessages(_profileId, agentId) {
      return [...(messages.get(agentId) || [])].sort((a, b) => a.seq - b.seq);
    },
    pmGetProject(_profileId, _projectId) {
      return {
        id: 10,
        profile_id: 1,
        name: "verification cardinality fixture",
        description: "one completion is one event",
        root_path: "/tmp/cardinality",
        config_json: configJson,
        created_at: "1970-01-01T00:00:00Z",
        updated_at: "1970-01-01T00:00:00Z",
      };
    },
    pmGetProfile(_profileId) {
      return { id: 1, profile_config: "{}" };
    },
    pmInsertSubagentRun() {
      return nextSubagentRunSeq++;
    },
    pmEndSubagentRun() {
      return { ok: true };
    },
    _agents: agents,
    _messages: messages,
  };
}

async function withTempUserData(fn) {
  const dir = mkdtempSync(join(tmpdir(), "cf-hooks-cardinality-"));
  _resetForTests();
  _setUserDataDir(dir);
  try {
    return await fn();
  } finally {
    await _closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("one PASSING verification emits exactly one agent.verifying with verified:true", { timeout: 30_000 }, async () => {
  await withTempUserData(async () => {
    // `test_command` present, so verifyCompletion really runs and really can
    // pass. Without it the gate would short-circuit and prove nothing.
    const core = makeFakeCore({
      configJson: JSON.stringify({ test_command: "node", test_timeout_ms: 1000 }),
    });
    const { id: agentId } = core.pmCreateAgent(10, "write then verify");

    // Force every verification to PASS on its first pass, so exactly one
    // completion occurs and no fix-retry path is entered.
    const testRunTool = getTool("test_run");
    const originalExecute = testRunTool.execute;
    testRunTool.execute = async () => ({
      ok: true,
      result: { stdout: "ok", stderr: "", exitCode: 0, passed: true, timedOut: false },
    });

    const provider = scriptedProvider(defaultE2ESequence());
    const started = await startAgent({ core, profileId: 1, agentId, provider });
    const bus = started.bus;

    const emissions = [];
    bus.on(AGENT_EVENTS.AGENT_VERIFYING, (e) => {
      emissions.push(e && e.payload ? e.payload : e);
    });

    const terminal = new Promise((resolve) => {
      bus.on(AGENT_EVENTS.AGENT_COMPLETED, (e) => resolve({ kind: "completed", payload: e.payload }));
      bus.on(AGENT_EVENTS.AGENT_FAILED, (e) => resolve({ kind: "failed", payload: e.payload }));
      bus.on(AGENT_EVENTS.AGENT_CANCELLED, () => resolve({ kind: "cancelled" }));
    });

    try {
      const outcome = await terminal;
      testRunTool.execute = originalExecute;

      assert.equal(
        outcome.kind,
        "completed",
        `the fixture must reach a COMPLETED run so a verification actually passed (got ${JSON.stringify(outcome.payload)})`,
      );

      // THE CARDINALITY ASSERTION.
      const completions = emissions.filter((p) => p && p.verified === true);
      assert.equal(
        completions.length,
        1,
        `one verification completion must raise exactly ONE event, saw ${completions.length}: ${JSON.stringify(emissions)}`,
      );

      // And the discrimination the mapping depends on: the START emissions must
      // NOT carry `verified`, otherwise a hook could not tell a start from a
      // completion and `verification.completed` would be ambiguous again.
      const starts = emissions.filter((p) => p && p.verified === undefined);
      assert.ok(
        starts.length >= 1,
        `the verify gate must announce its start too, saw ${JSON.stringify(emissions)}`,
      );
      for (const s of starts) {
        assert.equal(
          s.verified,
          undefined,
          "a start emission must not carry `verified`; that field is the only thing separating start from completion",
        );
      }

      // A `verified:false` emission is fix-retry bookkeeping, never a second
      // completion. With a passing first verification there must be none.
      const failures = emissions.filter((p) => p && p.verified === false);
      assert.equal(
        failures.length,
        0,
        `a first-pass success must not emit verified:false fix bookkeeping, saw ${JSON.stringify(failures)}`,
      );
    } finally {
      testRunTool.execute = originalExecute;
    }
  });
});
