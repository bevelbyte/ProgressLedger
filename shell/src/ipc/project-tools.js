import { safeHandle } from "../security/safe-handle.js";
// Project Mode â€” IPC surface for the tool registry.
//
// Channels:
//   project:list-tools           â†’ safe metadata for every tool
//   project:approve-tool        â†’ mints a short-lived approval token for
//                                 a (toolName, input) pair. The renderer
//                                 then calls project:invoke-tool with
//                                 the returned token.
//   project:invoke-tool         â†’ runs a tool. If approval is required
//                                 and no token is supplied, returns
//                                 { ok: false, requiresApproval: {...} }.
//
// All privileged operations (filesystem, child_process) stay here in the
// main process. The renderer only sees the safe metadata + structured
// results.

import { ipcMain } from "electron";
import {
  PROJECT_TOOLS,
  getTool as registryGetTool,
  listToolsSafe,
  safeMetadata,
} from "../services/project-tools/index.js";
import {
  APPROVAL_REQUIRED,
  PERMISSION_INFO,
  mintApprovalToken,
  requiresToolApproval,
  validateToolInvocation,
} from "../services/project-tools/security.js";
import {
  setActiveProjectRootFor,
  getActiveProjectRootFor,
  clearActiveProjectRootFor,
} from "./agent-root-registry.js";
import { createInvokeToolHandler } from "./project-tools-invoke.js";

// Re-export the per-agent root helpers so callers can import them from
// either the registry module or the IPC module. The registry is the
// authoritative source; this file is the Electron-bound surface.
export {
  setActiveProjectRootFor,
  getActiveProjectRootFor,
  clearActiveProjectRootFor,
  _resetActiveProjectRoots,
} from "./agent-root-registry.js";

// Tool runs can be cancelled cooperatively. The IPC layer hands each
// run a controller, and the agent can mark it cancelled by tool name.
const cancellable = new Map(); // runId -> { cancelled: true }

/**
 * Register the project-tools IPC channels.
 *
 * ctx = { core, win, notify }
 *
 * The agent loop calls `setActiveProjectRootFor` / `clearActiveProjectRootFor`
 * from the main process around each run. The renderer never sees the
 * setters â€” there's no IPC for them.
 */
export function register(ctx) {
  // Expose the per-agent root registry so the agent loop can call the
  // setters. The IPC layer does NOT accept a projectRoot from the renderer
  // at any point â€” the renderer cannot pick a tool's project root.
  ctx.projectTools = {
    setActiveProjectRootFor,
    getActiveProjectRootFor,
    clearActiveProjectRootFor,
    cancelRun(runId) {
      const rec = cancellable.get(runId);
      if (rec) rec.cancelled = true;
    },
  };

  safeHandle("project:list-tools", () => {
    return {
      ok: true,
      tools: listToolsSafe(),
      approvalRequired: [...APPROVAL_REQUIRED],
      permissionInfo: PERMISSION_INFO,
    };
  });

  // Mint an approval token. The renderer calls this when the user
  // clicks "Approve" in the dialog. We do not log the input.
  safeHandle("project:approve-tool", (_e, payload) => {
    const toolName = payload && typeof payload.toolName === "string" ? payload.toolName : "";
    const input = payload && typeof payload.input === "object" && payload.input !== null ? payload.input : {};
    const profileId = typeof payload?.profileId === "number" ? payload.profileId : undefined;
    const projectId = typeof payload?.projectId === "number" ? payload.projectId : undefined;
    const agentId = typeof payload?.agentId === "number" ? payload.agentId : undefined;
    const t = getTool(toolName);
    if (!t) return { ok: false, error: { code: "tool-not-supported", message: "unknown tool" } };
    if (!requiresToolApproval(toolName, t)) {
      // No approval needed; we still hand out a token so the renderer's
      // code path is symmetric. The invoke handler will accept the
      // token without binding it to any specific input.
      const token = mintApprovalToken(toolName, input, { profileId, projectId, agentId });
      return { ok: true, token, ttlMs: 60_000, needed: false };
    }
    const v = validateToolInvocation(toolName, input, { getTool });
    if (!v.ok) return v;
    if (![profileId, projectId, agentId].every(Number.isInteger)) {
      return { ok: false, error: { code: "invalid-ids", message: "profileId, projectId and agentId are required for approved project-tool runs" } };
    }
    const token = mintApprovalToken(toolName, input, { profileId, projectId, agentId });
    return { ok: true, token, ttlMs: 60_000, needed: true };
  });

  // Run a tool. Approval is checked here, NOT in the tool itself.
  //
  // The ordering (authorize -> consume approval -> execute) lives in the
  // Electron-free `project-tools-invoke.js` so it can be tested directly by a
  // plain `node --test` runner. See SF-4 there.
  const invokeTool = createInvokeToolHandler({ core: ctx.core, cancellable });
  safeHandle("project:invoke-tool", async (_e, payload) => invokeTool(payload));
}


function getTool(name) {
  return registryGetTool(name);
}

// Helper for the agent: list metadata for one tool (main-process only).
export function _getToolMetadata(name) {
  return safeMetadata(PROJECT_TOOLS[name] || null);
}
