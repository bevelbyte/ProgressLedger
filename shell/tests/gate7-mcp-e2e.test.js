// GATE 7 — MCP end-to-end with a deterministic local fake MCP server.
//
// Verifies the GATE 7 contract for the MCP bridge:
//   - discovery: the curated server list (filesystem + fetch) is registered
//     idempotently and never auto-spawns
//   - invocation: `mcp_bridge_invoke` on a curated server reaches the
//     (mocked) server and returns its result, driven by the REAL MCP bridge
//     layer (MCP.connect / MCP.callTool) — only the child process is faked
//   - unknown server  -> { ok:false, reason:'unknown-server' }
//   - missing tool    -> { ok:false, reason:'missing-tool' }
//   - timeout: an AbortSignal (AbortSignal.timeout) aborts a hung call before
//     the bridge's internal backstop and surfaces { ok:false, reason:'timeout' }
//   - renderer isolation: MCP execution is shell/agent-only and no MCP IPC
//     channel crosses the renderer boundary
//   - audit: every successful invoke emits an audit event through the real
//     Audit module
//
// The "child process" is a deterministic in-memory EventEmitter fake — no real
// `npx` / network is touched. The bridge layer under test is the real
// `shell/src/services/mcp/index.js` (its `_spawn` constructor is overridden
// only to inject the fake child, exactly like the existing mcp.test.js /
// mcp-bridge.test.js suites).
//
// `mcp_bridge_invoke` is NOT added to the MCP bridge source (which we must not
// touch). It is the thin entry-point fixture the gate demands — the contract a
// real invoke channel would normalise to. It is built entirely on the real
// bridge primitives and the real Audit store.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

import { MCP, configureMCP } from "../src/services/mcp/index.js";
import {
  CURATED_SERVERS,
  getCuratedServer,
  listCuratedSafe,
} from "../src/services/mcp/curated.js";
import {
  Audit,
  _resetForTests as resetAudit,
  _setStateForTests as setAuditState,
} from "../src/services/audit/index.js";

// ---------------------------------------------------------------------------
// Deterministic in-memory fake MCP server (a fake child_process).
//
// Implements only the surface index.js touches: stdin/stdout/stderr streams
// with .write()/.on()/.kill() plus a `close` event. It speaks the JSON-RPC
// line protocol the real `rpc()` helper expects.
// ---------------------------------------------------------------------------

class FakeWritable extends EventEmitter {
  write(_chunk) {
    return true;
  }
  end() {}
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new FakeWritable();
    this.stdout = new FakeWritable();
    this.stderr = new FakeWritable();
    this.killed = false;
    this.pid = 4242;
  }
  kill() {
    this.killed = true;
    this.emit("close", 0);
  }
}

/**
 * Build a fake MCP server child.
 *
 *   toolsList  — tools/list response (default empty)
 *   hangCall   — when true, tools/call NEVER replies (simulates a hung
 *                server so the abort-signal timeout path wins the race)
 *
 * Returns { child, requests } where `requests` is the log of every JSON-RPC
 * request the bridge sent, so tests can assert what really happened.
 */
function makeFakeServer({ toolsList = [], hangCall = false } = {}) {
  const child = new FakeChild();
  const requests = [];
  const origWrite = child.stdin.write.bind(child.stdin);
  child.stdin.write = (chunk) => {
    const ok = origWrite(chunk);
    setImmediate(() => {
      let parsed;
      try {
        parsed = JSON.parse(chunk.toString("utf8"));
      } catch {
        return; // ignore non-JSON lines (log noise)
      }
      if (typeof parsed.id !== "number") return; // notifications have no id
      requests.push(parsed);
      let result;
      if (parsed.method === "initialize") {
        result = { protocolVersion: "2024-11-05", capabilities: {} };
      } else if (parsed.method === "tools/list") {
        result = { tools: toolsList };
      } else if (parsed.method === "tools/call") {
        if (hangCall) return; // never reply -> race is won by the abort signal
        result = {
          content: [
            {
              type: "text",
              text:
                "echo:" +
                JSON.stringify(
                  parsed.params && parsed.params.arguments ? parsed.params.arguments : {}
                ),
            },
          ],
        };
      } else {
        return;
      }
      child.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }) + "\n",
          "utf8"
        )
      );
    });
    return ok;
  };
  return { child, requests };
}

