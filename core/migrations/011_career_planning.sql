-- Migration 011: Career Planning foundation (schema version 11).
--
-- The academic side answers "what am I doing now?"; this adds the smallest
-- persistent model for "where am I going?": a profile's career GOALS and the
-- ordered MILESTONES toward each goal. Deliberately minimal and additive — no
-- generic task engine, no job/company/application tables (those are future
-- modules that can attach to this foundation without redesign).
--
-- Naming: `career_goals` / `career_milestones` are distinct from the existing
-- academic `milestones` table (semester -> milestone -> subject). No coupling.

CREATE TABLE IF NOT EXISTS career_goals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id   INTEGER NOT NULL,
    title        TEXT    NOT NULL,
    target_role  TEXT,                              -- e.g. "Backend Engineer" (free text; never hardcoded)
    domain       TEXT,                              -- e.g. "Fintech" / "Research"
    description  TEXT,
    target_date  TEXT,                              -- ISO date YYYY-MM-DD, optional
    status       TEXT    NOT NULL DEFAULT 'active', -- active | achieved | paused
    is_primary   INTEGER NOT NULL DEFAULT 0,        -- one primary goal per profile (enforced in domain layer)
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_career_goals_profile ON career_goals(profile_id);

CREATE TABLE IF NOT EXISTS career_milestones (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id      INTEGER NOT NULL,
    title        TEXT    NOT NULL,
    description  TEXT,
    target_date  TEXT,                              -- ISO date, optional
    sort_order   INTEGER NOT NULL DEFAULT 0,        -- explicit ordering within a goal
    completed_at TEXT,                              -- NULL = active, non-NULL = completed (mirrors deadlines)
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (goal_id) REFERENCES career_goals(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_career_milestones_goal ON career_milestones(goal_id);
