// MCP — Model Context Protocol connection manager.
//
// Covers:
//   - register/unregister round trip
//   - list returns metadata, NOT the live child handle
//   - isConnected returns false until connect() succeeds
//   - callTool on a non-connected server returns not-connected
//   - listTools on a non-connected server returns not-connected
//   - connect failure (mock spawn that throws) returns spawn-failed
//
// The spawn constructor is dependency-injected so no real child process
// is ever created.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  MCP,
  configureMCP,
} from "../src/services/mcp/index.js";

const SCOPE = { profileId: 1, projectId: 2 };

test.beforeEach(() => {
  MCP._resetForTests();
});

// ---------------------------------------------------------------------------
// Fake child process — implements only the surface MCP uses: stdin/stdout/
// stderr streams with .write() / .on() / .kill(), plus a `close` event.
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
    this.killed = false;
    this.pid = 12345;
  }
  kill() { this.killed = true; this.emit("close", 0); }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Make a spawn mock. The returned function creates a FakeChild whose
 * stdout echoes a JSON-RPC response for every request (so the handshake
 * and tools/list succeed).
 */
function makeSpawnMock({ fail } = {}) {
  return (_cmd, _args, _opts) => {
    if (fail) throw new Error("spawn-boom");
    return new FakeChild();
  };
}

/**
 * Make a spawn mock that installs an echo responder BEFORE returning
 * the child. The responder replies to every JSON-RPC request on stdin
 * with the matching id on stdout.
 */
function makeEchoSpawnMock() {
  return (_cmd, _args, _opts) => {
    const child = new FakeChild();
    const origWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk) => {
      const ok = origWrite(chunk);
      setImmediate(() => {
        let parsed;
        try { parsed = JSON.parse(chunk.toString("utf8")); } catch { return; }
        if (typeof parsed.id !== "number") return;
        let result;
        if (parsed.method === "initialize") {
          result = { protocolVersion: "2024-11-05", capabilities: {} };
        } else if (parsed.method === "tools/list") {
          result = { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
        } else if (parsed.method === "tools/call") {
          result = { content: [{ type: "text", text: "ok" }] };
        } else {
          return;
        }
        child.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }) + "\n", "utf8"));
      });
      return ok;
    };
    return child;
  };
}

function handshakeResponse(id) {
  return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: {} } };
}

// ---------------------------------------------------------------------------
// register / unregister / list / isConnected
// ---------------------------------------------------------------------------

test("register + list returns metadata only", () => {
  MCP.register({ ...SCOPE, name: "fs", command: "fake", args: ["--x"], env: { FOO: "1" } });
  const list = MCP.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "fs");
  assert.equal(list[0].command, "fake");
  assert.deepEqual(list[0].args, ["--x"]);
  // list must NOT include the child handle, the tools cache, or stdin/stdout.
  assert.equal(list[0].child, undefined);
  assert.equal(list[0].tools, undefined);
});

test("unregister removes a server", () => {
  MCP.register({ ...SCOPE, name: "fs", command: "fake", args: [] });
  MCP.unregister("fs", SCOPE);
  assert.equal(MCP.list().length, 0);
});

test("isConnected is false until connect succeeds", () => {
  MCP.register({ ...SCOPE, name: "fs", command: "fake", args: [] });
  assert.equal(MCP.isConnected("fs"), false);
});

test("register rejects invalid input", () => {
  const r1 = MCP.register({ name: "", command: "fake", args: [] });
  assert.equal(r1.ok, false);
  const r2 = MCP.register({ name: "x", command: "", args: [] });
  assert.equal(r2.ok, false);
});

test("registration rejects missing or ambiguous ownership scope", () => {
  const missing = MCP.register({ name: "unscoped", command: "fake", args: [] });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "invalid-scope");

  const nullProject = MCP.register({ profileId: 1, projectId: null, name: "null-project", command: "fake", args: [] });
  assert.equal(nullProject.ok, false);
  assert.equal(nullProject.error.code, "invalid-scope");
});

