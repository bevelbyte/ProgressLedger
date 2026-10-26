//! Browser profiles: isolated browsing identities inside one workspace
//! profile (Phase 3B, V2-33).
//!
//! A workspace profile (the student's profile, `profiles.id`) scopes ALL
//! app data. A browser profile scopes only browsing state: its own
//! persistent Electron partition (cookies, localStorage, sessionStorage,
//! IndexedDB, cache, service workers, permissions, downloads), or, for a
//! temporary profile, an in-memory partition that evaporates on close.
//! Temporary profiles are NEVER database rows; they live only in the
//! shell. Every stored row is a persistent profile.
//!
//! Trust notes:
//! * Partition names come only from validated internal ids (workspace
//!   id + browser local id), never user text. The shell builds the name;
//!   Rust only validates the id shape (see valid_browser_profile_id).
//! * The proxy password column holds an OPAQUE safeStorage blob minted
//!   by the shell. Rust never inspects, decrypts, or logs it; the IPC
//!   strips it before any profile object reaches the renderer. A
//!   profile whose proxy mode is `none` must carry no proxy fields at
//!   all (fail-closed: no stale credentials linger on a direct profile).
//! * `permissions_allow` is a JSON array of permission names, each from
//!   a fixed allowlist. It is validated token by token (no JSON parser
//!   dependency): every token must be exactly a quoted allowlisted name,
//!   so any string passing validation IS a valid array of those names.
//! * The `type` column is exposed to JS as `profileType` (Rust cannot
//!   use `type` as a field name). Stored rows are always `persistent`;
//!   temporary profiles carry `temporary` in memory only.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::params;

use crate::db::{to_err, with_db, with_immediate_transaction};
use crate::errors::{coded, codes};
use crate::validate::{
    bounded_text, enum_value, required_text, text, valid_browser_profile_id, valid_id, MAX_NAME,
};

const PROXY_MODES: &[&str] = &["none", "http", "https", "socks5"];
const WEBRTC_POLICIES: &[&str] = &[
    "default",
    "default_public_interface_only",
    "default_public_and_private_interfaces",
    "disable_non_proxied_udp",
];
const UA_PRESETS: &[&str] = &["default", "windows", "macos", "linux"];
const GRANTABLE_PERMISSIONS: &[&str] = &[
    "camera",
    "microphone",
    "geolocation",
    "notifications",
    "fullscreen",
    "clipboard-sanitized-write",
];
const MAX_NOTES: usize = 2000;
const MAX_BLOB: usize = 4096;

#[napi(object)]
pub struct BrowserProfile {
    pub local_id: String,
    pub profile_id: i32,
    pub display_name: String,
    pub position: i32,
    pub enabled: bool,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub notes: String,
    pub profile_type: String,
    pub is_default: bool,
    pub proxy_mode: String,
    pub proxy_host: Option<String>,
    pub proxy_port: Option<i32>,
    pub proxy_username: Option<String>,
    pub proxy_password_encrypted: Option<String>,
    pub proxy_bypass: String,
    pub language: Option<String>,
    pub user_agent_preset: Option<String>,
    pub webrtc_policy: String,
    pub permissions_allow: String,
    pub gpc: bool,
    pub dnt: bool,
    pub block_third_party_cookies: bool,
    pub clear_on_close: bool,
    pub download_dir: Option<String>,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub start_pages: String,
}

fn profile_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BrowserProfile> {
    let enabled: i32 = row.get(4)?;
    let is_default: i32 = row.get(9)?;
    let gpc: i32 = row.get(19)?;
    let dnt: i32 = row.get(20)?;
    let block_cookies: i32 = row.get(21)?;
    let clear_on_close: i32 = row.get(22)?;
    Ok(BrowserProfile {
        local_id: row.get(0)?,
        profile_id: row.get(1)?,
        display_name: row.get(2)?,
        position: row.get(3)?,
        enabled: enabled != 0,
        color: row.get(5)?,
        icon: row.get(6)?,
        notes: row.get(7)?,
        profile_type: row.get(8)?,
        is_default: is_default != 0,
        proxy_mode: row.get(10)?,
        proxy_host: row.get(11)?,
        proxy_port: row.get(12)?,
        proxy_username: row.get(13)?,
        proxy_password_encrypted: row.get(14)?,
        proxy_bypass: row.get(15)?,
        language: row.get(16)?,
        user_agent_preset: row.get(17)?,
        webrtc_policy: row.get(18)?,
        permissions_allow: row.get(23)?,
        gpc: gpc != 0,
        dnt: dnt != 0,
        block_third_party_cookies: block_cookies != 0,
        clear_on_close: clear_on_close != 0,
        download_dir: row.get(24)?,
        created_at: row.get(25)?,
        last_used_at: row.get(26)?,
        start_pages: row.get(27)?,
    })
}

