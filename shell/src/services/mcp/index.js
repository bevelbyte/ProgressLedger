// MCP — Model Context Protocol server connection manager.
//
// Each MCP server is a stdio-launched child process that exposes tools via
// JSON-RPC. The renderer NEVER spawns MCP processes: the shell owns every
// connection lifecycle.
//
// Tools discovered from a connected MCP server are bridged into the agent
// tool registry (see `shell/src/services/project-tools/index.js`). Each
// tool becomes a regular `PROJECT_TOOLS` entry: the agent can invoke it
// like any built-in, but the renderer never sees the server's port, host,
// token, or process info — only the safe metadata (name, description,
// permission, inputSchema) returned by `listToolsSafe()`.
//
// `spawn` is dependency-injected so tests can pass a mock and never touch
// a real child process.
//
// All public functions never throw. Failures surface as
// `{ ok: false, error: { code, message } }`.

import {
  register as registerTool,
  unregister as unregisterTool,
} from "../project-tools/index.js";
import { CURATED_SERVERS } from "./curated.js";

const MCP_PERMISSIONS = Object.freeze({ READ: "READ", WRITE: "WRITE", EXECUTE: "EXECUTE", NETWORK: "NETWORK", DESTRUCTIVE: "DESTRUCTIVE" });

// ---- module state ---------------------------------------------------------

// Map<`${profileId}:${projectId}:${name}`, { name, profileId, projectId, command, args, env, child: any, tools: any[], status: 'registered' | 'connecting' | 'connected' | 'disconnected' | 'failed', error?: string }>
const servers = new Map();

function serverKey(name, scope) {
  const normalized = normalizeScope(scope);
  return normalized ? `${normalized.profileId}:${normalized.projectId}:${name}` : null;
}

function findServer(name, scope) {
  const key = serverKey(name, scope);
  const exact = key ? servers.get(key) : null;
  if (exact) return { rec: exact, key, owned: true };
  const foreign = [...servers.entries()].find(([, entry]) => entry.name === name);
  return foreign
    ? { rec: foreign[1], key: foreign[0], owned: false }
    : { rec: null, key, owned: false };
}

// Injectable constructor — defaults to child_process.spawn when running in
// Electron. Tests pass a mock via configureMCP({ spawn }).
import { spawn as nodeSpawn } from "node:child_process";
let _spawn = nodeSpawn;

/**
 * Override the spawn constructor. Used by tests to inject a mock. Passing
 * a falsy value restores the default (node:child_process.spawn).
 */
export function configureMCP({ spawn } = {}) {
  _spawn = spawn || nodeSpawn;
}

// ---- helpers --------------------------------------------------------------

function err(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== "object") return null;
  const { profileId, projectId } = scope;
  if (!Number.isInteger(profileId) || profileId < 1 || !Number.isInteger(projectId) || projectId < 1) return null;
  return { profileId, projectId };
}

/**
 * Send a single JSON-RPC message to a child process over its stdin and
 * resolve with the response. Used by `connect` (initialize handshake),
 * `listTools` (tools/list), and `callTool` (tools/call). Lines are
 * delimited by `\n` per the MCP spec.
 */
function rpc(child, request, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    if (!child || !child.stdout || !child.stdin) {
      return resolve(err("not-connected", "child has no stdio"));
    }
    let buf = "";
    let settled = false;
    const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
    const timer = setTimeout(() => finish(err("rpc-timeout", `request ${request.method} timed out`)), timeoutMs);

    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && parsed.id === request.id) {
            clearTimeout(timer);
            child.stdout.off("data", onData);
            finish(parsed);
            return;
          }
        } catch {
          // Ignore malformed lines — could be log output from the server.
        }
      }
    };
    child.stdout.on("data", onData);
    child.stderr?.on("data", () => { /* discard; surface on close */ });

    child.once("close", (code) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      finish(err("rpc-closed", `child closed (code=${code})`));
    });

    try {
      child.stdin.write(JSON.stringify(request) + "\n");
    } catch (e) {
      clearTimeout(timer);
      finish(err("rpc-write-failed", String(e && e.message || e)));
    }
  });
}

// ---- public API -----------------------------------------------------------

/**
 * Register a server. Spawn is NOT performed here — only the metadata is
 * recorded. Idempotent: re-registering an existing name overwrites the
 * config but does NOT auto-connect.
 */
function register({ profileId, projectId, name, command, args, env }) {
  const scope = normalizeScope({ profileId, projectId });
  if (!scope) return err("invalid-scope", "MCP registration requires profileId and projectId");
  if (typeof name !== "string" || !name) return err("invalid-input", "name required");
  if (typeof command !== "string" || !command) return err("invalid-input", "command required");
  if (!Array.isArray(args)) args = [];
  if (!env || typeof env !== "object") env = {};
  servers.set(serverKey(name, scope), {
    name,
    profileId: scope.profileId,
    projectId: scope.projectId,
    command,
    args: [...args],
    env: { ...env },
    child: null,
    tools: [],
    status: "registered",
  });
  return { ok: true };
}

