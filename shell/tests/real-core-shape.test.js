// Production-stack shape regression tests (Phase 12).
//
// The REAL NAPI core (@progress-ledger/core) has a different surface shape
// than the in-memory fake cores used across the older test suite:
//
//   * pmCreateProject / pmCreateAgent return a PLAIN NUMBER row id.
//   * pmUpdateAgent / pmFinishAgent return undefined (void).
//   * Every row is camelCase-only (planJson, projectId, tokensIn,
//     parentAgentId) — no snake_case aliases.
//   * pmGetAgent rows carry parentAgentId ONLY when non-null.
//   * The core object exposes NO startAgent method.
//
// Reading the wrong shape silently yields `undefined` in production.
// These tests pin the shell layer against EXACTLY the real shape using
// a faithful core double (shape verified empirically against the
// compiled NAPI binary):
//
//   T1  full loop run on the real shape (persistence contract)
//   T2  delegate_research spawns a live child through the
//       ctx.startSubAgent wiring (would fail against the real core
//       without the number-return fix and the child-start wiring)
//   T3  normalizeAgentRow aliases tokens both spellings
//
// No network: the mock provider drives every model round.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startAgent, cancelAgent, getRun, AGENT_EVENTS, STATES, normalizeAgentRow } from "../src/services/agent/loop.js";
import { createMockProvider } from "../src/services/agent/provider.js";
import { _resetForTests as resetToolRegistry } from "../src/services/project-tools/index.js";

// ---------------------------------------------------------------------------
// real-shaped core double — mirrors the compiled NAPI surface EXACTLY
// ---------------------------------------------------------------------------

let agentIdSeq = 900_000;
let projectIdSeq = 900;
let subrunSeq = 9_000;

function makeRealShapeCore({ projectRoot } = {}) {
  const agents = new Map();
  const messages = new Map();
  const projects = new Map();
  const subruns = new Map();

  function now() {
    return new Date().toISOString().slice(0, 19).replace("T", " ");
  }

  function recordMessage(agentId, role, content, name) {
    const list = messages.get(agentId) || [];
    const row = { id: list.length + 1, agentId, seq: list.length + 1, role, content, createdAt: now() };
    if (name != null) row.name = name;
    list.push(row);
    messages.set(agentId, list);
    return row.seq;
  }

  const core = {
    // Plain-number returns, void returns — exactly like the NAPI binary.
    pmCreateProject(_profileId, name, description, rootPath, configJson) {
      const id = projectIdSeq++;
      projects.set(id, {
        id,
        profileId: _profileId,
        name,
        description: description ?? null,
        rootPath: rootPath ?? null,
        configJson: configJson ?? null,
        createdAt: now(),
        updatedAt: now(),
      });
      return id;
    },
    pmCreateAgent(projectId, objective, parentAgentId) {
      const id = agentIdSeq++;
      const row = {
        id,
        projectId,
        objective,
        state: STATES.IDLE,
        planJson: "[]",
        tokensIn: 0,
        tokensOut: 0,
        createdAt: now(),
        updatedAt: now(),
      };
      if (parentAgentId != null) row.parentAgentId = parentAgentId;
      agents.set(id, row);
      messages.set(id, []);
      return id;
    },
    pmGetAgent(_profileId, agentId) {
      const a = agents.get(agentId);
      return a ? { ...a } : null;
    },
    pmUpdateAgent(_profileId, agentId, state, planJson, tokensIn, tokensOut) {
      const a = agents.get(agentId);
      if (!a) return;
      a.state = state;
      a.planJson = planJson;
      a.tokensIn = tokensIn;
      a.tokensOut = tokensOut;
      a.updatedAt = now();
      // returns undefined (void), like the real core
    },
    pmFinishAgent(_profileId, agentId, state) {
      const a = agents.get(agentId);
      if (!a) return;
      a.state = state;
      a.updatedAt = now();
    },
    pmAppendMessage(_profileId, agentId, role, content, name) {
      return recordMessage(agentId, role, content, name);
    },
    pmListMessages(_profileId, agentId) {
      return [...(messages.get(agentId) || [])].sort((x, y) => x.seq - y.seq).map((m) => ({ ...m }));
    },
    pmGetProject(_profileId, projectId) {
      const p = projects.get(projectId);
      return p ? { ...p } : null;
    },
    pmGetChildren(_profileId, parentAgentId) {
      return [...agents.values()].filter((a) => a.parentAgentId === parentAgentId).map((a) => ({ ...a }));
    },
    pmInsertSubagentRun(_profileId, parentAgentId, role, childAgentId, runId) {
      const id = subrunSeq++;
      subruns.set(id, { id, parentAgentId, role: role ?? null, childAgentId: childAgentId ?? null, runId: runId ?? null });
      return id;
    },
    pmEndSubagentRun(_profileId, id, outcome, tokensIn, tokensOut, error) {
      const r = subruns.get(id);
      if (r) {
        r.outcome = outcome;
        r.tokensIn = tokensIn;
        r.tokensOut = tokensOut;
        r.error = error ?? "";
      }
    },
    pmListSubagentRuns(_profileId, parentAgentId, limit) {
      let rows = [...subruns.values()];
      if (parentAgentId != null) rows = rows.filter((r) => r.parentAgentId === parentAgentId);
      if (typeof limit === "number" && limit > 0) rows = rows.slice(0, limit);
      return rows;
    },
    // NO pmGetProfile, NO startAgent — the real NAPI core has neither.
    _agents: agents,
    _messages: messages,
    _projects: projects,
  };
  return core;
}

