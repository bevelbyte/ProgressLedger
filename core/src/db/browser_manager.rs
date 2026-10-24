//! Donut Browser Manager: durable metadata for CareerFlow-managed isolated
//! browser profiles and their URL shortcuts.
//!
//! Ownership: every row belongs to exactly one CareerFlow profile
//! (`cf_profile_id`), with ON DELETE CASCADE so deleting the profile removes
//! its managed browser profiles and shortcuts in one step.
//!
//! Deliberately ABSENT from this layer: the machine-local Donut profile UUID.
//! That binding lives in a workspace-level JSON store (donut-bindings.json,
//! resolved by the shell) because it points into this machine's Donut data
//! directory and must never be exported as portable data.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, OptionalExtension};

use crate::db::{to_err, with_db, with_transaction};
use crate::errors::{coded, codes};

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Storage-time URL guard: every persisted browser-shortcut URL must be a
/// normalized http(s) absolute URL. Mirrors the main-process `validateHttpUrl`
/// rule exactly so storage and open-time enforcement cannot drift.
fn validate_shortcut_url(input: &str) -> Result<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(coded(codes::INVALID_URL, "shortcut URL is empty"));
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| {
        coded(
            codes::INVALID_URL,
            "Shortcut URL is malformed (must be http or https)",
        )
    })?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(coded(
            codes::INVALID_URL,
            format!("shortcut URL scheme is not allowed: {scheme}"),
        ));
    }
    if parsed.host_str().map(str::is_empty).unwrap_or(true) {
        return Err(coded(codes::INVALID_URL, "shortcut URL is missing a host"));
    }
    Ok(parsed.into())
}

#[napi(object)]
pub struct BrowserProfileRecord {
    pub local_id: String,
    pub cf_profile_id: i32,
    pub display_name: String,
    pub position: i32,
    pub enabled: bool,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[napi(object)]
pub struct BrowserShortcutRecord {
    pub id: i32,
    pub browser_profile_id: String,
    pub cf_profile_id: i32,
    pub label: String,
    pub url: String,
    pub position: i32,
    pub created_at: String,
    pub pinned: bool,
}

const PROFILE_COLS: &str =
    "local_id, cf_profile_id, display_name, position, enabled, created_at, last_used_at";

fn row_to_profile(row: &rusqlite::Row) -> rusqlite::Result<BrowserProfileRecord> {
    Ok(BrowserProfileRecord {
        local_id: row.get(0)?,
        cf_profile_id: row.get(1)?,
        display_name: row.get(2)?,
        position: row.get(3)?,
        enabled: row.get::<_, i32>(4)? != 0,
        created_at: row.get(5)?,
        last_used_at: row.get(6)?,
    })
}

const SHORTCUT_COLS: &str =
    "s.id, s.browser_profile_id, bp.cf_profile_id, s.label, s.url, s.position, s.created_at, s.pinned";

fn row_to_shortcut(row: &rusqlite::Row) -> rusqlite::Result<BrowserShortcutRecord> {
    Ok(BrowserShortcutRecord {
        id: row.get(0)?,
        browser_profile_id: row.get(1)?,
        cf_profile_id: row.get(2)?,
        label: row.get(3)?,
        url: row.get(4)?,
        position: row.get(5)?,
        created_at: row.get(6)?,
        pinned: row.get::<_, i32>(7)? != 0,
    })
}

/// List a CareerFlow profile's managed browser profiles in stable order.
#[napi]
pub fn list_browser_profiles(cf_profile_id: i32) -> Result<Vec<BrowserProfileRecord>> {
    with_db(|conn| {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {PROFILE_COLS} FROM browser_profiles
                 WHERE cf_profile_id = ?1
                 ORDER BY position ASC, created_at ASC"
            ))
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![cf_profile_id], row_to_profile)
            .map_err(to_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(to_err)?);
        }
        Ok(out)
    })
}

