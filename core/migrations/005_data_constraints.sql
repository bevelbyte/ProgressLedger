-- Migration 005: Add CHECK constraints and TRIGGERs for data consistency
-- Since SQLite does not support ALTER TABLE ADD CHECK, we use TRIGGERs to enforce validation.

-- Repair (CareerFlow successor): this migration previously created triggers on a
-- `session_states` table that no earlier migration ever defined, so FRESH
-- database initialization failed at version 5. Databases that had already
-- reached v5+ predate the broken edit and are unaffected (migrations are
-- version-gated). The table is now defined here, before its triggers.
CREATE TABLE IF NOT EXISTS session_states (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id       INTEGER NOT NULL,
    started_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at         TEXT,
    duration_minutes INTEGER NOT NULL DEFAULT 0,
    notes            TEXT NOT NULL DEFAULT '',
    updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);

-- Ensure credits are positive and reasonable
CREATE TRIGGER IF NOT EXISTS check_courses_credits_insert
BEFORE INSERT ON courses WHEN NEW.credits <= 0 OR NEW.credits > 20
BEGIN SELECT RAISE(ABORT, 'credits must be between 1 and 20'); END;

CREATE TRIGGER IF NOT EXISTS check_courses_credits_update
BEFORE UPDATE ON courses WHEN NEW.credits <= 0 OR NEW.credits > 20
BEGIN SELECT RAISE(ABORT, 'credits must be between 1 and 20'); END;

-- Ensure grade_points are within valid range (0-10)
CREATE TRIGGER IF NOT EXISTS check_courses_grade_points_insert
BEFORE INSERT ON courses WHEN NEW.grade_points IS NOT NULL AND (NEW.grade_points < 0 OR NEW.grade_points > 10)
BEGIN SELECT RAISE(ABORT, 'grade_points must be between 0 and 10'); END;

CREATE TRIGGER IF NOT EXISTS check_courses_grade_points_update
BEFORE UPDATE ON courses WHEN NEW.grade_points IS NOT NULL AND (NEW.grade_points < 0 OR NEW.grade_points > 10)
BEGIN SELECT RAISE(ABORT, 'grade_points must be between 0 and 10'); END;

-- Ensure ease_factor in SM-2 cards is valid (minimum 1.3)
CREATE TRIGGER IF NOT EXISTS check_cards_ease_factor_insert
BEFORE INSERT ON cards WHEN NEW.ease_factor < 1.3
BEGIN SELECT RAISE(ABORT, 'ease_factor must be >= 1.3'); END;

CREATE TRIGGER IF NOT EXISTS check_cards_ease_factor_update
BEFORE UPDATE ON cards WHEN NEW.ease_factor < 1.3
BEGIN SELECT RAISE(ABORT, 'ease_factor must be >= 1.3'); END;

-- Ensure interval_days is non-negative
CREATE TRIGGER IF NOT EXISTS check_cards_interval_insert
BEFORE INSERT ON cards WHEN NEW.interval_days < 0
BEGIN SELECT RAISE(ABORT, 'interval_days must be >= 0'); END;

CREATE TRIGGER IF NOT EXISTS check_cards_interval_update
BEFORE UPDATE ON cards WHEN NEW.interval_days < 0
BEGIN SELECT RAISE(ABORT, 'interval_days must be >= 0'); END;

-- Ensure repetitions is non-negative
CREATE TRIGGER IF NOT EXISTS check_cards_repetitions_insert
BEFORE INSERT ON cards WHEN NEW.repetitions < 0
BEGIN SELECT RAISE(ABORT, 'repetitions must be >= 0'); END;

CREATE TRIGGER IF NOT EXISTS check_cards_repetitions_update
BEFORE UPDATE ON cards WHEN NEW.repetitions < 0
BEGIN SELECT RAISE(ABORT, 'repetitions must be >= 0'); END;

-- Ensure experiment_no is positive
CREATE TRIGGER IF NOT EXISTS check_lab_exp_no_insert
BEFORE INSERT ON lab_experiments WHEN NEW.experiment_no <= 0
BEGIN SELECT RAISE(ABORT, 'experiment_no must be > 0'); END;

