// GATE 17 (v7) — Focused Security Audit of Project Mode
//
// Tests covering vectors NOT already in gate14-security-final.test.js:
//   1. Renderer IPC payload cannot carry projectRoot (resolved from (profileId, agentId) tuple)
//   2. safeExecFile: command/argv passed as-is, no shell interpretation
//   3. Sub-agent recursion guard (isSubAgent filters delegate_* tools from child tool set)
//   4. MCP callTool returns structured error on child-close; timeout mechanism exists
//   5. Audit log redacts Stripe secret key (sk_live_) in string fields
//   6. CSP script-src has no 'unsafe-inline' (blocks <script> injection)
//   7. project:create-agent IPC handler validates non-empty objective
//   8. project:finish-agent IPC handler rejects sub-agent finalization

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";

import { safeExecFile } from "../src/services/project-tools/_runtime.js";
import { Audit, _INTERNAL, _setStateForTests, _resetForTests } from "../src/services/audit/index.js";
import { CSP_HEADER } from "../src/security/csp.js";
import { MCP, configureMCP } from "../src/services/mcp/index.js";
import { _resetForTests as resetProjectTools } from "../src/services/project-tools/index.js";

const MCP_SCOPE = { profileId: 1, projectId: 1 };

// ---------------------------------------------------------------------------
// 1. Renderer IPC payload cannot carry projectRoot
// ---------------------------------------------------------------------------