const PROFILE_COLS: &str = "local_id, cf_profile_id, display_name, position, enabled, \
    color, icon, notes, type, is_default, proxy_mode, proxy_host, proxy_port, \
    proxy_username, proxy_password_encrypted, proxy_bypass, language, \
    user_agent_preset, webrtc_policy, gpc, dnt, block_third_party_cookies, \
    clear_on_close, permissions_allow, download_dir, created_at, last_used_at, start_pages";

fn valid_start_pages(value: String) -> Result<String> {
    // Stored exactly as the UI edits it: one URL per line. Empty lines
    // are dropped. Every remaining line must be an http(s) URL with a
    // host; localhost and private hosts are allowed here (start pages
    // are the user's own choice, unlike a fetched test URL). At most
    // 20 pages, each at most 2048 chars.
    let mut kept: Vec<&str> = Vec::new();
    for raw in value.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if kept.len() >= 20 || line.len() > 2048 || line.chars().any(|c| c.is_whitespace()) {
            return Err(coded(
                codes::INVALID_INPUT,
                "start pages must be at most 20 http(s) URLs, one per line",
            ));
        }
        let rest = line
            .strip_prefix("http://")
            .or_else(|| line.strip_prefix("https://"));
        let Some(rest) = rest else {
            return Err(coded(
                codes::INVALID_INPUT,
                "start pages must be http(s) URLs, one per line",
            ));
        };
        let host = rest.split(['/', '?', '#']).next().unwrap_or("");
        if host.is_empty() {
            return Err(coded(
                codes::INVALID_INPUT,
                "start pages must be http(s) URLs, one per line",
            ));
        }
        kept.push(line);
    }
    Ok(kept.join("\n"))
}

fn valid_color(value: Option<String>) -> Result<Option<String>> {
    match value {
        None => Ok(None),
        Some(s) => {
            let ok = s.len() == 7
                && s.starts_with('#')
                && s[1..].chars().all(|c| c.is_ascii_hexdigit());
            if !ok {
                return Err(coded(
                    codes::INVALID_INPUT,
                    "color must be a #RRGGBB hex color",
                ));
            }
            Ok(Some(s))
        }
    }
}

fn valid_icon(value: Option<String>) -> Result<Option<String>> {
    match value {
        None => Ok(None),
        Some(s) => {
            let ok = !s.is_empty()
                && s.len() <= 40
                && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
            if !ok {
                return Err(coded(
                    codes::INVALID_INPUT,
                    "icon must be a short icon name (letters, digits, - or _)",
                ));
            }
            Ok(Some(s))
        }
    }
}

fn valid_language(value: Option<String>) -> Result<Option<String>> {
    match value {
        None => Ok(None),
        Some(s) => {
            let ok = {
                let parts: Vec<&str> = s.split('-').collect();
                (parts.len() == 1 || parts.len() == 2)
                    && parts[0].len() == 2
                    && parts[0].chars().all(|c| c.is_ascii_lowercase())
                    && (parts.len() == 1
                        || (parts[1].len() == 2
                            && parts[1].chars().all(|c| c.is_ascii_uppercase())))
            };
            if !ok {
                return Err(coded(
                    codes::INVALID_INPUT,
                    "language must look like en or en-US",
                ));
            }
            Ok(Some(s))
        }
    }
}

fn valid_proxy_host(value: Option<String>) -> Result<Option<String>> {
    match value {
        None => Ok(None),
        Some(s) => {
            let ok = !s.is_empty()
                && s.len() <= 253
                && !s.contains(|c: char| c.is_whitespace() || c == '/' || c == ':' || c == '@')
                && !s.contains('\0');
            if !ok {
                return Err(coded(
                    codes::INVALID_INPUT,
                    "proxy_host must be a plain hostname or IP (no scheme, port, or credentials)",
                ));
            }
            Ok(Some(s))
        }
    }
}

