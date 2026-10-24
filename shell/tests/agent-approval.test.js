// Phase 12 — agent approval membership.
//
// Single source of truth: APPROVAL_REQUIRED in
// src/services/project-tools/security.js. The agent loop must consult
// this set directly; this test pins its membership so any drift
// surfaces here.

import test from "node:test";
import assert from "node:assert/strict";

import { APPROVAL_REQUIRED } from "../src/services/project-tools/security.js";

test("APPROVAL_REQUIRED includes exec_run", () => {
  assert.equal(APPROVAL_REQUIRED.has("exec_run"), true);
});

test("APPROVAL_REQUIRED includes fs_write", () => {
  assert.equal(APPROVAL_REQUIRED.has("fs_write"), true);
});

test("APPROVAL_REQUIRED does NOT include fs_read", () => {
  assert.equal(APPROVAL_REQUIRED.has("fs_read"), false);
});

test("APPROVAL_REQUIRED does NOT include fs_search", () => {
  assert.equal(APPROVAL_REQUIRED.has("fs_search"), false);
});