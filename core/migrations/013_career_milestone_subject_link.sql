-- Migration 013: link a career milestone to a subject (schema version 13).
-- Additive column on career_milestones, nullable.
-- Deletion semantics are enforced in Rust (not via SQLite FK).

ALTER TABLE career_milestones ADD COLUMN linked_subject_id INTEGER;