// SF-4 — authorization must precede approval-token consumption on
// `project:invoke-tool`.
//
// An approval token is SINGLE-USE. Before this ordering was fixed, the handler
// consumed the token first and only then called authorizeProjectToolScope().
// Execution was already blocked for an unauthorized caller, so it was never an
// execution bypass — but the unauthorized caller could still BURN a valid
// token, forcing the legitimate user to approve again.
//
// These tests drive the real Electron-free handler
// (`ipc/project-tools-invoke.js`), which is exactly what `ipc/project-tools.js`
// registers for the channel, so the ordering under test is the shipped one.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createInvokeToolHandler } from "../src/ipc/project-tools-invoke.js";
import {
  APPROVAL_REQUIRED,
  mintApprovalToken,
  purgeExpiredApprovalTokens,
  requiresToolApproval,
} from "../src/services/project-tools/security.js";
import { PROJECT_TOOLS } from "../src/services/project-tools/index.js";

/** Pick a real tool that requires approval and build input its schema accepts. */
const APPROVED_TOOL = [...APPROVAL_REQUIRED].find((name) => {
  const t = PROJECT_TOOLS[name];
  return t && requiresToolApproval(name, t);
});
assert.ok(APPROVED_TOOL, "registry must expose at least one approval-gated tool");

/**
 * Build a minimal valid input for the chosen tool straight from its declared
 * JSON-Schema subset, so the test never depends on a guessed payload shape.
 */
const TOOL_INPUT = (() => {
  const schema = PROJECT_TOOLS[APPROVED_TOOL].inputSchema || {};
  const out = {};
  for (const field of schema.required || []) {
    const spec = (schema.properties || {})[field] || {};
    if (spec.type === "string") out[field] = "npm";
    else if (spec.type === "number") out[field] = 1;
    else if (spec.type === "boolean") out[field] = false;
    else if (spec.type === "array") out[field] = [];
    else out[field] = {};
  }
  return out;
})();

test("SF-4: the chosen approval-gated tool accepts the generated input", async () => {
  const { validateToolInvocation } = await import("../src/services/project-tools/security.js");
  const { getTool } = await import("../src/services/project-tools/index.js");
  const v = validateToolInvocation(APPROVED_TOOL, TOOL_INPUT, { getTool });
  assert.equal(v.ok, true, `generated input must validate: ${JSON.stringify(v)} input=${JSON.stringify(TOOL_INPUT)}`);
});

function ownedCore() {
  return {
    pmGetAgent: async () => ({ id: 21, profileId: 7, projectId: 11 }),
    pmGetProject: async () => ({ id: 11, profileId: 7 }),
  };
}

/** Core where agent 21 belongs to a DIFFERENT project than the one claimed. */
function foreignCore() {
  return {
    pmGetAgent: async () => ({ id: 21, profileId: 7, projectId: 12 }),
    pmGetProject: async () => ({ id: 11, profileId: 7 }),
  };
}

function recordingExec() {
  const calls = [];
  const exec = async (tool, input, ctx) => {
    calls.push({ tool, input, ctx });
    return { ok: true, result: "executed" };
  };
  return { calls, exec };
}

test("SF-4: an unauthorized scope cannot consume a valid single-use approval token", async () => {
  const { calls, exec } = recordingExec();
  const invoke = createInvokeToolHandler({ core: foreignCore(), exec });

  // The legitimate user mints a real, valid token for their own scope.
  const token = mintApprovalToken(APPROVED_TOOL, TOOL_INPUT, {
    profileId: 7, projectId: 11, agentId: 21,
  });

  // An unauthorized caller presents that token with a scope that fails
  // authorizeProjectToolScope (agent 21 actually lives in project 12).
  const attack = await invoke({
    toolName: APPROVED_TOOL,
    input: TOOL_INPUT,
    approvalToken: token,
    profileId: 7, projectId: 11, agentId: 21,
  });

  // Execution blocked ...
  assert.equal(attack.ok, false);
  assert.equal(attack.error.code, "not-owned");
  assert.equal(calls.length, 0, "no tool may execute for an unauthorized scope");

  // ... and, critically, the token must NOT have been consumed. The same token
  // is still usable by the authorized owner.
  const owner = createInvokeToolHandler({ core: ownedCore(), exec });
  const legit = await owner({
    toolName: APPROVED_TOOL,
    input: TOOL_INPUT,
    approvalToken: token,
    profileId: 7, projectId: 11, agentId: 21,
  });
  assert.equal(legit.ok, true, `the authorized owner must still be able to use the token: ${JSON.stringify(legit)}`);
  assert.equal(calls.length, 1, "exactly one execution, by the authorized owner");

  // The token is genuinely single-use: replay by the owner now fails.
  const replay = await owner({
    toolName: APPROVED_TOOL,
    input: TOOL_INPUT,
    approvalToken: token,
    profileId: 7, projectId: 11, agentId: 21,
  });
  assert.equal(replay.ok, false);
  assert.ok(replay.requiresApproval, "a burned token must re-prompt for approval");
  assert.equal(calls.length, 1, "a replayed token must not execute again");
});

