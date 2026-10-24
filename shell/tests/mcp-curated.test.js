// Tests for the curated MCP server list.
//
// Covers:
//   - CURATED_SERVERS is non-empty and every entry has the required shape
//   - listCuratedSafe() returns renderer-safe clones (not the canonical refs)
//   - getCuratedServer() returns shallow clones / null on miss
//   - MCP.ensureCuratedServers() is idempotent and only registers metadata
//     (does NOT spawn a child process)
//   - The startup helper (`onAgentStart`) delegates to MCP.ensureCuratedServers
//
// No real `npx` is ever invoked; the spawn constructor is dependency-injected
// via `configureMCP({ spawn })` and we assert it was never called.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  CURATED_SERVERS,
  getCuratedServer,
  listCuratedSafe,
} from "../src/services/mcp/curated.js";
import {
  MCP,
  configureMCP,
} from "../src/services/mcp/index.js";
import { onAgentStart } from "../src/services/mcp/startup.js";

const TEST_SCOPE = { profileId: 1, projectId: 1 };

// ---------------------------------------------------------------------------
// A spawn mock that records every invocation. We assert that
// `ensureCuratedServers()` never triggers it.
// ---------------------------------------------------------------------------

class FakeWritable extends EventEmitter {
  write(_chunk) { return true; }
  end() {}
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new FakeWritable();
    this.stdout = new FakeWritable();
    this.stderr = new FakeWritable();
  }
}

function makeSpySpawn() {
  const calls = [];
  const fn = (_cmd, _args, _opts) => {
    calls.push({ cmd: _cmd, args: _args });
    return new FakeChild();
  };
  fn.calls = calls;
  return fn;
}

test.beforeEach(() => {
  MCP._resetForTests();
});

// ---------------------------------------------------------------------------
// 1) CURATED_SERVERS is non-empty
// ---------------------------------------------------------------------------

test("CURATED_SERVERS is non-empty", () => {
  assert.ok(Array.isArray(CURATED_SERVERS), "CURATED_SERVERS must be an array");
  assert.ok(CURATED_SERVERS.length >= 1, "CURATED_SERVERS must contain at least one entry");
});

// ---------------------------------------------------------------------------
// 2) Every entry has the required fields
// ---------------------------------------------------------------------------

test("every curated entry has the required fields", () => {
  for (const s of CURATED_SERVERS) {
    assert.equal(typeof s.id, "string");
    assert.ok(s.id.length > 0, `entry id must be non-empty: ${JSON.stringify(s)}`);
    assert.equal(typeof s.command, "string");
    assert.ok(s.command.length > 0, `entry command must be non-empty: ${s.id}`);
    assert.ok(Array.isArray(s.args), `entry args must be an array: ${s.id}`);
    assert.equal(typeof s.description, "string");
    assert.ok(s.description.length > 0, `entry description must be non-empty: ${s.id}`);
    assert.ok(Array.isArray(s.tools), `entry tools must be an array: ${s.id}`);
  }
});

// ---------------------------------------------------------------------------
// 3) The list contains filesystem + fetch (per brief)
// ---------------------------------------------------------------------------

test("the curated list contains filesystem and fetch", () => {
  const ids = CURATED_SERVERS.map((s) => s.id);
  assert.ok(ids.includes("filesystem"), "filesystem server must be in the curated list");
  assert.ok(ids.includes("fetch"), "fetch server must be in the curated list");
});

// ---------------------------------------------------------------------------
// 4) listCuratedSafe() returns clones, not references
// ---------------------------------------------------------------------------

test("listCuratedSafe returns shallow clones (callers cannot mutate the canonical list)", () => {
  const safe = listCuratedSafe();
  assert.equal(safe.length, CURATED_SERVERS.length);
  for (let i = 0; i < safe.length; i++) {
    assert.notEqual(safe[i], CURATED_SERVERS[i], `entry ${i} must be a fresh object`);
    assert.deepEqual(safe[i].args, CURATED_SERVERS[i].args, `args must match for ${safe[i].id}`);
    assert.deepEqual(safe[i].tools, CURATED_SERVERS[i].tools, `tools must match for ${safe[i].id}`);
  }
  // Mutate the clone — canonical list must be unaffected.
  const target = safe[0];
  const originalArgs = [...CURATED_SERVERS[0].args];
  target.args.push("--evil");
  target.id = "tampered";
  assert.deepEqual(CURATED_SERVERS[0].args, originalArgs, "canonical args must be unchanged");
  assert.notEqual(CURATED_SERVERS[0].id, "tampered", "canonical id must be unchanged");
});

