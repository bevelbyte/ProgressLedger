-- Migration 026: browser profiles settings (Phase 3B) + ledger profile link + workspace live cap.
--
-- V2-33: browser_profiles (015) is REUSED, not replaced. Its columns are
-- generic; this migration adds the Phase 3B settings. browser_shortcuts
-- stays untouched as history (3B has no shortcuts).
--
-- Browser profile ids are TEXT local_ids of the form "bp-<uuid>" (the
-- shell mints them with crypto.randomUUID). The "bp-" prefix guarantees
-- the value is never mistaken for an integer when stored in an
-- INTEGER-affinity column (browser_tabs.browser_profile_id below).

-- 1. New settings columns on browser_profiles.
ALTER TABLE browser_profiles ADD COLUMN color TEXT;
ALTER TABLE browser_profiles ADD COLUMN icon TEXT;
ALTER TABLE browser_profiles ADD COLUMN notes TEXT NOT NULL DEFAULT '';
ALTER TABLE browser_profiles ADD COLUMN type TEXT NOT NULL DEFAULT 'persistent';
ALTER TABLE browser_profiles ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
ALTER TABLE browser_profiles ADD COLUMN proxy_mode TEXT NOT NULL DEFAULT 'none';
ALTER TABLE browser_profiles ADD COLUMN proxy_host TEXT;
ALTER TABLE browser_profiles ADD COLUMN proxy_port INTEGER;
ALTER TABLE browser_profiles ADD COLUMN proxy_username TEXT;
ALTER TABLE browser_profiles ADD COLUMN proxy_password_encrypted TEXT;
ALTER TABLE browser_profiles ADD COLUMN proxy_bypass TEXT NOT NULL DEFAULT '<local>';
ALTER TABLE browser_profiles ADD COLUMN language TEXT;
ALTER TABLE browser_profiles ADD COLUMN user_agent_preset TEXT;
ALTER TABLE browser_profiles ADD COLUMN webrtc_policy TEXT NOT NULL DEFAULT 'default_public_interface_only';
ALTER TABLE browser_profiles ADD COLUMN permissions_allow TEXT NOT NULL DEFAULT '["clipboard-sanitized-write","fullscreen"]';
ALTER TABLE browser_profiles ADD COLUMN gpc INTEGER NOT NULL DEFAULT 0;
ALTER TABLE browser_profiles ADD COLUMN dnt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE browser_profiles ADD COLUMN block_third_party_cookies INTEGER NOT NULL DEFAULT 0;
ALTER TABLE browser_profiles ADD COLUMN clear_on_close INTEGER NOT NULL DEFAULT 0;
ALTER TABLE browser_profiles ADD COLUMN download_dir TEXT;

-- One default profile per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_profiles_default
    ON browser_profiles(cf_profile_id) WHERE is_default = 1;

-- 2. Default profile row for every workspace that lacks one. The id is
-- "bp-" plus 32 hex chars (never a bare integer, never user text).
INSERT INTO browser_profiles
    (local_id, cf_profile_id, display_name, position, enabled, created_at, last_used_at, is_default)
SELECT 'bp-' || lower(hex(randomblob(16))), id, 'Default', 0, 1,
       strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), NULL, 1
FROM profiles
WHERE NOT EXISTS (
    SELECT 1 FROM browser_profiles bp
    WHERE bp.cf_profile_id = profiles.id AND bp.is_default = 1
);

-- 3. Repoint Phase 3 tab rows (browser_profile_id = workspace id) to the
-- workspace's default browser profile. After this, every browser_tabs
-- row carries a "bp-..." text id.
UPDATE browser_tabs
SET browser_profile_id = (
    SELECT bp.local_id FROM browser_profiles bp
    WHERE bp.cf_profile_id = browser_tabs.profile_id AND bp.is_default = 1
)
WHERE browser_profile_id = profile_id;

-- 4. Ledger link: each capture records the browser profile id + name at
-- capture time (denormalized, so the chip survives profile deletion).
-- NULL means no browser profile (manual passage, or a pre-3B entry).
ALTER TABLE research_sources ADD COLUMN browser_profile_id TEXT;
ALTER TABLE research_sources ADD COLUMN browser_profile_name TEXT;
ALTER TABLE research_captures ADD COLUMN browser_profile_id TEXT;
ALTER TABLE research_captures ADD COLUMN browser_profile_name TEXT;

-- 5. Workspace live-page cap (Phase 3 hardcoded 5; now configurable).
ALTER TABLE profiles ADD COLUMN browser_live_cap INTEGER NOT NULL DEFAULT 5;