/// Validate the permissions JSON without a parser: split on commas and
/// require every token to be exactly a quoted allowlisted name. Names
/// contain only lowercase letters and hyphens, so no escaping can hide
/// a second value inside a token.
fn valid_permissions_allow(value: String) -> Result<String> {
    let trimmed = value.trim();
    if !trimmed.starts_with('[') || !trimmed.ends_with(']') {
        return Err(coded(
            codes::INVALID_INPUT,
            "permissions_allow must be a JSON array of permission names",
        ));
    }
    let inner = &trimmed[1..trimmed.len() - 1];
    if inner.trim().is_empty() {
        return Ok("[]".to_string());
    }
    let mut names = Vec::new();
    for token in inner.split(',') {
        let token = token.trim();
        if token.len() < 3 || !token.starts_with('"') || !token.ends_with('"') {
            return Err(coded(
                codes::INVALID_INPUT,
                "permissions_allow entries must be quoted permission names",
            ));
        }
        let name = &token[1..token.len() - 1];
        if !GRANTABLE_PERMISSIONS.contains(&name) {
            return Err(coded(
                codes::INVALID_INPUT,
                format!("permission {name:?} cannot be granted per profile"),
            ));
        }
        names.push(name);
    }
    Ok(format!(
        "[{}]",
        names
            .iter()
            .map(|n| format!("\"{n}\""))
            .collect::<Vec<_>>()
            .join(",")
    ))
}

#[allow(clippy::too_many_arguments)]
fn validate_settings(
    proxy_mode: String,
    proxy_host: Option<String>,
    proxy_port: Option<i32>,
    proxy_username: Option<String>,
    proxy_password_encrypted: Option<String>,
    proxy_bypass: String,
    language: Option<String>,
    user_agent_preset: Option<String>,
    webrtc_policy: String,
    permissions_allow: String,
    download_dir: Option<String>,
) -> Result<(
    String,
    Option<String>,
    Option<i32>,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    Option<String>,
)> {
    let proxy_mode = enum_value(proxy_mode, "proxy_mode", PROXY_MODES)?;
    let proxy_host = valid_proxy_host(proxy_host)?;
    let proxy_bypass = bounded_text(proxy_bypass, "proxy_bypass", 1000)?;
    let language = valid_language(language)?;
    let user_agent_preset = match user_agent_preset {
        None => None,
        Some(p) => Some(enum_value(p, "user_agent_preset", UA_PRESETS)?),
    };
    let webrtc_policy = enum_value(webrtc_policy, "webrtc_policy", WEBRTC_POLICIES)?;
    let permissions_allow = valid_permissions_allow(permissions_allow)?;
    let download_dir = text(download_dir, "download_dir", 1000)?;
    if proxy_mode == "none" {
        if proxy_host.is_some()
            || proxy_port.is_some()
            || proxy_username.is_some()
            || proxy_password_encrypted.is_some()
        {
            return Err(coded(
                codes::INVALID_INPUT,
                "a profile with proxy_mode none must not carry proxy host, port, or credentials",
            ));
        }
        return Ok((
            proxy_mode,
            None,
            None,
            None,
            None,
            proxy_bypass,
            language,
            user_agent_preset,
            webrtc_policy,
            permissions_allow,
            download_dir,
        ));
    }
    let proxy_host = match proxy_host {
        Some(h) => Some(h),
        None => {
            return Err(coded(
                codes::INVALID_INPUT,
                "proxy_host is required when a proxy is configured",
            ))
        }
    };
    let proxy_port = match proxy_port {
        Some(p) if (1..=65535).contains(&p) => Some(p),
        _ => {
            return Err(coded(
                codes::INVALID_INPUT,
                "proxy_port must be between 1 and 65535 when a proxy is configured",
            ))
        }
    };
    let proxy_username = text(proxy_username, "proxy_username", 200)?;
    let proxy_password_encrypted = text(proxy_password_encrypted, "proxy_password_encrypted", MAX_BLOB)?;
    Ok((
        proxy_mode,
        proxy_host,
        proxy_port,
        proxy_username,
        proxy_password_encrypted,
        proxy_bypass,
        language,
        user_agent_preset,
        webrtc_policy,
        permissions_allow,
        download_dir,
    ))
}

#[napi]
pub fn list_browser_profiles(profile_id: i32) -> Result<Vec<BrowserProfile>> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    with_db(|conn| {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {PROFILE_COLS} FROM browser_profiles \
                 WHERE cf_profile_id=?1 ORDER BY position ASC, created_at ASC, local_id ASC"
            ))
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![profile_id], profile_from_row)
            .map_err(to_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(to_err)?);
        }
        Ok(out)
    })
}

