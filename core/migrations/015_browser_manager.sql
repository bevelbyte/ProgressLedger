-- Migration 015: Donut Browser Manager (schema version 15).
--
-- CareerFlow-managed browser profiles: durable metadata for isolated Donut
-- browser identities the user manages through the Browser tab.
--
-- Ownership model:
--   * browser_profiles.cf_profile_id -> profiles.id (ON DELETE CASCADE):
--     deleting a CareerFlow profile removes its managed browser profiles and,
--     through the cascade below, their shortcuts. The machine-local binding
--     to the actual Donut profile UUID deliberately lives OUTSIDE the database
--     (workspace-level donut-bindings.json) so it is never exported as
--     portable data and never survives as a dangling pointer in backups.
--   * local_id is CareerFlow-generated (UUID) and stable across machines;
--     the Donut UUID is resolved lazily at open time by the main process.

CREATE TABLE browser_profiles (
  local_id TEXT PRIMARY KEY,
  cf_profile_id INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  FOREIGN KEY (cf_profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE INDEX idx_browser_profiles_cf ON browser_profiles(cf_profile_id);

CREATE TABLE browser_shortcuts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  browser_profile_id TEXT NOT NULL,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (browser_profile_id)
    REFERENCES browser_profiles(local_id) ON DELETE CASCADE
);

CREATE INDEX idx_browser_shortcuts_bp ON browser_shortcuts(browser_profile_id);
