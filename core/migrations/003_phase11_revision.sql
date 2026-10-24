-- 003_phase11_revision.sql— Phase 11 Sprint 1 tables (schema version 3).
-- Adds: deadlines, mistakes, cards (SM-2 spaced repetition), subject_links.

-- ===== Deadline Radar =====
-- Tracks exam dates, placement deadlines, GATE dates, etc.
-- Linked to subjects so cascade deletes work properly.
CREATE TABLE IF NOT EXISTS deadlines (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id    INTEGER NOT NULL,
    deadline_date TEXT NOT NULL,                    -- ISO date: YYYY-MM-DD
    category      TEXT NOT NULL DEFAULT 'exam',     -- exam | placement | gate | custom
    title         TEXT NOT NULL,
    notes         TEXT DEFAULT '',
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_deadlines_subject ON deadlines(subject_id);
CREATE INDEX IF NOT EXISTS idx_deadlines_date ON deadlines(deadline_date);

-- ===== Mistake Ledger =====
-- Logs errors from practice tests/assignments with type tagging.
-- mistake_type: conceptual | calculation | formula | silly | time_management
CREATE TABLE IF NOT EXISTS mistakes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id       INTEGER NOT NULL,
    question_text    TEXT NOT NULL,
    mistake_type     TEXT NOT NULL DEFAULT 'conceptual',
    correct_approach TEXT DEFAULT '',
    tags             TEXT DEFAULT '[]',              -- JSON array of strings
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mistakes_subject ON mistakes(subject_id);
CREATE INDEX IF NOT EXISTS idx_mistakes_type ON mistakes(mistake_type);

-- ===== Recall Deck (SM-2 Spaced Repetition) =====
-- Flashcards for formulas, derivations, key concepts.
-- SM-2 fields: ease_factor (default 2.5), interval (days), repetitions, due_date
CREATE TABLE IF NOT EXISTS cards (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id    INTEGER NOT NULL,
    front         TEXT NOT NULL,                    -- Question/prompt (supports LaTeX)
    back          TEXT NOT NULL,                    -- Answer (supports LaTeX)
    ease_factor   REAL NOT NULL DEFAULT 2.5,        -- SM-2 ease factor (min 1.3)
    interval_days INTEGER NOT NULL DEFAULT 0,       -- Days until next review
    repetitions   INTEGER NOT NULL DEFAULT 0,       -- Consecutive correct reviews
    due_date      TEXT NOT NULL,                    -- ISO date: YYYY-MM-DD
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_reviewed DATETIME,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cards_subject ON cards(subject_id);
CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due_date);

-- ===== Subject Links =====
-- Bookmarks study URLs (Wikipedia, YouTube, NPTEL, etc.) to subjects.
-- is_primary marks the "main" research URL for quick access.
CREATE TABLE IF NOT EXISTS subject_links (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id  INTEGER NOT NULL,
    label       TEXT NOT NULL,
    url         TEXT NOT NULL,
    is_primary  INTEGER NOT NULL DEFAULT 0,         -- 0 = false, 1 = true
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subject_links_subject ON subject_links(subject_id);
