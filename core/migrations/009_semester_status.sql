-- Migration 009: explicit, user-declared semester status (schema version 9).
--
-- Semester status is the student's DECLARED academic state (Upcoming / In
-- Progress / Completed). It is a distinct concept from:
--   * semester progress — DERIVED from course/subject data (never stored),
--   * SGPA/CGPA          — computed by the Rust domain from graded courses.
-- Previously the CGPA UI kept status only in memory and the mapper re-DERIVED it
-- from subject statuses on reload, so a user's declaration was silently
-- overwritten when course data changed. Persisting it here makes it durable and
-- independent of marks. `semesters` already models the semester entity, so this
-- is a single additive column — no separate table.
-- NEVER edit a shipped migration — this only adds a column.

ALTER TABLE semesters ADD COLUMN status TEXT NOT NULL DEFAULT 'Upcoming';
