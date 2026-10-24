// Tool: delegate_research — spawn a RESEARCHER sub-agent and wait for
// it to finish. The parent's tool set includes the 4 delegate_* tools;
// the child loop's tool set does NOT (see _roles.js + loop.js).
//
// NETWORK permission, NOT in APPROVAL_REQUIRED (see security.js —
// once the user has started the parent agent, sub-agent spawning is
// an internal continuation of the same workflow).
//
// Workaround: the parent→child link is now first-class via the
// `parent_agent_id` column on pm_agents (see migration 018 +
// `pm_set_parent`). We set it directly on the child row at creation
// time and ALSO annotate `plan_json.steps[i].assigned_agent_id` so the
// renderer's PlanView can show the link inline without a second SQL
// round-trip. The plan_json annotation is therefore a denormalized
// cache for fast rendering, not the source of truth.

import { errorEnvelope } from "./_runtime.js";
import {
  ROLE_PROMPTS,
  ROLE_TOOLS,
  ROLE_OUTPUT_SHAPE,
  MAX_CONCURRENT_SUBAGENTS,
  DELEGATE_TOOL_NAMES,
  buildChildObjective,
} from "./_roles.js";
import { getChildState, onSubAgentTerminal, invalidateChildStateCache, normalizeAgentRow } from "../agent/loop.js";
import { parseSubAgentResult } from "../agent/subagent-result.js";

export const ROLE = "researcher";

export const tool = {
  name: "delegate_research",
  description:
    "Spawn a researcher sub-agent with a scoped read-only tool set. Blocks until the child " +
    "completes (or 5 min timeout) and returns its final assistant message.",
  permission: "NETWORK",
  inputSchema: {
    type: "object",
    properties: {
      objective: { type: "string", description: "What the researcher should investigate" },
      step_id: { type: "string", description: "Identifier of the parent plan step that owns this sub-agent" },
      files: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of file paths inside the project root to scope the research",
      },
      expected_output_shape: { type: "string", description: "Override the role's default output shape" },
    },
    required: ["objective", "step_id"],
  },
  outputSchema: {
    type: "object",
    properties: {
      child_agent_id: { type: "number" },
      state: { type: "string" },
      result: { type: "object" },
    },
  },
  timeoutMs: 5 * 60 * 1000, // 5 min per the architectural cap

  async execute(input, ctx) {
    return runDelegate(ROLE, input, ctx);
  },
};

// ---------------------------------------------------------------------------
// Shared executor — every delegate_* tool delegates here. Keeps the 4
// tool files trivial and ensures the concurrency cap, plan_json
// workaround, and recursion guard are implemented exactly once.
// ---------------------------------------------------------------------------

