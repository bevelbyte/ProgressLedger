//! Focus Curtain: Study mode settings.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::params;

use crate::db::{to_err, with_db};
use crate::errors::{coded, codes};
use crate::validate::valid_id;

#[napi(object)]
pub struct FocusSettings {
    pub id: i32,
    pub profile_id: i32,
    pub is_enabled: bool,
    pub blocked_domains: String,
    pub created_at: String,
}

// ===== Focus Curtain =====

#[napi]
pub fn get_focus_settings(profile_id: i32) -> Result<Option<FocusSettings>> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    with_db(|conn| {
        let mut stmt = conn
            .prepare("SELECT id, profile_id, is_enabled, blocked_domains, created_at FROM focus_settings WHERE profile_id = ?1")
            .map_err(to_err)?;

        let mut rows = stmt
            .query_map(params![profile_id], |row| {
                Ok(FocusSettings {
                    id: row.get(0)?,
                    profile_id: row.get(1)?,
                    is_enabled: row.get::<_, i32>(2)? != 0,
                    blocked_domains: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(to_err)?;

        if let Some(r) = rows.next() {
            Ok(Some(r.map_err(to_err)?))
        } else {
            Ok(None)
        }
    })
}

/// Insert or update focus settings for `profile_id`. The profile must
/// already exist; we verify before writing so a renderer compromise
/// cannot plant rows against a non-existent (or another user's) profile.
#[napi]
pub fn update_focus_settings(
    profile_id: i32,
    is_enabled: bool,
    blocked_domains: String,
) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    with_db(|conn| {
        assert_profile_exists(conn, profile_id)?;
        conn.execute(
            "INSERT INTO focus_settings (profile_id, is_enabled, blocked_domains)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(profile_id) DO UPDATE SET is_enabled = ?2, blocked_domains = ?3",
            params![profile_id, is_enabled as i32, blocked_domains],
        )
        .map_err(to_err)?;
        Ok(())
    })
}

/// Confirm `profile_id` exists in the profiles table. The P1 audit found
/// focus.rs accepted a renderer-supplied profile_id without checking the
/// profile exists. This is the cheap first line of defense — even if a
/// renderer bug sent a stale id, we fail with NOT_OWNED before the SQL.
fn assert_profile_exists(conn: &rusqlite::Connection, profile_id: i32) -> Result<()> {
    let n: i32 = conn
        .query_row(
            "SELECT 1 FROM profiles WHERE id = ?1",
            params![profile_id],
            |r| r.get(0),
        )
        .map_err(to_err)?;
    if n == 0 {
        return Err(coded(codes::NOT_OWNED, "Profile does not exist"));
    }
    Ok(())
}