/**
 * Unregister a server. Disconnects first if connected.
 */
function unregister(name, scope = null) {
  const found = findServer(name, scope);
  const key = found.key;
  const rec = found.rec;
  if (!rec) return { ok: true };
  const requested = normalizeScope(scope);
  if (!requested || rec.profileId !== requested.profileId || rec.projectId !== requested.projectId) {
    return err("not-owned", "MCP server is outside the active project scope");
  }
  disconnect(name, requested);
  servers.delete(key);
  return { ok: true };
}

/**
 * Returns metadata for every registered server. Does NOT include the
 * child handle, tools cache, or status — that information is shell-only.
 */
function list() {
  return [...servers.values()].map((rec) => ({
    name: rec.name,
    profileId: rec.profileId,
    projectId: rec.projectId,
    command: rec.command,
    args: [...rec.args],
    status: rec.status,
    toolCount: rec.tools.length,
  }));
}

/**
 * Spawn the child process and run the MCP initialize handshake. On
 * success the server's status becomes 'connected'. On any failure, the
 * status becomes 'failed' and the error is returned.
 */
async function connect(name, scope = null) {
  const found = findServer(name, scope);
  const key = found.key;
  const rec = found.rec;
  if (!rec) return err("not-found", `server not registered: ${name}`);
  const requested = normalizeScope(scope);
  if (!requested || rec.profileId !== requested.profileId || rec.projectId !== requested.projectId) {
    return err("not-owned", "MCP server is outside the active project scope");
  }
  if (rec.status === "connected" && rec.child) return { ok: true };

  rec.status = "connecting";
  rec.error = undefined;

  let child;
  try {
    // SECURITY: NEVER shell:true. Args are passed as a vector so the OS
    // shell does not interpret metacharacters.
    child = _spawn(rec.command, rec.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...rec.env },
      shell: false,
    });
  } catch (e) {
    rec.status = "failed";
    rec.error = String(e && e.message || e);
    return err("spawn-failed", rec.error);
  }
  if (!child || typeof child.stdin?.write !== "function") {
    rec.status = "failed";
    rec.error = "spawn returned an unusable handle";
    return err("spawn-failed", rec.error);
  }

  rec.child = child;

  // The initialize handshake. Per the MCP spec the server replies with
  // its protocolVersion and capabilities.
  const handshake = await rpc(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {} },
  }, 5_000);

  if (!handshake || handshake.ok === false) {
    rec.status = "failed";
    rec.error = (handshake && handshake.error && handshake.error.message) || "handshake failed";
    try { child.kill(); } catch {}
    rec.child = null;
    return err("handshake-failed", rec.error);
  }

  // Send the `initialized` notification (no response expected).
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  } catch {
    // Best-effort; some servers don't require it.
  }

  rec.status = "connected";

  // Eagerly fetch tools so listTools() is fast after connect().
  const toolsRes = await rpc(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, 5_000);
  if (toolsRes && Array.isArray(toolsRes.result && toolsRes.result.tools)) {
    rec.tools = toolsRes.result.tools;
  } else {
    rec.tools = [];
  }

  // Bridge every discovered tool into the agent tool registry so the
  // agent can call it like any built-in. The renderer NEVER sees the
  // server name, port, token, or process info — only the safe metadata
  // returned by `listToolsSafe()`.
  bridgeTools(name, scope);

  return { ok: true };
}

/**
 * Disconnect a server. Idempotent. Kills the child if any.
 * Also unregisters every bridged tool from the agent tool registry
 * so the renderer no longer sees them in `listToolsSafe()`.
 */
function disconnectAll() {
  for (const rec of [...servers.values()]) disconnect(rec.name, { profileId: rec.profileId, projectId: rec.projectId });
  return { ok: true };
}

function disconnect(name, scope = null) {
  const key = scope === null ? null : serverKey(name, scope);
  const rec = key ? servers.get(key) : [...servers.values()].find((entry) => entry.name === name);
  if (!rec) return { ok: true };
  if (scope !== null) {
    const requested = normalizeScope(scope);
    if (!requested || rec.profileId !== requested.profileId || rec.projectId !== requested.projectId) {
      return err("not-owned", "MCP server is outside the active project scope");
    }
  }
  // Unbridge any tools we previously registered for this server
  // BEFORE killing the child, so a stale execute function cannot
  // outlive the connection.
  unbridgeTools(name, rec && { profileId: rec.profileId, projectId: rec.projectId });
  if (rec.child) {
    try { rec.child.kill(); } catch {}
    rec.child = null;
  }
  rec.status = "disconnected";
  rec.tools = [];
  return { ok: true };
}

