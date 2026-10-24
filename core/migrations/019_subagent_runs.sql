-- 019_subagent_runs.sql — Sub-agent run telemetry (schema version 19).
--
-- The agent loop currently emits AGENT_* bus events at start / end but
-- persists nothing about individual sub-agent runs. The subagent_runs
-- table is a lightweight per-invocation log:
--
--   * one row per sub-agent invocation (spawned by a parent agent via
--     the 4 delegate_* tools)
--   * `started_at` is stamped on dispatch; `ended_at` is stamped when
--     the child loop reaches a terminal state (completed / failed /
--     cancelled)
--   * `outcome` mirrors the pm_agents.state at end (one of:
--     'completed' | 'failed' | 'cancelled')
--   * `tokens_in` / `tokens_out` are the cumulative token counts at end
--   * `error` carries the failure reason (e.g. 'budget-exceeded',
--     'verify-exhausted:N:...') so a parent can show WHY a child failed
--     without scanning the child's transcript
--
-- This is the source of truth for the per-invocation telemetry; the
-- AGENT_* bus events stay ephemeral for the in-memory ring buffer.
--
-- Schema notes (Ponytail: smallest correct solution):
--   * No FK to pm_agents — telemetry is observational, not load-bearing
--     for the parent's plan; if the child row is deleted, the telemetry
--     row survives (orphaned, harmless).
--   * `parent_agent_id` IS recorded so the UI can scope by parent.
--   * `id` is autoincrement for stable ordering + cheap `MAX(id)+1`
--     probing when the loop needs it.
--   * No cascade — sub-agent telemetry outlives its referent by design.

CREATE TABLE IF NOT EXISTS subagent_runs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    -- The parent that spawned this sub-agent. Matches pm_agents.id on
    -- the parent row at dispatch time. Stays here as a denormalized
    -- snapshot so a child delete does not orphan the link.
    parent_agent_id   INTEGER NOT NULL,
    -- One of 'researcher' | 'coder' | 'tester' | 'reviewer'. Nullable
    -- so the same row shape covers unknown roles in future.
    role              TEXT,
    -- The pm_agents.id of the child at dispatch time. Nullable because
    -- a row may be inserted optimistically before pmCreateAgent returns
    -- in some flows; in practice it is always present.
    child_agent_id    INTEGER,
    -- Sub-agent dispatch run id (the parent's `runId`). Distinct from
    -- the child's pm_agents.id so a parent can correlate telemetry
    -- with in-flight RUNS map entries.
    run_id            TEXT,
    -- ISO timestamp stamped at dispatch.
    started_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- NULL while the run is in flight; set when the child loop reaches
    -- a terminal state.
    ended_at          DATETIME,
    -- NULL while in flight; one of 'completed' | 'failed' | 'cancelled'
    -- on terminal transition.
    outcome           TEXT,
    -- Cumulative token counts at end. NULL while in flight.
    tokens_in         INTEGER,
    tokens_out        INTEGER,
    -- Failure reason (mirrors the `reason` arg passed to finishAgent).
    -- Empty while in flight or on success.
    error             TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent ON subagent_runs(parent_agent_id);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_started ON subagent_runs(started_at DESC, id DESC);