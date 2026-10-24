// MCP <-> agent tool registry bridging tests.
//
// Covers:
//   - connect() registers every discovered tool into PROJECT_TOOLS
//   - the bridged tool's execute() calls MCP.callTool on the server
//   - the bridged tool's inputSchema matches the MCP tools/list schema
//   - disconnect() unregisters the bridged tools
//   - a bridged tool call against a disposed server returns not-connected
//   - listToolsSafe() never exposes the server's port / token / url /
//     process info (only safe metadata)
//
// Uses the same fake EventEmitter-based child process pattern as
// `shell/tests/mcp.test.js` and `shell/tests/agent-e2e.test.js`. No real
// child process is spawned; the spawn constructor is dependency-
// injected via `configureMCP({ spawn })`.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  MCP,
  configureMCP,
} from "../src/services/mcp/index.js";
import { requiresToolApproval } from "../src/services/project-tools/security.js";
import {
  PROJECT_TOOLS,
  getTool,
  listTools,
  listToolsSafe,
  _resetForTests as resetProjectTools,
} from "../src/services/project-tools/index.js";

// ---------------------------------------------------------------------------
// Fake child process (same shape as mcp.test.js / agent-e2e.test.js).
// Implements only the surface MCP uses: stdin/stdout/stderr streams
// with .write() / .on() / .kill(), plus a `close` event.
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
    this.pid = 99999;
  }
  kill() { this.killed = true; this.emit("close", 0); }
}

/**
 * Build a spawn mock that responds to every JSON-RPC request on
 * stdin with a matching id on stdout. The response for
 * `tools/list` is taken from `toolsList`; everything else returns a
 * minimal valid response. The mock records every request so tests
 * can assert what the bridged tool's execute() actually sent.
 */
function makeEchoSpawnMock({ toolsList = [] } = {}) {
  const child = new FakeChild();
  const requests = [];
  const origWrite = child.stdin.write.bind(child.stdin);
  child.stdin.write = (chunk) => {
    const ok = origWrite(chunk);
    setImmediate(() => {
      let parsed;
      try { parsed = JSON.parse(chunk.toString("utf8")); } catch { return; }
      if (typeof parsed.id !== "number") return; // notifications: ignore
      requests.push(parsed);
      let result;
      if (parsed.method === "initialize") {
        result = { protocolVersion: "2024-11-05", capabilities: {} };
      } else if (parsed.method === "tools/list") {
        result = { tools: toolsList };
      } else if (parsed.method === "tools/call") {
        result = { content: [{ type: "text", text: "echo:" + JSON.stringify(parsed.params && parsed.params.arguments || {}) }] };
      } else {
        return;
      }
      child.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }) + "\n", "utf8"));
    });
    return ok;
  };
  return { child, requests };
}

// ---------------------------------------------------------------------------
// Fixture reset between tests: both the MCP server map and the dynamic
// project-tools registry must start empty so registrations don't bleed.
// ---------------------------------------------------------------------------

test.beforeEach(() => {
  MCP._resetForTests();
  resetProjectTools();
});

// ---------------------------------------------------------------------------
// 1) connect() registers every discovered tool into PROJECT_TOOLS.
// ---------------------------------------------------------------------------

