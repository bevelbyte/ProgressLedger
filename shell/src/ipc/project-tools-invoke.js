// Electron-free orchestration for the `project:invoke-tool` channel.
//
// This module exists so the authorization / approval / execution ORDER can be
// exercised by a plain `node --test` runner. `ipc/project-tools.js` is the
// Electron-bound surface; it registers the channel and delegates here.
//
// Security ordering (SF-4) is the whole point of this module:
//
//     1. tool lookup          — cheap, no state
//     2. input validation     — cheap, no state
//     3. AUTHORIZATION        — may reject, must not consume anything
//     4. approval consumption — single-use; only after (3) passed
//     5. execution
//
// An approval token is single-use. If step 4 ran before step 3, an unauthorized
// caller could burn a legitimate user's valid token and force a re-approval
// prompt. Execution was already blocked in that case, so it was never an
// execution bypass — but authorize-then-consume is the correct invariant and
// matches the dispatchTool path in `ipc/commands-hooks.js`.
//
// This module imports no Electron API. It is pure orchestration over injected
// dependencies so the ordering is directly testable.

import { PROJECT_TOOLS, getTool as registryGetTool } from "../services/project-tools/index.js";
import { runTool } from "../services/project-tools/_runtime.js";
import {
  APPROVAL_REQUIRED,
  PERMISSION_INFO,
  consumeApprovalToken,
  requiresToolApproval,
  validateToolInvocation,
} from "../services/project-tools/security.js";
import { getActiveProjectRootFor } from "./agent-root-registry.js";
import { authorizeProjectToolScope } from "../security/project-mode-auth.js";

function getTool(name) {
  return registryGetTool(name);
}

function idOf(value) {
  return typeof value === "number" ? value : undefined;
}

/**
 * Build the `project:invoke-tool` handler.
 *
 * @param {object} deps
 * @param {object} deps.core            authoritative NAPI core (ownership rows)
 * @param {Map<string, {cancelled:boolean}>} [deps.cancellable] runId -> record
 * @param {(profileId:number, agentId:number) => string|null} [deps.resolveProjectRoot]
 * @param {(tool:any, input:object, ctx:object) => Promise<any>} [deps.exec]
 * @returns {(payload:object) => Promise<any>}
 */
export function createInvokeToolHandler({
  core,
  cancellable = new Map(),
  resolveProjectRoot = getActiveProjectRootFor,
  exec = runTool,
} = {}) {
  return async function invokeProjectTool(payload) {
    const toolName = payload && typeof payload.toolName === "string" ? payload.toolName : "";
    const input = payload && typeof payload.input === "object" && payload.input !== null ? payload.input : {};
    const approvalToken = payload && typeof payload.approvalToken === "string" ? payload.approvalToken : null;
    const runId = payload && typeof payload.runId === "string" ? payload.runId : null;
    const profileId = idOf(payload && payload.profileId);
    const projectId = idOf(payload && payload.projectId);
    const agentId = idOf(payload && payload.agentId);

    // 1) tool lookup.
    const t = getTool(toolName);
    if (!t) {
      return { ok: false, error: { code: "tool-not-supported", message: `unknown tool: ${toolName}` } };
    }

    // 2) input validation — cheap and always runs.
    const v = validateToolInvocation(toolName, input, { getTool });
    if (!v.ok) return v;

    // 3) AUTHORIZATION — before any approval token is consumed.
    const scope = await authorizeProjectToolScope(core, profileId, projectId, agentId);
    if (!scope.ok) return scope;

    // 4) approval gate (single-use consumption).
    if (requiresToolApproval(toolName, t)) {
      if (!approvalToken || !consumeApprovalToken(approvalToken, toolName, input, { profileId, projectId, agentId })) {
        return {
          ok: false,
          requiresApproval: {
            tool: toolName,
            input,
            permission: t.permission,
            permissionInfo: PERMISSION_INFO[t.permission] || null,
          },
        };
      }
    }

    // 5) execution.
    //
    // Resolve the per-agent project root. The renderer cannot pick a root;
    // only an agent loop can. If a renderer-initiated call arrives without a
    // (profile, agent), the project root is null and tools will refuse with
    // `project-root-not-set`.
    const projectRoot = (typeof profileId === "number" && typeof agentId === "number")
      ? resolveProjectRoot(profileId, agentId)
      : null;

    const ctxForRun = {
      projectRoot,
      // Optional reservation scoping for write-class tools. Manual
      // (non-agent) calls may not have these; tools like fs_write refuse
      // with `invalid-input` when any of them is missing.
      profileId,
      projectId,
      agentId,
      isCancellable: () => {
        if (!runId) return false;
        const rec = cancellable.get(runId);
        return !!(rec && rec.cancelled);
      },
    };

    if (runId) cancellable.set(runId, { cancelled: false });
    try {
      return await exec(t, input, ctxForRun);
    } finally {
      if (runId) cancellable.delete(runId);
    }
  };
}

export { PROJECT_TOOLS, APPROVAL_REQUIRED, getTool };
