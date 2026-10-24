import { safeHandle } from "../security/safe-handle.js";
// Goal Mode â€” IPC surface (shell-side).
//
// Channels (in alphabetical order):
//   goal:create         â†’ create a new goal in (profileId, projectId)
//   goal:get            â†’ fetch one goal
//   goal:list           â†’ list goals (filter by state, limit)
//   goal:delete         â†’ hard-delete a goal (cascades events)
//   goal:start          â†’ invoke the goal engine to start a goal
//   goal:cancel         â†’ invoke the goal engine to cancel a goal
//   goal:list-events    â†’ list timeline events for a goal
//   goal:get-agent-id   â†’ resolve the linked pm_agents.id (if any)
//   goal:reconcile      â†’ recover any non-terminal goals for a profile
//   goal:subscribe      â†’ renderer subscribes to engine-level events
//
// Ownership: every handler validates `profile_id` ownership via the
// pm_goals / pm_projects SQL chain. Provider credentials never cross
// this boundary; the engine reads them from the credentials store at
// start-time.

import { ipcMain } from "electron";
import { Audit } from "../services/audit/index.js";
import { startGoal as engineStartGoal, cancelGoal as engineCancelGoal, onGoalEvent, reconcileGoalsForProfile } from "../services/goals/engine.js";
import { runRecoverySweep } from "../services/agent/recovery.js";
import { resumeAgent as loopResumeAgent } from "../services/agent/loop.js";
import { createApprovalResolver } from "./project-mode.js";
import { authorizeAgentRecord, authorizeProjectRecord } from "../security/project-mode-auth.js";

let ctx = null;

async function callPm(method, args = []) {
  const fn = ctx && ctx.core && typeof ctx.core[method] === "function" ? ctx.core[method] : null;
  if (!fn) return { ok: false, reason: "core-not-wired" };
  try {
    return await fn.apply(ctx.core, args);
  } catch (e) {
    return { ok: false, reason: "core-error", message: String(e && e.message || e) };
  }
}

async function assertProfileOwned(profileId) {
  if (!Number.isInteger(profileId)) return { ok: false, reason: "invalid-profile-id" };
  if (!ctx?.core || typeof ctx.core.getProfiles !== "function") {
    return { ok: false, reason: "core-not-wired" };
  }
  try {
    const profiles = await Promise.resolve(ctx.core.getProfiles());
    return Array.isArray(profiles) && profiles.some((p) => Number(p?.id ?? p?.profile_id) === profileId)
      ? { ok: true }
      : { ok: false, reason: "profile-not-found" };
  } catch {
    return { ok: false, reason: "profile-ownership-check-failed" };
  }
}

async function assertGoalOwned(profileId, goalId) {
  const profile = await assertProfileOwned(profileId);
  if (!profile.ok) return profile;
  const goal = await callPm("pmGetGoal", [profileId, goalId]);
  if (!goal || goal.ok === false || Number(goal.id) !== goalId || Number(goal.profileId ?? goal.profile_id) !== profileId) {
    return { ok: false, reason: "goal-not-owned" };
  }
  return { ok: true, goal };
}

async function assertAgentOwned(profileId, agentId) {
  const agent = await callPm("pmGetAgent", [profileId, agentId]);
  return authorizeAgentRecord(profileId, agentId, agent);
}

