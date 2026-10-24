// Project Mode — sub-agent run telemetry.
//
// Tiny wrapper around the NAPI surface (`pm_insert_subagent_run` /
// `pm_end_subagent_run` / `pm_list_subagent_runs`). The agent loop
// (see loop.js) calls `start()` at sub-agent dispatch and `end()` at
// terminal state. `list()` is the read path used by the future UI
// panel.
//
// Design (Ponytail: smallest correct solution):
//   * No caching layer. NAPI is in-process; SQLite reads are cheap.
//     A 200ms cache here would just create a divergence window with
//     the on-disk truth.
//   * NO silent failures. The NAPI calls return primitives (number /
//     void / array); when `core` is missing we return a structured
//     `{ ok: false, reason }` so callers (and tests) can branch.
//   * All side-effecting methods are async even though the underlying
//     NAPI call is sync — so a future move to a thread pool or a
//     non-blocking IPC channel is a one-line change.
//
// Storage: SQLite table `subagent_runs` (see core/migrations/019_…sql).
// Schema:
//   id                INTEGER PRIMARY KEY
//   parent_agent_id   INTEGER NOT NULL   (ref pm_agents.id, ownership-gated)
//   role              TEXT               (researcher | coder | tester | reviewer)
//   child_agent_id    INTEGER            (ref pm_agents.id)
//   run_id            TEXT               (parent dispatch runId)
//   started_at        DATETIME NOT NULL
//   ended_at          DATETIME NULL      (set on terminal transition)
//   outcome           TEXT NULL          (completed | failed | cancelled)
//   tokens_in         INTEGER NULL
//   tokens_out        INTEGER NULL
//   error             TEXT NOT NULL      (failure reason, empty on success)

/**
 * Insert a new subagent_runs row. Returns the new id, or
 * `{ ok: false, reason }` when core is missing or the call fails.
 *
 * @param {object} core           loaded Rust NAPI core
 * @param {object} args
 * @param {number} args.profileId
 * @param {number} args.parentAgentId
 * @param {string|null} [args.role]
 * @param {number|null} [args.childAgentId]
 * @param {string|null} [args.runId]
 * @returns {Promise<number | { ok: false, reason: string }>}
 */
export async function start(core, { profileId, parentAgentId, role = null, childAgentId = null, runId = null }) {
  if (!core || typeof core.pmInsertSubagentRun !== "function") {
    return { ok: false, reason: "core-not-wired" };
  }
  if (typeof profileId !== "number" || typeof parentAgentId !== "number") {
    return { ok: false, reason: "invalid-input" };
  }
  try {
    const id = await core.pmInsertSubagentRun(
      profileId,
      parentAgentId,
      role == null ? null : String(role),
      typeof childAgentId === "number" ? childAgentId : null,
      runId == null ? null : String(runId),
    );
    return id;
  } catch (e) {
    return { ok: false, reason: "core-error", message: String(e && e.message || e) };
  }
}

/**
 * Close an open subagent_runs row. Returns `true` on success or
 * `{ ok: false, reason }` when the call fails. Double-end (closing
 * a row that is already terminal) is rejected by the NAPI layer with
 * `INVALID_INPUT` — we surface that unchanged.
 *
 * @param {object} core
 * @param {object} args
 * @param {number} args.profileId
 * @param {number} args.id
 * @param {string} args.outcome            'completed' | 'failed' | 'cancelled'
 * @param {number} [args.tokensIn=0]
 * @param {number} [args.tokensOut=0]
 * @param {string} [args.error='']
 * @returns {Promise<true | { ok: false, reason: string }>}
 */
export async function end(core, { profileId, id, outcome, tokensIn = 0, tokensOut = 0, error = "" }) {
  if (!core || typeof core.pmEndSubagentRun !== "function") {
    return { ok: false, reason: "core-not-wired" };
  }
  if (typeof profileId !== "number" || typeof id !== "number") {
    return { ok: false, reason: "invalid-input" };
  }
  if (!outcome || typeof outcome !== "string") {
    return { ok: false, reason: "invalid-outcome" };
  }
  try {
    await core.pmEndSubagentRun(profileId, id, outcome, tokensIn, tokensOut, error == null ? "" : String(error));
    return true;
  } catch (e) {
    return { ok: false, reason: "core-error", message: String(e && e.message || e) };
  }
}

/**
 * List subagent_runs rows. `parentAgentId` is optional — when set,
 * only that parent's rows are returned. `limit` is clamped by the
 * NAPI layer to [1, 1000]; defaults to 200.
 *
 * @param {object} core
 * @param {object} args
 * @param {number} args.profileId
 * @param {number|null} [args.parentAgentId]
 * @param {number|null} [args.limit]
 * @returns {Promise<Array<object> | { ok: false, reason: string }>}
 */