#[napi]
pub fn create_browser_profile(
    profile_id: i32,
    local_id: String,
    display_name: String,
    color: Option<String>,
    icon: Option<String>,
    notes: String,
) -> Result<BrowserProfile> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let local_id = valid_browser_profile_id(local_id, "local_id")?;
    let display_name = required_text(display_name, "display_name", MAX_NAME)?;
    let color = valid_color(color)?;
    let icon = valid_icon(icon)?;
    let notes = bounded_text(notes, "notes", MAX_NOTES)?;
    with_immediate_transaction(|conn| {
        let profile_exists: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM profiles WHERE id=?1",
                params![profile_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        if profile_exists == 0 {
            return Err(coded(
                codes::INVALID_INPUT,
                "workspace profile does not exist",
            ));
        }
        let position: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM browser_profiles WHERE cf_profile_id=?1",
                params![profile_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        conn.execute(
            "INSERT INTO browser_profiles \
             (local_id, cf_profile_id, display_name, position, enabled, color, icon, notes, \
              created_at) \
             VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
            params![local_id, profile_id, display_name, position, color, icon, notes],
        )
        .map_err(to_err)?;
        conn.query_row(
            &format!("SELECT {PROFILE_COLS} FROM browser_profiles WHERE local_id=?1"),
            params![local_id],
            profile_from_row,
        )
        .map_err(to_err)
    })
}

/// Idempotent: returns the workspace's default profile, promoting the
/// earliest profile when no default exists, or creating a fresh
/// "Default" (with the shell-supplied candidate id) when none exist.
/// The shell calls this on every browser open, so a workspace can
/// never be left without a default profile to browse in.
#[napi]
pub fn ensure_default_browser_profile(
    profile_id: i32,
    candidate_local_id: String,
) -> Result<BrowserProfile> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let candidate_local_id = valid_browser_profile_id(candidate_local_id, "candidate_local_id")?;
    with_immediate_transaction(|conn| {
        let existing = conn.query_row(
            &format!(
                "SELECT {PROFILE_COLS} FROM browser_profiles \
                 WHERE cf_profile_id=?1 AND is_default=1"
            ),
            params![profile_id],
            profile_from_row,
        );
        if let Ok(profile) = existing {
            return Ok(profile);
        }
        let earliest = conn.query_row(
            &format!(
                "SELECT {PROFILE_COLS} FROM browser_profiles \
                 WHERE cf_profile_id=?1 ORDER BY position ASC, created_at ASC, local_id ASC LIMIT 1"
            ),
            params![profile_id],
            profile_from_row,
        );
        if let Ok(profile) = earliest {
            conn.execute(
                "UPDATE browser_profiles SET is_default=1 WHERE local_id=?1",
                params![profile.local_id],
            )
            .map_err(to_err)?;
            return conn
                .query_row(
                    &format!("SELECT {PROFILE_COLS} FROM browser_profiles WHERE local_id=?1"),
                    params![profile.local_id],
                    profile_from_row,
                )
                .map_err(to_err);
        }
        conn.execute(
            "INSERT INTO browser_profiles \
             (local_id, cf_profile_id, display_name, position, enabled, is_default, created_at) \
             VALUES (?1, ?2, 'Default', 0, 1, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
            params![candidate_local_id, profile_id],
        )
        .map_err(to_err)?;
        conn.query_row(
            &format!("SELECT {PROFILE_COLS} FROM browser_profiles WHERE local_id=?1"),
            params![candidate_local_id],
            profile_from_row,
        )
        .map_err(to_err)
    })
}

#[allow(clippy::too_many_arguments)]
#[napi]
pub fn update_browser_profile(
    local_id: String,
    display_name: String,
    color: Option<String>,
    icon: Option<String>,
    notes: String,
    proxy_mode: String,
    proxy_host: Option<String>,
    proxy_port: Option<i32>,
    proxy_username: Option<String>,
    proxy_password_encrypted: Option<String>,
    proxy_bypass: String,
    language: Option<String>,
    user_agent_preset: Option<String>,
    webrtc_policy: String,
    permissions_allow: String,
    gpc: bool,
    dnt: bool,
    block_third_party_cookies: bool,
    clear_on_close: bool,
    download_dir: Option<String>,
    start_pages: String,
) -> Result<BrowserProfile> {
    let local_id = valid_browser_profile_id(local_id, "local_id")?;
    let display_name = required_text(display_name, "display_name", MAX_NAME)?;
    let color = valid_color(color)?;
    let icon = valid_icon(icon)?;
    let notes = bounded_text(notes, "notes", MAX_NOTES)?;
    let start_pages = valid_start_pages(start_pages)?;
    let (
        proxy_mode,
        proxy_host,
        proxy_port,
        proxy_username,
        proxy_password_encrypted,
        proxy_bypass,
        language,
        user_agent_preset,
        webrtc_policy,
        permissions_allow,
        download_dir,
    ) = validate_settings(
        proxy_mode,
        proxy_host,
        proxy_port,
        proxy_username,
        proxy_password_encrypted,
        proxy_bypass,
        language,
        user_agent_preset,
        webrtc_policy,
        permissions_allow,
        download_dir,
    )?;
    with_immediate_transaction(|conn| {
        let changed = conn
            .execute(
                "UPDATE browser_profiles SET display_name=?2, color=?3, icon=?4, notes=?5, \
                 proxy_mode=?6, proxy_host=?7, proxy_port=?8, proxy_username=?9, \
                 proxy_password_encrypted=?10, proxy_bypass=?11, language=?12, \
                 user_agent_preset=?13, webrtc_policy=?14, permissions_allow=?15, \
                 gpc=?16, dnt=?17, block_third_party_cookies=?18, clear_on_close=?19, \
                 download_dir=?20, start_pages=?21 WHERE local_id=?1",
                params![
                    local_id,
                    display_name,
                    color,
                    icon,
                    notes,
                    proxy_mode,
                    proxy_host,
                    proxy_port,
                    proxy_username,
                    proxy_password_encrypted,
                    proxy_bypass,
                    language,
                    user_agent_preset,
                    webrtc_policy,
                    permissions_allow,
                    i32::from(gpc),
                    i32::from(dnt),
                    i32::from(block_third_party_cookies),
                    i32::from(clear_on_close),
                    download_dir,
                    start_pages,
                ],
            )
            .map_err(to_err)?;
        if changed == 0 {
            return Err(coded(
                codes::INVALID_INPUT,
                "browser profile does not exist",
            ));
        }
        conn.query_row(
            &format!("SELECT {PROFILE_COLS} FROM browser_profiles WHERE local_id=?1"),
            params![local_id],
            profile_from_row,
        )
        .map_err(to_err)
    })
}

