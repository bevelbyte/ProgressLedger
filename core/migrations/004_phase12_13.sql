-- Migration 004: Phase 12 (BTech Trackers & Formulas) + Phase 13 (Focus Curtain)
-- Version: 4

--------------------------------------------------------------------------------
-- Phase 12: CGPA/SGPA Planner
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS courses (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id      INTEGER NOT NULL,
    semester_label  TEXT    NOT NULL,
    course_name     TEXT    NOT NULL,
    credits         REAL    NOT NULL DEFAULT 0,
    grade           TEXT,
    grade_points    REAL,
    is_hypothetical INTEGER NOT NULL DEFAULT 0,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_courses_profile ON courses(profile_id);
CREATE INDEX IF NOT EXISTS idx_courses_semester ON courses(profile_id, semester_label);

--------------------------------------------------------------------------------
-- Phase 12: Lab Record & Viva Tracker
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lab_experiments (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id       INTEGER NOT NULL,
    experiment_no    INTEGER NOT NULL,
    title            TEXT    NOT NULL,
    record_submitted INTEGER NOT NULL DEFAULT 0,
    viva_done        INTEGER NOT NULL DEFAULT 0,
    viva_score       TEXT,
    notes            TEXT,
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lab_experiments_subject ON lab_experiments(subject_id);

--------------------------------------------------------------------------------
-- Phase 12: Project Tracker
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id   INTEGER NOT NULL,
    name         TEXT    NOT NULL,
    project_type TEXT    NOT NULL DEFAULT 'other',  -- mini | major | other
    status       TEXT    NOT NULL DEFAULT 'planning', -- planning | active | completed
    deadline     TEXT,
    description  TEXT,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_projects_profile ON projects(profile_id);

CREATE TABLE IF NOT EXISTS project_tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL,
    title       TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'todo', -- todo | in_progress | done
    priority    TEXT    NOT NULL DEFAULT 'medium', -- low | medium | high
    due_date    TEXT,
    notes       TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks(project_id);

--------------------------------------------------------------------------------
-- Phase 12: Formula Board
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS formulas (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id    INTEGER NOT NULL,
    title         TEXT    NOT NULL,
    latex_content TEXT    NOT NULL,
    category      TEXT,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_formulas_subject ON formulas(subject_id);

--------------------------------------------------------------------------------
-- Phase 13: Focus Curtain
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS focus_settings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id      INTEGER NOT NULL UNIQUE,
    is_enabled      INTEGER NOT NULL DEFAULT 0,
    blocked_domains TEXT    NOT NULL DEFAULT '["facebook.com","instagram.com","twitter.com","x.com","reddit.com","tiktok.com","snapchat.com"]',
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);
