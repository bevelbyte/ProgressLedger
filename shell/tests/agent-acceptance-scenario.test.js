// Acceptance end-to-end agentic scenario test — deterministic fixture +
// multi-step execution with parallel tool-call rounds, a verify-gate
// fix-retry cycle, and a final verification summary.
//
// This is the PRIMARY ACCEPTANCE SCENARIO for Project Mode's agentic
// loop in the v7 sprint. It is hermetic: no SQLite, no NAPI binding,
// no network.
//
// The scenario exercises the full GOAL -> UNDERSTAND -> IMPLEMENT
// (parallel fs_write x2) -> WRITE TESTS (parallel fs_write x2) ->
// TEST (FAIL) -> VERIFY-FAIL -> FIX-RETRY -> VERIFY-PASS -> COMPLETE
// path through `startAgent`, using:
//
//   - the `acceptanceProvider` from `src/services/agent/fixture-acceptance.js`
//   - a fake `core` that records every pm_* call in memory
//   - monkey-patched `test_run` / `fs_write` / `inspect_project` tools
//     so the verification gate's first pass fails (recovery leg) and the
//     second passes (completion leg)
//
// Key assertions:
//   (a) terminal state is `completed`
//   (b) the plan ends with all steps in `done` status + at least one
//       `fix-*` step also in `done` status
//   (c) a `verified` status message exists (the gate passed)
//   (d) a `fix-retrying` status message exists (the FAILURE leg fired)
//   (e) the final assistant message contains "All steps verified"
//   (f) at least 4 `tool_call` rows and 4 `tool_result` rows exist
//   (g) at least 1 `tool_call` round contains 2+ tool calls (parallel
//       fs_write round)
//   (h) fs_write was called >=4 times (2 parallel implement + 2 parallel
//       test writes)
//   (i) test_run was called exactly 3 times (gate fail + in-loop fail +
//       gate pass)
//   (j) the fixture has exactly 10 scripted rounds

import test from "node:test";
import assert from "node:assert/strict";

import { startAgent, AGENT_EVENTS, STATES } from "../src/services/agent/loop.js";
import { acceptanceProvider, acceptanceSequence } from "../src/services/agent/fixture-acceptance.js";
import { PROJECT_TOOLS } from "../src/services/project-tools/index.js";
import { parsePlan, isPlanComplete } from "../src/services/agent/plan.js";

// ---------------------------------------------------------------------------
// Fixture sanity: acceptanceSequence is well-formed and acceptanceProvider
// wraps it correctly.
// ---------------------------------------------------------------------------

test("acceptance fixture: acceptanceSequence has the 10 rounds the scenario needs", () => {
  const seq = acceptanceSequence();
  assert.equal(seq.length, 10, `expected exactly 10 scripted rounds, got ${seq.length}`);
  // Round 1: text-only plan message (no tool calls).
  assert.equal(seq[0].finishReason, "stop");
  assert.equal(seq[0].toolCalls, undefined);
  assert.match(seq[0].text, /Plan:/);
  assert.match(seq[0].text, /count_lines/);
  // Round 2: inspect_project.
  assert.equal(seq[1].toolCalls.length, 1);
  assert.equal(seq[1].toolCalls[0].name, "inspect_project");
  // Round 3: TWO PARALLEL fs_write calls (core + CLI).
  assert.equal(seq[2].toolCalls.length, 2);
  assert.equal(seq[2].toolCalls[0].name, "fs_write");
  assert.equal(seq[2].toolCalls[1].name, "fs_write");
  assert.match(JSON.parse(seq[2].toolCalls[0].args).path, /count_lines\.js/);
  // Round 4: TWO PARALLEL fs_write calls (unit + integration tests).
  assert.equal(seq[3].toolCalls.length, 2);
  assert.equal(seq[3].toolCalls[0].name, "fs_write");
  assert.equal(seq[3].toolCalls[1].name, "fs_write");
  assert.match(JSON.parse(seq[3].toolCalls[0].args).path, /count_lines\.test\.js/);
  // Round 5: test_run + diagnose text (the in-loop test that fails).
  assert.equal(seq[4].toolCalls.length, 1);
  assert.equal(seq[4].toolCalls[0].name, "test_run");
  assert.match(seq[4].text, /countLines/);
  assert.match(seq[4].text, /split/);
  // Round 6: final summary text (the gate's post-success streamChat).
  assert.equal(seq[5].finishReason, "stop");
  assert.equal(seq[5].toolCalls, undefined);
  assert.match(seq[5].text, /All steps verified/);
  assert.match(seq[5].text, /count_lines/);
  // Round 7: fix fs_write (safety net).
  assert.equal(seq[6].toolCalls.length, 1);
  assert.equal(seq[6].toolCalls[0].name, "fs_write");
  assert.match(JSON.parse(seq[6].toolCalls[0].args).path, /count_lines\.js/);
  assert.match(JSON.parse(seq[6].toolCalls[0].args).content, /fixed/);
  // Round 8: re-run test_run (safety net).
  assert.equal(seq[7].toolCalls.length, 1);
  assert.equal(seq[7].toolCalls[0].name, "test_run");
  // Round 9: extra test_run (safety net).
  assert.equal(seq[8].toolCalls.length, 1);
  assert.equal(seq[8].toolCalls[0].name, "test_run");
  // Round 10: extra text (safety net).
  assert.equal(seq[9].finishReason, "stop");
  assert.equal(seq[9].toolCalls, undefined);
});