/// Idempotent delete: false means the row was already gone (the shell
/// clears the partition first, so "already gone" is a success, not an
/// error). Deleting the default does not promote another profile here;
/// the next ensure_default call promotes or recreates one.
#[napi]
pub fn delete_browser_profile(local_id: String) -> Result<bool> {
    let local_id = valid_browser_profile_id(local_id, "local_id")?;
    // Deleting a profile must not leave orphan tab rows pointing at
    // it (Iso15: C tabs remained after C was deleted, so a restart
    // would try to restore tabs in a deleted profile). Both deletes
    // run in one transaction, so a failure leaves neither half done.
    with_immediate_transaction(|conn| {
        conn.execute(
            "DELETE FROM browser_tabs WHERE browser_profile_id=?1",
            params![local_id],
        )
        .map_err(to_err)?;
        let changed = conn
            .execute(
                "DELETE FROM browser_profiles WHERE local_id=?1",
                params![local_id],
            )
            .map_err(to_err)?;
        Ok(changed > 0)
    })
}

/// Pending partition deletes (V2-39). A partition name is validated
/// exactly like a profile id shape (letters, digits, hyphens only), so a
/// pending row can never name a path outside Partitions/.
#[napi(object)]
pub struct PendingBrowserProfileDelete {
    pub local_id: String,
    pub partition_name: String,
    pub workspace_profile_id: i32,
}

fn valid_partition_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

#[napi]
pub fn add_pending_browser_profile_delete(
    workspace_profile_id: i32,
    local_id: String,
    partition_name: String,
) -> Result<bool> {
    let workspace_profile_id = valid_id(workspace_profile_id, "workspace_profile_id")?;
    let local_id = valid_browser_profile_id(local_id, "local_id")?;
    if !valid_partition_name(&partition_name) {
        return Err(coded(codes::INVALID_INPUT, "invalid partition_name"));
    }
    with_db(|conn| {
        conn.execute(
            "INSERT INTO browser_profile_pending_deletes (local_id, partition_name, workspace_profile_id) VALUES (?1, ?2, ?3) ON CONFLICT(local_id) DO UPDATE SET partition_name=excluded.partition_name, workspace_profile_id=excluded.workspace_profile_id",
            params![local_id, partition_name, workspace_profile_id],
        )
        .map_err(to_err)?;
        Ok(true)
    })
}

#[napi]
pub fn list_pending_browser_profile_deletes() -> Result<Vec<PendingBrowserProfileDelete>> {
    with_db(|conn| {
        let mut stmt = conn
            .prepare("SELECT local_id, partition_name, workspace_profile_id FROM browser_profile_pending_deletes ORDER BY created_at")
            .map_err(to_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(PendingBrowserProfileDelete {
                    local_id: r.get(0)?,
                    partition_name: r.get(1)?,
                    workspace_profile_id: r.get(2)?,
                })
            })
            .map_err(to_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(to_err)?);
        }
        Ok(out)
    })
}