/// Validate that `cf_profile_id` exists. Returns the (existing) id or an
/// `unknown-profile` coded error. Centralized so every mutation in this
/// module shares one existence check.
fn assert_cf_profile_exists(cf_profile_id: i32) -> Result<()> {
    with_db(|conn| {
        let n: i32 = conn
            .query_row(
                "SELECT 1 FROM profiles WHERE id = ?1",
                params![cf_profile_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(to_err)?
            .unwrap_or(0);
        if n != 1 {
            return Err(coded(codes::UNKNOWN_PROFILE, "unknown CareerFlow profile"));
        }
        Ok(())
    })
}

/// Read the owner row (cf_profile_id) for a shortcut id. Returns
/// `unknown-shortcut` when the id does not exist.
fn shortcut_owner_profile(shortcut_id: i32) -> Result<i32> {
    with_db(|conn| {
        let owner: Option<i32> = conn
            .query_row(
                "SELECT bp.cf_profile_id
                 FROM browser_shortcuts s JOIN browser_profiles bp
                   ON bp.local_id = s.browser_profile_id
                 WHERE s.id = ?1",
                params![shortcut_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(to_err)?;
        owner.ok_or_else(|| coded(codes::UNKNOWN_SHORTCUT, "unknown shortcut id"))
    })
}

/// Per-call ownership gate: the row must exist and belong to the supplied
/// CareerFlow profile. Centralized so every mutation in this module has one
/// uniform check that returns the same `not-owned` coded error.
fn assert_browser_profile_owned(local_id: String, cf_profile_id: i32) -> Result<()> {
    with_db(|conn| {
        let owner: Option<i32> = conn
            .query_row(
                "SELECT cf_profile_id FROM browser_profiles WHERE local_id = ?1",
                params![local_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(to_err)?;
        match owner {
            None => Err(coded(
                codes::UNKNOWN_BROWSER_PROFILE,
                "unknown browser profile",
            )),
            Some(o) if o != cf_profile_id => Err(coded(
                codes::NOT_OWNED,
                "browser profile is owned by a different CareerFlow profile",
            )),
            Some(_) => Ok(()),
        }
    })
}
/// Internal-only: re-read a row we just inserted without going through the
/// ownership gate (the calling code IS the owner and just validated that).
fn get_browser_profile_internal(local_id: String) -> Result<Option<BrowserProfileRecord>> {
    with_db(|conn| {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {PROFILE_COLS} FROM browser_profiles WHERE local_id = ?1"
            ))
            .map_err(to_err)?;
        let mut rows = stmt
            .query_map(params![local_id], row_to_profile)
            .map_err(to_err)?;
        match rows.next() {
            Some(row) => Ok(Some(row.map_err(to_err)?)),
            None => Ok(None),
        }
    })
}

/// Fetch one managed browser profile by its stable local id. The row is
/// only returned when it belongs to the supplied cf_profile_id; otherwise
/// the call is treated as a non-existent row from the caller's perspective
/// (the main process and renderer must not be able to discover rows owned
/// by other profiles).
#[napi]
pub fn get_browser_profile(
    cf_profile_id: i32,
    local_id: String,
) -> Result<Option<BrowserProfileRecord>> {
    with_db(|conn| {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {PROFILE_COLS} FROM browser_profiles
                 WHERE local_id = ?1 AND cf_profile_id = ?2"
            ))
            .map_err(to_err)?;
        let mut rows = stmt
            .query_map(params![local_id, cf_profile_id], row_to_profile)
            .map_err(to_err)?;
        match rows.next() {
            Some(row) => Ok(Some(row.map_err(to_err)?)),
            None => Ok(None),
        }
    })
}

/// Register a new managed browser profile. `local_id` is generated by the
/// caller (renderer never sees it; it is an opaque key) and becomes the
/// machine-local binding key used by the Donut transport layer. The supplied
/// `cf_profile_id` MUST exist in `profiles`; any other id is rejected.
#[napi]
pub fn add_browser_profile(
    cf_profile_id: i32,
    local_id: String,
    display_name: String,
) -> Result<BrowserProfileRecord> {
    assert_cf_profile_exists(cf_profile_id)?;
    if local_id.trim().is_empty() {
        return Err(coded(
            codes::INVALID_URL,
            "browser profile local id is empty",
        ));
    }
    if display_name.trim().is_empty() {
        return Err(coded(
            codes::INTERNAL,
            "browser profile display name is empty",
        ));
    }
    let created_at = now_iso();
    with_db(|conn| {
        let next_position: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(position), 0) + 1 FROM browser_profiles
                 WHERE cf_profile_id = ?1",
                params![cf_profile_id],
                |row| row.get(0),
            )
            .map_err(to_err)?;
        conn.execute(
            "INSERT INTO browser_profiles
               (local_id, cf_profile_id, display_name, position, enabled, created_at)
             VALUES (?1, ?2, ?3, ?4, 1, ?5)",
            params![
                local_id,
                cf_profile_id,
                display_name,
                next_position,
                created_at
            ],
        )
        .map_err(to_err)?;
        Ok(())
    })?;
    // Re-read so the returned record matches persisted state exactly.
    let rec = get_browser_profile_internal(local_id.clone())?;
    rec.ok_or_else(|| {
        napi::Error::new(
            napi::Status::GenericFailure,
            "browser profile vanished immediately after insert",
        )
    })
}

