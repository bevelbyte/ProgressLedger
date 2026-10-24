-- Migration 014: structural subject identity for courses (schema version 14).
--
-- courses.subject_id becomes the authoritative link between a graded course
-- row and its subject. Nullable by design: rows that cannot be linked
-- deterministically are PRESERVED with NULL and keep working through the
-- legacy (semester_label + course_name) resolution until the planner links
-- them during its next save.
--
-- Backfill rules (deliberately conservative):
--   * Same profile only — resolved through subjects -> milestones ->
--     semesters -> tracks.profile_id, so a profile-A course can never attach
--     to a profile-B subject.
--   * Same semester (semesters.name == courses.semester_label).
--   * Name equality on trimmed lower-case text (the legacy identity).
--   * Exactly ONE candidate subject, else the row stays NULL: ambiguity is
--     reported by remaining visible as NULL, never guessed.
-- Idempotent: already-linked rows are skipped (subject_id IS NULL guard) and
-- the COUNT(*) = 1 guard makes re-runs converge to the same result.
-- Fresh installs: tables are empty, so this is a no-op.

ALTER TABLE courses ADD COLUMN subject_id INTEGER;

UPDATE courses
SET subject_id = (
  SELECT s.id
  FROM subjects s
  JOIN milestones m ON m.id = s.milestone_id
  JOIN semesters se ON se.id = m.semester_id
  JOIN tracks t ON t.id = se.track_id
  WHERE t.profile_id = courses.profile_id
    AND se.name = courses.semester_label
    AND lower(trim(s.name)) = lower(trim(courses.course_name))
)
WHERE subject_id IS NULL
  AND (
    SELECT COUNT(*)
    FROM subjects s
    JOIN milestones m ON m.id = s.milestone_id
    JOIN semesters se ON se.id = m.semester_id
    JOIN tracks t ON t.id = se.track_id
    WHERE t.profile_id = courses.profile_id
      AND se.name = courses.semester_label
      AND lower(trim(s.name)) = lower(trim(courses.course_name))
  ) = 1;