// ---------------------------------------------------------------------------
// connect / listTools / callTool (with injected spawn mock)
// ---------------------------------------------------------------------------

test("connect spawns child, performs handshake, marks connected", async () => {
  configureMCP({ spawn: makeEchoSpawnMock() });
  MCP.register({ ...SCOPE, name: "fs", command: "fake", args: [] });
  const res = await MCP.connect("fs", SCOPE);
  assert.equal(res.ok, true);
  assert.equal(MCP.isConnected("fs"), true);
  const tools = await MCP.listTools("fs", SCOPE);
  assert.equal(tools.ok, true);
  assert.equal(tools.tools.length, 1);
  assert.equal(tools.tools[0].name, "echo");
});

test("callTool on a non-connected server returns not-connected", async () => {
  configureMCP({ spawn: makeSpawnMock() });
  MCP.register({ ...SCOPE, name: "fs", command: "fake", args: [] });
  const r = await MCP.callTool("fs", "echo", { msg: "hi" }, SCOPE);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "not-connected");
});

test("listTools on a non-connected server returns not-connected", async () => {
  configureMCP({ spawn: makeSpawnMock() });
  MCP.register({ ...SCOPE, name: "fs", command: "fake", args: [] });
  const r = await MCP.listTools("fs", SCOPE);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "not-connected");
});

test("callTool on an unknown server returns not-found", async () => {
  configureMCP({ spawn: makeSpawnMock() });
  const r = await MCP.callTool("ghost", "echo", {});
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "not-found");
});

test("connect returns spawn-failed when spawn throws (never throws)", async () => {
  configureMCP({ spawn: makeSpawnMock({ fail: true }) });
  MCP.register({ ...SCOPE, name: "fs", command: "fake", args: [] });
  const r = await MCP.connect("fs", SCOPE);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "spawn-failed");
  // Still marked not-connected.
  assert.equal(MCP.isConnected("fs"), false);
});

test("connect returns handshake-failed when child writes no response", async () => {
  configureMCP({ spawn: makeSpawnMock() });
  MCP.register({ ...SCOPE, name: "fs", command: "fake", args: [] });
  // No responder installed — handshake times out. We won't await the full 5s;
  // the helper returns { ok:false, error } once the timeout fires.
  // To keep this test fast, just unregister immediately after — the
  // pending rpc resolves with rpc-closed or rpc-timeout, but connect()
  // returns handshake-failed synchronously enough for the assertion.
  const p = MCP.connect("fs", SCOPE);
  MCP.unregister("fs", SCOPE);
  const r = await p;
  // Either handshake-failed (timeout) or rpc-closed (unregister killed);
  // both are non-throwing structured failures.
  assert.equal(r.ok, false);
  assert.ok(["handshake-failed", "rpc-closed", "rpc-timeout"].includes(r.error.code));
});

test("disconnect is idempotent and clears connected state", async () => {
  configureMCP({ spawn: makeSpawnMock() });
  MCP.register({ ...SCOPE, name: "fs", command: "fake", args: [] });
  // Never connected — disconnect still succeeds.
  assert.equal(MCP.disconnect("fs", SCOPE).ok, true);
  assert.equal(MCP.disconnect("fs", SCOPE).ok, true);
  assert.equal(MCP.isConnected("fs"), false);
});

test("callTool rejects a cross-project scope even when the server is connected", async () => {
  configureMCP({ spawn: makeEchoSpawnMock() });
  MCP.register({ ...SCOPE, name: "scoped", command: "fake", args: [] });
  const connected = await MCP.connect("scoped", SCOPE);
  assert.equal(connected.ok, true);
  const wrongScope = await MCP.callTool("scoped", "echo", {}, { profileId: 1, projectId: 99 });
  assert.equal(wrongScope.ok, false);
  assert.equal(wrongScope.error.code, "not-owned");
});