/// Rename a managed browser profile. The supplied cf_profile_id must own the
/// target row; otherwise the call is rejected without mutating it.
#[napi]
pub fn rename_browser_profile(
    cf_profile_id: i32,
    local_id: String,
    display_name: String,
) -> Result<()> {
    assert_browser_profile_owned(local_id.clone(), cf_profile_id)?;
    if display_name.trim().is_empty() {
        return Err(coded(
            codes::INTERNAL,
            "browser profile display name is empty",
        ));
    }
    with_db(|conn| {
        let n = conn
            .execute(
                "UPDATE browser_profiles SET display_name = ?2
                 WHERE local_id = ?1 AND cf_profile_id = ?3",
                params![local_id, display_name, cf_profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "browser profile is not owned by this CareerFlow profile",
            ));
        }
        Ok(())
    })
}

/// Enable/disable a managed browser profile. Disabled profiles stay visible
/// for management but refuse opens at the service boundary. Ownership-checked.
#[napi]
pub fn set_browser_profile_enabled(
    cf_profile_id: i32,
    local_id: String,
    enabled: bool,
) -> Result<()> {
    assert_browser_profile_owned(local_id.clone(), cf_profile_id)?;
    with_db(|conn| {
        let n = conn
            .execute(
                "UPDATE browser_profiles SET enabled = ?2
                 WHERE local_id = ?1 AND cf_profile_id = ?3",
                params![local_id, enabled as i32, cf_profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "browser profile is not owned by this CareerFlow profile",
            ));
        }
        Ok(())
    })
}

/// Mark usage: bump last_used_at to now (called after a successful open).
/// Ownership-checked — the caller (main-process open pipeline) supplies the
/// resolved cf_profile_id and the bump is bound to the right owner.
#[napi]
pub fn touch_browser_profile(cf_profile_id: i32, local_id: String) -> Result<()> {
    assert_browser_profile_owned(local_id.clone(), cf_profile_id)?;
    let ts = now_iso();
    with_db(|conn| {
        let n = conn
            .execute(
                "UPDATE browser_profiles SET last_used_at = ?2
                 WHERE local_id = ?1 AND cf_profile_id = ?3",
                params![local_id, ts, cf_profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "browser profile is not owned by this CareerFlow profile",
            ));
        }
        Ok(())
    })
}

