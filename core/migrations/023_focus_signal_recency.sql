-- Migration 023: indexes supporting bounded focus-signal recency queries.
CREATE INDEX IF NOT EXISTS idx_sessions_started ON session_states(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_subject_started ON session_states(subject_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_mistakes_subject_created ON mistakes(subject_id, created_at DESC);
