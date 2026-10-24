// The retired browser_* compatibility tools are read-only refusals, not
// browser mutations. They must fail locally without a misleading approval
// prompt; unrelated tool approval and token guarantees remain unchanged.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_REQUIRED,
  requiresToolApproval,
  mintApprovalToken,
  consumeApprovalToken,
  APPROVAL_TOKEN_TTL_MS,
  _resetApprovalTokens,
} from "../src/services/project-tools/security.js";
import { UNSUPPORTED_DONUT_TOOL_NAMES } from "../src/services/browser-workspace-tools.js";

test.beforeEach(() => _resetApprovalTokens());
test.afterEach(() => _resetApprovalTokens());

test("retired Donut browser-control compatibility tools do not require approval", () => {
  for (const name of UNSUPPORTED_DONUT_TOOL_NAMES) {
    assert.equal(APPROVAL_REQUIRED.has(name), false, `${name} is not in the approval set`);
    assert.equal(
      requiresToolApproval(name, { name, permission: "READ" }),
      false,
      `${name} fails locally without an approval dialog`,
    );
  }
});

test("dangerous static tools remain approval-gated", () => {
  for (const name of ["exec_run", "fs_write", "test_run", "build_run"]) {
    assert.equal(APPROVAL_REQUIRED.has(name), true, `${name} remains gated`);
    assert.equal(requiresToolApproval(name, { name, permission: "WRITE" }), true);
  }
});

test("generic dynamic-tool rule remains unchanged", () => {
  assert.equal(requiresToolApproval("mcp_remote_write", { name: "mcp_remote_write", permission: "WRITE" }), true);
  assert.equal(requiresToolApproval("mcp_remote_read", { name: "mcp_remote_read", permission: "READ" }), false);
  assert.equal(requiresToolApproval("custom_dynamic", { name: "custom_dynamic", permission: "WRITE" }), false);
});

test("approval tokens remain single-use, bound to tool + input + ownership scope", () => {
  const tool = "fs_write";
  const input = { path: "notes.md", content: "example" };
  const scope = { profileId: 7, projectId: 1, agentId: 11 };
  const token = mintApprovalToken(tool, input, scope);
  assert.equal(typeof token, "string");
  assert.ok(token.length > 0);

  assert.equal(consumeApprovalToken(token, "exec_run", input, scope), false);
  assert.equal(consumeApprovalToken(token, tool, { path: "other.md", content: "example" }, scope), false);
  assert.equal(consumeApprovalToken(token, tool, input, { profileId: 7, projectId: 1, agentId: 12 }), false);
  assert.equal(consumeApprovalToken(token, tool, input, { profileId: 8, projectId: 1, agentId: 11 }), false);
  assert.equal(consumeApprovalToken(token, tool, input, { profileId: 7, projectId: 2, agentId: 11 }), false);
  assert.equal(consumeApprovalToken(token, tool, input, null), false);
  assert.equal(consumeApprovalToken(token, tool, input, { profileId: "7", projectId: 1, agentId: 11 }), false);
  assert.equal(consumeApprovalToken(token, tool, input, scope), true);
  assert.equal(consumeApprovalToken(token, tool, input, scope), false);
});

test("approval token TTL remains 60 seconds", () => {
  assert.equal(APPROVAL_TOKEN_TTL_MS, 60_000);
});