/// Delete a managed browser profile. Shortcuts cascade via FK. The Donut-side
/// profile itself is intentionally NOT touched here — unlinking is a
/// CareerFlow bookkeeping operation, not a destructive Donut action.
/// Ownership-checked so a foreign renderer cannot wipe another profile's row.
#[napi]
pub fn delete_browser_profile(cf_profile_id: i32, local_id: String) -> Result<()> {
    assert_browser_profile_owned(local_id.clone(), cf_profile_id)?;
    with_db(|conn| {
        let n = conn
            .execute(
                "DELETE FROM browser_profiles
                 WHERE local_id = ?1 AND cf_profile_id = ?2",
                params![local_id, cf_profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "browser profile is not owned by this CareerFlow profile",
            ));
        }
        Ok(())
    })
}

/// Persist an explicit ordering for a CareerFlow profile's browser profiles.
/// Every id must belong to the supplied cf_profile_id; the whole batch is
/// rejected otherwise. No silent reordering of foreign rows.
#[napi]
pub fn reorder_browser_profiles(cf_profile_id: i32, ordered_local_ids: Vec<String>) -> Result<()> {
    assert_cf_profile_exists(cf_profile_id)?;
    with_transaction(|conn| {
        for local_id in ordered_local_ids.iter() {
            let owner: Option<i32> = conn
                .query_row(
                    "SELECT cf_profile_id FROM browser_profiles WHERE local_id = ?1",
                    params![local_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(to_err)?;
            match owner {
                None => {
                    return Err(coded(
                        codes::UNKNOWN_BROWSER_PROFILE,
                        "unknown browser profile in reorder list",
                    ))
                }
                Some(o) if o != cf_profile_id => {
                    return Err(coded(
                        codes::NOT_OWNED,
                        "reorder list contains a foreign browser profile",
                    ))
                }
                Some(_) => {}
            }
        }
        for (idx, local_id) in ordered_local_ids.iter().enumerate() {
            conn.execute(
                "UPDATE browser_profiles SET position = ?2
                 WHERE local_id = ?1 AND cf_profile_id = ?3",
                params![local_id, idx as i32 + 1, cf_profile_id],
            )
            .map_err(to_err)?;
        }
        Ok(())
    })
}

/// Fetch one shortcut by id (used by the main-process open pipeline to
/// resolve ownership before any Donut call).
#[napi]
pub fn get_browser_shortcut(id: i32) -> Result<Option<BrowserShortcutRecord>> {
    with_db(|conn| {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {SHORTCUT_COLS}
                 FROM browser_shortcuts s
                 JOIN browser_profiles bp ON bp.local_id = s.browser_profile_id
                 WHERE s.id = ?1"
            ))
            .map_err(to_err)?;
        let mut rows = stmt
            .query_map(params![id], row_to_shortcut)
            .map_err(to_err)?;
        match rows.next() {
            Some(row) => Ok(Some(row.map_err(to_err)?)),
            None => Ok(None),
        }
    })
}

/// List the URL shortcuts of one managed browser profile in stable order.
/// Read-side ownership gate: if the browser profile does not exist OR is
/// owned by a different CareerFlow profile, the listing is empty (never
/// an error). Reads must never leak a "row exists but you don't own it"
/// signal — that's a write-side concern, not a read-side one.
#[napi]
pub fn list_browser_shortcuts(
    cf_profile_id: i32,
    browser_profile_id: String,
) -> Result<Vec<BrowserShortcutRecord>> {
    with_db(|conn| {
        // Owner check first; if no row matches, return [] silently.
        let owner: Option<i32> = conn
            .query_row(
                "SELECT cf_profile_id FROM browser_profiles WHERE local_id = ?1",
                params![browser_profile_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(to_err)?;
        match owner {
            None => return Ok(Vec::new()),
            Some(o) if o != cf_profile_id => return Ok(Vec::new()),
            Some(_) => {}
        }
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {SHORTCUT_COLS}
                 FROM browser_shortcuts s
                 JOIN browser_profiles bp ON bp.local_id = s.browser_profile_id
                 WHERE s.browser_profile_id = ?1
                 ORDER BY s.position ASC, s.created_at ASC"
            ))
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![browser_profile_id], row_to_shortcut)
            .map_err(to_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(to_err)?);
        }
        Ok(out)
    })
}

