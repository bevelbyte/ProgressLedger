// Curated MCP server list.
//
// The shell ships a small, opinionated set of MCP servers that the agent
// can invoke out of the box without the user having to register anything.
// The list is intentionally short (filesystem + fetch); both are run
// on-demand via `npx -y @modelcontextprotocol/server-*` and are NEVER
// auto-spawned at app startup — they only spawn when the agent first
// asks for a tool on the server (via `ensureCuratedServers()` then
// `MCP.connect()`).
//
// Each entry exposes only safe metadata. The `args` here are passed
// verbatim to `child_process.spawn` with `shell: false` — no shell
// interpretation, so no metacharacter hazard.
//
// SECURITY: this module is shell-only. The renderer never imports it
// directly, and there is NO `mcp:*` IPC channel — not `mcp:list-curated`,
// not any other. The renderer-isolation decision is deliberate and is
// asserted by shell/tests/gate7-mcp-e2e.test.js; the earlier comment here
// naming an `mcp:list-curated` channel described a handler that does not
// exist.
//
// REACHABILITY (corrected 2026-09-27 — the previous text here was WRONG)
//   This file previously stated that `mcp/startup.js onAgentStart()` "has no
//   production caller". That is false and it was a dangerous kind of false: a
//   future engineer could have read it as licence to wire `MCP.connect()`,
//   which SPAWNS `npx -y @modelcontextprotocol/server-*` and therefore reaches
//   the network.
//
//   The accurate position, verified against the code:
//     * `shell/src/ipc/project-mode.js` calls `onAgentStart(...)` on
//       `project:start-agent` for the run's (profileId, projectId), and again
//       for a sub-agent's own scope on the delegate bridge. Both are wrapped in
//       try/catch.
//     * So `ensureCuratedServers()` — and therefore this catalogue — IS reached
//       in production, on every agent start.
//     * That remains SAFE because registration is metadata-only: it calls
//       `MCP.register()`, which stores `{command,args,env}` with `child: null`
//       and `status: "registered"`. It spawns nothing and touches no network.
//     * `MCP.connect()` and `MCP.callTool()` are still the only paths that spawn
//       or execute, and they still have NO production caller.
//
//   So: catalogue registered on every agent start, nothing ever spawned. Pinned
//   by shell/tests/mcp-production-wiring.test.js; see mcp/startup.js for the
//   full reachability statement.

/**
 * Curated MCP servers available out of the box.
 *
 * @typedef {object} CuratedServer
 * @property {string} id           Stable identifier used as the MCP server name.
 * @property {string} command       Executable (typically `npx`).
 * @property {string[]} args        Argument vector passed to spawn().
 * @property {string} description   Human-readable description (safe to surface).
 * @property {string[]} tools       Tool names the server is expected to expose.
 * @property {string} [env]         Optional environment overrides.
 */

/** @type {CuratedServer[]} */
export const CURATED_SERVERS = [
  {
    id: "filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "--root", "."],
    description: "Read/write local files within the project root",
    tools: ["read_file", "write_file", "list_directory", "search_files"],
  },
  {
    id: "fetch",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
    description: "HTTP fetch with rate limiting and content extraction",
    tools: ["fetch"],
  },
];

/**
 * Look up a curated server entry by id. Returns `null` if unknown.
 * The returned object is a shallow copy so callers cannot mutate the
 * canonical list.
 *
 * @param {string} id
 * @returns {CuratedServer | null}
 */
export function getCuratedServer(id) {
  if (typeof id !== "string" || !id) return null;
  const found = CURATED_SERVERS.find((s) => s.id === id);
  if (!found) return null;
  return {
    id: found.id,
    command: found.command,
    args: [...found.args],
    description: found.description,
    tools: [...found.tools],
    env: found.env ? { ...found.env } : undefined,
  };
}

/**
 * Return the curated list as renderer-safe metadata. Each entry is a
 * shallow clone; `command` and `args` are kept (they are not secrets —
 * the renderer wants to display the spawn plan) but anything else that
 * could leak process info is excluded.
 */
export function listCuratedSafe() {
  return CURATED_SERVERS.map((s) => ({
    id: s.id,
    command: s.command,
    args: [...s.args],
    description: s.description,
    tools: [...s.tools],
  }));
}