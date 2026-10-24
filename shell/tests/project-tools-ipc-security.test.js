import test from "node:test";
import assert from "node:assert/strict";
import { authorizeProjectToolScope } from "../src/security/project-mode-auth.js";

function coreFor({ agent, project }) {
  return {
    pmGetAgent: async () => agent,
    pmGetProject: async () => project,
  };
}

test("project-tool scope accepts an exact profile/project/agent tuple", async () => {
  const result = await authorizeProjectToolScope(
    coreFor({
      agent: { id: 21, profileId: 7, projectId: 11 },
      project: { id: 11, profileId: 7 },
    }),
    7,
    11,
    21,
  );
  assert.deepEqual(result, { ok: true, scoped: true });
});

test("project-tool scope rejects an agent from another project even when profile matches", async () => {
  const result = await authorizeProjectToolScope(
    coreFor({
      agent: { id: 21, profileId: 7, projectId: 12 },
      project: { id: 11, profileId: 7 },
    }),
    7,
    11,
    21,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "not-owned");
});

test("project-tool scope rejects a project from another profile", async () => {
  const result = await authorizeProjectToolScope(
    coreFor({
      agent: { id: 21, profileId: 7, projectId: 11 },
      project: { id: 11, profileId: 8 },
    }),
    7,
    11,
    21,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "not-owned");
});

test("project-tool scope requires all identifiers when any scope is supplied", async () => {
  const result = await authorizeProjectToolScope({}, 7, undefined, 21);
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "invalid-ids",
      message: "profileId, projectId and agentId must be supplied together",
    },
  });
});


test("command scope rejects cross-project/agent ownership", async () => {
  const { authorizeCommandScope } = await import("../src/security/project-mode-auth.js");
  const core = coreFor({ agent: { id: 21, profileId: 7, projectId: 12 }, project: { id: 11, profileId: 7 } });
  const r = await authorizeCommandScope(core, 7, 11, 21);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "not-owned");
});

test("command scope rejects an agent without a complete project scope", async () => {
  const { authorizeCommandScope } = await import("../src/security/project-mode-auth.js");
  const r = await authorizeCommandScope(coreFor({}), 7, null, 21);
  assert.deepEqual(r, { ok: false, error: "invalid-ids" });
});