function makeProjectRoot() {
  const dir = mkdtempSync(join(tmpdir(), "cf-realshape-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.js"), "export const a = 1;\n");
  return dir;
}

async function runToTerminal(core, { profileId, agentId, provider, startSubAgent, timeoutMs = 30_000 }) {
  const startRes = await startAgent({ core, profileId, agentId, provider, startSubAgent });
  assert.equal(startRes.ok, true, `startAgent: ${JSON.stringify(startRes)}`);
  const terminal = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), timeoutMs);
    const done = (kind) => (e) => { clearTimeout(t); resolve({ kind, payload: e && e.payload }); };
    startRes.bus.on(AGENT_EVENTS.AGENT_COMPLETED, done("completed"));
    startRes.bus.on(AGENT_EVENTS.AGENT_FAILED, done("failed"));
    startRes.bus.on(AGENT_EVENTS.AGENT_CANCELLED, done("cancelled"));
  });
  // The run slot is cleared by the loop's finally block shortly after
  // the terminal event fires — poll briefly before asserting on it.
  const s = Date.now();
  while (getRun(agentId) !== null && Date.now() - s < 5000) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return { startRes, terminal };
}

// ---------------------------------------------------------------------------
// T1 — full loop run on the real shape
// ---------------------------------------------------------------------------

