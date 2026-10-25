-- Pending partition deletes (Phase 3B delete fix, V2-39).
-- Electron keeps a partition folder locked while the app runs, and a
-- session object that outlives its views can recreate the folder after
-- a delete (Diag3/Diag4: rm succeeded, dir back with cache files).
-- So a delete that cannot remove the folder while running records the
-- folder here, and the shell removes it at the next app start (and at
-- quit if possible). The row is removed only after the folder is gone,
-- so a failed removal is retried next start, never silently dropped.
CREATE TABLE IF NOT EXISTS browser_profile_pending_deletes (
  local_id TEXT PRIMARY KEY,
  partition_name TEXT NOT NULL,
  workspace_profile_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