test("SF-4: an incomplete scope tuple cannot consume a token either", async () => {
  const { calls, exec } = recordingExec();
  const invoke = createInvokeToolHandler({ core: ownedCore(), exec });
  const token = mintApprovalToken(APPROVED_TOOL, TOOL_INPUT, {
    profileId: 7, projectId: 11, agentId: 21,
  });

  // profileId without projectId/agentId is refused before consumption.
  const partial = await invoke({
    toolName: APPROVED_TOOL,
    input: TOOL_INPUT,
    approvalToken: token,
    profileId: 7,
  });
  assert.equal(partial.ok, false);
  assert.equal(partial.error.code, "invalid-ids");
  assert.equal(calls.length, 0);

  // Token survives the rejected attempt.
  const owner = createInvokeToolHandler({ core: ownedCore(), exec });
  const legit = await owner({
    toolName: APPROVED_TOOL,
    input: TOOL_INPUT,
    approvalToken: token,
    profileId: 7, projectId: 11, agentId: 21,
  });
  assert.equal(legit.ok, true, "an invalid-ids rejection must not burn the token");
});

test("SF-4: a scope that cannot be verified at all cannot consume a token", async () => {
  const { calls, exec } = recordingExec();
  // core-not-wired: authorizeProjectToolScope cannot prove ownership.
  const invoke = createInvokeToolHandler({ core: {}, exec });
  const token = mintApprovalToken(APPROVED_TOOL, TOOL_INPUT, {
    profileId: 7, projectId: 11, agentId: 21,
  });

  const res = await invoke({
    toolName: APPROVED_TOOL,
    input: TOOL_INPUT,
    approvalToken: token,
    profileId: 7, projectId: 11, agentId: 21,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "core-not-wired");
  assert.equal(calls.length, 0);

  const owner = createInvokeToolHandler({ core: ownedCore(), exec });
  const legit = await owner({
    toolName: APPROVED_TOOL,
    input: TOOL_INPUT,
    approvalToken: token,
    profileId: 7, projectId: 11, agentId: 21,
  });
  assert.equal(legit.ok, true, "a core-not-wired rejection must not burn the token");
});

test("SF-4: missing approval still prompts for an authorized caller (unchanged behaviour)", async () => {
  const { calls, exec } = recordingExec();
  const invoke = createInvokeToolHandler({ core: ownedCore(), exec });

  const res = await invoke({
    toolName: APPROVED_TOOL,
    input: TOOL_INPUT,
    profileId: 7, projectId: 11, agentId: 21,
  });
  assert.equal(res.ok, false);
  assert.equal(res.requiresApproval.tool, APPROVED_TOOL);
  assert.equal(calls.length, 0);
});

test("SF-4: the handler sources authorize before consuming, in the shipped order", () => {
  const source = readFileSync(
    new URL("../src/ipc/project-tools-invoke.js", import.meta.url),
    "utf8",
  );
  const authorizeAt = source.indexOf("authorizeProjectToolScope(core");
  const consumeAt = source.indexOf("consumeApprovalToken(approvalToken");
  const execAt = source.indexOf("await exec(t, input, ctxForRun)");
  assert.ok(authorizeAt > 0, "authorizeProjectToolScope must be called");
  assert.ok(consumeAt > 0, "consumeApprovalToken must be called");
  assert.ok(execAt > 0, "the tool must be executed");
  assert.ok(authorizeAt < consumeAt, "authorization must precede token consumption");
  assert.ok(consumeAt < execAt, "token consumption must precede execution");
});

test("SF-4: the Electron IPC surface delegates to the tested handler", () => {
  const source = readFileSync(
    new URL("../src/ipc/project-tools.js", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /safeHandle\("project:invoke-tool",[\s\S]{0,200}invokeTool\(payload\)\)/,
    "project:invoke-tool must delegate to the Electron-free handler",
  );
  assert.match(source, /createInvokeToolHandler\(\{\s*core: ctx\.core/);
});

test("SF-4: purgeExpiredApprovalTokens still works (regression guard)", () => {
  purgeExpiredApprovalTokens(Date.now() + 10 * 60_000);
});
