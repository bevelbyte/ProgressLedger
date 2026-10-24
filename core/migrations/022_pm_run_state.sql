-- 022_pm_run_state.sql: in-flight agent run registry (schema version 22).
--
-- Phase 14's agent loop keeps the live run registry (`RUNS`) in memory.
-- That means an Electron process crash/restart loses every running agent's
-- controller / bus / signal even though pm_agents.state is still
-- persisted. The goal engine can reconcile terminal-vs-non-terminal
-- goals (Phase 14), but it cannot resume a non-terminal agent
-- automatically without re-running every tool call (dangerous).
--
-- Phase 15 adds a tiny durable registry: `pm_run_state`. One row per
-- (profile_id, agent_id). The agent loop writes the entry whenever it
-- starts, transitions, or finishes a run. On startup the recovery
-- sweep reads it to determine whether the previous in-flight run can
-- be safely resumed.
--
-- Notes (Ponytail: smallest correct solution):
--   * profile_id is denormalized so the sweep can run as one query per
--     profile (no joins).
--   * state is one of: 'running' | 'paused' | 'completed' | 'failed'
--     | 'cancelled'. We mirror pm_agents.state + an explicit terminal
--     marker; the loop updates both.
--   * run_id, controller_id, role are the live-run metadata. controller_id
--     is opaque (a short uuid) — used only to detect stale registry rows.
--   * phase captures the last-known high-level state for the recovery
--     sweep: 'preparing' | 'planning' | 'executing' | 'verifying' |
--     'awaiting_approval' | 'idle' | 'unknown'. The recovery sweep uses
--     this to decide between safe-resume and requires-user-resume.
--   * parent_run_id is set when the row was spawned as a sub-agent; the
--     recovery sweep uses it to avoid resurrecting an entire chain if
--     the parent has been cleaned up.
--   * last_event_at is set on every write; the recovery sweep treats any
--     row older than 30 minutes as "likely stale" and refuses to
--     auto-resume without user consent.
--   * No FK to pm_agents (intentional). A delete of pm_agents leaves
--     pm_run_state as an orphan row, which the sweep can simply
--     ignore. Cleaner than cascade surprises.

CREATE TABLE IF NOT EXISTS pm_run_state (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id          INTEGER NOT NULL,
    agent_id            INTEGER NOT NULL,
    run_id              TEXT    NOT NULL,
    role                TEXT,
    is_sub_agent        TEXT,
    parent_run_id       TEXT,
    phase               TEXT    NOT NULL DEFAULT 'unknown',
    state               TEXT    NOT NULL DEFAULT 'running',
    tokens_in           INTEGER NOT NULL DEFAULT 0,
    tokens_out          INTEGER NOT NULL DEFAULT 0,
    recovery            TEXT    NOT NULL DEFAULT 'requires-user',
    last_event_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (profile_id, agent_id),
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pm_run_state_state ON pm_run_state(state);
CREATE INDEX IF NOT EXISTS idx_pm_run_state_last_event ON pm_run_state(last_event_at DESC);