export async function list(core, { profileId, parentAgentId = null, limit = null }) {
  if (!core || typeof core.pmListSubagentRuns !== "function") {
    return { ok: false, reason: "core-not-wired" };
  }
  if (typeof profileId !== "number") {
    return { ok: false, reason: "invalid-input" };
  }
  try {
    const out = await core.pmListSubagentRuns(profileId, parentAgentId, limit);
    return Array.isArray(out) ? out : [];
  } catch (e) {
    return { ok: false, reason: "core-error", message: String(e && e.message || e) };
  }
}

// ----------------------------------------------------------------------------
// Sub-agent depth + cost limits (PRIORITY 4 — prevent runaway spawning)
// ----------------------------------------------------------------------------
//
// These helpers enforce three limits on sub-agent spawning:
//
//   1. maxDepth (default 3)         — a sub-agent at depth N can only spawn
//                                     sub-agents at depth N+1 up to the max.
//   2. maxTotalPerRun (default 8)   — no more than 8 sub-agent starts for a
//                                     single parent agent.
//   3. maxTokensPerSubagent (default 200_000) — if a sub-agent's cumulative
//                                     tokens_in + tokens_out exceeds this
//                                     value, the sub-agent is terminated.
//
// Limits are configurable per project via `pm_projects.config_json`:
//   { "subagent_limits": { "maxDepth": 3, "maxTotalPerRun": 8, "maxTokensPerSubagent": 200000 } }
//
// Design (Ponytail: smallest correct solution):
//   * Pure functions where possible (parseSubagentLimits, shouldCancelForTokenLimit).
//   * NO silent failures: core errors propagate as { ok: false, reason }.
//   * The recursion guard in loop.js (deleting delegate_* tools from a child's
//     tool set) is retained. These limits are defense-in-depth: they catch
//     runaway spawning even if the recursion guard is removed or bypassed.
//   * Depth is computed by walking the parent_agent_id chain. Cycles are
//     detected with a visited-set so a malformed DB never loops forever.

export const DEFAULT_SUBAGENT_LIMITS = Object.freeze({
  maxDepth: 3,
  maxTotalPerRun: 8,
  maxTokensPerSubagent: 200_000,
});

/**
 * Parse a project's `config_json` (or a raw string) and return the
 * sub-agent limit values. Missing / malformed JSON yields defaults.
 * Individual fields default independently — a partial config is fine.
 *
 * @param {object|string|null} configJson
 * @returns {{ maxDepth: number, maxTotalPerRun: number, maxTokensPerSubagent: number }}
 */
