import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { authorizeAgentRecord, authorizeProjectRecord, isApprovalOwned, sanitizeApprovalEntry } from "../src/security/project-mode-auth.js";

const projectModeSource = readFileSync(
  fileURLToPath(new URL("../src/ipc/project-mode.js", import.meta.url)),
  "utf8",
);

test("project-mode auth: missing or foreign agent ownership is denied", () => {
  const owned = { id: 11, profile_id: 7 };
  assert.deepEqual(authorizeAgentRecord(7, 11, owned), { ok: true, agent: owned });
  assert.deepEqual(authorizeAgentRecord(8, 11, null), { ok: false, error: "agent-not-owned" });
  assert.deepEqual(authorizeAgentRecord(7, 99, null), { ok: false, error: "agent-not-owned" });
  assert.deepEqual(authorizeAgentRecord(7, 11, { id: 11, profile_id: 8 }), { ok: false, error: "agent-not-owned" });
  assert.deepEqual(authorizeAgentRecord(7, undefined, owned), { ok: false, error: "invalid-ids" });
});

test("project-mode auth: approval cannot cross profile or agent boundary", () => {
  const approval = { id: "11:c1", profileId: 7, agentId: 11, toolName: "exec_run", input: { secret: "DO-NOT-LEAK" }, resolve() {} };
  assert.equal(isApprovalOwned(approval, 7, 11), true);
  assert.equal(isApprovalOwned(approval, 8, 11), false);
  assert.equal(isApprovalOwned(approval, 7, 12), false);
  assert.equal(isApprovalOwned(approval, undefined, undefined), false);
});

test("project-mode auth: approval summaries exclude resolver and raw tool input", () => {
  const summary = sanitizeApprovalEntry({
    id: "11:c1",
    profileId: 7,
    agentId: 11,
    callId: "c1",
    toolName: "exec_run",
    permission: "execute",
    input: { command: "SECRET-COMMAND" },
    resolve() {},
  });
  assert.deepEqual(summary, {
    id: "11:c1",
    profileId: 7,
    agentId: 11,
    callId: "c1",
    toolName: "exec_run",
    permission: "execute",
  });
  assert.equal(JSON.stringify(summary).includes("SECRET-COMMAND"), false);
});

test("project-mode provider credential guard: project ownership is required", async () => {
  const owned = { id: 10, profile_id: 7 };
  assert.deepEqual(authorizeProjectRecord(7, 10, owned), { ok: true, project: owned });
  assert.deepEqual(authorizeProjectRecord(8, 10, null), { ok: false, error: "project-not-owned" });
  assert.deepEqual(authorizeProjectRecord(7, 99, null), { ok: false, error: "project-not-owned" });
  assert.deepEqual(authorizeProjectRecord(7, 10, { id: 10, profile_id: 8 }), { ok: false, error: "project-not-owned" });
  assert.deepEqual(authorizeProjectRecord(7, undefined, owned), { ok: false, error: "invalid-ids" });
});

test("project-mode read/mutation IPC gates agent and project ownership before privileged NAPI calls", () => {
  for (const channel of [
    "project:get-agent",
    "project:get-children",
    "project:set-parent",
    "project:get-plan",
    "project:list-messages",
    "agent:list-messages",
  ]) {
    const start = projectModeSource.indexOf(`safeHandle(\"${channel}\"`);
    assert.ok(start >= 0, `${channel} must be registered`);
    const body = projectModeSource.slice(start, start + 1200);
    assert.match(body, /assertAgentOwned\(profileId/,
      `${channel} must verify agent ownership before its core call`);
  }

  for (const channel of ["project:get-default-provider", "project:set-default-provider"]) {
    const start = projectModeSource.indexOf(`safeHandle(\"${channel}\"`);
    assert.ok(start >= 0, `${channel} must be registered`);
    const body = projectModeSource.slice(start, start + 1000);
    assert.match(body, /assertProjectOwned\(profileId/,
      `${channel} must verify project ownership before its core call`);
  }

  const exportStart = projectModeSource.indexOf('safeHandle("agent:export-session"');
  assert.ok(exportStart >= 0, "agent:export-session must be registered");
  const exportBody = projectModeSource.slice(exportStart, exportStart + 1600);
  assert.match(exportBody, /assertAgentOwned\(profileId/,
    "agent:export-session must verify agent ownership before reading the transcript");
  for (const channel of ["project:get-project", "project:delete-project", "project:list-agents"]) {
    const start = projectModeSource.indexOf(`safeHandle(\"${channel}\"`);
    assert.ok(start >= 0, `${channel} must be registered`);
    const body = projectModeSource.slice(start, start + 1200);
    assert.match(body, /assertProjectOwned\(profileId/,
      `${channel} must verify project ownership before its core call`);
  }
});

test("project-mode profile-scoped reads and plan templates verify profile ownership before NAPI access", () => {
  for (const channel of [
    "project:list-projects",
    "project:create-project",
    "agent:list-subagent-runs",
    "agent:list-recent",
    "agent:list-errors",
    "agent:list-resumable",
    "plan:save-template",
    "plan:list-templates",
    "plan:load-template",
    "plan:delete-template",
  ]) {
    const start = projectModeSource.indexOf(`safeHandle(\"${channel}\"`);
    assert.ok(start >= 0, `${channel} must be registered`);
    const body = projectModeSource.slice(start, start + 1800);
    assert.match(body, /assertProfileOwned\(profileId\)/,
      `${channel} must verify the requested profile exists before its core call`);
  }

  const subagentStart = projectModeSource.indexOf('safeHandle("agent:list-subagent-runs"');
  const subagentBody = projectModeSource.slice(subagentStart, subagentStart + 1800);
  assert.match(subagentBody, /assertAgentOwned\(profileId, parentAgentId\)/,
    "agent:list-subagent-runs must verify an explicitly requested parent agent belongs to the profile");
});