/// Add a URL shortcut to a managed browser profile. URL is validated at
/// STORAGE time: defense in depth with the open-time validation. The target
/// browser profile must belong to the supplied cf_profile_id; otherwise
/// rejected without inserting anything.
#[napi]
pub fn add_browser_shortcut(
    cf_profile_id: i32,
    browser_profile_id: String,
    label: String,
    url: String,
) -> Result<BrowserShortcutRecord> {
    assert_browser_profile_owned(browser_profile_id.clone(), cf_profile_id)?;
    if label.trim().is_empty() {
        return Err(coded(codes::INTERNAL, "shortcut label is empty"));
    }
    let normalized = validate_shortcut_url(&url)?;
    let created_at = now_iso();
    let id = with_db(|conn| {
        let next_position: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(position), 0) + 1 FROM browser_shortcuts
                 WHERE browser_profile_id = ?1",
                params![browser_profile_id],
                |row| row.get(0),
            )
            .map_err(to_err)?;
        conn.execute(
            "INSERT INTO browser_shortcuts
               (browser_profile_id, label, url, position, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                browser_profile_id,
                label,
                normalized,
                next_position,
                created_at
            ],
        )
        .map_err(to_err)?;
        Ok(conn.last_insert_rowid() as i32)
    })?;
    // Return the fully-populated record.
    with_db(|conn| {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {SHORTCUT_COLS}
                 FROM browser_shortcuts s
                 JOIN browser_profiles bp ON bp.local_id = s.browser_profile_id
                 WHERE s.id = ?1"
            ))
            .map_err(to_err)?;
        let mut rows = stmt
            .query_map(params![id], row_to_shortcut)
            .map_err(to_err)?;
        match rows.next() {
            Some(row) => Ok(row.map_err(to_err)?),
            None => Err(napi::Error::new(
                napi::Status::GenericFailure,
                "shortcut vanished immediately after insert",
            )),
        }
    })
}

/// Update a shortcut's label and URL. The shortcut must belong to a browser
/// profile owned by the supplied cf_profile_id; the URL is re-validated.
#[napi]
pub fn update_browser_shortcut(
    cf_profile_id: i32,
    id: i32,
    label: String,
    url: String,
) -> Result<()> {
    let owner = shortcut_owner_profile(id)?;
    if owner != cf_profile_id {
        return Err(coded(
            codes::NOT_OWNED,
            "shortcut belongs to a different CareerFlow profile",
        ));
    }
    if label.trim().is_empty() {
        return Err(coded(codes::INTERNAL, "shortcut label is empty"));
    }
    let normalized = validate_shortcut_url(&url)?;
    with_db(|conn| {
        // Re-check ownership in the same statement so the row is only updated
        // when the cf_profile_id actually owns the underlying browser profile.
        let n = conn
            .execute(
                "UPDATE browser_shortcuts
                   SET label = ?2, url = ?3
                 WHERE id = ?1
                   AND browser_profile_id IN
                     (SELECT local_id FROM browser_profiles WHERE cf_profile_id = ?4)",
                params![id, label, normalized, cf_profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "shortcut is not owned by this CareerFlow profile",
            ));
        }
        Ok(())
    })
}

/// Delete a shortcut. Ownership flows through the parent browser profile.
#[napi]
pub fn delete_browser_shortcut(cf_profile_id: i32, id: i32) -> Result<()> {
    let owner = shortcut_owner_profile(id)?;
    if owner != cf_profile_id {
        return Err(coded(
            codes::NOT_OWNED,
            "shortcut belongs to a different CareerFlow profile",
        ));
    }
    with_db(|conn| {
        let n = conn
            .execute(
                "DELETE FROM browser_shortcuts
                 WHERE id = ?1
                   AND browser_profile_id IN
                     (SELECT local_id FROM browser_profiles WHERE cf_profile_id = ?2)",
                params![id, cf_profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "shortcut is not owned by this CareerFlow profile",
            ));
        }
        Ok(())
    })
}