CREATE TRIGGER IF NOT EXISTS check_lab_exp_no_update
BEFORE UPDATE ON lab_experiments WHEN NEW.experiment_no <= 0
BEGIN SELECT RAISE(ABORT, 'experiment_no must be > 0'); END;

-- Ensure subject status is valid
CREATE TRIGGER IF NOT EXISTS check_subject_status_insert
BEFORE INSERT ON subjects WHEN NEW.status NOT IN ('pending', 'in_progress', 'done')
BEGIN SELECT RAISE(ABORT, 'invalid subject status'); END;

CREATE TRIGGER IF NOT EXISTS check_subject_status_update
BEFORE UPDATE ON subjects WHEN NEW.status NOT IN ('pending', 'in_progress', 'done')
BEGIN SELECT RAISE(ABORT, 'invalid subject status'); END;

-- Ensure project status is valid
CREATE TRIGGER IF NOT EXISTS check_project_status_insert
BEFORE INSERT ON projects WHEN NEW.status NOT IN ('planning', 'in_progress', 'on_hold', 'completed', 'cancelled')
BEGIN SELECT RAISE(ABORT, 'invalid project status'); END;

CREATE TRIGGER IF NOT EXISTS check_project_status_update
BEFORE UPDATE ON projects WHEN NEW.status NOT IN ('planning', 'in_progress', 'on_hold', 'completed', 'cancelled')
BEGIN SELECT RAISE(ABORT, 'invalid project status'); END;

-- Ensure project task status is valid
CREATE TRIGGER IF NOT EXISTS check_project_task_status_insert
BEFORE INSERT ON project_tasks WHEN NEW.status NOT IN ('todo', 'in_progress', 'done', 'cancelled')
BEGIN SELECT RAISE(ABORT, 'invalid project task status'); END;

CREATE TRIGGER IF NOT EXISTS check_project_task_status_update
BEFORE UPDATE ON project_tasks WHEN NEW.status NOT IN ('todo', 'in_progress', 'done', 'cancelled')
BEGIN SELECT RAISE(ABORT, 'invalid project task status'); END;

-- Ensure project task priority is valid
CREATE TRIGGER IF NOT EXISTS check_project_task_priority_insert
BEFORE INSERT ON project_tasks WHEN NEW.priority NOT IN ('low', 'medium', 'high', 'urgent')
BEGIN SELECT RAISE(ABORT, 'invalid project task priority'); END;

CREATE TRIGGER IF NOT EXISTS check_project_task_priority_update
BEFORE UPDATE ON project_tasks WHEN NEW.priority NOT IN ('low', 'medium', 'high', 'urgent')
BEGIN SELECT RAISE(ABORT, 'invalid project task priority'); END;

-- Ensure deadline category is valid
CREATE TRIGGER IF NOT EXISTS check_deadline_category_insert
BEFORE INSERT ON deadlines WHEN NEW.category NOT IN ('exam', 'assignment', 'project', 'placement', 'gate', 'certification', 'other')
BEGIN SELECT RAISE(ABORT, 'invalid deadline category'); END;

CREATE TRIGGER IF NOT EXISTS check_deadline_category_update
BEFORE UPDATE ON deadlines WHEN NEW.category NOT IN ('exam', 'assignment', 'project', 'placement', 'gate', 'certification', 'other')
BEGIN SELECT RAISE(ABORT, 'invalid deadline category'); END;

-- Ensure mistake_type is valid
CREATE TRIGGER IF NOT EXISTS check_mistake_type_insert
BEFORE INSERT ON mistakes WHEN NEW.mistake_type NOT IN ('conceptual', 'calculation', 'formula', 'silly', 'time_management', 'other')
BEGIN SELECT RAISE(ABORT, 'invalid mistake type'); END;

CREATE TRIGGER IF NOT EXISTS check_mistake_type_update
BEFORE UPDATE ON mistakes WHEN NEW.mistake_type NOT IN ('conceptual', 'calculation', 'formula', 'silly', 'time_management', 'other')
BEGIN SELECT RAISE(ABORT, 'invalid mistake type'); END;