test("T1: loop completes on the real NAPI row shape (plain-number creates, camelCase rows, void updates)", async () => {
  resetToolRegistry();
  const root = makeProjectRoot();
  const core = makeRealShapeCore({ projectRoot: root });
  try {
    const profileId = 1;
    const projectId = core.pmCreateProject(profileId, "shape-probe", null, root, JSON.stringify({ context_packet_max_tokens: 0, context_packet_max_project_intel_tokens: 0 }));
    assert.equal(typeof projectId, "number", "pmCreateProject must return a plain number");
    const agentId = core.pmCreateAgent(projectId, "Reply with exactly PONG and nothing else. Do not use tools.", null);
    assert.equal(typeof agentId, "number", "pmCreateAgent must return a plain number");

    const { terminal } = await runToTerminal(core, { profileId, agentId, provider: createMockProvider({ text: "PONG" }) });
    assert.equal(terminal.kind, "completed", `terminal: ${JSON.stringify(terminal)}`);

    const row = core.pmGetAgent(profileId, agentId);
    assert.equal(row.state, STATES.COMPLETED);
    assert.equal(typeof row.planJson, "string", "row must carry camelCase planJson");
    assert.ok(row.tokensIn > 0 && row.tokensOut > 0, `tokens persisted, got in=${row.tokensIn} out=${row.tokensOut}`);

    const msgs = core.pmListMessages(profileId, agentId);
    assert.ok(msgs.length >= 3, `system+user+assistant expected, got ${msgs.length}`);
    for (const m of msgs) {
      assert.equal(typeof m.agentId, "number", "message rows are camelCase (agentId)");
      assert.ok(m.content != null);
    }
    assert.ok(msgs.some((m) => m.role === "assistant" && /PONG/.test(m.content)), "PONG in an assistant message");
    assert.equal(getRun(agentId), null, "no zombie run");
  } finally {
    resetToolRegistry();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T2 — delegate_research against the real shape (number id + startSubAgent)
// ---------------------------------------------------------------------------

test("T2: delegate_research spawns a child on the real NAPI shape via ctx.startSubAgent", async () => {
  resetToolRegistry();
  const root = makeProjectRoot();
  const core = makeRealShapeCore({ projectRoot: root });
  try {
    const profileId = 1;
    const projectId = core.pmCreateProject(profileId, "shape-delegate", null, root, JSON.stringify({ context_packet_max_tokens: 0, context_packet_max_project_intel_tokens: 0 }));
    const agentId = core.pmCreateAgent(projectId, "Use delegate_research for step-1, then report the child result.", null);

    // Round 1: parent calls delegate_research. Round 2: parent answers.
    const parentProvider = createMockProvider({
      toolCalls: [
        {
          id: "call-1",
          name: "delegate_research",
          args: JSON.stringify({ objective: "List the files under src/ and report how many exist.", step_id: "step-1" }),
        },
      ],
      text: "The researcher reports: 1 file under src/.",
    });
    // The child loop uses its own provider (no delegate tools available).
    const childProvider = createMockProvider({ text: '{"summary": "1 file under src/"}' });

    // Production wiring: the IPC layer passes startSubAgent because the
    // real core object has no startAgent method. Child provider is the
    // loop's concern in production (credential store); here we pin the
    // wiring itself, so resolve via a childArgs provider injection.
    const startSubAgent = (childArgs) => startAgent({ ...childArgs, core, provider: childProvider });

    const { terminal } = await runToTerminal(core, { profileId, agentId, provider: parentProvider, startSubAgent, timeoutMs: 60_000 });
    assert.equal(terminal.kind, "completed", `parent terminal: ${JSON.stringify(terminal)}`);

    const toolResults = core.pmListMessages(profileId, agentId).filter((m) => m.role === "tool_result");
    assert.ok(toolResults.length >= 1, "delegate_research tool result recorded");
    const delegateResult = JSON.parse(toolResults[0].content);
    assert.equal(delegateResult.ok, true, `delegate envelope ok: ${JSON.stringify(delegateResult).slice(0, 300)}`);
    assert.equal(typeof delegateResult.result.child_agent_id, "number", "child id is a number");
    assert.equal(delegateResult.result.state, STATES.COMPLETED, `child state: ${delegateResult.result.state}`);

    const childRow = core.pmGetAgent(profileId, delegateResult.result.child_agent_id);
    assert.ok(childRow, "child row exists");
    assert.equal(childRow.parentAgentId, agentId, "child row carries parentAgentId (camelCase, non-null only)");
    assert.equal(childRow.state, STATES.COMPLETED, "child completed");
    assert.equal(getRun(delegateResult.result.child_agent_id), null, "no zombie child run");
    // NOTE: the parent plan_json assigned_agent_id annotation is a
    // denormalized cache that the loop's own plan persists clobber
    // (known P2 gap). The AUTHORITATIVE parent->child link is
    // parentAgentId on the child row, asserted above.

    // cancelAgent cleanup hygiene
    assert.equal(cancelAgent(agentId).ok, false, "cancel after terminal refuses");
  } finally {
    resetToolRegistry();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T3 — normalizeAgentRow token aliases
// ---------------------------------------------------------------------------

test("T3: normalizeAgentRow aliases tokens in both spellings", () => {
  const camel = normalizeAgentRow({ id: 1, tokensIn: 3, tokensOut: 4 });
  assert.equal(camel.tokens_in, 3);
  assert.equal(camel.tokens_out, 4);
  const snake = normalizeAgentRow({ id: 2, tokens_in: 7, tokens_out: 8 });
  assert.equal(snake.tokensIn, 7);
  assert.equal(snake.tokensOut, 8);
});