/// Persist an explicit ordering for a browser profile's shortcuts. The
/// parent browser profile must belong to the supplied cf_profile_id AND
/// every shortcut id must belong to that browser profile.
#[napi]
pub fn reorder_browser_shortcuts(
    cf_profile_id: i32,
    browser_profile_id: String,
    ordered_ids: Vec<i32>,
) -> Result<()> {
    assert_browser_profile_owned(browser_profile_id.clone(), cf_profile_id)?;
    with_transaction(|conn| {
        for id in ordered_ids.iter() {
            let owner_bp: Option<String> = conn
                .query_row(
                    "SELECT browser_profile_id FROM browser_shortcuts WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(to_err)?;
            match owner_bp {
                None => {
                    return Err(coded(
                        codes::UNKNOWN_SHORTCUT,
                        "unknown shortcut in reorder list",
                    ))
                }
                Some(o) if o != browser_profile_id => {
                    return Err(coded(
                        codes::NOT_OWNED,
                        "reorder list contains a foreign shortcut",
                    ))
                }
                Some(_) => {}
            }
        }
        for (idx, id) in ordered_ids.iter().enumerate() {
            conn.execute(
                "UPDATE browser_shortcuts SET position = ?2
                 WHERE id = ?1 AND browser_profile_id = ?3",
                params![id, idx as i32 + 1, browser_profile_id],
            )
            .map_err(to_err)?;
        }
        Ok(())
    })
}

/// Toggle the `pinned` flag on a browser shortcut. Ownership-gated: the
/// shortcut's parent browser profile must belong to the supplied
/// `cf_profile_id`. No mutation when the parent is owned by a different
/// CareerFlow profile, and no Donut transport is involved — the pin is a
/// pure local UI concern.
#[napi]
pub fn toggle_browser_shortcut_pin(
    cf_profile_id: i32,
    shortcut_id: i32,
    pinned: bool,
) -> Result<()> {
    let owner = shortcut_owner_profile(shortcut_id)?;
    if owner != cf_profile_id {
        return Err(coded(
            codes::NOT_OWNED,
            "shortcut belongs to a different CareerFlow profile",
        ));
    }
    with_db(|conn| {
        let n = conn
            .execute(
                "UPDATE browser_shortcuts
                   SET pinned = ?2
                 WHERE id = ?1
                   AND browser_profile_id IN
                     (SELECT local_id FROM browser_profiles WHERE cf_profile_id = ?3)",
                params![shortcut_id, pinned as i32, cf_profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "shortcut is not owned by this CareerFlow profile",
            ));
        }
        Ok(())
    })
}

/// List every pinned shortcut owned by the supplied CareerFlow profile,
/// ordered by browser profile position then shortcut position — the same
/// ordering the Browser Manager itself uses, so a shortcut appears in
/// Quick Actions in the same relative order as in the manager.
///
/// This is the read path for the Quick Actions panel. It is intentionally
/// not exposed to the renderer as a generic `list all` — the panel only
/// needs the pinned subset, and the index `idx_browser_shortcuts_pinned`
/// keeps this an O(pinned) read regardless of total shortcut count.
#[napi]
pub fn list_pinned_browser_shortcuts(cf_profile_id: i32) -> Result<Vec<BrowserShortcutRecord>> {
    assert_cf_profile_exists(cf_profile_id)?;
    with_db(|conn| {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {SHORTCUT_COLS}
                 FROM browser_shortcuts s
                 JOIN browser_profiles bp
                   ON bp.local_id = s.browser_profile_id
                 WHERE s.pinned = 1
                   AND bp.cf_profile_id = ?1
                   AND bp.enabled = 1
                 ORDER BY bp.position ASC, bp.created_at ASC,
                          s.position ASC, s.created_at ASC"
            ))
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![cf_profile_id], row_to_shortcut)
            .map_err(to_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(to_err)?);
        }
        Ok(out)
    })
}
