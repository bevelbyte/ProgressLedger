-- CareerFlow-owned embedded-browser Research ledger. Separate from academic resources.
CREATE TABLE IF NOT EXISTS research_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    canonical_url TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    domain TEXT NOT NULL,
    saved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
    UNIQUE(profile_id, canonical_url)
);

CREATE TABLE IF NOT EXISTS research_captures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    source_id INTEGER NOT NULL,
    source_url TEXT NOT NULL,
    source_title TEXT NOT NULL,
    page_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('clip','highlight','extraction')),
    text TEXT NOT NULL CHECK(length(trim(text)) > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
    FOREIGN KEY (source_id) REFERENCES research_sources(id) ON DELETE CASCADE,
    UNIQUE(profile_id, source_id, kind, text)
);

CREATE INDEX IF NOT EXISTS idx_research_sources_profile_saved
    ON research_sources(profile_id, saved_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_research_captures_profile_created
    ON research_captures(profile_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_research_captures_source_kind
    ON research_captures(source_id, kind);
