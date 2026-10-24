-- 021_pm_goals.sql — Goal Mode orchestration tables (schema version 21).
--
-- Goal Mode is a thin orchestration layer on top of the proven Project
-- Mode agent loop. A "goal" is the user-facing unit of autonomous work:
-- "Refactor authentication, update tests, ensure verification passes."
--
-- The agent loop, plan DAG, tools, verification, and persistence live
-- in pm_projects / pm_agents / pm_messages unchanged. Goals add:
--
--   * `pm_goals` — one row per user-submitted goal. Holds the user-given
--     title + objective, the goal-kind (CODE_CHANGE / RESEARCH / ANALYSIS),
--     the project (pm_projects) the goal operates on, the agent run
--     (pm_agents) the goal currently drives, the explicit lifecycle
--     state machine, completion/failure reason, and timestamps.
--   * `pm_goal_events` — append-only event log for every state
--     transition and the agent-id linkage point. Powers the UI timeline
--     and the audit-style "what happened" view.
--
-- Design notes (smallest correct solution):
--   * State machine mirrors the agent-loop vocabulary where possible:
--     created -> starting -> running -> verifying -> completed
--                                       \-> failed
--                                       \-> cancelled
--     Terminal: `completed`, `failed`, `cancelled`.
--   * `pm_goals` carries profile_id directly so every read/write can
--     gate ownership in one query (mirrors pm_plan_templates — see
--     migration 020). The owning project is joined for cross-project
--     isolation at the read site.
--   * `linked_agent_id` is nullable — a goal may exist briefly in
--     `created` / `starting` before the goal engine creates its agent
--     row. After that it points at the agent row that drives the work.
--   * `require_verification` is a boolean hint. CODE_CHANGE defaults to
--     true; RESEARCH / ANALYSIS default to false. The goal engine is
--     the authoritative enforcer; the column is a hint for the UI.
--   * `kind` is allowlisted at the Rust boundary.
--   * `priority` is an optional user hint (low/normal/high). The agent
--     loop does not consume it today; reserved for future work.
--   * No FK to pm_messages — goals reference the agent, not individual
--     transcript rows. The transcript remains the source of truth for
--     execution history.
--   * `pm_goal_events` has no FK to pm_goals either (denormalised by
--     design) so an event log survives a goal delete.

CREATE TABLE IF NOT EXISTS pm_goals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id      INTEGER NOT NULL,
    -- Owning project (FK enforced). Deleting the project cascades to
    -- the goal so the UI never sees a dangling row.
    project_id      INTEGER NOT NULL,
    -- User-given short label. Capped at MAX_NAME.
    title           TEXT    NOT NULL,
    -- The objective the goal will hand to its agent. Stored verbatim so
    -- the audit log shows exactly what the user typed.
    objective       TEXT    NOT NULL,
    -- Allowlisted at the Rust boundary. Allowed values:
    --   'code_change' — modify code, run verification, fix-retry.
    --   'research'    — gather info; success on agent completion.
    --   'analysis'    — produce an artifact; success on agent completion.
    kind            TEXT    NOT NULL DEFAULT 'code_change',
    -- Lifecycle state machine (validated at the Rust boundary):
    --   'created' | 'starting' | 'running' | 'verifying'
    --   'completed' | 'failed' | 'cancelled'
    state           TEXT    NOT NULL DEFAULT 'created',
    -- Optional user priority hint.
    priority        TEXT    NOT NULL DEFAULT 'normal',
    -- Whether the goal requires verification before completion. Hint
    -- only — the goal engine is the authoritative enforcer.
    require_verification INTEGER NOT NULL DEFAULT 1,
    -- The pm_agents.id that currently drives this goal. NULL until the
    -- goal engine creates the agent row, then stays stable.
    linked_agent_id INTEGER,
    -- Reason for the terminal state (verification failure, cancellation
    -- reason, etc.). Free text up to MAX_TEXT.
    failure_reason  TEXT    NOT NULL DEFAULT '',
    -- Final result text (last assistant summary from the linked agent).
    result_text     TEXT    NOT NULL DEFAULT '',
    -- Aggregate counters (denormalised for cheap UI rendering).
    plan_step_count INTEGER NOT NULL DEFAULT 0,
    -- ISO timestamps.
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at      DATETIME,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at    DATETIME,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES pm_projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pm_goals_profile_state ON pm_goals(profile_id, state, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_pm_goals_project ON pm_goals(project_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_pm_goals_agent ON pm_goals(linked_agent_id);

CREATE TABLE IF NOT EXISTS pm_goal_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id         INTEGER NOT NULL,
    -- The event type: 'created' | 'started' | 'agent_linked'
    --   | 'state_changed' | 'progress' | 'completed' | 'failed'
    --   | 'cancelled' | 'note'
    event           TEXT    NOT NULL,
    -- Optional free-text content (capped).
    message         TEXT    NOT NULL DEFAULT '',
    -- Optional structured payload (JSON). For state_changed events this
    -- is { from, to }.
    payload_json    TEXT,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pm_goal_events_goal ON pm_goal_events(goal_id, created_at DESC, id DESC);