test("connect registers every discovered tool into the agent tool registry", async () => {
  const toolsList = [
    { name: "echo", description: "Echo back input", inputSchema: { type: "object", properties: { msg: { type: "string" } } } },
    { name: "sum", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
  ];
  const { child: _child } = makeEchoSpawnMock({ toolsList });
  configureMCP({ spawn: () => _child });

  MCP.register({ profileId: 7, projectId: 11, name: "test-srv", command: "fake", args: [] });
  const r = await MCP.connect("test-srv", { profileId: 7, projectId: 11 });
  assert.equal(r.ok, true);

  const names = listTools().map((t) => t.name).sort();
  // The 16 static tools are still here, plus the 2 bridged ones.
  assert.ok(names.includes("mcp_test-srv__echo"));
  assert.ok(names.includes("mcp_test-srv__sum"));

  const echo = getTool("mcp_test-srv__echo");
  assert.ok(echo, "echo tool must be resolvable via getTool");
  assert.equal(echo.name, "mcp_test-srv__echo");
  assert.equal(echo.description, "Echo back input");
  assert.equal(echo.permission, "WRITE", "undeclared MCP capabilities must not default to READ");
  assert.equal(typeof echo.execute, "function");

  // PROJECT_TOOLS (the frozen map) still only has the static 16 —
  // bridged tools live in the dynamic map.
  assert.equal("mcp_test-srv__echo" in PROJECT_TOOLS, false, "bridged tool must NOT be in the frozen PROJECT_TOOLS map");
});

test("MCP bridge classifies declared capabilities and annotations conservatively", async () => {
  const toolsList = [
    { name: "read", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } },
    { name: "spoofed-read", permission: "READ", inputSchema: { type: "object" } },
    { name: "write-spoof", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } },
    { name: "write", permission: "write", inputSchema: { type: "object" } },
    { name: "execute", _permission: "EXECUTE", inputSchema: { type: "object" } },
    { name: "network", annotations: { openWorldHint: true }, inputSchema: { type: "object" } },
    { name: "destroy", annotations: { destructiveHint: true }, inputSchema: { type: "object" } },
    { name: "unknown", inputSchema: { type: "object" } },
  ];
  const { child } = makeEchoSpawnMock({ toolsList });
  configureMCP({ spawn: () => child });
  MCP.register({ profileId: 7, projectId: 11, name: "classified", command: "fake", args: [] });
  assert.equal((await MCP.connect("classified", { profileId: 7, projectId: 11 })).ok, true);

  assert.equal(getTool("mcp_classified__read").permission, "WRITE", "readOnlyHint is untrusted and must remain approval-gated");
  assert.equal(getTool("mcp_classified__spoofed-read").permission, "WRITE", "permission=READ from an MCP server must not bypass approval");
  assert.equal(requiresToolApproval("mcp_classified__spoofed-read", getTool("mcp_classified__spoofed-read")), true, "spoofed READ MCP tool must be approval-gated");
  assert.equal(getTool("mcp_classified__write-spoof").permission, "WRITE", "a write-capable tool can spoof readOnlyHint");
  assert.equal(getTool("mcp_classified__write").permission, "WRITE");
  assert.equal(getTool("mcp_classified__execute").permission, "EXECUTE");
  assert.equal(getTool("mcp_classified__network").permission, "NETWORK");
  assert.equal(getTool("mcp_classified__destroy").permission, "DESTRUCTIVE");
  assert.equal(getTool("mcp_classified__unknown").permission, "WRITE");
});

// ---------------------------------------------------------------------------
// 2) The bridged tool's execute() calls MCP.callTool on the server.
// ---------------------------------------------------------------------------

test("bridged tool's execute() forwards the call to the MCP server", async () => {
  const toolsList = [
    { name: "echo", description: "Echo", inputSchema: { type: "object", properties: { msg: { type: "string" } } } },
  ];
  const { child: _child, requests } = makeEchoSpawnMock({ toolsList });
  configureMCP({ spawn: () => _child });

  MCP.register({ profileId: 7, projectId: 11, name: "test-srv", command: "fake", args: [] });
  const r = await MCP.connect("test-srv", { profileId: 7, projectId: 11 });
  assert.equal(r.ok, true);

  const echo = getTool("mcp_test-srv__echo");
  assert.ok(echo);
  const res = await echo.execute({ msg: "hi" }, { projectRoot: "/tmp", profileId: 7, projectId: 11, agentId: 1, isCancellable: () => false });
  assert.equal(res.ok, true);
  // The fake server echoes the JSON-serialised arguments back.
  assert.ok(res.result.content[0].text.includes("hi"));

  // The fake's request log should include exactly one tools/call.
  const calls = requests.filter((r) => r.method === "tools/call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.name, "echo");
  assert.deepEqual(calls[0].params.arguments, { msg: "hi" });
});

test("scoped MCP bridge refuses execution outside its profile/project", async () => {
  const toolsList = [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } }];
  const { child: _child, requests } = makeEchoSpawnMock({ toolsList });
  configureMCP({ spawn: () => _child });

  MCP.register({ profileId: 7, projectId: 11, name: "scoped-srv", command: "fake", args: [] });
  assert.equal((await MCP.connect("scoped-srv", { profileId: 7, projectId: 11 })).ok, true);
  const echo = getTool("mcp_scoped-srv__echo");
  assert.ok(echo);

  const denied = await echo.execute({}, { profileId: 7, projectId: 12, agentId: 1 });
  assert.deepEqual(denied, {
    ok: false,
    error: { code: "not-owned", message: "MCP server is outside the active project scope" },
  });
  assert.equal(requests.filter((r) => r.method === "tools/call").length, 0);

  const allowed = await echo.execute({}, { profileId: 7, projectId: 11, agentId: 1 });
  assert.equal(allowed.ok, true);
  assert.equal(requests.filter((r) => r.method === "tools/call").length, 1);
});

// ---------------------------------------------------------------------------
// 3) The bridged tool's inputSchema matches the MCP tools/list schema.
// ---------------------------------------------------------------------------