export async function runDelegate(role, input, ctx) {
  if (!ctx || typeof ctx.core !== "object" || ctx.core === null) {
    return errorEnvelope("invalid-input", "delegate_* requires ctx.core (the loaded Rust NAPI core)");
  }
  if (!input || typeof input.objective !== "string" || input.objective.length === 0) {
    return errorEnvelope("invalid-input", "objective is required");
  }
  if (typeof input.step_id !== "string" || input.step_id.length === 0) {
    return errorEnvelope("invalid-input", "step_id is required");
  }

  const core = ctx.core;
  const parentProfileId = ctx.profileId;
  const parentAgentId = ctx.agentId;
  const projectId = ctx.projectId;
  if (!parentProfileId || !parentAgentId || !projectId) {
    return errorEnvelope(
      "invalid-input",
      "delegate_* requires ctx.profileId / ctx.agentId / ctx.projectId to be set on the tool context",
    );
  }

  // 1) Concurrency cap. We check the parent loop's inFlight map via the
  //    helper exposed on ctx (see loop.js). The cap is per-parent: a
  //    4th concurrent delegate_* call is refused.
  if (typeof ctx.subAgentSlotAvailable !== "function" || !ctx.subAgentSlotAvailable()) {
    return errorEnvelope(
      "too-many-concurrent-subagents",
      `parent already has ${MAX_CONCURRENT_SUBAGENTS} in-flight sub-agents`,
    );
  }

  // 2) Construct the child objective. The existing pmCreateAgent
  //    signature is (projectId, objective) — no parent_agent_id — so we
  //    encode role + step + files + expected output shape in the
  //    objective string itself.
  const childObjective = buildChildObjective(role, {
    objective: input.objective,
    stepId: input.step_id,
    files: Array.isArray(input.files) ? input.files : [],
    expectedOutputShape:
      typeof input.expected_output_shape === "string" && input.expected_output_shape.length > 0
        ? input.expected_output_shape
        : null,
  });

  // 3) Create the child pm_agents row, setting parent_agent_id in the
  //    same insert. This is the source of truth for the parent→child
  //    link (see migration 018). The plan_json annotation written below
  //    is a denormalized cache for fast rendering.
  //    The REAL NAPI core returns the new row id as a plain number;
  //    some test fakes return { id }. Accept both shapes.
  const createRes = await core.pmCreateAgent(projectId, childObjective, parentAgentId);
  const childAgentId = typeof createRes === "number"
    ? createRes
    : createRes && typeof createRes === "object" && typeof createRes.id === "number"
      ? createRes.id
      : null;
  if (childAgentId == null) {
    return errorEnvelope("tool-failed", "pmCreateAgent did not return a row id");
  }

  // 3a) Atomically reserve the parent's slot. If the reservation fails
  //     (concurrent delegate_* reached the cap between the check above
  //     and now) we surface the same too-many-concurrent-subagents
  //     error. Note: the child pm_agents row has already been created;
  //     we leave it in 'idle' state — it is not started. The shell's
  //     project:list-agents will show it as a never-started child.
  if (typeof ctx.subAgentSlotReserve !== "function" || !ctx.subAgentSlotReserve(childAgentId)) {
    return errorEnvelope(
      "too-many-concurrent-subagents",
      `parent already has ${MAX_CONCURRENT_SUBAGENTS} in-flight sub-agents`,
    );
  }

  // 4) Annotate the parent's plan_json with the child link as a
  //    denormalized cache for the renderer's PlanView (fast rendering).
  //    The authoritative link lives on `parent_agent_id` (set above).
  await annotateParentPlanWithChild(core, parentProfileId, parentAgentId, input.step_id, role, childAgentId);

  // 5) Start the child loop with isSubAgent=true so its tool set is
  //    filtered to exclude the 4 delegate_* tools (recursion guard).
  const startRes = await core.startAgent
    ? await core.startAgent({ profileId: parentProfileId, agentId: childAgentId, isSubAgent: true, role })
    : await startChildViaIpc(ctx, parentProfileId, childAgentId, role);
  if (!startRes || startRes.ok !== true) {
    if (typeof ctx.subAgentSlotRelease === "function") {
      ctx.subAgentSlotRelease(childAgentId);
    }
    try {
      await core.pmFinishAgent(parentProfileId, childAgentId, "cancelled");
    } catch (_e) {
      // Best-effort cleanup; the parent must not retain a phantom slot.
    }
    return errorEnvelope(
      "tool-failed",
      `failed to start child agent ${childAgentId}: ${startRes && startRes.reason ? startRes.reason : "unknown"}`,
    );
  }

  // 5a) GATE 1 (P0): attach the child's live controller to the parent's
  //     in-flight slot. `cancelAgent(parent)` aborts every controller in
  //     the descendant tree via the run registry — this registration is
  //     what makes that walk possible. Also keep a direct reference so
  //     the cooperative path below can abort the child without waiting
  //     for the registry.
  const childController = startRes.controller || null;
  if (typeof ctx.subAgentSlotAttach === "function" && childController) {
    ctx.subAgentSlotAttach(childAgentId, { runId: startRes.runId, controller: childController });
  }

  // 6) Poll for completion with a 5-min cap. We use the persisted
  //    pm_agents.state — that is the source of truth per the loop
  //    contract — and return the structured child result. We subscribe
  //    to SUBAGENT_EVENTS.CHILD_TERMINAL so the loop wakes IMMEDIATELY
  //    when the child finishes, with a 2000ms fallback poll in case the
  //    event is missed (configurable via SUBAGENT_POLL_MS env var).
  //    `getChildState` is a 200ms-cached wrapper around
  //    pmGetAgent — repeated wake-ups are cheap.
  //
  //    GATE 1 (P0): the poll loop ALSO wakes the moment the PARENT is
  //    cancelled (ctx.onCancelled). On parent cancel we abort the
  //    child's controller (propagation) and wait — bounded — for the
  //    child to reach a persisted terminal state, so there is no zombie
  //    child and no duplicate finalization (the child's own loop is the
  //    only writer of its terminal state).
  const POLL_MS = Number(process.env.SUBAGENT_POLL_MS) || 2000;
  const TIMEOUT_MS = 5 * 60 * 1000;
  const CANCEL_GRACE_MS = 10_000;
  const startedAt = Date.now();
  let lastState = null;
  let wakeResolver = null;
  const wake = () => {
    const r = wakeResolver;
    wakeResolver = null;
    if (r) r();
  };
  const onWake = (detail) => {
    if (detail && detail.childAgentId === childAgentId) wake();
  };
  const unsubscribe = onSubAgentTerminal(onWake);
  const onParentCancel = () => wake();
  const removeCancelWatch =
    typeof ctx.onCancelled === "function" ? ctx.onCancelled(onParentCancel) : null;
  const isTerminalState = (s) => s === "completed" || s === "failed" || s === "cancelled";
  try {
    while (true) {
      if (ctx.isCancellable && ctx.isCancellable()) {
        // Parent cancelled: propagate to the child, wait for it to
        // persist its terminal state, then report the cancellation.
        if (childController && !childController.signal.aborted) childController.abort();
        const deadline = Date.now() + CANCEL_GRACE_MS;
        while (Date.now() < deadline) {
          const cs2 = await getChildState(core, parentProfileId, childAgentId);
          const s2 = cs2 && typeof cs2.state === "string" ? cs2.state : null;
          if (isTerminalState(s2)) {
            lastState = s2;
            break;
          }
          await sleep(25);
        }
        return errorEnvelope(
          "cancelled",
          `parent cancelled; child agent ${childAgentId} final state: ${lastState || "unknown"}`,
        );
      }
      const cs = await getChildState(core, parentProfileId, childAgentId);
      lastState = cs && typeof cs.state === "string" ? cs.state : null;
      if (isTerminalState(lastState)) break;
      if (Date.now() - startedAt > TIMEOUT_MS) {
        return errorEnvelope("timeout", `child agent ${childAgentId} did not finish within ${TIMEOUT_MS}ms`);
      }
      // Wait for either an event-driven wake OR the fallback poll tick.
      const waitForEvent = new Promise((resolve) => {
        wakeResolver = resolve;
      });
      const waitForPoll = sleep(POLL_MS);
      await Promise.race([waitForEvent, waitForPoll]);
      wakeResolver = null;
    }
  } finally {
    if (typeof removeCancelWatch === "function") removeCancelWatch();
    if (typeof unsubscribe === "function") unsubscribe();
    invalidateChildStateCache(childAgentId);
    // GATE 1: release the in-flight slot on EVERY exit path (success,
    // parent cancel, timeout, throw). The previous release-on-success-
    // only behavior leaked the slot and starved later delegate_* calls.
    if (typeof ctx.subAgentSlotRelease === "function") {
      ctx.subAgentSlotRelease(childAgentId);
    }
  }

  // 7) Read the child's transcript and parse it through the shared
  //    structured-result parser. The parser is a pure helper that
  //    produces role-specific fields and falls back to the raw text
  //    when the last assistant message is not valid JSON.
  const messages = await core.pmListMessages(parentProfileId, childAgentId);
  const result = parseSubAgentResult(Array.isArray(messages) ? messages : [], role);

  return {
    ok: true,
    result: {
      child_agent_id: childAgentId,
      role,
      state: lastState,
      result,
      elapsedMs: Date.now() - startedAt,
      role_prompt: ROLE_PROMPTS[role],
      expected_output_shape: ROLE_OUTPUT_SHAPE[role],
      scoped_tools: ROLE_TOOLS[role],
      recursion_guard: DELEGATE_TOOL_NAMES, // echoed for the parent's tool_result
    },
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Annotate the parent's plan_json so the parent→child link is
 * queryable without a schema migration. We set on the step keyed by
 * step_id (or append a new step entry if none matches):
 *   { assigned_agent_id: <childId>, assigned_to: <role> }
 *
 * Plan_json may be either a JSON array of step objects (legacy) or
 * the wrapped `{ steps: [...] }` shape produced by `planToJson`. We
 * accept both and normalise before mutating.
 *
 * Other steps are preserved verbatim. On any error we do NOT fail the
 * delegate_* call — the child has already been spawned. The annotation
 * is a nicety for the IPC / read path.
 */
async function annotateParentPlanWithChild(core, profileId, agentId, stepId, role, childAgentId) {
  let plan = { steps: [] };
  try {
    const agent = normalizeAgentRow(await core.pmGetAgent(profileId, agentId));
    if (agent && typeof agent.plan_json === "string" && agent.plan_json.length > 0) {
      try {
        const raw = JSON.parse(agent.plan_json);
        if (Array.isArray(raw)) {
          plan = { steps: raw, version: 1 };
        } else if (raw && typeof raw === "object" && Array.isArray(raw.steps)) {
          plan = raw;
        }
      } catch { /* keep default */ }
    }
    if (!plan || !Array.isArray(plan.steps)) plan = { steps: [], version: 1 };
  } catch {
    plan = { steps: [], version: 1 };
  }

  let matched = false;
  for (const step of plan.steps) {
    if (step && typeof step === "object" && (step.id === stepId || step.step_id === stepId)) {
      step.assigned_agent_id = childAgentId;
      step.assigned_to = role;
      matched = true;
      break;
    }
  }
  if (!matched) {
    plan.steps.push({
      id: stepId,
      step_id: stepId,
      title: stepId,
      status: "pending",
      depends_on: [],
      files: [],
      assigned_to: role,
      assigned_agent_id: childAgentId,
    });
  }

  try {
    await core.pmUpdateAgent(profileId, agentId, "planning", JSON.stringify(plan), 0, 0);
  } catch {
    // best effort — the child has already been spawned
  }
}

/**
 * Fallback path when the NAPI surface does not expose startAgent
 * directly. In production the IPC layer's project:start-agent channel
 * is the actual entry point; tests may bypass IPC. We try the
 * loop.js export via the helper mounted on ctx by the IPC layer.
 */
async function startChildViaIpc(ctx, profileId, agentId, role) {
  if (ctx && ctx.startSubAgent) {
    return await ctx.startSubAgent({
      profileId,
      projectId: ctx.projectId,
      agentId,
      isSubAgent: true,
      role,
    });
  }
  return { ok: false, reason: "start-agent-not-wired" };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
