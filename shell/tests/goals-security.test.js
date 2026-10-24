import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const goalsSource = readFileSync(new URL("../src/ipc/goals.js", import.meta.url), "utf8");

function bodyOf(channel, size = 1800) {
  const start = goalsSource.indexOf(`safeHandle(\"${channel}\"`);
  assert.ok(start >= 0, `${channel} must be registered`);
  return goalsSource.slice(start, start + size);
}

test("goal IPC profile boundary is enforced before profile-scoped reads and recovery", () => {
  for (const channel of [
    "goal:create",
    "goal:list",
    "goal:reconcile",
    "goal:recovery-sweep",
  ]) {
    assert.match(bodyOf(channel), /assertProfileOwned\(profileId\)/,
      `${channel} must verify profile ownership before privileged access`);
  }
});

test("goal IPC verifies goal ownership before goal reads and mutations", () => {
  for (const channel of [
    "goal:get",
    "goal:delete",
    "goal:start",
    "goal:cancel",
    "goal:list-events",
    "goal:get-agent-id",
  ]) {
    assert.match(bodyOf(channel), /assertGoalOwned\(profileId, goalId\)/,
      `${channel} must verify the goal belongs to the requested profile`);
  }
});

test("goal link and resume cannot cross agent/project ownership boundaries", () => {
  const link = bodyOf("goal:link-agent", 2600);
  assert.match(link, /assertGoalOwned\(profileId, goalId\)/);
  assert.match(link, /assertAgentOwned\(profileId, agentId\)/);
  assert.match(link, /goal-agent-project-mismatch/);

  const resume = bodyOf("goal:resume", 3600);
  assert.match(resume, /goal-not-owned/);
  assert.match(resume, /agent-not-owned/);
  assert.match(resume, /goal-agent-mismatch/);
});

test("fresh and resumed Goal IPC paths wire the trusted Agent approval resolver", () => {
  const start = bodyOf("goal:start", 1800);
  assert.match(start, /approvalResolverFactory/);
  assert.match(start, /createApprovalResolver/);

  const resume = bodyOf("goal:resume", 3600);
  assert.match(resume, /approvalResolver:\s*createApprovalResolver\(\{ profileId, agentId \}\)/);
  assert.doesNotMatch(start, /approved\s*:/, "renderer payloads must not supply approval decisions");
  assert.doesNotMatch(resume, /approved\s*:/, "renderer payloads must not supply approval decisions");
});