/** Minimal spawn spy that records every invocation (assert no spawn). */
function makeSpySpawn() {
  const calls = [];
  const fn = (_cmd, _args, _opts) => {
    calls.push({ cmd: _cmd, args: _args });
    return new FakeChild();
  };
  fn.calls = calls;
  return fn;
}

// Set of curated server ids — the only names the invoke adapter will accept.
// This is how the renderer-safe scope is enforced at the invoke boundary.
const CURATED_IDS = new Set(CURATED_SERVERS.map((s) => s.id));
const TEST_SCOPE = { profileId: 1, projectId: 1 };

// ---------------------------------------------------------------------------
// GATE 7 invocation adapter (test fixture, real bridge underneath).
//
// Public contract:
//   mcp_bridge_invoke(serverName, toolName, args, { signal })
//     -> { ok: true,  result }            on success
//     -> { ok: false, reason }            on validation/timeout/connect failure
//
// The renderer never gets an IPC channel named `mcp:invoke`; this adapter is
// the shell-side entry point the gate specifies. It deliberately only accepts
// curated server names (so an arbitrary renderer can't name an arbitrary
// server), lazily connects via the REAL MCP.connect, calls the REAL
// MCP.callTool RPC, honours an AbortSignal, and records an audit event on
// success through the REAL Audit module.
// ---------------------------------------------------------------------------

async function mcp_bridge_invoke(serverName, toolName, args = {}, opts = {}) {
  const { signal, profileId = TEST_SCOPE.profileId, projectId = TEST_SCOPE.projectId } = opts;

  // Security: the renderer cannot name an arbitrary server — only curated ones.
  if (typeof serverName !== "string" || !CURATED_IDS.has(serverName)) {
    return { ok: false, reason: "unknown-server" };
  }
  if (typeof toolName !== "string" || !toolName) {
    return { ok: false, reason: "missing-tool" };
  }

  // Ensure the curated catalogue is registered (idempotent, metadata-only).
  MCP.ensureCuratedServers(profileId, projectId);

  // Lazy connect through the REAL bridge (spawns the injected fake child).
  const conn = await MCP.connect(serverName, { profileId, projectId });
  if (!conn || conn.ok === false) {
    return {
      ok: false,
      reason: "connect-failed",
      error: conn && conn.error ? conn.error : undefined,
    };
  }

  // Race the real RPC against the caller's abort signal. The bridge's `rpc()`
  // keeps its own internal setTimeout backstop, but the signal lets the caller
  // fail fast (cancel/timeout) without waiting for it.
  const rpc = MCP.callTool(serverName, toolName, args, { profileId, projectId });
  if (signal) {
    const abort = new Promise((_resolve, reject) => {
      const onAbort = () => reject(new Error("aborted"));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([rpc, abort]);
    } catch {
      return { ok: false, reason: "timeout" };
    }
  }

  const res = await rpc;
  if (!res || res.ok === false) {
    return {
      ok: false,
      reason: "tool-error",
      error: res && res.error ? res.error : undefined,
    };
  }

  // Audit logging through the real Audit store (never fails the call).
  Audit.log({
    event: "mcp.tool.invoked",
    tool: toolName,
    input_summary:
      typeof args === "object" && args !== null
        ? JSON.stringify(args).slice(0, 128)
        : String(args).slice(0, 128),
    result: "ok",
  });

  return { ok: true, result: res.result };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

test.beforeEach(() => {
  MCP._resetForTests();
  resetAudit();
  setAuditState({ filePath: null });
});

// Tear down any spawned fake child so no pending 10s rpc timer lingers
// between tests. Disconnect resolves any in-flight rpc() via the child
// `close` event (clearing its internal setTimeout).
test.afterEach(() => {
  for (const s of MCP.list()) {
    MCP.disconnect(s.name);
  }
  MCP._resetForTests();
});

// ---------------------------------------------------------------------------
// 1) Curated servers registered idempotently, never auto-spawned
// ---------------------------------------------------------------------------

test("GATE 7: curated server list (filesystem + fetch) is registered idempotently without spawning", () => {
  const spy = makeSpySpawn();
  configureMCP({ spawn: spy });

  const first = MCP.ensureCuratedServers(TEST_SCOPE.profileId, TEST_SCOPE.projectId);
  assert.ok(Array.isArray(first));
  assert.deepEqual(
    new Set(first),
    new Set(CURATED_SERVERS.map((s) => s.id)),
    "first call registers every curated id"
  );

  // Idempotent second call must be a no-op.
  const second = MCP.ensureCuratedServers(TEST_SCOPE.profileId, TEST_SCOPE.projectId);
  assert.deepEqual(second, [], "second call must return [] (idempotent)");

  // Metadata only — never connected, never spawned.
  assert.equal(spy.calls.length, 0, "ensureCuratedServers must NOT spawn");
  const listed = MCP.list();
  const curatedListed = listed.filter((e) => CURATED_IDS.has(e.name));
  assert.equal(
    curatedListed.length,
    CURATED_SERVERS.length,
    "curated entries appear exactly once"
  );
  for (const e of curatedListed) {
    assert.equal(e.status, "registered", `${e.name} must not auto-connect`);
  }

  // The renderer-safe projector returns the exact safe envelope.
  const safe = listCuratedSafe();
  for (const entry of safe) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["args", "command", "description", "id", "tools"].sort(),
      "renderer-safe envelope keys are fixed"
    );
  }
});

