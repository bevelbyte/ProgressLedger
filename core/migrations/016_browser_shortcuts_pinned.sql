-- Migration 016: Quick Actions pin state.
--
-- Adds a single boolean column to the existing browser_shortcuts table.
-- No new tables, no duplicated state. The Quick Actions panel is a read-only
-- view of this column, restricted to the active CareerFlow profile's rows.
--
-- A small partial index keeps the pinned-row query at O(pinned) regardless of
-- the size of the shortcut table — the panel's hot path is
-- `WHERE pinned = 1 AND cf_profile_id = ?` joined back through browser_profiles.
--
-- The pin is portable user intent, NOT a machine-local identifier, so the
-- portability v2 export carries it across machines; the restored row's
-- local id is freshly minted and a fresh `bfc-<localId>` Donut binding is
-- resolved lazily on the new machine.

ALTER TABLE browser_shortcuts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_browser_shortcuts_pinned
  ON browser_shortcuts(browser_profile_id, pinned)
  WHERE pinned = 1;
