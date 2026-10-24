-- Phase 3 browser port: full page text, FTS search, and tab state.
-- Snapshots themselves are files under the shell's vault/sources dir;
-- the database stores only the file NAME (never a path) plus its SHA-256,
-- so a database copy never leaks a filesystem layout.
ALTER TABLE research_sources ADD COLUMN content_file TEXT;
ALTER TABLE research_sources ADD COLUMN content_sha256 TEXT;
ALTER TABLE research_sources ADD COLUMN text_length INTEGER NOT NULL DEFAULT 0;
ALTER TABLE research_sources ADD COLUMN text_truncated INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS research_source_texts (
    source_id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    FOREIGN KEY (source_id) REFERENCES research_sources(id) ON DELETE CASCADE
);

-- Unified full-text index (Progress Ledger style, explicit inserts, no
-- triggers): sources and kept passages in one index, so one search
-- finds both. kind/profile_id/source_id/capture_id are metadata
-- (UNINDEXED: stored, not tokenized); title and body are searchable.
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
    kind UNINDEXED,
    profile_id UNINDEXED,
    source_id UNINDEXED,
    capture_id UNINDEXED,
    title,
    body
);

-- Backfill: passages saved before FTS existed become searchable.
-- Sources have no text yet (the texts table is new), so there is
-- nothing to backfill for them.
INSERT INTO search_index(kind, profile_id, source_id, capture_id, title, body)
    SELECT 'passage', profile_id, source_id, id, source_title, text
    FROM research_captures;

-- Browser tabs that survive a restart. browser_profile_id is the
-- workspace profile id in Phase 3; Phase 3B repoints it at real
-- browser-profile ids. Position is repaired in code on close, so there
-- is deliberately no unique constraint on it.
CREATE TABLE IF NOT EXISTS browser_tabs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    browser_profile_id INTEGER NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_browser_tabs_profile_position
    ON browser_tabs(profile_id, position, id);