test("acceptance fixture: acceptanceProvider wraps scriptedProvider and is internal-only", () => {
  const prov = acceptanceProvider();
  assert.equal(prov._internal, true, "acceptanceProvider must mark itself as a test-only provider");
  assert.equal(typeof prov.streamChat, "function");
  assert.equal(typeof prov._getRound, "function");
  assert.equal(prov._getRound(), 0, "round counter starts at 0");
});

// ---------------------------------------------------------------------------
// Helpers: a fake `core` (in-memory SQLite replacement).
// ---------------------------------------------------------------------------

function makeFakeCore() {
  const agents = new Map();
  const messages = new Map();
  let nextAgentId = 2000;
  function record(agentId, role, content, name, payloadJson) {
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
  }
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
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        parent_agent_id: null,
      });
      messages.set(id, []);
      return { id };
    },
    pmGetAgent(_profileId, agentId) {
      const a = agents.get(agentId);
      if (!a) throw new Error("not found");
      return { ...a };
    },
    pmUpdateAgent(_profileId, agentId, state, planJson, tokensIn, tokensOut) {
      const a = agents.get(agentId);
      if (!a) throw new Error("not found");
      a.state = state;
      a.plan_json = planJson;
      a.tokens_in = tokensIn;
      a.tokens_out = tokensOut;
      a.updated_at = new Date().toISOString();
      return { ok: true };
    },
    pmAppendMessage(profileId, agentId, role, content, name, payloadJson) {
      record(agentId, role, content, name, payloadJson);
      return { seq: (messages.get(agentId) || []).length };
    },
    pmFinishAgent(_profileId, agentId, state) {
      const a = agents.get(agentId);
      if (!a) throw new Error("not found");
      a.state = state;
      a.finished_at = new Date().toISOString();
    },
    pmGetProject(_profileId, _projectId) {
      return {
        id: 20,
        profile_id: 1,
        name: "Acceptance scenario project",
        description: "count_lines tool acceptance test",
        root_path: "/tmp/acceptance-scenario",
        config_json: "{}",
        created_at: "1970-01-01T00:00:00Z",
        updated_at: "1970-01-01T00:00:00Z",
      };
    },
    pmListMessages(_profileId, agentId) {
      return (messages.get(agentId) || []).slice();
    },
    pmGetProfile(_profileId) {
      return { id: 1, profile_config: "{}" };
    },
    _agents: agents,
    _messages: messages,
  };
  return core;
}

// Pre-seed a 4-step plan matching the acceptance brief:
//   step-1 (understand) -> step-2 (implement) ->
//   step-3 (write tests) -> step-4 (run tests)
function seedPlan(core, agentId) {
  const plan = {
    version: 1,
    steps: [
      { id: "step-1", title: "Understand the repository", status: "pending", depends_on: [], files: [], assigned_to: null },
      { id: "step-2", title: "Implement count_lines tool", status: "pending", depends_on: ["step-1"], files: [], assigned_to: null },
      { id: "step-3", title: "Write test suite", status: "pending", depends_on: ["step-2"], files: [], assigned_to: null },
      { id: "step-4", title: "Run the tests", status: "pending", depends_on: ["step-3"], files: [], assigned_to: null },
    ],
  };
  core.pmUpdateAgent(1, agentId, STATES.IDLE, JSON.stringify(plan), 0, 0);
  return plan;
}