export function register(registerCtx) {
  ctx = registerCtx;

  // The renderer can subscribe to engine events; we just rebroadcast
  // them over the standard notify() channel.
  onGoalEvent((evt) => {
    if (ctx && typeof ctx.notify === "function") {
      ctx.notify("goal:event", evt);
    }
  });

  safeHandle("goal:create", async (_e, payload) => {
    if (!payload || typeof payload !== "object") return { ok: false, error: "invalid-payload" };
    const { profileId, projectId, title, objective, kind, priority, requireVerification } = payload;
    if (typeof profileId !== "number" || typeof projectId !== "number") {
      return { ok: false, error: "invalid-ids" };
    }
    const profile = await assertProfileOwned(profileId);
    if (!profile.ok) return profile;
    const project = await callPm("pmGetProject", [profileId, projectId]);
    const projectOwnership = authorizeProjectRecord(profileId, projectId, project);
    if (!projectOwnership.ok) return projectOwnership;
    if (typeof title !== "string" || title.trim().length === 0) {
      return { ok: false, error: "title-required" };
    }
    if (typeof objective !== "string" || objective.trim().length === 0) {
      return { ok: false, error: "objective-required" };
    }
    const r = await callPm("pmCreateGoal", [
      profileId,
      projectId,
      title,
      objective,
      typeof kind === "string" ? kind : null,
      typeof priority === "string" ? priority : null,
      typeof requireVerification === "boolean" ? requireVerification : null,
    ]);
    Audit.log({
      event: "goal.create",
      profileId,
      projectId,
      agentId: null,
      tool: null,
      input_summary: title,
      result: r && r.ok === false ? "fail" : "ok",
      durationMs: null,
      detail: typeof objective === "string" ? objective.slice(0, 120) : null,
    });
    return r;
  });

  safeHandle("goal:get", async (_e, { profileId, goalId }) => {
    if (typeof profileId !== "number" || typeof goalId !== "number") {
      return { ok: false, error: "invalid-ids" };
    }
    const ownership = await assertGoalOwned(profileId, goalId);
    return ownership.ok ? ownership.goal : ownership;
  });

  safeHandle("goal:list", async (_e, { profileId, state, limit } = {}) => {
    const ownership = await assertProfileOwned(profileId);
    if (!ownership.ok) return ownership;
    return callPm("pmListGoals", [
      profileId,
      typeof state === "string" && state.length > 0 ? state : null,
      typeof limit === "number" ? limit : 100,
    ]);
  });

  safeHandle("goal:delete", async (_e, { profileId, goalId }) => {
    if (typeof profileId !== "number" || typeof goalId !== "number") {
      return { ok: false, error: "invalid-ids" };
    }
    const ownership = await assertGoalOwned(profileId, goalId);
    if (!ownership.ok) return ownership;
    const r = await callPm("pmDeleteGoal", [profileId, goalId]);
    Audit.log({
      event: "goal.delete",
      profileId,
      projectId: null,
      agentId: null,
      tool: null,
      input_summary: null,
      result: r && r.ok === false ? "fail" : "ok",
      durationMs: null,
      detail: `goalId=${goalId}`,
    });
    return r;
  });

  safeHandle("goal:start", async (_e, { profileId, goalId } = {}) => {
    if (!ctx || !ctx.core) return { ok: false, reason: "core-not-wired" };
    if (typeof profileId !== "number" || typeof goalId !== "number") {
      return { ok: false, reason: "invalid-ids" };
    }
    const ownership = await assertGoalOwned(profileId, goalId);
    if (!ownership.ok) return ownership;
    try {
      const r = await engineStartGoal({
        core: ctx.core,
        profileId,
        goalId,
        approvalResolverFactory: ({ profileId: resolverProfileId, agentId }) =>
          createApprovalResolver({ profileId: resolverProfileId, agentId }),
      });
      return r;
    } catch (e) {
      return { ok: false, reason: "engine-threw", message: String(e && e.message || e) };
    }
  });

  safeHandle("goal:cancel", async (_e, { profileId, goalId } = {}) => {
    if (!ctx || !ctx.core) return { ok: false, reason: "core-not-wired" };
    if (typeof profileId !== "number" || typeof goalId !== "number") {
      return { ok: false, reason: "invalid-ids" };
    }
    const ownership = await assertGoalOwned(profileId, goalId);
    if (!ownership.ok) return ownership;
    try {
      const r = await engineCancelGoal({ core: ctx.core, profileId, goalId });
      return r;
    } catch (e) {
      return { ok: false, reason: "engine-threw", message: String(e && e.message || e) };
    }
  });

  safeHandle("goal:list-events", async (_e, { profileId, goalId, limit } = {}) => {
    if (typeof profileId !== "number" || typeof goalId !== "number") {
      return { ok: false, error: "invalid-ids" };
    }
    const ownership = await assertGoalOwned(profileId, goalId);
    if (!ownership.ok) return ownership;
    return callPm("pmListGoalEvents", [profileId, goalId, typeof limit === "number" ? limit : 100]);
  });

  safeHandle("goal:get-agent-id", async (_e, { profileId, goalId } = {}) => {
    if (typeof profileId !== "number" || typeof goalId !== "number") {
      return { ok: false, error: "invalid-ids" };
    }
    const ownership = await assertGoalOwned(profileId, goalId);
    if (!ownership.ok) return ownership;
    return callPm("pmGetGoalAgentId", [profileId, goalId]);
  });

  // Phase 15: explicit link-agent channel used by the renderer's
  // "Promote to Goal" affordance. The existing engine creates a fresh
  // agent when startGoal runs, so this IPC channel is the explicit
  // path for "this goal is bound to an existing agent row".
  safeHandle("goal:link-agent", async (_e, { profileId, goalId, agentId } = {}) => {
    if (!ctx || !ctx.core) return { ok: false, reason: "core-not-wired" };
    if (typeof profileId !== "number" || typeof goalId !== "number" || typeof agentId !== "number") {
      return { ok: false, reason: "invalid-ids" };
    }
    const goalOwnership = await assertGoalOwned(profileId, goalId);
    if (!goalOwnership.ok) return goalOwnership;
    const agentOwnership = await assertAgentOwned(profileId, agentId);
    if (!agentOwnership.ok) return agentOwnership;
    const goalProjectId = Number(goalOwnership.goal.projectId ?? goalOwnership.goal.project_id);
    const agentProjectId = Number(agentOwnership.agent.projectId ?? agentOwnership.agent.project_id);
    if (!Number.isInteger(goalProjectId) || goalProjectId !== agentProjectId) {
      return { ok: false, reason: "goal-agent-project-mismatch" };
    }
    try {
      await ctx.core.pmLinkGoalAgent(profileId, goalId, agentId);
      // After linking, append a "promote" note so the timeline shows
      // the user explicitly promoted this run to a Goal.
      await ctx.core.pmAppendGoalEvent(
        profileId,
        goalId,
        "promoted from Project Mode",
        JSON.stringify({ agent_id: agentId, source: "promote-to-goal" })
      );
      Audit.log({
        event: "goal.promote",
        profileId,
        projectId: null,
        agentId,
        tool: null,
        input_summary: null,
        result: "ok",
        durationMs: null,
        detail: `goalId=${goalId}`,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: "engine-threw", message: String(e && e.message || e) };
    }
  });

  safeHandle("goal:reconcile", async (_e, { profileId } = {}) => {
    if (!ctx || !ctx.core) return { ok: false, reason: "core-not-wired" };
    if (typeof profileId !== "number") return { ok: false, reason: "invalid-profile-id" };
    const ownership = await assertProfileOwned(profileId);
    if (!ownership.ok) return ownership;
    try {
      return await reconcileGoalsForProfile({ core: ctx.core, profileId });
    } catch (e) {
      return { ok: false, reason: "reconcile-threw", message: String(e && e.message || e) };
    }
  });

  // Phase 15 â€” startup crash/resume sweep. The renderer calls this once
   // per active profile on mount. Returns the rows that need user
   // attention (or that we classified as safe-resume) plus the goal
   // reconciliation count. Never auto-resumes.
  safeHandle("goal:recovery-sweep", async (_e, { profileId } = {}) => {
    if (!ctx || !ctx.core) return { ok: false, reason: "core-not-wired" };
    if (typeof profileId !== "number") return { ok: false, reason: "invalid-profile-id" };
    const ownership = await assertProfileOwned(profileId);
    if (!ownership.ok) return ownership;
    try {
      const r = await runRecoverySweep({ core: ctx.core, profileId });
      Audit.log({
        event: "goal.recovery.sweep",
        profileId,
        projectId: null,
        agentId: null,
        tool: null,
        input_summary: null,
        result: r && r.ok ? "ok" : "fail",
        durationMs: null,
        detail: JSON.stringify({
          resumable: (r && r.resumable && r.resumable.length) || 0,
          stale: (r && r.stale && r.stale.length) || 0,
          goalReconciled: (r && r.goalReconciled) || 0,
        }),
      });
      return r;
    } catch (e) {
      return { ok: false, reason: "sweep-threw", message: String(e && e.message || e) };
    }
  });

  // Phase 16 â€” EXPLICIT, user-driven resume. The recovery sweep only
  // classifies rows; it never auto-resumes. This channel is what the
  // user presses when they see a `safe-resume` row: it re-attaches the
  // existing agent loop (resumeAgent -> startAgent with isResume=true)
  // so the loop continues from the persisted plan â€” no replay of
  // already-completed steps, no duplicate agent creation.
  safeHandle("goal:resume", async (_e, { profileId, goalId, agentId } = {}) => {
    if (!ctx || !ctx.core) return { ok: false, reason: "core-not-wired" };
    if (typeof profileId !== "number" || typeof goalId !== "number" || typeof agentId !== "number") {
      return { ok: false, reason: "invalid-ids" };
    }
    try {
      // Resume is a goal-scoped capability. Never accept an arbitrary
      // same-profile agent id just because it is resumable: the requested
      // goal must actually be linked to that exact agent.
      const goal = await ctx.core.pmGetGoal(profileId, goalId);
      if (!goal || goal.ok === false || Number(goal.id) !== goalId || Number(goal.profileId ?? goal.profile_id) !== profileId) {
        return { ok: false, reason: "goal-not-owned" };
      }
      const linkedAgentId = goal && (goal.linkedAgentId ?? goal.linked_agent_id);
      if (Number(linkedAgentId) !== agentId) {
        return { ok: false, reason: "goal-agent-mismatch" };
      }

      // Recovery classification is authoritative for restart safety. A
      // missing, stale, terminal, or phase-inconsistent run-state row must
      // not be resumed merely because pm_agents is non-terminal.
      const runState = typeof ctx.core.pmGetRunState === "function"
        ? await ctx.core.pmGetRunState(profileId, agentId)
        : null;
      if (!runState || runState.state === "completed" || runState.state === "failed" || runState.state === "cancelled") {
        return { ok: false, reason: "resume-state-unavailable" };
      }
      if (runState.recovery === "stale") {
        return { ok: false, reason: "stale-run" };
      }
      const phaseToState = {
        preparing: "idle",
        planning: "planning",
        executing: "executing_tool",
        verifying: "verifying",
        awaiting_approval: "waiting_for_approval",
        idle: "idle",
      };
      // Ownership + phase consistency via the established primitive:
      // real NAPI rows carry NO profileId/profile_id field (project
      // linkage is implicit via project_id), so an inline
      // `agent.profileId !== profileId` check rejects every real row
      // with NaN !== profileId. This made goal:resume permanently
      // broken against the real core.
      const agentRow = await ctx.core.pmGetAgent(profileId, agentId);
      const agentOwnership = authorizeAgentRecord(profileId, agentId, agentRow);
      if (!agentOwnership.ok) {
        return { ok: false, reason: "agent-not-owned" };
      }
      const agentState = agentRow && agentRow.state;
      if (phaseToState[runState.phase] && phaseToState[runState.phase] !== agentState) {
        return { ok: false, reason: "resume-phase-mismatch" };
      }

      // The engine observes the linked agent's lifecycle; calling the
      // loop's resumeAgent directly is the same path the goal engine uses
      // for a fresh run (no second engine).
      const r = await loopResumeAgent({
        core: ctx.core,
        profileId,
        agentId,
        approvalResolver: createApprovalResolver({ profileId, agentId }),
      });
      if (!r || r.ok === false) return r;
      Audit.log({
        event: "goal.resume",
        profileId,
        projectId: null,
        agentId,
        tool: null,
        input_summary: null,
        result: "ok",
        durationMs: null,
        detail: `goalId=${goalId}; runId=${r.runId}`,
      });
      return { ok: true, runId: r.runId };
    } catch (e) {
      return { ok: false, reason: "resume-threw", message: String(e && e.message || e) };
    }
  });
}