#[napi]
pub fn remove_pending_browser_profile_delete(local_id: String) -> Result<bool> {
    let local_id = valid_browser_profile_id(local_id, "local_id")?;
    with_db(|conn| {
        let changed = conn
            .execute(
                "DELETE FROM browser_profile_pending_deletes WHERE local_id=?1",
                params![local_id],
            )
            .map_err(to_err)?;
        Ok(changed > 0)
    })
}

/// Touch last_used_at (called when a view is created in this profile or
/// the user switches to it, so the manager's "last used" stays honest).
#[napi]
pub fn touch_browser_profile(local_id: String) -> Result<bool> {
    let local_id = valid_browser_profile_id(local_id, "local_id")?;
    with_db(|conn| {
        let changed = conn
            .execute(
                "UPDATE browser_profiles SET last_used_at=strftime('%Y-%m-%dT%H:%M:%SZ', 'now') \
                 WHERE local_id=?1",
                params![local_id],
            )
            .map_err(to_err)?;
        Ok(changed > 0)
    })
}

#[napi]
pub fn get_browser_live_cap(profile_id: i32) -> Result<i32> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    with_db(|conn| {
        let cap: i32 = conn
            .query_row(
                "SELECT browser_live_cap FROM profiles WHERE id=?1",
                params![profile_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        Ok(cap.clamp(1, 20))
    })
}

#[napi]
pub fn set_browser_live_cap(profile_id: i32, cap: i32) -> Result<i32> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    if !(1..=20).contains(&cap) {
        return Err(coded(
            codes::INVALID_INPUT,
            "browser_live_cap must be between 1 and 20",
        ));
    }
    with_db(|conn| {
        let changed = conn
            .execute(
                "UPDATE profiles SET browser_live_cap=?2 WHERE id=?1",
                params![profile_id, cap],
            )
            .map_err(to_err)?;
        if changed == 0 {
            return Err(coded(
                codes::INVALID_INPUT,
                "workspace profile does not exist",
            ));
        }
        Ok(cap)
    })
}