/**
 * Returns the cached tools list for a connected server, or refreshes via
 * `tools/list`. Returns `{ ok: false, error: { code: 'not-connected' } }`
 * if the server is not currently connected.
 */
async function listTools(name, scope = null) {
  const found = findServer(name, scope);
  const rec = found.rec;
  if (!rec) return err("not-found", `server not registered: ${name}`);
  if (rec.status !== "connected" || !rec.child) return err("not-connected", `server not connected: ${name}`);
  const requested = normalizeScope(scope);
  if (!requested || rec.profileId !== requested.profileId || rec.projectId !== requested.projectId) {
    return err("not-owned", "MCP server is outside the active project scope");
  }
  const res = await rpc(rec.child, { jsonrpc: "2.0", id: 100, method: "tools/list", params: {} }, 5_000);
  if (!res || res.ok === false) return res || err("rpc-failed", "no response");
  if (Array.isArray(res.result && res.result.tools)) {
    rec.tools = res.result.tools;
    return { ok: true, tools: rec.tools };
  }
  return { ok: true, tools: [] };
}

/**
 * Call a tool on a connected server. Returns
 * `{ ok: false, error: { code: 'not-connected' } }` if the server isn't
 * connected, never throws.
 */
async function callTool(name, toolName, args, scope = null) {
  const found = findServer(name, scope);
  const rec = found.rec;
  if (!rec) return err("not-found", `server not registered: ${name}`);
  if (rec.status !== "connected" || !rec.child) return err("not-connected", `server not connected: ${name}`);
  if (typeof toolName !== "string" || !toolName) return err("invalid-input", "toolName required");
  const requested = normalizeScope(scope);
  if (!requested || rec.profileId !== requested.profileId || rec.projectId !== requested.projectId) {
    return err("not-owned", "MCP server is outside the active project scope");
  }
  const res = await rpc(rec.child, {
    jsonrpc: "2.0",
    id: 200,
    method: "tools/call",
    params: { name: toolName, arguments: args || {} },
  }, 10_000);
  if (!res || res.ok === false) return res || err("rpc-failed", "no response");
  return { ok: true, result: res.result };
}

/**
 * Health probe — returns whether the server is currently connected.
 */
function isConnected(name) {
  return [...servers.values()].some((rec) => rec.name === name && rec.status === "connected" && rec.child);
}

// ---- bridging to the agent tool registry ----------------------------------
//
// Each MCP-discovered tool is wrapped into a regular `PROJECT_TOOLS`
// entry so the agent can call it like any built-in. The wrapper's
// `execute` calls `MCP.callTool(serverName, toolName, args)` with an
// AbortSignal timeout and returns the standard `{ ok, result }`
// envelope. The renderer's `listToolsSafe()` exposes only the safe
// metadata — name, description, permission, inputSchema — never the
// server name, port, token, or process info.

const BRIDGED_PREFIX = "mcp_"; // visible name prefix is internal; renderer just sees the tool name

/**
 * Compose a deterministic registry name for a tool bridged from a
 * server. The namespacing prevents collisions across servers and
 * with the static 16 built-ins.
 */
function bridgedName(serverName, toolName) {
  return `${BRIDGED_PREFIX}${serverName}__${toolName}`;
}

/**
 * Build the `PROJECT_TOOLS` entry for one MCP-discovered tool. The
 * `execute` closes over the server name and tool name; on invocation
 * it asks the MCP module to call the tool on the live server, then
 * normalises the response into the standard envelope.
 */
function buildBridgedTool(serverName, rawTool) {
  const toolName = rawTool && rawTool.name;
  if (typeof toolName !== "string" || !toolName) return null;
  const description = typeof rawTool.description === "string" ? rawTool.description : "";
  const inputSchema = rawTool.inputSchema && typeof rawTool.inputSchema === "object"
    ? rawTool.inputSchema
    : { type: "object", properties: {} };
  const annotations = rawTool.annotations && typeof rawTool.annotations === "object" ? rawTool.annotations : {};
  // MCP annotations and extension fields are server supplied metadata, not
  // trusted authority. Start from WRITE so a malicious or mistaken
  // readOnlyHint/permission=READ cannot suppress the project-tool approval
  // gate. Explicit higher-risk classes may upgrade the classification.
  let permission = MCP_PERMISSIONS.WRITE;
  const explicit = rawTool._permission ?? rawTool.permission;
  if (typeof explicit === "string" && Object.prototype.hasOwnProperty.call(MCP_PERMISSIONS, explicit.toUpperCase())) {
    const declared = explicit.toUpperCase();
    if (declared !== MCP_PERMISSIONS.READ) permission = declared;
  } else if (annotations.destructiveHint === true) {
    permission = MCP_PERMISSIONS.DESTRUCTIVE;
  } else if (annotations.openWorldHint === true) {
    permission = MCP_PERMISSIONS.NETWORK;
  }
  return {
    name: bridgedName(serverName, toolName),
    // SECURITY: the description MUST NOT mention the server name,
    // port, token, or any process info. Only the tool name (which the
    // server already exposed in tools/list) is safe to echo. The
    // fallback description is intentionally generic.
    description: description || `MCP tool: ${toolName}`,
    permission,
    inputSchema,
    timeoutMs: 10_000,
    async execute(input, _ctx) {
      const scope = _ctx && Number.isInteger(_ctx.profileId) && Number.isInteger(_ctx.projectId)
        ? { profileId: _ctx.profileId, projectId: _ctx.projectId }
        : null;
      const res = await callTool(serverName, toolName, input || {}, scope);
      if (!res || res.ok === false) {
        return {
          ok: false,
          error: {
            code: (res && res.error && res.error.code) || "not-connected",
            message: (res && res.error && res.error.message) || "MCP tool call failed",
          },
        };
      }
      return { ok: true, result: res.result };
    },
  };
}

