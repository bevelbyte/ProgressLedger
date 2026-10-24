// Agent-startup hook for the MCP bridge.
//
// The agent loop (shell/src/services/agent/loop.js) is intentionally kept free
// of MCP wiring. The INTENT was that callers which kick off an agent (the
// `project:start-agent` IPC handler in shell/src/ipc/project-mode.js, plus the
// `startSubAgent` fallback bridge) invoke `onAgentStart()` here, so the curated
// server list is registered exactly once before the first tool call lands.
//
// REACHABILITY - READ THIS BEFORE TRUSTING THE MCP PANEL
//   The catalogue registration half of this intent is NOW WIRED.
//   `project:start-agent` (shell/src/ipc/project-mode.js) calls `onAgentStart()`
//   for the run's (profileId, projectId) scope, and the `startSubAgent` delegate
//   bridge calls it for the CHILD's own scope, because a delegate runs in a
//   different scope than its parent. Both calls are wrapped in try/catch:
//   registering a metadata catalogue must never fail an agent run.
//
//   So `MCP.list()` is no longer always `[]`, and `marketplace.listMcp()` no
//   longer always answers `{ ok: true, mcp: [] }`.
//
//   WHAT IS STILL NOT WIRED, deliberately: `MCP.connect()` and
//   `MCP.callTool()` still have no production caller, so no MCP child process is
//   ever spawned and no MCP tool is ever exposed to the agent. That half needs a
//   design decision - which curated servers to auto-connect, and what their
//   lifecycle and shutdown are - and `connect()` spawns
//   `npx -y @modelcontextprotocol/server-*`, i.e. it reaches the network. It is
//   therefore left alone rather than guessed at.
//
//   Registration itself is metadata-only: `ensureCuratedServers()` calls
//   `MCP.register()`, which stores `{command,args,env}`. It spawns nothing.
//   That is what makes calling it on every agent start safe.
//
//   Pinned by shell/tests/mcp-production-wiring.test.js.
//
// This module is shell-only; nothing in here is exposed to the
// renderer. There is no `mcp:*` IPC channel - see services/mcp/curated.js.

import { MCP } from "./index.js";

/**
 * Called when an agent is about to start. Registers the curated
 * MCP server list idempotently (no-op after the first call). Crucially
 * this does NOT spawn any child processes â€” the servers stay in the
 * `registered` state until the agent (or test) explicitly calls
 * `MCP.connect()`.
 *
 * Returns the names that were newly registered on this call (empty
 * array if already initialised). The shape mirrors
 * `MCP.ensureCuratedServers()`.
 *
 * @returns {string[]}
 */
export function onAgentStart(profileId, projectId) {
  return MCP.ensureCuratedServers(profileId, projectId);
}
