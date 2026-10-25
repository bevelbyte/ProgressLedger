-- Research sources are per (workspace profile, browser profile, URL),
-- not per (workspace profile, URL). Before this migration, two browser
-- profiles capturing the same URL collided on UNIQUE(profile_id,
-- canonical_url): the second capture updated the first profile's row
-- (keeping its browser_profile_id) and overwrote its text, so B/C/D/F
-- captures of /state never created their own rows (Iso13: only the A
-- row existed after A, B and C captures). Rebuild the table with the
-- browser profile in the unique key. The rebuild runs with foreign
-- keys OFF (see migrations.rs for version 27): with FK ON, dropping
-- the parent would cascade-delete research_captures and
-- research_source_texts rows; with FK OFF they survive, and RENAME
-- re-points their FK definitions at the rebuilt table. Source ids are
-- preserved, so the FTS index (keyed by source_id) stays valid.
CREATE TABLE IF NOT EXISTS research_sources_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    canonical_url TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    domain TEXT NOT NULL,
    saved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    content_file TEXT,
    content_sha256 TEXT,
    text_length INTEGER NOT NULL DEFAULT 0,
    text_truncated INTEGER NOT NULL DEFAULT 0,
    browser_profile_id TEXT,
    browser_profile_name TEXT,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    -- No table-level UNIQUE here on purpose: a plain UNIQUE treats
    -- NULL browser ids as distinct, so two manual (no-browser) saves
    -- of the same URL would create two rows instead of updating one.
    -- Uniqueness lives in the two partial indexes below instead.
);
INSERT INTO research_sources_new (id, profile_id, canonical_url, url, title, domain, saved_at, content_file, content_sha256, text_length, text_truncated, browser_profile_id, browser_profile_name)
    SELECT id, profile_id, canonical_url, url, title, domain, saved_at, content_file, content_sha256, text_length, text_truncated, browser_profile_id, browser_profile_name FROM research_sources;
DROP TABLE research_sources;
ALTER TABLE research_sources_new RENAME TO research_sources;
CREATE INDEX IF NOT EXISTS idx_research_sources_profile_saved
    ON research_sources(profile_id, saved_at DESC, id DESC);
-- One source per (workspace, browser profile, URL) when a browser
-- profile exists, and one per (workspace, URL) when it does not.
-- Partial indexes, because a plain UNIQUE would let NULL browser
-- rows duplicate (NULL != NULL in a unique index).
CREATE UNIQUE INDEX IF NOT EXISTS idx_research_sources_browser
    ON research_sources(profile_id, browser_profile_id, canonical_url)
    WHERE browser_profile_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_research_sources_no_browser
    ON research_sources(profile_id, canonical_url)
    WHERE browser_profile_id IS NULL;