// ---------------------------------------------------------------------------
// The end-to-end acceptance test.
// ---------------------------------------------------------------------------

test("e2e acceptance: full multi-step loop with parallel tools + verify-gate fix-retry drives GOAL -> IMPLEMENT -> FAILURE -> RECOVERY -> VERIFY -> COMPLETE", async () => {
  const core = makeFakeCore();
  const created = core.pmCreateAgent(
    20,
    "Add a count_lines tool that counts non-empty lines in a given file. Implement the core module and CLI wrapper in parallel, write unit and integration tests in parallel, run the test suite, diagnose any failure, fix the implementation, verify the result, and provide a final report."
  );
  const agentId = created.id;
  const plan = seedPlan(core, agentId);

  // Patch the 3 tools the agent will invoke.
  const inspect = PROJECT_TOOLS.inspect_project;
  const fsWrite = PROJECT_TOOLS.fs_write;
  const testRun = PROJECT_TOOLS.test_run;
  const origInspect = inspect.execute;
  const origWrite = fsWrite.execute;
  const origTest = testRun.execute;

  const fsWriteCalls = [];
  let testCallCount = 0;

  inspect.execute = async () => ({
    ok: true,
    result: {
      root: "/tmp/acceptance-scenario",
      entries: ["README.md", "count_lines.js", "count_lines.test.js", "count_lines.integration.test.js"],
      fileCount: 4,
      dirCount: 1,
    },
  });
  fsWrite.execute = async (input) => {
    fsWriteCalls.push({ path: input && input.path, content: input && input.content });
    return { ok: true, result: { written: true } };
  };
  // test_run fails on calls 1 and 2 (gate fail + in-loop fail), passes
  // on call 3 (gate pass after fix step).
  testRun.execute = async () => {
    testCallCount += 1;
    if (testCallCount <= 2) {
      return {
        ok: true,
        result: {
          passed: false,
          stdout: "FAIL: empty string -> 1",
          stderr: "AssertionError: countLines('') !== 0",
          code: 1,
          exitCode: 1,
        },
      };
    }
    return {
      ok: true,
      result: {
        passed: true,
        stdout: "All tests passed (2 suites, 5 tests).",
        stderr: "",
        code: 0,
      },
    };
  };

  // verify.js only calls test_run when config_json has a test_command.
  core.pmGetProject = () => ({
    id: 20,
    profile_id: 1,
    name: "Acceptance scenario project",
    description: "count_lines tool acceptance test",
    root_path: "/tmp/acceptance-scenario",
    config_json: JSON.stringify({ test_command: "node", test_timeout_ms: 10_000 }),
    created_at: "1970-01-01T00:00:00Z",
    updated_at: "1970-01-01T00:00:00Z",
  });

  const provider = acceptanceProvider();

  let startRes = null;
  try {
    startRes = await startAgent({
      core,
      profileId: 1,
      agentId,
      provider,
      approvalResolver: async () => ({ approved: true }),
      isSubAgent: false,
      role: null,
    });
    assert.equal(
      startRes.ok,
      true,
      `expected startAgent to return ok:true, got ${JSON.stringify(startRes)}`
    );
    const bus = startRes.bus;

    const terminal = await new Promise((resolve) => {
      bus.on(AGENT_EVENTS.AGENT_COMPLETED, (e) => resolve({ kind: "completed", payload: e.payload }));
      bus.on(AGENT_EVENTS.AGENT_FAILED, (e) => resolve({ kind: "failed", payload: e.payload }));
      bus.on(AGENT_EVENTS.AGENT_CANCELLED, () => resolve({ kind: "cancelled" }));
    });

    // (a) Terminal state is `completed`.
    assert.equal(
      terminal.kind,
      "completed",
      `expected completed, got ${terminal.kind} ${JSON.stringify(terminal.payload)}`
    );

    // (b) pm_agents state is `completed` and finished_at is set.
    const a = core._agents.get(agentId);
    assert.equal(a.state, STATES.COMPLETED, `agent state should be completed, got ${a.state}`);
    assert.ok(a.finished_at, "finished_at must be set");
    assert.ok(
      typeof a.finished_at === "string" && a.finished_at.length > 0,
      "finished_at must be a non-empty ISO string"
    );

    // (c) pm_messages has the expected row count.
    const msgs = core._messages.get(agentId) || [];
    assert.ok(msgs.length >= 10, `expected >=10 messages, got ${msgs.length}`);

    // (d) plan_json ends with all steps + at least one fix-* step in `done` status.
    const finalPlan = parsePlan(a.plan_json);
    assert.equal(
      isPlanComplete(finalPlan),
      true,
      `final plan should be complete: ${JSON.stringify(finalPlan)}`
    );
    for (const s of finalPlan.steps) {
      assert.equal(s.status, "done", `step ${s.id} should be done, got ${s.status}`);
    }
    const fixSteps = finalPlan.steps.filter((s) => s.id.startsWith("fix-"));
    assert.ok(
      fixSteps.length >= 1,
      "expected at least one fix step appended by the verification gate"
    );
    for (const s of fixSteps) {
      assert.equal(s.status, "done", `fix step ${s.id} should be done`);
    }

    // (e) a `verified` status row exists (the gate passed).
    const verified = msgs.filter((m) => m.role === "status" && m.name === "verified");
    assert.ok(
      verified.length >= 1,
      `expected at least one 'verified' status message, got ${verified.length}`
    );
    const verifiedPayload = JSON.parse(verified[0].payload_json);
    assert.equal(verifiedPayload.name, "verified");
    assert.equal(verifiedPayload.reason, "test-passed");

    // (f) a `fix-retrying` status row exists (proves the FAILURE leg fired).
    const fixRetrying = msgs.filter((m) => m.role === "status" && m.name === "fix-retrying");
    assert.ok(
      fixRetrying.length >= 1,
      `expected at least one 'fix-retrying' status message, got ${fixRetrying.length}`
    );
    const fixRetryingPayload = JSON.parse(fixRetrying[0].payload_json);
    assert.equal(fixRetryingPayload.fixAttempts, 1);

    // (g) the final assistant message mentions 'All steps verified'.
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    assert.ok(
      assistantMsgs.length >= 1,
      `expected at least one assistant message, got ${assistantMsgs.length}`
    );
    const lastAssistant = assistantMsgs[assistantMsgs.length - 1].content;
    assert.match(
      lastAssistant,
      /All steps verified/,
      `final assistant message should mention 'All steps verified', got: ${JSON.stringify(lastAssistant)}`
    );

    // (h) tool_call + tool_result rows are present.
    const toolCalls = msgs.filter((m) => m.role === "tool_call");
    const toolResults = msgs.filter((m) => m.role === "tool_result");
    assert.ok(toolCalls.length >= 4, `expected >=4 tool_call rows, got ${toolCalls.length}`);
    assert.ok(toolResults.length >= 4, `expected >=4 tool_result rows, got ${toolResults.length}`);

    // (i) at least one `tool_call` round contains 2+ tool calls (parallel fs_write round).
    const multiToolRounds = toolCalls.filter((m) => {
      try {
        const parsed = JSON.parse(m.content);
        return Array.isArray(parsed) && parsed.length >= 2;
      } catch (_e) {
        return false;
      }
    });
    assert.ok(
      multiToolRounds.length >= 1,
      `expected at least one tool_call round with 2+ tool calls (the parallel fs_write round), got ${multiToolRounds.length}`
    );

    // (j) fs_write was called >=4 times (2 parallel implement + 2 parallel test writes).
    assert.ok(
      fsWriteCalls.length >= 4,
      `expected >=4 fs_write calls, got ${fsWriteCalls.length}`
    );
    // The first two fs_write calls target count_lines.js and count_lines.cli.js.
    assert.equal(fsWriteCalls[0].path, "count_lines.js");
    assert.equal(fsWriteCalls[1].path, "count_lines.cli.js");
    // The next two target the test files.
    assert.match(fsWriteCalls[2].path, /count_lines\.test\.js/);
    assert.match(fsWriteCalls[3].path, /count_lines\.integration\.test\.js/);

    // (k) test_run was called exactly 3 times (gate fail + in-loop fail + gate pass).
    assert.equal(
      testCallCount,
      3,
      `expected test_run to be called exactly 3 times, got ${testCallCount} times`
    );
  } finally {
    inspect.execute = origInspect;
    fsWrite.execute = origWrite;
    testRun.execute = origTest;
    void plan;
  }
});
