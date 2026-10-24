// Project Mode — tool registry.
//
// Exposes the 16 initial tools + lookup helpers consumed by the IPC
// layer. The renderer can list the safe metadata (name, description,
// permission, inputSchema) but never the execute functions — those
// stay in the main process.
//
// In addition to the static `PROJECT_TOOLS` map, the registry supports
// dynamic registration via `register()` / `unregister()` so that
// shell-side subsystems (e.g. the MCP connection manager) can bridge
// tools that only exist at runtime. The renderer's `listToolsSafe()`
// sees both static and dynamic tools, but NEVER the execute functions
// or the metadata that would let the renderer reach the underlying
// server (no port, no host, no token, no process info).

import { tool as fsList } from "./fs_list.js";
import { tool as fsRead } from "./fs_read.js";
import { tool as fsSearch } from "./fs_search.js";
import { tool as fsWrite } from "./fs_write.js";
import { tool as shellGitStatus } from "./shell_git_status.js";
import { tool as shellGitDiff } from "./shell_git_diff.js";
import { tool as shellGitLog } from "./shell_git_log.js";
import { tool as execRun } from "./exec_run.js";
import { tool as testRun } from "./test_run.js";
import { tool as buildRun } from "./build_run.js";
import { tool as inspectProject } from "./inspect_project.js";
import { tool as delegateResearch } from "./delegate_research.js";
import { tool as delegateCoder } from "./delegate_coder.js";
import { tool as delegateTester } from "./delegate_tester.js";
import { tool as delegateReviewer } from "./delegate_reviewer.js";
import { tool as memoryRecall } from "./memory_recall.js";

export const PROJECT_TOOLS = Object.freeze({
  fs_list: fsList,
  fs_read: fsRead,
  fs_search: fsSearch,
  fs_write: fsWrite,
  shell_git_status: shellGitStatus,
  shell_git_diff: shellGitDiff,
  shell_git_log: shellGitLog,
  exec_run: execRun,
  test_run: testRun,
  build_run: buildRun,
  inspect_project: inspectProject,
  // Sub-agent delegation tools. NETWORK permission; not approval-required
  // (see security.js). The 4 tools share a single executor in
  // delegate_research.js; each wrapper file just sets its role.
  delegate_research: delegateResearch,
  delegate_coder: delegateCoder,
  delegate_tester: delegateTester,
  delegate_reviewer: delegateReviewer,
  // Project Mode memory layer: read-side retrieval of prior memory.
  memory_recall: memoryRecall,
});

// Dynamic tools registered at runtime (e.g. tools bridged from MCP
// servers). The static `PROJECT_TOOLS` map is frozen; this mutable map
// is the only path through which new tools can enter the registry.
// Reset by `_resetForTests()` between test runs.
const dynamicTools = new Map();

/**
 * Register a tool at runtime. The tool must satisfy the same shape as
 * a static tool: { name, description, permission, inputSchema, async
 * execute } where `execute` returns the standard
 * `{ ok, result }` envelope. Idempotent: re-registering the same name
 * overwrites the prior entry. Returns `{ ok: true }` on success or
 * `{ ok: false, error: { code, message } }` on validation failure.
 *
 * The renderer NEVER sees the execute function. It only sees the safe
 * metadata via `listToolsSafe()`.
 */
export function register(tool) {
  if (!tool || typeof tool !== "object") return { ok: false, error: { code: "invalid-input", message: "tool required" } };
  if (typeof tool.name !== "string" || !tool.name) return { ok: false, error: { code: "invalid-input", message: "tool.name required" } };
  if (typeof tool.description !== "string") return { ok: false, error: { code: "invalid-input", message: "tool.description required" } };
  if (typeof tool.permission !== "string") return { ok: false, error: { code: "invalid-input", message: "tool.permission required" } };
  if (!tool.inputSchema || typeof tool.inputSchema !== "object") return { ok: false, error: { code: "invalid-input", message: "tool.inputSchema required" } };
  if (typeof tool.execute !== "function") return { ok: false, error: { code: "invalid-input", message: "tool.execute must be a function" } };
  dynamicTools.set(tool.name, tool);
  return { ok: true };
}

/**
 * Unregister a dynamically added tool by name. Idempotent: returns
 * `{ ok: true }` even if the name was not registered. Static tools
 * cannot be removed by this function.
 */
export function unregister(name) {
  if (typeof name !== "string" || !name) return { ok: false, error: { code: "invalid-input", message: "name required" } };
  if (!dynamicTools.has(name)) return { ok: true };
  dynamicTools.delete(name);
  return { ok: true };
}

/**
 * Resolve a tool by name. Static tools win over dynamic ones if the
 * same name is registered in both (defensive: the static registry is
 * the source of truth for the 16 built-ins). Returns the tool object
 * (with execute) for main-process callers, or null for unknown names.
 */
export function getTool(name) {
  if (typeof name !== "string" || !name) return null;
  if (Object.prototype.hasOwnProperty.call(PROJECT_TOOLS, name)) return PROJECT_TOOLS[name];
  if (dynamicTools.has(name)) return dynamicTools.get(name);
  return null;
}

/**
 * List every registered tool as a plain array — static + dynamic.
 */
export function listTools() {
  return [...Object.values(PROJECT_TOOLS), ...dynamicTools.values()];
}

/**
 * Renderer-safe metadata for a single tool. No execute function, no
 * output schema detail. This is what `project:list-tools` returns.
 */
export function safeMetadata(tool) {
  if (!tool || typeof tool !== "object") return null;
  return {
    name: tool.name,
    description: tool.description,
    permission: tool.permission,
    inputSchema: tool.inputSchema,
  };
}

/**
 * List of every tool's safe metadata (static + dynamic). The renderer
 * sees only this shape; it cannot reach the execute function or any
 * server-side metadata (no port / host / token / process info).
 */
export function listToolsSafe() {
  return listTools().map(safeMetadata).filter(Boolean);
}

/**
 * Test-only: clear all dynamically registered tools. The static
 * `PROJECT_TOOLS` map is unaffected.
 */
export function _resetForTests() {
  dynamicTools.clear();
}