// ---------------------------------------------------------------------------
// 5) getCuratedServer returns null on miss, a clone on hit
// ---------------------------------------------------------------------------

test("getCuratedServer returns null for unknown id, clone for known id", () => {
  assert.equal(getCuratedServer(""), null);
  assert.equal(getCuratedServer(null), null);
  assert.equal(getCuratedServer(undefined), null);
  assert.equal(getCuratedServer("does-not-exist"), null);

  const first = CURATED_SERVERS[0];
  const hit = getCuratedServer(first.id);
  assert.ok(hit, `must return a record for ${first.id}`);
  assert.notEqual(hit, first, "must be a fresh object, not the canonical record");
  assert.equal(hit.id, first.id);
  assert.deepEqual(hit.args, first.args);
  assert.deepEqual(hit.tools, first.tools);
});

// ---------------------------------------------------------------------------
// 6) ensureCuratedServers() is idempotent
// ---------------------------------------------------------------------------

test("ensureCuratedServers() is idempotent", () => {
  // After _resetForTests the flag is also reset.
  const first = MCP.ensureCuratedServers(TEST_SCOPE.profileId, TEST_SCOPE.projectId);
  assert.ok(Array.isArray(first));
  assert.equal(first.length, CURATED_SERVERS.length, "every curated id should be registered on first call");

  // Second call is a no-op.
  const second = MCP.ensureCuratedServers(TEST_SCOPE.profileId, TEST_SCOPE.projectId);
  assert.deepEqual(second, [], "second call must return an empty array (idempotent)");

  // The server map now contains the curated entries — but only once.
  const listed = MCP.list();
  const curatedIds = new Set(CURATED_SERVERS.map((s) => s.id));
  const curatedListed = listed.filter((e) => curatedIds.has(e.name));
  assert.equal(curatedListed.length, CURATED_SERVERS.length, "curated entries must appear exactly once in the server map");
  // And every curated entry is in the `registered` state — never `connected`.
  for (const e of curatedListed) {
    assert.equal(e.status, "registered", `${e.name} must NOT auto-connect on registration`);
  }
});

// ---------------------------------------------------------------------------
// 7) ensureCuratedServers() does NOT spawn any child process
// ---------------------------------------------------------------------------

test("ensureCuratedServers() does NOT spawn any child process (lazy spawn)", () => {
  const spy = makeSpySpawn();
  configureMCP({ spawn: spy });

  MCP.ensureCuratedServers(TEST_SCOPE.profileId, TEST_SCOPE.projectId);
  MCP.ensureCuratedServers(TEST_SCOPE.profileId, TEST_SCOPE.projectId); // idempotent — must also not spawn
  assert.equal(spy.calls.length, 0, "spawn must NOT be invoked by ensureCuratedServers");

  // Confirm lazy semantics: only an explicit connect() spawns.
  MCP.connect("filesystem", TEST_SCOPE);
  assert.equal(spy.calls.length, 1, "connect() must trigger exactly one spawn");
  assert.equal(spy.calls[0].cmd, "npx");
});

// ---------------------------------------------------------------------------
// 8) The startup helper delegates to MCP.ensureCuratedServers
// ---------------------------------------------------------------------------

test("onAgentStart() registers the curated list via the MCP bridge", () => {
  const registered = onAgentStart(TEST_SCOPE.profileId, TEST_SCOPE.projectId);
  assert.ok(Array.isArray(registered));
  assert.equal(registered.length, CURATED_SERVERS.length);

  // Second call is a no-op.
  assert.deepEqual(onAgentStart(TEST_SCOPE.profileId, TEST_SCOPE.projectId), []);

  // The bridge now has the curated entries.
  const ids = MCP.list().map((e) => e.name);
  for (const s of CURATED_SERVERS) {
    assert.ok(ids.includes(s.id), `MCP.list must include ${s.id} after onAgentStart`);
  }
});

// ---------------------------------------------------------------------------
// 9) listCuratedSafe() returns the exact safe metadata shape used internally
// ---------------------------------------------------------------------------

test("listCuratedSafe() returns the envelope shape consumed by the handler", () => {
  const safe = listCuratedSafe();
  // Every entry has the same keys.
  for (const entry of safe) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["args", "command", "description", "id", "tools"],
      "renderer-safe envelope keys must be exactly { id, command, args, description, tools }"
    );
  }
});
