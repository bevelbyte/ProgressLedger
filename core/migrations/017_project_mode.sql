-- 017_project_mode.sql — Project Mode foundation (schema version 17).
--
-- Project Mode is CareerFlow's agentic project workspace: a user gives the
-- agent a goal; the agent plans, uses tools, executes, verifies, and reports.
-- This migration adds the smallest persistent model that supports a
-- long-running, multi-step, resumable agent session.
--
-- Naming: `pm_*` prefix keeps the new tables distinct from the existing
-- `career_*` / `browser_*` / `projects` (manual project tracker) tables.
-- No coupling to those tables.
--
-- Design notes (Ponytail: smallest correct solution):
--   * We persist the conversation transcript as a flat message log. Tool
--     calls and tool results are first-class message rows with a typed
--     `role` so the renderer can render them in a single stream.
--   * We persist agent state (state machine + plan JSON + token usage)
--     in `pm_agents`. Resumption reads the same row.
--   * Project context is the user's chosen project root on the local
--     filesystem. We store the path, not the file tree (the agent
--     re-discovers files via tools).
--   * All tables are scoped by `profile_id` (existing convention); the
--     agent core resolves ownership at the SQL boundary.

CREATE TABLE IF NOT EXISTS pm_projects (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id      INTEGER NOT NULL,
    name            TEXT    NOT NULL,
    description     TEXT    NOT NULL DEFAULT '',
    -- Absolute path to the user's chosen project root on the local
    -- filesystem. The agent's tools operate inside this path. Renderer
    -- never sees this directly; it is rendered as the project's name.
    root_path       TEXT    NOT NULL,
    -- JSON blob: agent config (model, provider, max-steps, etc.). The
    -- schema is owned by the main-process agent; we just persist it.
    config_json     TEXT    NOT NULL DEFAULT '{}',
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pm_projects_profile ON pm_projects(profile_id);

CREATE TABLE IF NOT EXISTS pm_agents (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      INTEGER NOT NULL,
    -- User-given objective (e.g. "Analyze this project and find the
    -- biggest architectural problems"). Persisted verbatim.
    objective       TEXT    NOT NULL,
    -- State machine value: idle | planning | waiting_for_tool |
    -- executing_tool | waiting_for_approval | observing | replanning |
    -- verifying | completed | failed | cancelled. Persisted as TEXT for
    -- forward compatibility; the agent core validates at read.
    state           TEXT    NOT NULL DEFAULT 'idle',
    -- Plan: JSON array of { id, title, status, depends_on } steps.
    plan_json       TEXT    NOT NULL DEFAULT '[]',
    -- Cumulative token usage (input, output) for budgeting.
    tokens_in       INTEGER NOT NULL DEFAULT 0,
    tokens_out      INTEGER NOT NULL DEFAULT 0,
    -- When the last run finished (or NULL if not yet finished).
    finished_at     DATETIME,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES pm_projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pm_agents_project ON pm_agents(project_id);
CREATE INDEX IF NOT EXISTS idx_pm_agents_state ON pm_agents(state);

CREATE TABLE IF NOT EXISTS pm_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id        INTEGER NOT NULL,
    -- Sequence within an agent's transcript. Strictly increasing.
    seq             INTEGER NOT NULL,
    -- Message role: system | user | assistant | tool_call | tool_result |
    -- error | status.
    role            TEXT    NOT NULL,
    -- Content. For tool_call/tool_result this is JSON.
    content         TEXT    NOT NULL DEFAULT '',
    -- For tool_call/tool_result: the tool name. For status: the event name.
    name            TEXT,
    -- For tool_result: the structured { ok, result, error, elapsedMs }.
    -- For status: the structured event payload.
    payload_json    TEXT,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (agent_id) REFERENCES pm_agents(id) ON DELETE CASCADE,
    UNIQUE (agent_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_pm_messages_agent_seq ON pm_messages(agent_id, seq);

-- Approval requests are a special kind of message. The agent emits a
-- tool_call whose permission is in APPROVAL_REQUIRED; the renderer pauses,
-- shows the user a dialog, and the user either approves (an approval
-- token is generated) or rejects. The decision is persisted as a status
-- message so resumption knows the outcome.
--
-- We do not add a separate pm_approvals table; the agent transcript is
-- already a complete record of every tool call + every decision.