-- Ensure resource kind is valid
CREATE TRIGGER IF NOT EXISTS check_resource_kind_insert
BEFORE INSERT ON resources WHEN NEW.kind NOT IN ('note', 'pdf', 'link', 'other')
BEGIN SELECT RAISE(ABORT, 'invalid resource kind'); END;

CREATE TRIGGER IF NOT EXISTS check_resource_kind_update
BEFORE UPDATE ON resources WHEN NEW.kind NOT IN ('note', 'pdf', 'link', 'other')
BEGIN SELECT RAISE(ABORT, 'invalid resource kind'); END;

-- Ensure project_type is valid
CREATE TRIGGER IF NOT EXISTS check_project_type_insert
BEFORE INSERT ON projects WHEN NEW.project_type NOT IN ('mini', 'major', 'capstone', 'research', 'other')
BEGIN SELECT RAISE(ABORT, 'invalid project type'); END;

CREATE TRIGGER IF NOT EXISTS check_project_type_update
BEFORE UPDATE ON projects WHEN NEW.project_type NOT IN ('mini', 'major', 'capstone', 'research', 'other')
BEGIN SELECT RAISE(ABORT, 'invalid project type'); END;

-- TRIGGER: Ensure only one primary link per subject
CREATE TRIGGER IF NOT EXISTS single_primary_link_per_subject
BEFORE UPDATE OF is_primary ON subject_links
WHEN NEW.is_primary = 1
BEGIN
    UPDATE subject_links SET is_primary = 0 
    WHERE subject_id = NEW.subject_id AND id != NEW.id;
END;

-- TRIGGER: Update updated_at timestamp on session_states modification
CREATE TRIGGER IF NOT EXISTS update_session_state_timestamp
AFTER UPDATE ON session_states
BEGIN
    UPDATE session_states SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;









-- TRIGGER: Cascade delete project tasks when project is deleted
CREATE TRIGGER IF NOT EXISTS cascade_delete_project_tasks
AFTER DELETE ON projects
BEGIN
    DELETE FROM project_tasks WHERE project_id = OLD.id;
END;

-- TRIGGER: Cascade delete lab experiments when subject is deleted
CREATE TRIGGER IF NOT EXISTS cascade_delete_lab_experiments
AFTER DELETE ON subjects
BEGIN
    DELETE FROM lab_experiments WHERE subject_id = OLD.id;
END;

-- TRIGGER: Cascade delete cards when subject is deleted
CREATE TRIGGER IF NOT EXISTS cascade_delete_cards
AFTER DELETE ON subjects
BEGIN
    DELETE FROM cards WHERE subject_id = OLD.id;
END;

-- TRIGGER: Cascade delete deadlines when subject is deleted
CREATE TRIGGER IF NOT EXISTS cascade_delete_deadlines
AFTER DELETE ON subjects
BEGIN
    DELETE FROM deadlines WHERE subject_id = OLD.id;
END;

-- TRIGGER: Cascade delete mistakes when subject is deleted
CREATE TRIGGER IF NOT EXISTS cascade_delete_mistakes
AFTER DELETE ON subjects
BEGIN
    DELETE FROM mistakes WHERE subject_id = OLD.id;
END;

-- TRIGGER: Cascade delete subject_links when subject is deleted
CREATE TRIGGER IF NOT EXISTS cascade_delete_subject_links
AFTER DELETE ON subjects
BEGIN
    DELETE FROM subject_links WHERE subject_id = OLD.id;
END;

-- TRIGGER: Cascade delete formulas when subject is deleted
CREATE TRIGGER IF NOT EXISTS cascade_delete_formulas
AFTER DELETE ON subjects
BEGIN
    DELETE FROM formulas WHERE subject_id = OLD.id;
END;

-- TRIGGER: Cascade delete session_states when subject is deleted
CREATE TRIGGER IF NOT EXISTS cascade_delete_session_states
AFTER DELETE ON subjects
BEGIN
    DELETE FROM session_states WHERE subject_id = OLD.id;
END;

-- TRIGGER: Cascade delete resources when subject is deleted
CREATE TRIGGER IF NOT EXISTS cascade_delete_resources
AFTER DELETE ON subjects
BEGIN
    DELETE FROM resources WHERE subject_id = OLD.id;
END;