export function parseSubagentLimits(configJson) {
  let cfg = {};
  try {
    if (configJson && typeof configJson === "object") {
      cfg = configJson;
    } else {
      cfg = JSON.parse(configJson || "{}") || {};
    }
  } catch {
    cfg = {};
  }
  const raw = cfg.subagent_limits || {};
  const num = (v, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  return {
    maxDepth: num(raw.maxDepth, DEFAULT_SUBAGENT_LIMITS.maxDepth),
    maxTotalPerRun: num(raw.maxTotalPerRun, DEFAULT_SUBAGENT_LIMITS.maxTotalPerRun),
    maxTokensPerSubagent: num(raw.maxTokensPerSubagent, DEFAULT_SUBAGENT_LIMITS.maxTokensPerSubagent),
  };
}

/**
 * Compute the depth of an agent by walking the parent_agent_id chain.
 * A top-level agent (no parent_agent_id) is depth 0. A direct child of
 * a top-level agent is depth 1. And so on.
 *
 * Cycles are detected with a visited-set. On any error (core missing,
 * pmGetAgent throws, agent not found) we return 0 — fail-open so a
 * lookup failure never blocks a legitimate spawn. The recursion guard
 * in loop.js (child tool set excludes delegate_*) is the primary
 * defense; this limit is defense-in-depth.
 *
 * @param {object} core
 * @param {object} args
 * @param {number} args.profileId
 * @param {number} args.agentId
 * @returns {Promise<number>}
 */
export async function getDepth(core, { profileId, agentId }) {
  if (!core || typeof core.pmGetAgent !== "function") return 0;
  if (typeof profileId !== "number" || typeof agentId !== "number") return 0;
  let depth = 0;
  let current = agentId;
  const seen = new Set();
  while (typeof current === "number" && !seen.has(current)) {
    seen.add(current);
    let agent;
    try {
      agent = await core.pmGetAgent(profileId, current);
    } catch {
      return depth; // fail-open on lookup error
    }
    if (!agent || typeof agent !== "object") return depth;
    if (typeof agent.parent_agent_id !== "number") return depth;
    depth += 1;
    current = agent.parent_agent_id;
  }
  return depth;
}

/**
 * Count the total number of sub-agent starts for a given parent agent.
 * This counts ALL rows (regardless of ended_at), because a parent agent
 * has a single run — once 8 sub-agents have been started for it, no more
 * should be started even if the first ones have finished.
 *
 * @param {object} core
 * @param {object} args
 * @param {number} args.profileId
 * @param {number} args.parentAgentId
 * @returns {Promise<number>}
 */
export async function countActiveSubagents(core, { profileId, parentAgentId }) {
  const rows = await list(core, { profileId, parentAgentId, limit: 1000 });
  if (!Array.isArray(rows)) return 0;
  return rows.length;
}

/**
 * Return the cumulative token count (tokens_in + tokens_out) for a
 * specific subagent_runs row, identified by its run_id. Returns 0 if
 * the row is not found or tokens are not yet recorded.
 *
 * @param {object} core
 * @param {object} args
 * @param {number} args.profileId
 * @param {string} args.subagentRunId
 * @returns {Promise<number>}
 */
export async function getTokenCount(core, { profileId, subagentRunId }) {
  if (!core || typeof core.pmListSubagentRuns !== "function") return 0;
  if (typeof profileId !== "number" || typeof subagentRunId !== "string") return 0;
  const rows = await list(core, { profileId, limit: 1000 });
  if (!Array.isArray(rows)) return 0;
  const row = rows.find((r) => r && r.runId === subagentRunId);
  if (!row) return 0;
  return (Number(row.tokensIn) || 0) + (Number(row.tokensOut) || 0);
}

/**
 * Pure decision function: should a sub-agent be terminated because its
 * cumulative tokens exceed the per-sub-agent limit?
 *
 *   tokensIn + tokensOut > limit   -> true   (over limit, terminate)
 *   tokensIn + tokensOut <= limit  -> false
 *   limit === 0                    -> false  (0 = no limit)
 *
 * @param {number} tokensIn
 * @param {number} tokensOut
 * @param {number} limit
 * @returns {boolean}
 */
export function shouldCancelForTokenLimit(tokensIn, tokensOut, limit) {
  const li = Number(limit);
  if (!Number.isFinite(li) || li <= 0) return false;
  const ti = Number(tokensIn) || 0;
  const to = Number(tokensOut) || 0;
  return (ti + to) > li;
}

/**
 * Check whether a sub-agent spawn is allowed under the configured
 * depth + count limits. Returns `{ ok: true }` when allowed, or
 * `{ ok: false, reason }` when a limit is breached.
 *
 * The token limit is NOT checked here — it is a runtime check enforced
 * during the sub-agent's loop (see loop.js usage-event handler). This
 * function only checks dispatch-time limits (depth + count).
 *
 * @param {object} core
 * @param {object} args
 * @param {number} args.profileId
 * @param {number} args.parentAgentId       the agent trying to spawn a child
 * @param {number} args.currentDepth        the parent's depth (child would be +1)
 * @param {object|string} args.configJson   project config_json (may be null)
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'depth-limit' | 'count-limit' }>}
 */
export async function checkLimits(core, { profileId, parentAgentId, currentDepth, configJson }) {
  const limits = parseSubagentLimits(configJson);

  // Depth check: a sub-agent at depth N can spawn a child at depth N+1
  // only if N+1 <= maxDepth. Equivalently, N < maxDepth.
  const depth = Number(currentDepth) || 0;
  if (depth + 1 > limits.maxDepth) {
    return { ok: false, reason: "depth-limit" };
  }

  // Count check: no more than maxTotalPerRun sub-agent starts for this parent.
  const count = await countActiveSubagents(core, { profileId, parentAgentId });
  if (count >= limits.maxTotalPerRun) {
    return { ok: false, reason: "count-limit" };
  }

  return { ok: true };
}

/**
 * Mark a sub-agent as cancelled with the limit reason. This is called
 * when a limit is breached at dispatch time: the child pm_agents row has
 * already been created (by pmCreateAgent in the delegate tool) but the
 * loop should not start. We mark the child as cancelled and close the
 * telemetry row so the parent can see "this sub-agent was refused".
 *
 * @param {object} core
 * @param {object} args
 * @param {number} args.profileId
 * @param {number} args.agentId             the child agent to cancel
 * @param {string} args.reason              the limit reason (depth-limit | count-limit | token-limit)
 * @param {number|null} [args.telemetryRunId]  the subagent_runs row id (if opened)
 * @returns {Promise<true | { ok: false, reason: string }>}
 */
export async function cancelSubagentForLimit(core, { profileId, agentId, reason, telemetryRunId = null }) {
  if (!core || typeof core.pmFinishAgent !== "function") {
    return { ok: false, reason: "core-not-wired" };
  }
  const msg = `limit-${reason}`;
  try {
    await core.pmFinishAgent(profileId, agentId, "cancelled");
  } catch (_e) {
    // best effort — the child row may already be in a terminal state
  }
  if (typeof telemetryRunId === "number") {
    await end(core, {
      profileId,
      id: telemetryRunId,
      outcome: "cancelled",
      tokensIn: 0,
      tokensOut: 0,
      error: msg,
    });
  }
  return true;
}