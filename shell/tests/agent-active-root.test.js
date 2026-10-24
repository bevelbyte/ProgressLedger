// Per-agent project root registry tests.
//
// Replaces the legacy single-activeProjectRoot global with a per-
// (profileId, agentId) Map. The agent loop calls
// setActiveProjectRootFor at the start of every run and
// clearActiveProjectRootFor in the run's `finally` block. Tools resolve
// the project root through getActiveProjectRootFor and return
// `{ ok: false, error: { code: 'project-root-not-set', ... } }` when no
// root is registered.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  setActiveProjectRootFor,
  getActiveProjectRootFor,
  clearActiveProjectRootFor,
  _resetActiveProjectRoots,
} from "../src/ipc/agent-root-registry.js";
import { runTool } from "../src/services/project-tools/_runtime.js";
import { getTool } from "../src/services/project-tools/index.js";

// ---------------------------------------------------------------------------
// 1) Registry: set / get / clear semantics
// ---------------------------------------------------------------------------

test("set then get for the same (profile, agent) returns the set value", () => {
  _resetActiveProjectRoots();
  setActiveProjectRootFor(1, 10, "/tmp/proj-A");
  assert.equal(getActiveProjectRootFor(1, 10), "/tmp/proj-A");
  _resetActiveProjectRoots();
});

test("different (profile, agent) pairs are isolated", () => {
  _resetActiveProjectRoots();
  setActiveProjectRootFor(1, 10, "/tmp/proj-A");
  setActiveProjectRootFor(1, 11, "/tmp/proj-B");
  setActiveProjectRootFor(2, 10, "/tmp/proj-C");

  assert.equal(getActiveProjectRootFor(1, 10), "/tmp/proj-A");
  assert.equal(getActiveProjectRootFor(1, 11), "/tmp/proj-B");
  assert.equal(getActiveProjectRootFor(2, 10), "/tmp/proj-C");

  // Pairs not registered stay null — no leakage from siblings.
  assert.equal(getActiveProjectRootFor(2, 11), null);
  assert.equal(getActiveProjectRootFor(3, 10), null);

  _resetActiveProjectRoots();
});

test("clear then get returns null", () => {
  _resetActiveProjectRoots();
  setActiveProjectRootFor(1, 10, "/tmp/proj-A");
  assert.equal(getActiveProjectRootFor(1, 10), "/tmp/proj-A");
  clearActiveProjectRootFor(1, 10);
  assert.equal(getActiveProjectRootFor(1, 10), null);
  _resetActiveProjectRoots();
});

test("clear is a no-op for an unregistered (profile, agent)", () => {
  _resetActiveProjectRoots();
  // Should not throw.
  clearActiveProjectRootFor(99, 99);
  assert.equal(getActiveProjectRootFor(99, 99), null);
  _resetActiveProjectRoots();
});

test("set ignores invalid arguments", () => {
  _resetActiveProjectRoots();
  // Bad profileId/agentId: no-op.
  setActiveProjectRootFor("1", 10, "/tmp/proj-A");
  setActiveProjectRootFor(1, null, "/tmp/proj-A");
  assert.equal(getActiveProjectRootFor(1, 10), null);
  // Bad path: no-op.
  setActiveProjectRootFor(1, 10, "");
  setActiveProjectRootFor(1, 10, null);
  assert.equal(getActiveProjectRootFor(1, 10), null);
  _resetActiveProjectRoots();
});

// ---------------------------------------------------------------------------
// 2) Tools: refuse with `project-root-not-set` when no root is set
// ---------------------------------------------------------------------------

function ctxWithoutRoot(profileId = 1, agentId = 1) {
  // Deliberately no projectRoot — mirrors what the agent loop would
  // pass to a tool when getActiveProjectRootFor returns null.
  return {
    profileId,
    projectId: 1,
    agentId,
    isCancellable: () => false,
    nowMs: () => Date.now(),
  };
}

const TOOLS_REQUIRING_ROOT = [
  "fs_list",
  "fs_search",
  "fs_write",
  "exec_run",
  "test_run",
  "build_run",
  "inspect_project",
];

test("every root-requiring tool returns project-root-not-set when no root is set", async () => {
  _resetActiveProjectRoots();
  try {
    for (const name of TOOLS_REQUIRING_ROOT) {
      // For tools that take a `path` (fs_write/fs_read), supply an
      // absolute path so we exercise the no-root branch instead of the
      // missing-input branch. Tools without an explicit `path` input
      // leave it undefined and fall through to the registry.
      const input = name === "exec_run" || name === "test_run" || name === "build_run"
        ? { command: "mytool-does-not-exist" } // exec_run refuses shell interpreters; we just need a non-forbidden name to reach the root check
        : name === "fs_write"
          ? { path: "/tmp/never-written.txt", content: "x" }
          : name === "fs_read"
            ? { path: "/tmp/never-read.txt" }
            : name === "fs_search"
              ? { query: "x" }
              : name === "inspect_project"
                ? {}
                : {}; // fs_list: no path, falls through to registry
      const res = await runTool(getTool(name), input, ctxWithoutRoot());
      assert.equal(res.ok, false, `${name} should fail when no root is set`);
      assert.equal(res.error.code, "project-root-not-set", `${name} should report project-root-not-set`);
      assert.equal(typeof res.error.message, "string");
    }
  } finally {
    _resetActiveProjectRoots();
  }
});

test("tools honour the per-agent root when set", async () => {
  _resetActiveProjectRoots();
  const root = mkdtempSync(join(tmpdir(), "cf-agent-root-"));
  try {
    setActiveProjectRootFor(1, 10, root);
    const res = await runTool(
      getTool("fs_list"),
      {}, // no input.path; the tool should fall through to the registry
      ctxWithoutRoot(1, 10),
    );
    assert.equal(res.ok, true);
    assert.equal(res.result.root, root);
    _resetActiveProjectRoots();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tools reject when ctx.profileId/ctx.agentId do not match the registered root", async () => {
  _resetActiveProjectRoots();
  try {
    setActiveProjectRootFor(1, 10, "/tmp/proj-A");
    // Wrong (profile, agent) → null → project-root-not-set.
    const res = await runTool(
      getTool("fs_list"),
      {},
      ctxWithoutRoot(1, 11),
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "project-root-not-set");
    _resetActiveProjectRoots();
  } finally {
    _resetActiveProjectRoots();
  }
});

// ---------------------------------------------------------------------------
// 3) Concurrency: clearing one agent does not affect another
// ---------------------------------------------------------------------------

test("clearing one (profile, agent) leaves others intact", () => {
  _resetActiveProjectRoots();
  setActiveProjectRootFor(1, 10, "/tmp/proj-A");
  setActiveProjectRootFor(1, 11, "/tmp/proj-B");
  clearActiveProjectRootFor(1, 10);
  assert.equal(getActiveProjectRootFor(1, 10), null);
  assert.equal(getActiveProjectRootFor(1, 11), "/tmp/proj-B");
  _resetActiveProjectRoots();
});