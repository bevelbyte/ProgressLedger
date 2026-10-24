-- Migration 010: deadline completion lifecycle (schema version 10).
--
-- A deadline is an academic task with a lifecycle: active (Upcoming/Due/Overdue)
-- -> completed -> optionally reopened. Completion is a nullable timestamp,
-- independent of the deadline DATE:
--   completed_at IS NULL     -> active (classified by deadline_date as before)
--   completed_at IS NOT NULL -> completed (excluded from overdue/due/attention)
-- Existing rows default to NULL, i.e. remain active. Additive only; never edits
-- a shipped migration and never rewrites the deadlines table.

ALTER TABLE deadlines ADD COLUMN completed_at TEXT;  -- ISO datetime, NULL = active