test("projectTools.invoke payload cannot carry projectRoot — resolved from (profileId, agentId) in main", () => {
  // The context-bridge invoke() must NOT include projectRoot in the IPC
  // payload. The main process resolves it via getActiveProjectRootFor.
  const preloadSrc = readFileSync(resolve("shell/src/preload.cjs"), "utf8");

  // Extract the projectTools.invoke function body from preload.cjs
  const invokeMatch = preloadSrc.match(/invoke:\s*\([^)]*\)\s*=>\s*\{[\s\S]*?ipcRenderer\.invoke\("project:invoke-tool"/);
  assert.ok(invokeMatch, "projectTools.invoke must exist in preload.cjs");
  const invokeBody = invokeMatch[0];

  // The payload object must not include projectRoot
  assert.ok(
    !/projectRoot/.test(invokeBody),
    "projectTools.invoke payload must not carry projectRoot — the renderer cannot pick a root"
  );

  // Also verify profileId / projectId / agentId are NOT sent by the
  // renderer-facing invoke() (they are internal to the agent loop).
  assert.ok(
    !/payload\..*profileId/.test(invokeBody),
    "projectTools.invoke payload must not carry profileId — the renderer cannot scope a tool call"
  );

  // The IPC handler must resolve projectRoot from the registry, not payload
  const ipcSrc = readFileSync(resolve("shell/src/ipc/project-tools.js"), "utf8");
  assert.ok(
    /getActiveProjectRootFor/.test(ipcSrc),
    "IPC handler must resolve projectRoot via getActiveProjectRootFor"
  );
  assert.ok(
    !/payload\.projectRoot|payload,\s*projectRoot/.test(ipcSrc),
    "IPC handler must not read projectRoot from the renderer-supplied payload"
  );
});

// ---------------------------------------------------------------------------
// 2. safeExecFile: command/argv passed as-is, no shell interpretation
// ---------------------------------------------------------------------------

test("safeExecFile: passes command and argv to execFile with no shell=True", async () => {
  const captured = {};
  function mockExecFile(cmd, argv, opts, cb) {
    captured.cmd = cmd;
    captured.argv = argv;
    captured.opts = opts;
    process.nextTick(() => cb(null, "mock-stdout", "mock-stderr"));
    return {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: () => {},
      once: () => {},
    };
  }

  // Shell metacharacters embedded in both command and argv must NOT be
  // interpreted — they are passed as literal strings to execFile.
  await safeExecFile(
    "echo; rm -rf /",
    ["hello && cat /etc/passwd", "$(whoami)", "`id`"],
    { cwd: "/tmp", timeoutMs: 5_000 },
    mockExecFile,
  );

  // Command is the literal string — NOT split or interpolated
  assert.equal(captured.cmd, "echo; rm -rf /");
  // argv entries are literal — NOT interpreted as shell command chains
  assert.deepEqual(captured.argv, ["hello && cat /etc/passwd", "$(whoami)", "`id`"]);
  // No shell option — execFile defaults to shell:false
  assert.equal(
    captured.opts.shell,
    undefined,
    "execFile options must not set shell:true — metacharacters are never interpreted"
  );
});

test("exec_run: FORBIDDEN_COMMANDS includes all shell interpreters (defense-in-depth)", () => {
  const src = readFileSync(resolve("shell/src/services/project-tools/exec_run.js"), "utf8");
  const forbiddenMatch = src.match(/FORBIDDEN_COMMANDS\s*=\s*new\s+Set\(\[([\s\S]*?)\]\)/);
  assert.ok(forbiddenMatch, "exec_run must define FORBIDDEN_COMMANDS");
  const forbiddenStr = forbiddenMatch[1];
  for (const cmd of ["bash", "sh", "zsh", "fish", "cmd", "cmd.exe", "powershell", "pwsh"]) {
    assert.ok(
      forbiddenStr.includes(`"${cmd}"`) || forbiddenStr.includes(`'${cmd}'`),
      `FORBIDDEN_COMMANDS must include ${cmd}`
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Sub-agent recursion guard (isSubAgent filters delegate_* tools)
// ---------------------------------------------------------------------------

test("loop.js: isSubAgent flag filters delegate_* tools from child tool set", () => {
  const src = readFileSync(resolve("shell/src/services/agent/loop.js"), "utf8");

  // The child loop must filter DELEGATE_TOOL_NAMES when isSubAgent is true.
  // This is the recursion guard: a sub-agent cannot delegate to a child.
  assert.ok(
    /if\s*\(\s*isSubAgent\s*\)\s*\{[\s\S]*?tools\s*=\s*tools\.filter\s*\(\s*\(t\)\s*=>\s*!DELEGATE_TOOL_NAMES\.includes\s*\(\s*t\.name\s*\)/.test(src),
    "startAgent must filter DELEGATE_TOOL_NAMES when isSubAgent=true"
  );

  // subAgentSlotAvailable must unconditionally return false for sub-agents.
  assert.ok(
    /subAgentSlotAvailable:\s*\(\)\s*=>\s*isSubAgent\s*\?\s*false/.test(src),
    "subAgentSlotAvailable must return false for sub-agents (cannot reserve slots)"
  );
});

test("delegate_research: runDelegate sets isSubAgent=true when starting child", () => {
  const src = readFileSync(resolve("shell/src/services/project-tools/delegate_research.js"), "utf8");
  assert.ok(
    /isSubAgent:\s*true/.test(src),
    "runDelegate must pass isSubAgent:true when starting the child agent loop"
  );
});

// ---------------------------------------------------------------------------
// 4. MCP: callTool returns structured error on child-close + timeout mechanism
// ---------------------------------------------------------------------------

// Fake child process — responds to initialize + tools/list but closes
// during tools:call, simulating a server that dies mid-invocation.
// Same shape as the FakeChild in mcp-bridge.test.js.
class FakeMcpChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = {
      _write: null,
      write: (chunk) => {
        if (this.stdin._write) this.stdin._write(chunk);
        return true;
      },
      end: () => {},
    };
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    this.pid = 99999;
  }
  kill() {
    this.killed = true;
    this.emit("close", 0);
  }
}

test.beforeEach(() => {
  MCP._resetForTests();
  resetProjectTools();
});

test("MCP callTool returns structured error when child closes during call", async () => {
  const child = new FakeMcpChild();
  // Intercept stdin.write to simulate JSON-RPC responses
  child.stdin._write = (chunk) => {
    let parsed;
    try {
      parsed = JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    } catch {
      return;
    }
    if (typeof parsed.id !== "number") return; // notifications: ignore
    setImmediate(() => {
      if (parsed.method === "initialize") {
        child.stdout.emit("data", Buffer.from(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: { protocolVersion: "2024-11-05", capabilities: {} },
          }) + "\n",
          "utf8",
        ));
      } else if (parsed.method === "tools/list") {
        child.stdout.emit("data", Buffer.from(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: {
              tools: [{
                name: "test_tool",
                description: "a test tool",
                inputSchema: { type: "object", properties: {} },
              }],
            },
          }) + "\n",
          "utf8",
        ));
      } else if (parsed.method === "tools/call") {
        // Simulate process death — child closes without responding
        child.emit("close", 0);
      }
    });
  };
  configureMCP({ spawn: () => child });

  MCP.register({ ...MCP_SCOPE, name: "test-srv", command: "fake", args: [] });
  const connectRes = await MCP.connect("test-srv", MCP_SCOPE);
  assert.equal(connectRes.ok, true, "connect should succeed with the mock child");

  const res = await MCP.callTool("test-srv", "test_tool", {}, MCP_SCOPE);
  assert.equal(res.ok, false, "callTool against a closed child must fail");
  assert.ok(res.error && typeof res.error === "object", "error must be an object");
  // rpc returns either rpc-closed (child died) or rpc-timeout (no response)
  assert.ok(
    res.error.code === "rpc-closed" || res.error.code === "rpc-timeout",
    `expected rpc-closed or rpc-timeout, got: ${res.error.code}`
  );
});

test("MCP: callTool is not reachable when server is not connected (not-connected)", async () => {
  // Register but do not connect.
  MCP.register({ ...MCP_SCOPE, name: "unconnected-srv", command: "fake", args: [] });
  const res = await MCP.callTool("unconnected-srv", "any_tool", {}, MCP_SCOPE);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "not-connected");
});

