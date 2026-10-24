-- Migration 012: link a career milestone to an existing project (schema v12).
--
-- The single "execution bridge" relationship: a portfolio-style milestone can
-- point at a real project the student is already tracking. Deliberately ONE
-- nullable reference column, not a polymorphic link table — type-safe, trivially
-- queryable, and extensible later by adding sibling columns/tables per domain.
--
-- Deletion semantics (enforced in the Rust domain + resolved via LEFT JOIN, NOT
-- via SQLite FK — runtime pooled connections run with foreign_keys OFF):
--   * deleting the project leaves the milestone intact; the reference simply
--     resolves to "missing" (linked_project_name = NULL) and the UI offers to
--     clear/relink.
--   * deleting the milestone never touches the project.
-- Cross-profile links are rejected in set_career_milestone_project.

ALTER TABLE career_milestones ADD COLUMN linked_project_id INTEGER;  -- NULL = no linked project