test("bridged tool's inputSchema matches the MCP tools/list schema", async () => {
  const schema = {
    type: "object",
    properties: {
      a: { type: "number", description: "first addend" },
      b: { type: "number", description: "second addend" },
    },
    required: ["a", "b"],
  };
  const toolsList = [{ name: "add", description: "Add", inputSchema: schema }];
  const { child: _child } = makeEchoSpawnMock({ toolsList });
  configureMCP({ spawn: () => _child });

  MCP.register({ profileId: 7, projectId: 11, name: "test-srv", command: "fake", args: [] });
  await MCP.connect("test-srv", { profileId: 7, projectId: 11 });

  const add = getTool("mcp_test-srv__add");
  assert.ok(add);
  assert.deepEqual(add.inputSchema, schema);
});

// ---------------------------------------------------------------------------
// 4) disconnect() unregisters the bridged tools.
// ---------------------------------------------------------------------------

test("disconnect unregisters the bridged tools", async () => {
  const toolsList = [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }];
  const { child: _child } = makeEchoSpawnMock({ toolsList });
  configureMCP({ spawn: () => _child });

  MCP.register({ profileId: 7, projectId: 11, name: "test-srv", command: "fake", args: [] });
  await MCP.connect("test-srv", { profileId: 7, projectId: 11 });
  assert.ok(getTool("mcp_test-srv__echo"), "tool should be registered after connect");

  MCP.disconnect("test-srv");
  assert.equal(getTool("mcp_test-srv__echo"), null, "tool must be unregistered after disconnect");
  assert.equal(listToolsSafe().some((t) => t.name === "mcp_test-srv__echo"), false);
});

// ---------------------------------------------------------------------------
// 5) A bridged tool call against a disposed server returns not-connected.
// ---------------------------------------------------------------------------

test("a bridged tool call against a disposed server returns not-connected", async () => {
  const toolsList = [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }];
  const { child: _child } = makeEchoSpawnMock({ toolsList });
  configureMCP({ spawn: () => _child });

  MCP.register({ profileId: 7, projectId: 11, name: "test-srv", command: "fake", args: [] });
  await MCP.connect("test-srv", { profileId: 7, projectId: 11 });
  const echo = getTool("mcp_test-srv__echo");
  assert.ok(echo);

  // Tear the connection down. The cached execute closure calls
  // MCP.callTool() which now sees status !== 'connected'.
  MCP.disconnect("test-srv");

  const res = await echo.execute({ msg: "after-disconnect" }, { projectRoot: "/tmp", profileId: 7, projectId: 11, agentId: 1, isCancellable: () => false });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "not-connected");
});

// ---------------------------------------------------------------------------
// 6) listToolsSafe() never exposes the server's port/token/url/process.
// ---------------------------------------------------------------------------

test("listToolsSafe never exposes server port, token, url, or process info", async () => {
  // The fake server is the only "server" in this test. Even though
  // our fake has no port/token/url, we register a real-looking
  // profileId/projectId to ensure the safe metadata is sanitised.
  const toolsList = [
    { name: "dangerous", description: "Should not leak server details", inputSchema: { type: "object" } },
  ];
  const { child: _child } = makeEchoSpawnMock({ toolsList });
  configureMCP({ spawn: () => _child });

  MCP.register({
    profileId: 1,
    projectId: 2,
    name: "secret-srv",
    command: "fake",
    args: ["--token=DEADBEEF", "--port=9999"],
    env: { SECRET: "TOP_SECRET" },
  });
  await MCP.connect("secret-srv", { profileId: 1, projectId: 2 });

  const meta = listToolsSafe().filter((t) => t.name === "mcp_secret-srv__dangerous");
  assert.equal(meta.length, 1);
  const m = meta[0];
  // Allowed keys: name, description, permission, inputSchema.
  assert.deepEqual(Object.keys(m).sort(), ["description", "inputSchema", "name", "permission"]);
  // No execute function. No port. No token. No url. No process info.
  assert.equal(typeof m.execute, "undefined");
  const blob = JSON.stringify(m);
  assert.equal(blob.includes("9999"), false, "port must not appear");
  assert.equal(blob.includes("DEADBEEF"), false, "token must not appear");
  assert.equal(blob.includes("TOP_SECRET"), false, "env secret must not appear");
  assert.equal(blob.includes("--token"), false, "argv must not appear");
  assert.equal(blob.includes("http"), false, "no url-like strings");
  assert.equal(blob.includes("pid"), false, "no process info");
  // The bridged description must NOT echo the server name (which is
  // shell-side metadata); only the tool's own name from tools/list
  // is safe to surface.
  assert.equal(blob.includes("from server secret-srv"), false, "description must not echo server name");
});