test("MCP: callTool source passes a timeout to rpc (timeout mechanism exists)", () => {
  const src = readFileSync(resolve("shell/src/services/mcp/index.js"), "utf8");
  // callTool must invoke rpc with a finite timeout (10_000ms).
  // This is the timeout that fires when a tool invocation "exceeds the
  // timeout" — the rpc() setTimeout calls err("rpc-timeout", ...).
  assert.ok(
    /callTool[\s\S]*?rpc\(.*?,[^)]*10_000/.test(src),
    "callTool must pass a 10_000ms timeout to rpc()"
  );
  // The rpc() function must use setTimeout for its timeout.
  assert.ok(
    /setTimeout.*err\("rpc-timeout"/.test(src),
    "rpc() must use setTimeout to fire rpc-timeout on stall"
  );
});

// ---------------------------------------------------------------------------
// 5. Audit: redacts Stripe secret key (sk_live_)
// ---------------------------------------------------------------------------

test("redact: Stripe secret key (sk_live_) is replaced in input_summary and detail", () => {
  _resetForTests();
  _setStateForTests({ filePath: null });
  const { redact } = _INTERNAL;

  const stripeKey = "sk_live_" + "51H8xK2eV5JY0g3vN7pBqMrdR2K4sT6wX8yZ0aB1cD2eF";
  const input = `Payment intent with key: ${stripeKey} for customer 123`;

  const result = redact(input);
  assert.ok(!result.includes(stripeKey), "Stripe key must not appear in redacted output");
  assert.ok(
    result.includes("sk_live_<redacted>"),
    "Stripe key must be replaced with sk_live_<redacted>"
  );

  _resetForTests();
});

test("Audit.log: Stripe key in input_summary and detail is redacted before persist", () => {
  _resetForTests();
  _setStateForTests({ filePath: null });
  const { redact } = _INTERNAL;

  const stripeKey = "sk_live_" + "abc123DEF456ghi789jkl012mno345pqr";

  // Log an event with a Stripe key in both input_summary and detail.
  // These are the fields normalize() runs through redact().
  Audit.log({
    event: "tool.invoked",
    profileId: 1,
    projectId: 1,
    agentId: 1,
    tool: "exec_run",
    input_summary: `cmd: deploy --key=${stripeKey}`,
    result: null,
    durationMs: null,
    detail: `deploy --key=${stripeKey} && echo success`,
  });

  const events = Audit.recent(10);
  assert.equal(events.length, 1);
  const ev = events[0];

  // input_summary must be redacted
  assert.ok(
    !ev.input_summary.includes(stripeKey),
    "Stripe key must be redacted from input_summary"
  );
  // detail must be redacted
  assert.ok(
    !ev.detail.includes(stripeKey),
    "Stripe key must be redacted from detail"
  );

  _resetForTests();
});

// ---------------------------------------------------------------------------
// 6. CSP: script-src has no 'unsafe-inline' (blocks <script> injection)
// ---------------------------------------------------------------------------

test("CSP: script-src must not include 'unsafe-inline' — blocks inline <script> injection", () => {
  const match = CSP_HEADER.match(/script-src\s+([^;]+)/i);
  assert.ok(match, "CSP must have a script-src directive");
  const value = match[1].trim();

  assert.ok(
    !value.includes("'unsafe-inline'") && !value.includes("unsafe-inline"),
    `script-src must not allow inline scripts — CSP blocks <script> injection. Got: ${value}`
  );
  assert.ok(
    !value.includes("'unsafe-eval'") && !value.includes("unsafe-eval"),
    `script-src must not allow eval/Function — CSP blocks dynamic code execution. Got: ${value}`
  );
});

test("CSP: object-src 'none' — prevents plugin/Flash/Java-based script execution", () => {
  const match = CSP_HEADER.match(/object-src\s+([^;]+)/i);
  assert.ok(match, "CSP must have object-src");
  const value = match[1].trim();
  assert.equal(
    value,
    "'none'",
    `object-src must be "'none'" to block <object>/<embed>/<applet>. Got: ${value}`
  );
});

// ---------------------------------------------------------------------------
// 7. project:create-agent IPC handler validates non-empty objective
// ---------------------------------------------------------------------------

test("project:create-agent IPC handler validates non-empty objective", () => {
  const src = readFileSync(resolve("shell/src/ipc/project-mode.js"), "utf8");
  const handlerMatch = src.match(
    /(?:ipcMain\.handle|safeHandle)\s*\(\s*["']project:create-agent["'][\s\S]*?callPm\("pmCreateAgent"[\s\S]*?\)\s*\)/m
  );
  assert.ok(handlerMatch, "project:create-agent handler must exist");
  const handlerBody = handlerMatch[0];

  // The handler must validate objective is a non-empty string before
  // forwarding to pmCreateAgent. This prevents the renderer from creating
  // an agent with an empty goal (which would produce a null/zero-length
  // objective in the DB).
  assert.ok(
    /objective/.test(handlerBody) &&
      (/objective\.trim\(\)/.test(handlerBody) || /objective\.length/.test(handlerBody) || /!objective/.test(handlerBody)),
    "create-agent handler must validate that objective is non-empty"
  );
  // Must return an error envelope (not call pmCreateAgent) when objective is empty
  assert.ok(
    /ok:\s*false/.test(handlerBody),
    "create-agent handler must return { ok:false } when objective is invalid"
  );
});

// ---------------------------------------------------------------------------
// 8. agent lifecycle mutation is not renderer-exposed
// ---------------------------------------------------------------------------

test("agent lifecycle mutation is not renderer-exposed", () => {
  const src = readFileSync(resolve("shell/src/ipc/project-mode.js"), "utf8");
  const preload = readFileSync(resolve("shell/src/preload.cjs"), "utf8");
  for (const channel of [
    "project:append-message",
    "project:update-agent",
    "project:finish-agent",
  ]) {
    assert.doesNotMatch(src, new RegExp(`(?:ipcMain\\.handle|safeHandle)\\(\\s*["']${channel}`));
    assert.doesNotMatch(preload, new RegExp(channel));
  }
});
