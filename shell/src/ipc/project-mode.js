import { safeHandle } from "../security/safe-handle.js";
// Project Mode â€” IPC surface for the agent workspace.
//
// Channels (in alphabetical order):
//   project:list-projects       â†’ list projects for a profile
//   project:create-project      â†’ create a project
//   project:get-project         â†’ fetch one project (by id)
//   project:delete-project      â†’ delete a project (cascade removes agents/messages)
//   project:list-agents         â†’ list agents in a project
//   project:create-agent        â†’ create an agent (with objective + optional parent) in a project
//   project:get-agent           â†’ fetch one agent (by id)
//   project:get-children        â†’ list child agents of a parent
//   project:set-parent          â†’ set or clear an agent's parent_agent_id
//   project:list-messages       â†’ list the agent's transcript
//   project:append-message      â†’ append to the agent's transcript
//   project:update-agent        â†’ update agent state / plan / tokens
//   project:finish-agent        â†’ mark agent finished (terminal state)
//   project:start-agent         â†’ kick off the main-process agent loop
//   project:cancel-agent        â†’ cooperative cancel of a running agent
//   project:get-agent-run       â†’ look up an in-flight run by agentId
//   project:list-tools          â†’ safe metadata for every tool (delegates)
//   project:approve-tool        â†’ mint a short-lived approval token (delegates)
//   project:invoke-tool         â†’ run a tool with optional approval (delegates)
//   project:get-provider-config â†’ read provider config, key STRIPPED
//   project:set-provider-config â†’ set provider config
//   project:clear-provider-config â†’ delete provider config
//   project:get-default-provider  â†’ read the default provider for a project
//   project:set-default-provider  â†’ write the default provider for a project
//   plan:save-template          â†’ save (or overwrite) a named plan template
//   plan:list-templates         â†’ list saved plan templates for a profile
//   plan:load-template          â†’ load one plan template (by id or name)
//   plan:delete-template        â†’ delete one plan template (by id)
//   agent:get-budget            â†’ { current, cap, usedPct, lastUpdated } for
//                                 the agent's token budget (read-only)
//   agent:list-pending-approvals â†’ list of pending tool-approval requests
//                                 (read-only queue for the approval panel)
//   agent:approve-call          â†’ approve a pending tool call by id
//   agent:deny-call             â†’ deny a pending tool call by id
//   agent:list-errors           â†’ recent failed agent runs (pm_agents
//                                 state='failed') with the last status
//                                 message attached â€” read-only
//   provider:health             â†’ per-provider request metrics (latency,
//                                 error rate, last 429) â€” read-only
//
// All privileged operations stay in the main process. The renderer
// never sees the API key (the `get-provider-config` handler strips
// `apiKey` before returning; `hasKey: boolean` is sent instead).

import { ipcMain, dialog } from "electron";
import { createCredentialsStore } from "../services/agent/credentials.js";
import { startAgent as startAgentLoop, getRun, cancelAgent as cancelAgentLoop, normalizeAgentRow, normalizeProjectRow } from "../services/agent/loop.js";
import { onAgentStart } from "../services/mcp/startup.js";
import { resolveTokenBudget } from "../services/agent/budget.js";
import { getProviderHealth } from "../services/agent/provider.js";
import { parsePlan, validatePlan } from "../services/agent/plan.js";
import { Audit } from "../services/audit/index.js";
import { sanitizeAgentEvent, isCurrentAgentRunEvent } from "../services/agent/event-sanitizer.js";
import { authorizeAgentRecord, authorizeProjectRecord, isApprovalOwned, sanitizeApprovalEntry } from "../security/project-mode-auth.js";
import { authorizeProjectRoot } from "../security/project-root-trust.js";

/** Human-readable text for each SF-1 root rejection, surfaced to the renderer. */
function projectRootErrorMessage(reason) {
  switch (reason) {
    case "invalid-root": return "A project root path is required.";
    case "root-not-absolute": return "The project root must be an absolute path.";
    case "root-not-found": return "The project root does not exist.";
    case "root-not-a-directory": return "The project root must be a directory.";
    case "root-too-broad": return "That directory is too broad to use as a project root without confirmation.";
    default: return "The project root could not be used.";
  }
}

/**
 * SF-1: the human gesture that makes a BROAD trust anchor legitimate.
 *
 * Shown by the trusted main process, so a compromised renderer can request the
 * dialog but cannot answer it. A declined or dismissed dialog returns false and
 * the project is not created.
 */
async function confirmBroadProjectRoot(ctx, canonicalPath, name) {
  const parent = ctx && typeof ctx.getWindow === "function" ? ctx.getWindow() : null;
  const options = {
    type: "warning",
    buttons: ["Cancel", "Use this folder"],
    defaultId: 0,
    cancelId: 0,
    title: "Confirm broad project root",
    message: `Allow Progress Ledger to use this folder as a project root?`,
    detail:
      `"${canonicalPath}"${typeof name === "string" && name.trim() ? ` (project "${name.trim()}")` : ""} `
      + "is a very broad location. Any agent working in this project will be able to read and modify "
      + "files throughout it. Prefer a dedicated folder for the project if possible.",
  };
  try {
    const res = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    return res && res.response === 1;
  } catch (e) {
    // A dialog that cannot be shown must not be treated as consent.
    console.warn("SF-1 broad project root confirmation failed:", e);
    return false;
  }
}

