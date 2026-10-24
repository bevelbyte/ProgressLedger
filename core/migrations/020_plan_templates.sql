-- 020_plan_templates.sql — Plan template library (schema version 20).
--
-- Lets a user save a completed `pm_agents.plan_json` plan as a reusable
-- template and re-load it as the starter plan for a fresh agent run.
-- Templates are scoped by profile_id so they follow the same ownership
-- convention as pm_projects / pm_agents (every row carries profile_id;
-- cross-profile reads return 0 rows from the SQL boundary).
--
-- Design notes (Ponytail: smallest correct solution):
--   * `plan_json` mirrors the storage shape used by pm_agents — a JSON
--     string. We let the shell parse / serialise; the Rust side just
--     validates that the JSON parses to the canonical { steps, version }
--     shape before INSERT.
--   * `name` is unique per profile so a user can rely on "My Triage Plan"
--     being a single row. The NAPI handler rejects duplicates with a
--     UNIQUE-violation surfaced as INVALID_INPUT.
--   * `description` is optional free text (capped at MAX_TEXT).
--   * No FK to pm_projects / pm_agents — templates are independent of
--     any specific agent run. Deleting a project / agent must NOT
--     cascade into losing saved templates.
--   * `step_count` is a denormalised count of `steps[]` so the UI can
--     render the table without re-parsing every plan_json blob. Kept in
--     sync by the NAPI layer at save time.

CREATE TABLE IF NOT EXISTS pm_plan_templates (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id      INTEGER NOT NULL,
    name            TEXT    NOT NULL,
    description     TEXT    NOT NULL DEFAULT '',
    plan_json       TEXT    NOT NULL,
    step_count      INTEGER NOT NULL DEFAULT 0,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
    UNIQUE (profile_id, name)
);
CREATE INDEX IF NOT EXISTS idx_pm_plan_templates_profile ON pm_plan_templates(profile_id, updated_at DESC, id DESC);