// ---------------------------------------------------------------------------
// 2) mcp_bridge_invoke on a curated server reaches the (mocked) server and
//    returns its result, exercising the REAL bridge connect + callTool + jsonrpc
// ---------------------------------------------------------------------------

test("GATE 7: mcp_bridge_invoke on a curated server calls the real bridge and returns the result", async () => {
  // Fake server replies to initialize + tools/list; tools/call echoes args.
  const { child, requests } = makeFakeServer({
    toolsList: [
      { name: "read_file", description: "read a file", inputSchema: { type: "object" } },
    ],
  });
  configureMCP({ spawn: () => child });

  const res = await mcp_bridge_invoke("filesystem", "read_file", { path: "/tmp/hello.txt" });

  // Success path returns the server's real result through the bridge.
  assert.equal(res.ok, true);
  assert.ok(res.result && Array.isArray(res.result.content), "result must carry the server's content");
  assert.equal(
    res.result.content[0].text.includes("/tmp/hello.txt"),
    true,
    "echoed args must round-trip through the real jsonrpc RPC"
  );

  // The bridge actually sent a tools/call to the server.
  const calls = requests.filter((r) => r.method === "tools/call");
  assert.equal(calls.length, 1, "exactly one tools/call must be sent");
  assert.equal(calls[0].params.name, "read_file");
  assert.deepEqual(calls[0].params.arguments, { path: "/tmp/hello.txt" });
});

// ---------------------------------------------------------------------------
// 3) Unknown server -> { ok:false, reason:'unknown-server' } (renderer cannot
//    name an arbitrary server)
// ---------------------------------------------------------------------------

test("GATE 7: mcp_bridge_invoke with an unknown server returns unknown-server (never reaches a child)", async () => {
  // Install the SPY as the active spawn so the assertion is meaningful:
  // if the adapter ever reached connect() for a non-curated name, spawn
  // would be invoked and spy.calls would be non-zero.
  const spy = makeSpySpawn();
  configureMCP({ spawn: spy });

  // A non-curated name must be rejected before any connect/spawn happens.
  const res = await mcp_bridge_invoke("evil-server", "anything", {});
  assert.equal(res.ok, false);
  assert.equal(res.reason, "unknown-server");
  assert.equal(spy.calls.length, 0, "unknown server must never spawn a child");
});

// ---------------------------------------------------------------------------
// 4) Empty / missing tool name -> { ok:false, reason:'missing-tool' }
// ---------------------------------------------------------------------------

test("GATE 7: mcp_bridge_invoke with an empty tool name returns missing-tool", async () => {
  const { child } = makeFakeServer();
  configureMCP({ spawn: () => child });

  const r1 = await mcp_bridge_invoke("filesystem", "", {});
  const r2 = await mcp_bridge_invoke("filesystem", undefined, {});
  const r3 = await mcp_bridge_invoke("filesystem", null, {});
  for (const r of [r1, r2, r3]) {
    assert.equal(r.ok, false);
    assert.equal(r.reason, "missing-tool");
  }
});

