-- Migration 008: CGPA domain becomes SQLite-authoritative (schema version 8).
--
-- The legacy CGPA Planner stored an entire degree/semester/subject/marks tree in
-- localStorage["progressledger_v2_degree_data_<profileId>"] and computed "SGPA" as
-- percentage/10 with no credits. This migration makes the `courses` table the
-- single source of truth for credit-weighted CGPA:
--   * courses gains marks (obtained/max) so grade points can be DERIVED from a
--     configurable per-profile grade scale, per Progress Ledger's authoritative model
--     (marks -> percentage -> grade point -> credit x GP -> SGPA -> CGPA).
--   * grade_scales / grade_bands store each profile's percentage->grade-point
--     mapping. Not assumed to be 10-point; any number of bands is allowed.
-- NEVER edit a shipped migration — this only adds columns/tables.

-- Marks on courses (nullable: a planned/not-yet-taken course has no marks yet).
ALTER TABLE courses ADD COLUMN marks_obtained REAL;   -- raw obtained marks
ALTER TABLE courses ADD COLUMN max_marks      REAL;   -- raw maximum marks

-- One grade scale per profile (id kept for future "named scales" without a rewrite).
CREATE TABLE IF NOT EXISTS grade_scales (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id  INTEGER NOT NULL UNIQUE,
    name        TEXT    NOT NULL DEFAULT 'Default',
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- Bands of a scale: percentage >= min_percent earns grade_point. Highest matching
-- band wins (resolved in the Rust domain layer). label is display-only.
CREATE TABLE IF NOT EXISTS grade_bands (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    scale_id      INTEGER NOT NULL,
    min_percent   REAL    NOT NULL,
    grade_point   REAL    NOT NULL,
    label         TEXT    NOT NULL DEFAULT '',
    sort_order    INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (scale_id) REFERENCES grade_scales(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_grade_bands_scale ON grade_bands(scale_id);