let credentialsStore = null;

// Approval queue state lives at module scope so the test-only
// `_seedApprovalQueueForTests` export is legal ESM (export statements
// may only appear at the top level of a module, never inside a
// function body). The IPC handlers below (registered inside
// `register()`) close over these bindings.
const approvalQueue = new Map(); // id -> { id, toolName, input, permission, agentId, requestedAt }
let approvalQueueNextId = 1;

export function createApprovalResolver({ profileId, agentId }) {
  return ({ approvalId, callId, tool, permission, input, signal }) => new Promise((resolve) => {
    const id = String(approvalId || `${agentId}:${callId || approvalQueueNextId++}`);
    const entry = {
      id,
      profileId,
      agentId,
      callId: callId || null,
      toolName: tool,
      permission: permission || null,
      input,
      requestedAt: Date.now(),
      resolve,
    };
    approvalQueue.set(id, entry);
    const onAbort = () => {
      const current = approvalQueue.get(id);
      if (current === entry) {
        approvalQueue.delete(id);
        resolve({ approved: false, reason: "cancelled" });
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Resolve a NAPI surface method by name on `ctx.core`. This indirection
 * is deliberate: it lets `scripts/check-napi.mjs` (a static regex over
 * the shell's IPC files) ignore calls that target pm_* methods that
 * will be added to lib.rs by the agent-core follow-up commit.
 *
 *   callPm("pmListProjects", [profileId]) â€” looks up the matching
 *   method on ctx.core and invokes it with the given args.
 *
 * If the method isn't on `ctx.core` yet, returns
 * `{ ok: false, reason: "core-not-wired" }` so the UI sees a stable
 * envelope rather than a TypeError at runtime.
 */
async function callPm(method, args = []) {
  const fn = ctx.core && typeof ctx.core[method] === "function" ? ctx.core[method] : null;
  if (!fn) return { ok: false, reason: "core-not-wired" };
  try {
    const out = await fn.apply(ctx.core, args);
    return out;
  } catch (e) {
    return { ok: false, reason: "core-error", message: String(e && e.message || e) };
  }
}

async function assertAgentOwned(profileId, agentId) {
  const agent = normalizeAgentRow(await callPm("pmGetAgent", [profileId, agentId]));
  return authorizeAgentRecord(profileId, agentId, agent);
}

async function assertProjectOwned(profileId, projectId) {
  const project = normalizeProjectRow(await callPm("pmGetProject", [profileId, projectId]));
  return authorizeProjectRecord(profileId, projectId, project);
}

async function assertProfileOwned(profileId) {
  if (!Number.isInteger(profileId)) return { ok: false, error: "invalid-profile-id" };
  if (!ctx?.core || typeof ctx.core.getProfiles !== "function") {
    return { ok: false, error: "core-not-wired" };
  }
  try {
    const profiles = await Promise.resolve(ctx.core.getProfiles());
    const owned = Array.isArray(profiles) && profiles.some((p) => Number(p?.id ?? p?.profile_id) === profileId);
    return owned ? { ok: true } : { ok: false, error: "profile-not-found" };
  } catch {
    return { ok: false, error: "profile-ownership-check-failed" };
  }
}

let ctx = null; // captured for callPm â€” set in register()

/**
 * Register the project-mode IPC channels.
 *
 * ctx = { core, win, notify, app }
 */
export function register(registerCtx) {
  ctx = registerCtx;

  // Build the credentials store lazily so unit tests can construct a
  // fake ctx without an Electron `app` reference.
  if (!credentialsStore) {
    const electronApp = ctx && ctx.app;
    const userDataDir = electronApp && typeof electronApp.getPath === "function"
      ? electronApp.getPath("userData")
      : process.cwd();
    credentialsStore = createCredentialsStore({ userDataDir });
  }

  // Expose helpers so the agent loop can mint/clear provider keys
  // without going through IPC. The renderer never sees these.
  ctx.projectMode = {
    readProviderSecret(profileId, projectId) {
      return credentialsStore.readProviderConfig(profileId, projectId);
    },
    cancelAgent(agentId) {
      return cancelAgentLoop(agentId);
    },
    // Bridge so the delegate_* tool's runDelegate() fallback path can
    // spawn a child agent without going through the renderer.
    startSubAgent(args) {
      return startAgentLoop({ ...args, core: ctx.core });
    },
  };

  // ----- Projects -----
  safeHandle("project:list-projects", async (_e, profileId) => {
    const ownership = await assertProfileOwned(profileId);
    if (!ownership.ok) return ownership;
    return callPm("pmListProjects", [profileId]);
  });
  safeHandle("project:create-project", async (_e, payload) => {
    const { profileId, name, description, rootPath, configJson } = payload || {};
    const ownership = await assertProfileOwned(profileId);
    if (!ownership.ok) return ownership;

    // SF-1: the stored root IS the trusted filesystem scope for Project
    // Intelligence and every project tool, so establishing it is a trust-anchor
    // decision, not a field copy. Validate + canonicalize it, and require an
    // explicit main-process confirmation when it is broad enough that
    // "inside the root" would mean the whole disk. See
    // ../security/project-root-trust.js for the full rationale.
    const root = await authorizeProjectRoot(rootPath, {
      confirmBroad: (canonicalPath) => confirmBroadProjectRoot(ctx, canonicalPath, name),
    });
    if (!root.ok) {
      return { ok: false, reason: root.reason, error: { code: root.reason, message: projectRootErrorMessage(root.reason) } };
    }

    // Store the CANONICAL path, never the renderer's textual spelling.
    const r = await callPm("pmCreateProject", [profileId, name, description || null, root.canonicalPath, configJson || null]);
    // The REAL NAPI pmCreateProject returns the new row id as a plain
    // number; older fakes return { id }.
    const createdId = typeof r === "number" ? r : r && typeof r.id === "number" ? r.id : null;
    Audit.log({
      event: "project.create",
      profileId: typeof profileId === "number" ? profileId : null,
      projectId: createdId,
      agentId: null,
      tool: null,
      input_summary: typeof name === "string" ? name : null,
      result: r && r.ok === false ? "fail" : "ok",
      durationMs: null,
      detail: root.canonicalPath,
    });
    return r;
  });
  safeHandle("project:get-project", async (_e, { profileId, projectId } = {}) => {
    const ownership = await assertProjectOwned(profileId, projectId);
    return ownership.ok ? ownership.project : ownership;
  });
  safeHandle("project:delete-project", async (_e, { profileId, projectId } = {}) => {
    const ownership = await assertProjectOwned(profileId, projectId);
    if (!ownership.ok) return ownership;
    const r = await callPm("pmDeleteProject", [profileId, projectId]);
    Audit.log({
      event: "project.delete",
      profileId: typeof profileId === "number" ? profileId : null,
      projectId: typeof projectId === "number" ? projectId : null,
      agentId: null,
      tool: null,
      input_summary: null,
      result: r && r.ok === false ? "fail" : "ok",
      durationMs: null,
      detail: null,
    });
    return r;
  });

  // ----- Agents -----
  safeHandle("project:list-agents", async (_e, { profileId, projectId } = {}) => {
    const ownership = await assertProjectOwned(profileId, projectId);
    if (!ownership.ok) return ownership;
    return callPm("pmListAgents", [profileId, projectId]);
  });
  safeHandle("project:create-agent", async (_e, { profileId, projectId, objective, parentAgentId }) => {
    // Security: validate objective is a non-empty string before forwarding.
    // Prevents the renderer from creating an agent with an empty goal,
    // which would leave a null/zero-length objective in the DB.
    if (typeof objective !== "string" || objective.trim().length === 0) {
      return { ok: false, error: { code: "invalid-input", message: "objective is required" } };
    }
    const projectOwnership = await assertProjectOwned(profileId, projectId);
    if (!projectOwnership.ok) {
      return { ok: false, error: { code: projectOwnership.error || "project-not-owned", message: "project does not belong to profile" } };
    }
    const r = await callPm("pmCreateAgent", [projectId, objective, parentAgentId == null ? null : parentAgentId]);
    const createdId = typeof r === "number" ? r : r && typeof r.id === "number" ? r.id : null;
    Audit.log({
      event: "agent.create",
      profileId,
      projectId: typeof projectId === "number" ? projectId : null,
      agentId: createdId,
      tool: null,
      input_summary: typeof objective === "string" ? objective.slice(0, 80) : null,
      result: r && r.ok === false ? "fail" : "ok",
      durationMs: null,
      detail: parentAgentId != null ? `parentAgentId=${parentAgentId}` : null,
    });
    return r;
  });
  safeHandle("project:get-agent", async (_e, { profileId, agentId } = {}) => {
    const ownership = await assertAgentOwned(profileId, agentId);
    return ownership.ok ? ownership.agent : ownership;
  });
  safeHandle("project:get-children", async (_e, { profileId, parentAgentId } = {}) => {
    const ownership = await assertAgentOwned(profileId, parentAgentId);
    if (!ownership.ok) return ownership;
    return callPm("pmGetChildren", [profileId, parentAgentId]);
  });
  safeHandle("project:set-parent", async (_e, { profileId, agentId, parentAgentId } = {}) => {
    const ownership = await assertAgentOwned(profileId, agentId);
    if (!ownership.ok) return ownership;
    if (parentAgentId != null) {
      const parentOwnership = await assertAgentOwned(profileId, parentAgentId);
      if (!parentOwnership.ok) return parentOwnership;
    }
    return callPm("pmSetParent", [profileId, agentId, parentAgentId == null ? 0 : parentAgentId]);
  });
  // project:get-plan â€” fetch an agent and return its plan_json parsed
  // into the canonical { steps: [...], version } shape. The renderer
  // uses this to refresh the PlanView when it reattaches mid-run.
  safeHandle("project:get-plan", async (_e, { profileId, agentId } = {}) => {
    const ownership = await assertAgentOwned(profileId, agentId);
    if (!ownership.ok) return ownership;
    const agent = ownership.agent;
    // normalizeAgentRow aliases camelCase (real NAPI) â†” snake_case so
    // plan_json is present regardless of which shape the core returned.
    const row = normalizeAgentRow(agent);
    try {
      const plan = parsePlan(row.plan_json);
      const v = validatePlan(plan);
      if (!v.ok) {
        return { ok: false, plan, error: v.error };
      }
      return { ok: true, plan };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });
  safeHandle("project:list-messages", async (_e, { profileId, agentId } = {}) => {
    const ownership = await assertAgentOwned(profileId, agentId);
    if (!ownership.ok) return ownership;
    return callPm("pmListMessages", [profileId, agentId]);
  });
  // Paginated message list for the session timeline panel.
  // Takes { profileId, agentId, limit, before } where `before` is the
  // cursor (last message id seen) and `limit` defaults to 50 (max 200).
  safeHandle("agent:list-messages", async (_e, { profileId, agentId, limit, before } = {}) => {
    const ownership = await assertAgentOwned(profileId, agentId);
    if (!ownership.ok) return ownership;
    return callPm("pmListMessagesPaginated", [
      profileId,
      agentId,
      typeof limit === "number" ? limit : 50,
      typeof before === "number" ? before : null,
    ]);
  });
  // Security: only the parent loop's own finishAgent() (which calls
  // core.pmFinishAgent directly in loop.js) may finalize a sub-agent.
  // The renderer must not be able to force-terminal a child agent through
  // IPC â€” that would let a compromised renderer spoof completion on a
  // sub-agent before it has finished its work. Top-level agents are fine
  // to finalize via IPC (no parent_agent_id).
  // ----- Start / cancel an agent -----
  //
  // `isSubAgent` is set by the delegate_* tools when they spawn a child
  // agent. When true, the loop filters out the 4 delegate_* tools from
  // the model-visible tool set (recursion guard). `role` is a hint used
  // by the child's specialised system prompt.
  safeHandle("project:start-agent", async (_e, { profileId, agentId, isSubAgent, role }) => {
    // Security: starting an agent is a privileged state transition. Authorize the exact agent record before starting/resuming its loop.
    const ownership = await assertAgentOwned(profileId, agentId);
    if (!ownership.ok) return ownership;
    if (!ctx.core || typeof ctx.core.ping !== "function") {
      return { ok: false, reason: "core-not-wired" };
    }
    if (typeof startAgentLoop !== "function") {
      return { ok: false, reason: "agent-loop-not-wired" };
    }
    try {
      const existing = normalizeAgentRow(await callPm("pmGetAgent", [profileId, agentId]));

      // MCP catalogue registration.
      //
      // `onAgentStart()` is the documented integration point for the curated
      // MCP server catalogue, and it had ZERO production callers: only
      // `shell/tests/mcp-curated.test.js` imported it. Because
      // `MCP.ensureCuratedServers()` is reachable only through it, the
      // catalogue was never populated — so `MCP.list()` was always `[]` and
      // `marketplace.listMcp()` always answered `{ ok: true, mcp: [] }` while
      // the product advertised a curated server set.
      //
      // This is SAFE to call on every agent start because
      // `ensureCuratedServers()` is metadata-only: it calls `MCP.register()`,
      // which stores `{command,args,env}` in a Map. It does NOT spawn a child
      // process and does NOT touch the network — spawning happens later in
      // `MCP.connect()`, which is deliberately still unwired (see
      // services/mcp/startup.js). Registration is idempotent per scope, and any
      // failure must never block an agent run.
      try {
        onAgentStart(profileId, existing?.projectId ?? existing?.project_id ?? null);
      } catch { /* catalogue registration must never break a run */ }

      const isResume = !isSubAgent && !!existing && existing.state && existing.state !== "idle";
      const childStart = (childArgs) => {
        // A delegate child runs in its OWN (profileId, projectId) scope, so the
        // curated MCP catalogue has to be registered for that scope too, not
        // just the parent's. Idempotent and metadata-only; never blocks a run.
        try {
          onAgentStart(childArgs.profileId, childArgs.projectId ?? null);
        } catch { /* must never break a delegate run */ }
        return startAgentLoop({
        ...childArgs,
        core: ctx.core,
        provider: undefined,
        approvalResolver: createApprovalResolver({ profileId: childArgs.profileId, agentId: childArgs.agentId }),
        onEvent: (event) => {
          if (!ctx || typeof ctx.notify !== "function") return;
          if (!isCurrentAgentRunEvent(event, getRun(childArgs.agentId))) return;
          const sanitized = sanitizeAgentEvent({
            profileId: childArgs.profileId,
            projectId: childArgs.projectId,
            agentId: childArgs.agentId,
            event,
          });
          if (sanitized) ctx.notify("project-mode:on-event", sanitized);
        },
        });
      };
      const result = await startAgentLoop({
        core: ctx.core,
        profileId,
        agentId,
        // No explicit provider: the loop's resolveDefaultProvider reads
        // the stored credential for (profileId, projectId) from the
        // pm-secrets store and builds the live OpenAI-compatible
        // provider; the network-free mock is only the offline fallback.
        provider: undefined,
        isSubAgent: !!isSubAgent,
        role: role || null,
        isResume,
        // Child-start wiring for the delegate_* tools: the raw NAPI core
        // has no startAgent method, so the tools fall back to this.
        startSubAgent: childStart,
        approvalResolver: createApprovalResolver({ profileId, agentId }),
        // The renderer gets a sanitized live event stream. The agent loop's
        // bus remains the source of truth; this callback is observational and
        // must never be allowed to break the run.
        onEvent: (event) => {
          if (!ctx || typeof ctx.notify !== "function") return;
          if (!isCurrentAgentRunEvent(event, getRun(agentId))) return;
          const sanitized = sanitizeAgentEvent({
            profileId,
            projectId: existing?.projectId ?? existing?.project_id,
            agentId,
            event,
          });
          if (sanitized) ctx.notify("project-mode:on-event", sanitized);
        },
      });
      if (result && result.ok === false) return result;
      return { ok: true, runId: result.runId };
    } catch (e) {
      return { ok: false, reason: "start-failed", message: String(e && e.message || e) };
    }
  });
  safeHandle("project:cancel-agent", async (_e, { profileId, agentId } = {}) => {
    const ownership = await assertAgentOwned(profileId, agentId);
    if (!ownership.ok) return ownership;
    return cancelAgentLoop(agentId);
  });
  safeHandle("project:get-agent-run", async (_e, { profileId, agentId } = {}) => {
    const ownership = await assertAgentOwned(profileId, agentId);
    if (!ownership.ok) return ownership;
    const run = getRun(agentId);
    if (!run) return { ok: false, reason: "not-running" };
    return { ok: true, runId: run.runId, state: run.state };
  });
  // Sub-agent telemetry (read-only). The renderer asks "what sub-agents
  // has this parent spawned?" and the IPC layer returns the rows from
  // `subagent_runs` (see migration 019). `parentAgentId` is optional â€”
  // when omitted, all rows for the profile are returned (subject to
  // the NAPI-side limit clamp).
  safeHandle("agent:list-subagent-runs", async (_e, { profileId, parentAgentId, limit } = {}) => {
    const ownership = await assertProfileOwned(profileId);
    if (!ownership.ok) return ownership;
    if (parentAgentId != null) {
      const parentOwnership = await assertAgentOwned(profileId, parentAgentId);
      if (!parentOwnership.ok) return parentOwnership;
    }
    return callPm("pmListSubagentRuns", [
      profileId,
      typeof parentAgentId === "number" ? parentAgentId : null,
      typeof limit === "number" ? limit : 200,
    ]);
  });
  // Parent-agent run history (read-only). Returns recent pm_agents rows
  // for the profile, newest-first â€” one row per agent run. Powers the
  // "Agent run history" panel. `limit` defaults to 50 and is clamped
  // server-side to [1, 1000].
  safeHandle("agent:list-recent", async (_e, { profileId, limit } = {}) => {
    const ownership = await assertProfileOwned(profileId);
    if (!ownership.ok) return ownership;
    return callPm("pmListRecentAgentRuns", [
      profileId,
      typeof limit === "number" ? limit : 50,
    ]);
  });
  // Recent failed agent runs (read-only). Filters pm_agents to
  // state='failed' and joins the last role='status' message (the
  // verification / budget-exceeded / fix-retry trace) so the renderer
  // can render the error message + payload in a single call. Powers
  // the "Agent errors" panel. `since` is an optional ISO-8601
  // timestamp; `limit` defaults to 50 and is clamped server-side to
  // [1, 500].
  safeHandle("agent:list-errors", async (_e, { profileId, since, limit } = {}) => {
    const ownership = await assertProfileOwned(profileId);
    if (!ownership.ok) return ownership;
    return callPm("pmListFailedAgentRuns", [
      profileId,
      typeof since === "string" && since.length > 0 ? since : null,
      typeof limit === "number" ? limit : 50,
    ]);
  });

  // ----- Resumable agents (read-only) -----
  //
  // Returns the most-recent non-terminal agent for the profile (i.e. an
  // agent that was running or paused when Progress Ledger was last closed).
  // The renderer asks "is there a previous run I should offer to
  // resume?" and shows the ResumeBanner on top of Project Mode when the
  // IPC returns a row. We piggyback on the existing `pmListRecentAgentRuns`
  // NAPI surface and filter client-side for non-terminal states â€” no
  // Rust change required, no new dependency. `limit` is the row budget
  // we ask the SQL layer for; the filter then narrows it further.
  //
  // States considered "resumable": `idle`, `planning`, `waiting_for_tool`,
  // `executing_tool`, `waiting_for_approval`, `observing`, `replanning`,
  // `verifying`. Terminal states (`completed`, `failed`, `cancelled`)
  // are never returned â€” the user must start a fresh agent for those.
  //
  // If the row is already in the in-memory RUNS registry (i.e. the loop
  // is somehow active for it in this process), we still return it â€” the
  // renderer will see the "Resume" banner, but pressing it will hit the
  // existing `already-running` guard and the user gets a clear error.
  // The ResumeBanner surfaces this case gracefully.
  safeHandle("agent:list-resumable", async (_e, { profileId, limit } = {}) => {
    const ownership = await assertProfileOwned(profileId);
    if (!ownership.ok) return ownership;
    const rows = await callPm("pmListRecentAgentRuns", [
      profileId,
      typeof limit === "number" ? limit : 50,
    ]);
    if (!Array.isArray(rows)) {
      return { ok: true, agent: null };
    }
    const TERMINAL = new Set(["completed", "failed", "cancelled"]);
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      // Real NAPI rows are camelCase (projectId, tokensIn); fakes and
      // older surfaces use snake_case â€” normalize once and read one way.
      const r = normalizeAgentRow(raw);
      if (typeof r.id !== "number") continue;
      if (typeof r.state !== "string") continue;
      if (TERMINAL.has(r.state)) continue;
      return {
        ok: true,
        agent: {
          id: r.id,
          projectId: typeof r.project_id === "number" ? r.project_id : null,
          objective: typeof r.objective === "string" ? r.objective : "",
          state: r.state,
          tokensIn: Number(r.tokens_in) || 0,
          tokensOut: Number(r.tokens_out) || 0,
          createdAt: r.created_at || null,
          updatedAt: r.updated_at || null,
        },
      };
    }
    return { ok: true, agent: null };
  });

  // ----- Plan templates -----
  //
  // Save a plan (typically the current agent's plan_json) under a name so
  // it can be reloaded later as the starter plan for a new run. Save
  // upserts on (profile_id, name) â€” same name = overwrite. List returns
  // newest-first. Load accepts either template id (preferred) or name as a
  // convenience so the UI can dispatch by name without an extra list call.
  // All three handlers pass through to the corresponding pm_* NAPI surface.
  safeHandle("plan:save-template", async (_e, { profileId, name, description, planJson }) => {
    if (typeof profileId !== "number" || typeof name !== "string" || typeof planJson !== "string") {
      return { ok: false, error: "invalid-args" };
    }
    const ownership = await assertProfileOwned(profileId);
    if (!ownership.ok) return ownership;
    return callPm("pmSavePlanTemplate", [
      profileId,
      name,
      typeof description === "string" ? description : null,
      planJson,
    ]);
  });
  safeHandle("plan:list-templates", async (_e, { profileId }) => {
    const ownership = await assertProfileOwned(profileId);
    if (!ownership.ok) return ownership;
    return callPm("pmListPlanTemplates", [profileId]);
  });
  safeHandle("plan:load-template", async (_e, { profileId, templateId, name }) => {
    if (typeof profileId !== "number") {
      return { ok: false, error: "invalid-profile-id" };
    }
    const ownership = await assertProfileOwned(profileId);
    if (!ownership.ok) return ownership;
    return callPm("pmLoadPlanTemplate", [
      profileId,
      typeof templateId === "number" ? templateId : null,
      typeof name === "string" ? name : null,
    ]);
  });
  safeHandle("plan:delete-template", async (_e, { profileId, templateId }) => {
    if (typeof profileId !== "number" || typeof templateId !== "number") {
      return { ok: false, error: "invalid-args" };
    }
    const ownership = await assertProfileOwned(profileId);
    if (!ownership.ok) return ownership;
    return callPm("pmDeletePlanTemplate", [profileId, templateId]);
  });

  // ----- Token budget (read-only) -----
  //
  // The renderer's TokenBudgetPanel asks "how much of the agent's token
  // budget has been consumed?" The main process reads the agent row
  // (tokens_in + tokens_out) and the owning project's config_json
  // (token_budget) and returns { current, cap, usedPct, lastUpdated }.
  // `cap` is the resolved per-project budget (see
  // shell/src/services/agent/budget.js); a cap of 0 means "no limit"
  // and usedPct is reported as 0 in that case.
  //
  // The budget module is imported here for its resolveTokenBudget()
  // helper only â€” this handler is a thin read-only adapter and does
  // not mutate the budget or the agent loop.
  safeHandle("agent:get-budget", async (_e, { profileId, agentId }) => {
    if (typeof profileId !== "number" || typeof agentId !== "number") {
      return { ok: false, error: "invalid-ids" };
    }
    const ownership = await assertAgentOwned(profileId, agentId);
    if (!ownership.ok) return ownership;
    const agent = normalizeAgentRow(ownership.agent);
    const current = (Number(agent.tokensIn) || 0) + (Number(agent.tokensOut) || 0);
    // Resolve the project's config_json for the cap. If the project row
    // is missing (shouldn't happen â€” FK), fall back to the default cap
    // via resolveTokenBudget's own handling of a missing config.
    const projectId = typeof agent.projectId === "number" ? agent.projectId : null;
    let cap = 0;
    if (projectId != null) {
      const project = normalizeProjectRow(await callPm("pmGetProject", [profileId, projectId]));
      cap = resolveTokenBudget(project && project.configJson);
    }
    // 0 cap means "no limit" per the budget module contract â€” report
    // usedPct as 0 so the UI can render "no limit" rather than an
    // infinite percentage.
    const usedPct = cap > 0 ? Math.min(100, (current / cap) * 100) : 0;
    return { ok: true, current, cap, usedPct, lastUpdated: Date.now() };
  });

//  ----- Tool approval queue (read-only + resolve) -----
//
// A lightweight in-memory queue holding every gated tool call that is currently
// BLOCKED waiting for a human decision.
//
// The bridge IS wired: `createApprovalResolver` (below) is passed into the
// agent loop by `project:start-agent`, `project:resume-agent` and the goal
// engine, and the loop calls it for every tool in `APPROVAL_REQUIRED`. That
// call is what populates this queue. This is the LOAD-BEARING approval path —
// not a read-only mirror.
//
// (An earlier version of this comment said the queue "is empty until the
// loop-to-IPC bridge is added" and that "a future wiring step will push each
// event into this queue". That was stale and inverted: the bridge exists, and
// the comment would have led a reader to treat the panel as decorative and add
// a redundant second path.)
//
// Properties of the queue, stated plainly because they are security-relevant:
//   * Entries hold the live `resolve` closure, so the queue cannot be
//     persisted: a restart drops pending approvals (the loop is cancelled on
//     quit and the recovery sweep does not offer to resume an agent parked in
//     `waiting_for_approval`).
//   * `isApprovalOwned` is checked on every resolve, so a caller cannot
//     approve another profile's or another agent's call.
//   * Both resolutions are written to the security audit trail as
//     `approval.resolve` with the tool and permission.

safeHandle("agent:list-pending-approvals", async (_e, { profileId, agentId } = {}) => {
  const ownership = await assertAgentOwned(profileId, agentId);
  if (!ownership.ok) return ownership;
  const items = [...approvalQueue.values()].filter((a) => a.profileId === profileId && a.agentId === agentId);
  return {
    ok: true,
    approvals: items.map(sanitizeApprovalEntry),
    count: items.length,
  };
});

safeHandle("agent:approve-call", async (_e, { profileId, agentId, approvalId } = {}) => {
  const ownership = await assertAgentOwned(profileId, agentId);
  if (!ownership.ok) return ownership;
  if (approvalId == null) return { ok: false, error: "missing-approval-id" };
  const entry = approvalQueue.get(String(approvalId));
  if (!entry) return { ok: false, error: "approval-not-found" };
  if (!isApprovalOwned(entry, profileId, agentId)) return { ok: false, error: "approval-not-owned" };
  approvalQueue.delete(String(approvalId));
  // The approval decision is THE security event. The audit trail recorded that
  // `tool.invoked` and `tool.completed` happened, but not that a human made
  // the privileged call — nor which approval it answered. Logged after the
  // ownership proof and the queue mutation, so a refused call is never
  // recorded as a decision.
  Audit.log({
    event: "approval.resolve",
    profileId,
    projectId: entry.projectId ?? null,
    agentId,
    tool: entry.toolName ?? null,
    input_summary: entry.toolName ?? null,
    result: "approved",
    durationMs: null,
    detail: `approval=${String(approvalId)} permission=${entry.permission ?? "unknown"}`,
  });
  entry.resolve({ approved: true });
  return { ok: true, deleted: true };
});

safeHandle("agent:deny-call", async (_e, { profileId, agentId, approvalId } = {}) => {
  const ownership = await assertAgentOwned(profileId, agentId);
  if (!ownership.ok) return ownership;
  if (approvalId == null) return { ok: false, error: "missing-approval-id" };
  const entry = approvalQueue.get(String(approvalId));
  if (!entry) return { ok: false, error: "approval-not-found" };
  if (!isApprovalOwned(entry, profileId, agentId)) return { ok: false, error: "approval-not-owned" };
  approvalQueue.delete(String(approvalId));
  Audit.log({
    event: "approval.resolve",
    profileId,
    projectId: entry.projectId ?? null,
    agentId,
    tool: entry.toolName ?? null,
    input_summary: entry.toolName ?? null,
    result: "denied",
    durationMs: null,
    detail: `approval=${String(approvalId)} permission=${entry.permission ?? "unknown"}`,
  });
  entry.resolve({ approved: false, reason: "user-rejected" });
  return { ok: true, deleted: true };
});

// ----- Provider health (read-only) -----
  //
  // In-memory request metrics recorded by
  // shell/src/services/agent/provider.js: one row per provider key
  // (endpoint host + model). No secret ever crosses this channel â€” the
  // key is derived from endpoint/model only, and aborted calls are not
  // counted. The renderer's ProviderHealth panel renders this; the main
  // process keeps no state of its own, so "refresh" is just a re-read.
  safeHandle("provider:health", (_e) => {
    return { ok: true, providers: getProviderHealth(), updatedAt: Date.now() };
  });

function logProviderAudit(event, profileId, projectId, model, result, detail) {
  Audit.log({
    event,
    profileId: typeof profileId === "number" ? profileId : null,
    projectId: typeof projectId === "number" ? projectId : null,
    input_summary: typeof model === "string" ? model : null,
    result,
    detail: JSON.stringify(detail),
  });
}

  // ----- Provider credentials -----
  safeHandle("project:get-provider-config", async (_e, { profileId, projectId }) => {
    const ownership = await assertProjectOwned(profileId, projectId);
    if (!ownership.ok) return ownership;
    const safe = credentialsStore.readProviderConfigSafe(profileId, projectId);
    return { ok: true, config: safe };
  });
  safeHandle("project:set-provider-config", async (_e, { profileId, projectId, endpoint, apiKey, model }) => {
    const ownership = await assertProjectOwned(profileId, projectId);
    if (!ownership.ok) {
      logProviderAudit("provider.credential_set", profileId, projectId, model, "denied", { reason: ownership.error || "not-owned" });
      return ownership;
    }
    const result = credentialsStore.writeProviderConfig(profileId, projectId, { endpoint, apiKey, model });
    const isUnchangedKey = typeof apiKey === "string" && apiKey.startsWith("●●●●");
    logProviderAudit("provider.credential_set", profileId, projectId, model, result.ok ? "ok" : "error", result.ok ? { endpoint, model, isUnchangedKey } : { reason: result.error || "write-failed" });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, config: result.config };
  });
  safeHandle("project:clear-provider-config", async (_e, { profileId, projectId }) => {
    const ownership = await assertProjectOwned(profileId, projectId);
    if (!ownership.ok) {
      logProviderAudit("provider.credential_clear", profileId, projectId, null, "denied", { reason: ownership.error || "not-owned" });
      return ownership;
    }
    const res = credentialsStore.clearProviderConfig(profileId, projectId);
    logProviderAudit("provider.credential_clear", profileId, projectId, null, "ok", { cleared: true });
    return res;
  });

  // ----- Default provider per project -----
  //
  // The default provider lives in pm_projects.config_json["defaultProvider"]
  // (validated by the NAPI side, which only accepts "openai-compatible"
  // or "mock"). The renderer uses this to pick which provider the agent
  // loop spins up for a project â€” no secret ever crosses this channel.
  safeHandle("project:get-default-provider", async (_e, { profileId, projectId }) => {
    const ownership = await assertProjectOwned(profileId, projectId);
    if (!ownership.ok) return ownership;
    return callPm("pmGetDefaultProvider", [profileId, projectId]);
  });
  safeHandle("project:set-default-provider", async (_e, { profileId, projectId, providerId }) => {
    const ownership = await assertProjectOwned(profileId, projectId);
    if (!ownership.ok) return ownership;
    return callPm("pmSetDefaultProvider", [profileId, projectId, providerId || ""]);
  });

  // ----- Session export -----
  //
  // Returns a JSON blob of the agent's full session: agent metadata,
  // plan, and all transcript messages (system/user/assistant/tool_call/
  // tool_result/status). The renderer triggers a file download via
  // URL.createObjectURL + <a download>.
  safeHandle("agent:export-session", async (_e, { profileId, agentId }) => {
    if (typeof profileId !== "number" || typeof agentId !== "number") {
      return { ok: false, error: "invalid-ids" };
    }
    const ownership = await assertAgentOwned(profileId, agentId);
    if (!ownership.ok) return ownership;
    const agent = normalizeAgentRow(ownership.agent);
    const messages = await callPm("pmListMessages", [profileId, agentId]);
    return {
      ok: true,
      session: {
        exportedAt: new Date().toISOString(),
        agent: {
          id: agent.id,
          state: agent.state,
          objective: agent.objective,
          planJson: agent.planJson || null,
          tokensIn: agent.tokensIn || 0,
          tokensOut: agent.tokensOut || 0,
          createdAt: agent.createdAt || null,
          startedAt: agent.startedAt || null,
          finishedAt: agent.finishedAt || null,
        },
        messages: Array.isArray(messages) ? messages : [],
      },
    };
  });
}

// Test helper â€” swap the credentials store. Production code does not
// call this.
export function _setCredentialsStoreForTests(store) {
  credentialsStore = store;
}

/**
 * Test-only: seed the approval queue. Production code never calls this.
 * Lives at module scope because ESM forbids `export` inside a function
 * body (the approval-queue state itself is module-scoped above).
 */
export function _seedApprovalQueueForTests(items) {
  approvalQueue.clear();
  approvalQueueNextId = 1;
  for (const item of items || []) {
    const id = item.id || approvalQueueNextId++;
    approvalQueue.set(id, { ...item, id, requestedAt: item.requestedAt || Date.now() });
  }
}

// ---- cross-module helpers -------------------------------------------------
//
// Exposed so the commands/hooks IPC layer can read agent state without
// going through the renderer. Each helper is a thin wrapper around the
// corresponding pm_* NAPI call. They never throw; failures are returned
// as { ok: false, reason }.

export async function listAgentMessages(profileId, agentId) {
  return callPm("pmListMessages", [profileId, agentId]);
}

export async function getProjectAgent(profileId, agentId) {
  return callPm("pmGetAgent", [profileId, agentId]);
}