/**
 * Register every tool currently in `rec.tools` into the agent tool
 * registry under the namespaced name. Idempotent: re-registering
 * overwrites the prior entry (the wrapper is regenerated so the
 * server name is fresh).
 */
function bridgeTools(serverName, scope) {
  const key = serverKey(serverName, scope);
  const rec = key ? servers.get(key) : null;
  if (!rec) return;
  for (const raw of rec.tools) {
    const bridged = buildBridgedTool(serverName, raw);
    if (!bridged) continue;
    registerTool(bridged);
  }
}

/**
 * Unregister every bridged tool for `serverName`. Static tools are
 * left untouched. Idempotent.
 */
function unbridgeTools(serverName, scope = null) {
  const prefix = `${BRIDGED_PREFIX}${serverName}__`;
  // The dynamic registry is not iterable by name, so we unregister by
  // looking up each tool the server declared. We do not depend on the
  // project-tools exposing a list, but we do know the names.
  // Re-fetch the cached tools list (if any) so disconnect after a
  // reconnect still removes the right entries.
  const key = scope === null ? null : serverKey(serverName, scope);
  const rec = key ? servers.get(key) : [...servers.values()].find((entry) => entry.name === serverName);
  const names = rec && Array.isArray(rec.tools) ? rec.tools.map((t) => t && t.name).filter(Boolean) : [];
  // Namespaced names:
  for (const toolName of names) {
    unregisterTool(bridgedName(serverName, toolName));
  }
  // Fallback: if the server was never connected but had tools cached,
  // the loop above still covers it. Nothing else to do.
  // Reference `prefix` to keep eslint-style unused-var linters quiet
  // if they're ever added — it's intentionally part of the contract.
  void prefix;
}

// ---- exports --------------------------------------------------------------

/**
 * Register every entry in `CURATED_SERVERS` into the MCP server map.
 * Idempotent: a no-op after the first call. Crucially this only records
 * metadata — it does NOT spawn a child process. The server is spawned
 * lazily on the first `connect()` call, which is triggered by the agent
 * when a tool on the server is needed. This keeps app startup cheap and
 * avoids hanging the launch on `npx` resolving a package.

 *
 * Returns the list of names that were registered on this call (empty
 * array if already initialised).
 *
 * @returns {string[]}
 */
function ensureCuratedServers(profileId, projectId) {
  const scope = normalizeScope({ profileId, projectId });
  if (!scope) return [];
  const registered = [];
  for (const entry of CURATED_SERVERS) {
    if (!entry || typeof entry.id !== "string" || !entry.id) continue;
    if (typeof entry.command !== "string" || !entry.command) continue;
    if (!Array.isArray(entry.args)) continue;
    // Use the existing `register()` so all the metadata validation +
    // map bookkeeping is consistent with the rest of the module.
    const existing = servers.get(serverKey(entry.id, scope));
    if (existing) continue;
    const r = register({
      profileId: scope.profileId,
      projectId: scope.projectId,
      name: entry.id,
      command: entry.command,
      args: entry.args,
      env: entry.env && typeof entry.env === "object" ? entry.env : {},
    });
    if (r && r.ok) registered.push(entry.id);
  }
  return registered;
}

export const MCP = {
  register,
  unregister,
  list,
  connect,
  disconnect,
  listTools,
  callTool,
  isConnected,
  // Convenience aliases used by the brief. They map 1:1 onto the
  // canonical verbs (`connect` / `disconnect` / `listTools`).
  mcp_connect: connect,
  mcp_disconnect: disconnect,
  mcp_list_tools: listTools,
  configureMCP,
  ensureCuratedServers,
  _resetForTests() {
    servers.clear();
  },
};