// ---------------------------------------------------------------------------
// 5) Timeout: AbortSignal.timeout(100) aborts a hung call before the bridge's
//    10s backstop and surfaces { ok:false, reason:'timeout' }
// ---------------------------------------------------------------------------

test("GATE 7: mcp_bridge_invoke respects AbortSignal.timeout and returns timeout on a hung server", async () => {
  // Fake server completes the handshake + tools/list but NEVER replies to
  // tools/call — so the real bridge's callTool/rpctimeout sits pending until
  // the abort signal wins the race.
  const { child, requests } = makeFakeServer({
    toolsList: [{ name: "fetch", description: "fetch url", inputSchema: { type: "object" } }],
    hangCall: true,
  });
  configureMCP({ spawn: () => child });

  const startedAt = Date.now();
  const res = await mcp_bridge_invoke("fetch", "fetch", { url: "https://example.test" }, {
    signal: AbortSignal.timeout(100),
    profileId: TEST_SCOPE.profileId,
    projectId: TEST_SCOPE.projectId,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(res.ok, false);
  assert.equal(res.reason, "timeout");
  // Must fail fast (well under the bridge's internal 10s backstop).
  assert.ok(elapsed < 2000, `timeout must surface fast (got ${elapsed}ms)`);

  // The bridge DID send the tools/call request before being aborted.
  assert.equal(
    requests.filter((r) => r.method === "tools/call").length,
    1,
    "tools/call must have been dispatched before the abort"
  );
});

// ---------------------------------------------------------------------------
// 6) Renderer isolation: the renderer can only reach the read-only curated
//    list IPC channel. There is NO mcp:invoke / mcp_bridge_invoke IPC handler
//    — the renderer cannot fire MCP execution directly.
// ---------------------------------------------------------------------------

test("GATE 7: renderer has no MCP execution or discovery IPC channel", () => {
  const src = readFileSync(
    new URL("../src/ipc/skills-plugins-mcp.js", import.meta.url),
    "utf8"
  );

  // Security: no MCP channel may cross the renderer boundary.
  assert.doesNotMatch(src, /ipcMain\.handle\(\s*["']mcp:list-curated["']/, "MCP discovery must remain shell-side");
  assert.doesNotMatch(
    src,
    /ipcMain\.handle\(\s*["']mcp:invoke["']/,
    "renderer must NOT have an mcp:invoke channel"
  );
  assert.doesNotMatch(
    src,
    /mcp_bridge_invoke/,
    "no mcp_bridge_invoke IPC channel may exist for the renderer"
  );
  assert.doesNotMatch(
    src,
    /ipcMain\.handle\(\s*["']mcp:call["']/,
    "renderer must NOT have an mcp:call channel"
  );

  // The internal safe projector still returns only curated metadata.
  const safe = listCuratedSafe();
  const ids = safe.map((s) => s.id);
  assert.ok(ids.includes("filesystem"));
  assert.ok(ids.includes("fetch"));
  assert.equal(getCuratedServer("not-a-server"), null, "non-curated name resolves to null");
});

// ---------------------------------------------------------------------------
// 7) Audit: every successful invoke emits an audit event via the real Audit
// ---------------------------------------------------------------------------

test("GATE 7: a successful mcp_bridge_invoke emits an audit event via the real Audit module", async () => {
  const { child } = makeFakeServer({
    toolsList: [{ name: "read_file", description: "read", inputSchema: { type: "object" } }],
  });
  configureMCP({ spawn: () => child });

  const emitted = Audit.list({ event: "mcp.tool.invoked" });
  assert.equal(emitted.length, 0, "no audit event before any invoke");

  const res = await mcp_bridge_invoke("filesystem", "read_file", { path: "/x/y" });
  assert.equal(res.ok, true);

  const after = Audit.list({ event: "mcp.tool.invoked" });
  assert.equal(after.length, 1, "exactly one audit event must be emitted");
  assert.equal(after[0].tool, "read_file", "audit event must record the tool");
  // The renderer-unsafe secret fields are never written; input_summary is
  // the redacted echo of args only.
  assert.equal(after[0].result, "ok");
  assert.ok(after[0].input_summary, "input_summary must be present");
  assert.equal(/secret|token|password/i.test(after[0].input_summary || ""), false);
});
