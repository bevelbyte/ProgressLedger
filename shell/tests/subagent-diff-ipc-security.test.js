import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { authorizeDiffCaller } from "../src/security/subagent-diff-auth.js";

function coreWith(rows) {
  return { pmGetAgent(_profileId, id) { return rows.get(id) || null; } };
}

test("subagent diff auth: caller can read its descendant diff", async () => {
  const rows = new Map([
    [10, { id: 10, profile_id: 1, parent_agent_id: null }],
    [11, { id: 11, profile_id: 1, parent_agent_id: 10 }],
    [12, { id: 12, profile_id: 1, parent_agent_id: 11 }],
  ]);
  const result = await authorizeDiffCaller(coreWith(rows), 1, 10, 12);
  assert.equal(result.ok, true);
});

test("subagent diff auth: foreign sibling is denied even when target id is supplied", async () => {
  const rows = new Map([
    [10, { id: 10, profile_id: 1, parent_agent_id: null }],
    [11, { id: 11, profile_id: 1, parent_agent_id: 10 }],
    [20, { id: 20, profile_id: 1, parent_agent_id: null }],
    [21, { id: 21, profile_id: 1, parent_agent_id: 20 }],
  ]);
  const result = await authorizeDiffCaller(coreWith(rows), 1, 10, 21);
  assert.deepEqual(result, { ok: false, error: { code: "not-authorised", message: "agent is outside caller subtree" } });
});

test("subagent diff auth: omitting caller identity is denied", async () => {
  const rows = new Map([[10, { id: 10, profile_id: 1, parent_agent_id: null }]]);
  const result = await authorizeDiffCaller(coreWith(rows), 1, undefined, 10);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid-input");
});
test("subagent diff IPC: handler requires explicit caller identity and authorizes before root resolution", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/ipc/subagent-diff.js", import.meta.url)), "utf8");
  assert.match(source, /\{ profileId, callerAgentId, agentId, runId, files, maxBytes \}/);
  const auth = source.indexOf("authorizeDiffCaller(core, profileId, callerAgentId, agentId)");
  const root = source.indexOf("getActiveProjectRootFor(profileId, callerAgentId)");
  assert.ok(auth >= 0 && root > auth, "authorization must precede project-root resolution");
});
