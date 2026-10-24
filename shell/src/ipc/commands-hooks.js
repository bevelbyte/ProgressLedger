import { safeHandle } from "../security/safe-handle.js";
// Commands + Hooks â€” IPC surface for the extension layer.
//
// Channels:
//   commands:list  â†’ [{ id, name, description, args }]
//   commands:run   â†’ run a single "/cmd arg1 arg2" command line
//   hooks:list     â†’ [{ eventName, hooks: [{ id }] }]
//
// The dispatchers route through the existing tool layer
// (project:invoke-tool) so the same approval flow + project-root
// pinning + validation applies. /commit and /fix therefore do NOT
// bypass approval; if exec_run needs a token, the IPC layer hands
// the renderer the { requiresApproval } envelope and the UI prompts.
//
// Commands and Hooks are shell-side services (no Rust surface). The
// renderer only ever sees structured envelopes.

import { ipcMain } from "electron";
import { Commands } from "../services/commands/index.js";
import { Hooks, HOOK_EVENTS } from "../services/hooks/index.js";
import {
  PROJECT_TOOLS,
} from "../services/project-tools/index.js";
import { runTool } from "../services/project-tools/_runtime.js";
import {
  APPROVAL_REQUIRED,
  consumeApprovalToken,
  validateToolInvocation,
} from "../services/project-tools/security.js";
import { getActiveProjectRootFor } from "./agent-root-registry.js";
import { authorizeCommandScope } from "../security/project-mode-auth.js";
import { cancelAgent as loopCancelAgent, getRun as loopGetRun } from "../services/agent/loop.js";
import { listAgentMessages, getProjectAgent } from "./project-mode.js";

let ctx = null; // captured for tool dispatch â€” set in register()

/**
 * Run a tool. Mirrors the dispatch path in ipc/project-tools.js but
 * kept local so the command dispatcher never has to know about the
 * IPC channel shape. Approval is required for the gated tools; we
 * do not auto-mint tokens.
 */
async function dispatchTool(toolName, input, options) {
  const t = PROJECT_TOOLS[toolName];
  if (!t) return { ok: false, error: { code: "tool-not-supported", message: `unknown tool: ${toolName}` } };
  const v = validateToolInvocation(toolName, input || {}, { getTool: (n) => PROJECT_TOOLS[n] });
  if (!v.ok) return v;
  const profileId = options && typeof options.profileId === "number" ? options.profileId : undefined;
  const projectId = options && typeof options.projectId === "number" ? options.projectId : undefined;
  const agentId = options && typeof options.agentId === "number" ? options.agentId : undefined;
  const scope = await authorizeCommandScope(ctx.core, profileId, projectId, agentId);
  if (!scope.ok) return scope;
  if (APPROVAL_REQUIRED.has(toolName)) {
    const token = options && typeof options.approvalToken === "string" ? options.approvalToken : null;
    if (!token || !consumeApprovalToken(token, toolName, input || {}, { profileId, projectId, agentId })) {
      return { ok: false, requiresApproval: { tool: toolName, input: input || {}, permission: t.permission } };
    }
  }
  const projectRoot = (typeof profileId === "number" && typeof agentId === "number") ? getActiveProjectRootFor(profileId, agentId) : null;
  return runTool(t, input || {}, { projectRoot, profileId, projectId, agentId });
}

/**
 * Register the commands + hooks IPC channels.
 *
 * ctx = { core, win, notify, app }
 */
export function register(registerCtx) {
  ctx = registerCtx;

  // Wire the command dispatcher to the existing project-tool surface.
  // The project-mode IPC exports pmListMessages / pmGetAgent; we route
  // through callPm() (already imported above) so the dispatcher never
  // has to know about the IPC channel shape.
  Commands.configureCommands({
    invokeTool: (toolName, input, opts) => dispatchTool(toolName, input, opts),
    cancelAgent: async (agentId) => loopCancelAgent(agentId),
    listMessages: async (profileId, agentId) => listAgentMessages(profileId, agentId),
    getAgent: async (profileId, agentId) => getProjectAgent(profileId, agentId),
    getRun: (agentId) => loopGetRun(agentId),
  });

  // ---- commands ----------------------------------------------------------

  safeHandle("commands:list", () => {
    return { ok: true, commands: Commands.list() };
  });

  safeHandle("commands:run", async (_e, payload) => {
    const profileId = payload && typeof payload.profileId === "number" ? payload.profileId : null;
    const projectId = payload && typeof payload.projectId === "number" ? payload.projectId : null;
    const commandLine = payload && typeof payload.commandLine === "string" ? payload.commandLine : "";
    const cmdCtx = {
      agentId: payload && typeof payload.agentId === "number" ? payload.agentId : null,
      approvalToken: payload && typeof payload.approvalToken === "string" ? payload.approvalToken : null,
    };
    if (profileId == null) return { ok: false, reason: "invalid-profile" };
    if (!commandLine) return { ok: false, reason: "invalid-command-line" };
    const scope = await authorizeCommandScope(ctx.core, profileId, projectId, cmdCtx.agentId);
    if (!scope.ok) return scope;
    const result = await Commands.run(profileId, projectId, commandLine, cmdCtx);
    return result;
  });

  // ---- hooks -------------------------------------------------------------

  safeHandle("hooks:list", () => {
    return { ok: true, events: Hooks.list(), known: [...HOOK_EVENTS] };
  });

  safeHandle("hooks:list-executions", (_e, filters) => {
    // `emitter` is the derived dormant-state report. The renderer needs it so it
    // can distinguish "no hook has run yet" from "no hook has EVER been emitted
    // because nothing calls Hooks.emit()". Returning an empty executions array
    // alone makes the second case indistinguishable from the first, which is how
    // dormant infrastructure ends up looking like working functionality.
    // See Hooks.emitterStatus() in shell/src/services/hooks/index.js.
    return {
      ok: true,
      executions: Hooks.listExecutions(filters || {}),
      emitter: Hooks.emitterStatus(),
    };
  });
}