/// How many ledger rows a profile delete would remove when the
/// "also delete ledger entries" box is ticked: captures from this
/// profile, sources from this profile, plus passages that belong to
/// a source from this profile but carry a different profile (they go
/// away with their source). The confirm shows exactly this number.
#[napi]
pub fn count_ledger_by_browser_profile(
    profile_id: i32,
    browser_profile_id: String,
) -> Result<i32> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let browser_profile_id = valid_browser_profile_id(browser_profile_id, "browser_profile_id")?;
    with_db(|conn| {
        let count: i32 = conn
            .query_row(
                "SELECT \
                 (SELECT COUNT(*) FROM research_captures \
                  WHERE profile_id=?1 AND browser_profile_id=?2) + \
                 (SELECT COUNT(*) FROM research_sources \
                  WHERE profile_id=?1 AND browser_profile_id=?2) + \
                 (SELECT COUNT(*) FROM research_captures c \
                  WHERE c.profile_id=?1 AND c.browser_profile_id IS NOT ?2 \
                  AND c.source_id IN (SELECT id FROM research_sources \
                   WHERE profile_id=?1 AND browser_profile_id=?2))",
                params![profile_id, browser_profile_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        Ok(count)
    })
}

/// Delete the ledger rows counted above, in one transaction. Returns
/// the same count (computed before deletion) so the shell can verify
/// the confirm number matched what was actually removed.
#[napi]
pub fn delete_ledger_by_browser_profile(
    profile_id: i32,
    browser_profile_id: String,
) -> Result<i32> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let browser_profile_id = valid_browser_profile_id(browser_profile_id, "browser_profile_id")?;
    with_immediate_transaction(|conn| {
        let count: i32 = conn
            .query_row(
                "SELECT \
                 (SELECT COUNT(*) FROM research_captures \
                  WHERE profile_id=?1 AND browser_profile_id=?2) + \
                 (SELECT COUNT(*) FROM research_sources \
                  WHERE profile_id=?1 AND browser_profile_id=?2) + \
                 (SELECT COUNT(*) FROM research_captures c \
                  WHERE c.profile_id=?1 AND c.browser_profile_id IS NOT ?2 \
                  AND c.source_id IN (SELECT id FROM research_sources \
                   WHERE profile_id=?1 AND browser_profile_id=?2))",
                params![profile_id, browser_profile_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        conn.execute(
            "DELETE FROM research_captures \
             WHERE profile_id=?1 AND browser_profile_id=?2",
            params![profile_id, browser_profile_id],
        )
        .map_err(to_err)?;
        // Passages that belong to a source from this profile go away
        // with their source, whatever profile they themselves carry
        // (otherwise they would be orphaned when the source is deleted).
        conn.execute(
            "DELETE FROM research_captures \
             WHERE profile_id=?1 AND source_id IN              (SELECT id FROM research_sources \
              WHERE profile_id=?1 AND browser_profile_id=?2)",
            params![profile_id, browser_profile_id],
        )
        .map_err(to_err)?;
        conn.execute(
            "DELETE FROM research_sources \
             WHERE profile_id=?1 AND browser_profile_id=?2",
            params![profile_id, browser_profile_id],
        )
        .map_err(to_err)?;
        Ok(count)
    })
}

#[cfg(test)]
mod tests {
    use super::valid_start_pages;

    #[test]
    fn start_pages_accepts_http_and_https_and_drops_blanks() {
        let out = valid_start_pages(
            "  https://example.com  \n\nhttp://127.0.0.1:8080/a?b=c\n".to_string(),
        )
        .unwrap();
        assert_eq!(out, "https://example.com\nhttp://127.0.0.1:8080/a?b=c");
    }

    #[test]
    fn start_pages_rejects_non_http_and_hostless_urls() {
        assert!(valid_start_pages("ftp://example.com".to_string()).is_err());
        assert!(valid_start_pages("example.com".to_string()).is_err());
        assert!(valid_start_pages("https://".to_string()).is_err());
        assert!(valid_start_pages("https://exa mple.com".to_string()).is_err());
    }

    #[test]
    fn browser_profiles_round_trip() {
        let path = std::env::temp_dir()
            .join(format!("pl-v2-test-bprofiles-{}.db", std::process::id()));
        crate::db::init_db(path.to_string_lossy().into_owned()).expect("init test db");
        let profile =
            crate::db::add_profile("Browser Test".to_string(), "browser-test".to_string())
                .expect("profile");
        let pid = profile.id;
        // The test profile did not exist at migration time, so the lazy
        // ensure path must create its Default.
        let def = super::ensure_default_browser_profile(pid, "bp-test-default".to_string())
            .expect("default");
        assert!(def.is_default);
        assert_eq!(def.display_name, "Default");
        assert_eq!(def.local_id, "bp-test-default");
        let def2 = super::ensure_default_browser_profile(pid, "bp-test-other".to_string())
            .expect("default2");
        assert_eq!(def2.local_id, "bp-test-default");
        let second = super::create_browser_profile(
            pid,
            "bp-test-work".to_string(),
            "Work".to_string(),
            Some("#e0a35c".to_string()),
            Some("briefcase".to_string()),
            "Work stuff".to_string(),
        )
        .expect("create");
        assert_eq!(second.position, 1);
        assert!(!second.is_default);
        let list = super::list_browser_profiles(pid).expect("list");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].local_id, "bp-test-default");
        let upd = super::update_browser_profile(
            second.local_id.clone(),
            "Work".to_string(),
            None,
            None,
            "".to_string(),
            "http".to_string(),
            Some("127.0.0.1".to_string()),
            Some(8080),
            Some("user".to_string()),
            Some("encrypted-blob".to_string()),
            "<local>".to_string(),
            Some("en-US".to_string()),
            Some("windows".to_string()),
            "default_public_interface_only".to_string(),
            "[\"camera\"]".to_string(),
            true,
            false,
            true,
            false,
            None,
            "".to_string(),
        )
        .expect("update");
        assert_eq!(upd.proxy_mode, "http");
        assert_eq!(upd.proxy_port, Some(8080));
        assert!(upd.gpc);
        assert!(upd.block_third_party_cookies);
        // Fail-closed: mode none must not carry proxy fields.
        assert!(super::update_browser_profile(
            second.local_id.clone(),
            "Work".to_string(),
            None,
            None,
            "".to_string(),
            "none".to_string(),
            Some("127.0.0.1".to_string()),
            None,
            None,
            None,
            "<local>".to_string(),
            None,
            None,
            "default_public_interface_only".to_string(),
            "[]".to_string(),
            false,
            false,
            false,
            false,
            None,
            "".to_string(),
        )
        .is_err());
        assert!(super::create_browser_profile(
            pid,
            "not-a-bp-id".to_string(),
            "Bad".to_string(),
            None,
            None,
            "".to_string(),
        )
        .is_err());
        assert!(super::create_browser_profile(
            pid,
            "bp-bad-color".to_string(),
            "Bad".to_string(),
            Some("red".to_string()),
            None,
            "".to_string(),
        )
        .is_err());
        assert_eq!(super::get_browser_live_cap(pid).expect("cap"), 5);
        assert_eq!(super::set_browser_live_cap(pid, 3).expect("set cap"), 3);
        assert!(super::set_browser_live_cap(pid, 99).is_err());
        let _src = crate::db::research::save_research_source(
            pid,
            "https://example.com/w".to_string(),
            "W".to_string(),
            Some("bp-test-work".to_string()),
            Some("Work".to_string()),
        )
        .expect("src");
        assert_eq!(
            super::count_ledger_by_browser_profile(pid, "bp-test-work".to_string()).expect("count"),
            1
        );
        assert_eq!(
            super::delete_ledger_by_browser_profile(pid, "bp-test-work".to_string())
                .expect("del ledger"),
            1
        );
        assert!(super::touch_browser_profile("bp-test-work".to_string()).expect("touch"));
        assert!(super::delete_browser_profile("bp-test-work".to_string()).expect("delete"));
        assert!(!super::delete_browser_profile("bp-test-work".to_string())
            .expect("delete idempotent"));
        let list2 = super::list_browser_profiles(pid).expect("list2");
        assert_eq!(list2.len(), 1);
    }

    #[test]
    fn browser_profile_pending_deletes_round_trip() {
        let path = std::env::temp_dir()
            .join(format!("pl-v2-test-pending-{}.db", std::process::id()));
        crate::db::init_db(path.to_string_lossy().into_owned()).expect("init test db");
        let profile =
            crate::db::add_profile("Pending Test".to_string(), "pending-test".to_string())
                .expect("profile");
        let pid = profile.id;
        assert!(super::list_pending_browser_profile_deletes().expect("list empty").is_empty());
        assert!(super::add_pending_browser_profile_delete(
            pid,
            "bp-test-pending".to_string(),
            "pl-browser-1-bp-test-pending".to_string(),
        ).expect("add pending"));
        let list = super::list_pending_browser_profile_deletes().expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].local_id, "bp-test-pending");
        assert_eq!(list[0].partition_name, "pl-browser-1-bp-test-pending");
        // Forged partition names are rejected, never stored.
        assert!(super::add_pending_browser_profile_delete(
            pid,
            "bp-test-pending2".to_string(),
            "../evil".to_string(),
        ).is_err());
        assert!(super::add_pending_browser_profile_delete(
            pid,
            "bp-test-pending2".to_string(),
            "pl-browser-1-bp-test-pending;rm".to_string(),
        ).is_err());
        assert!(super::remove_pending_browser_profile_delete("bp-test-pending".to_string()).expect("remove"));
        assert!(super::list_pending_browser_profile_deletes().expect("list after remove").is_empty());
        assert!(!super::remove_pending_browser_profile_delete("bp-test-pending".to_string()).expect("remove idempotent"));
    }

    #[test]
    fn browser_profile_delete_removes_its_tab_rows() {
        let path = std::env::temp_dir()
            .join(format!("pl-v2-test-tabdel-{}.db", std::process::id()));
        crate::db::init_db(path.to_string_lossy().into_owned()).expect("init test db");
        let profile =
            crate::db::add_profile("TabDel Test".to_string(), "tabdel-test".to_string())
                .expect("profile");
        let pid = profile.id;
        let second = super::create_browser_profile(
            pid,
            "bp-test-tabdel".to_string(),
            "TabDel".to_string(),
            None,
            None,
            "".to_string(),
        )
        .expect("create");
        // One tab row in the profile under test, one in another profile
        // (must survive the delete, proving the cleanup is scoped).
        crate::db::with_db(|conn| {
            conn.execute(
                "INSERT INTO browser_tabs (profile_id, browser_profile_id, url) VALUES (?1, ?2, ?3)",
                rusqlite::params![pid, "bp-test-tabdel", "https://example.com/a"],
            ).expect("insert tab a");
            conn.execute(
                "INSERT INTO browser_tabs (profile_id, browser_profile_id, url) VALUES (?1, ?2, ?3)",
                rusqlite::params![pid, "bp-test-other", "https://example.com/b"],
            ).expect("insert tab b");
            Ok(())
        }).expect("insert tabs");
        assert!(super::delete_browser_profile("bp-test-tabdel".to_string()).expect("delete"));
        let remaining: i64 = crate::db::with_db(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM browser_tabs WHERE browser_profile_id='bp-test-tabdel'",
                [],
                |r| r.get(0),
            ).map_err(crate::db::to_err)
        }).expect("count tabs");
        assert_eq!(remaining, 0);
        let other: i64 = crate::db::with_db(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM browser_tabs WHERE browser_profile_id='bp-test-other'",
                [],
                |r| r.get(0),
            ).map_err(crate::db::to_err)
        }).expect("count other tabs");
        assert_eq!(other, 1);
        let _ = second;
    }
}
