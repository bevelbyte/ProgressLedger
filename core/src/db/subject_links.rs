//! Subject Links: Bookmarks study URLs (Wikipedia, YouTube, NPTEL, etc.) to subjects.
//!
//! This module manages bookmarked research links for subjects, with support for
//! marking a primary link and opening them in the browser.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection};

use crate::db::{to_err, with_db, with_transaction};
use crate::errors::{coded, codes};
use crate::validate::valid_id;

#[napi(object)]
pub struct SubjectLink {
    pub id: i32,
    pub subject_id: i32,
    pub label: String,
    pub url: String,
    pub is_primary: bool,
    pub created_at: String,
}

/// Get all bookmarks/links for a subject (e.g. Wikipedia, YouTube, NPTEL).
#[napi]
pub fn get_subject_links(profile_id: i32, subject_id: i32) -> Result<Vec<SubjectLink>> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let subject_id = valid_id(subject_id, "subject_id")?;
    with_db(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT l.id, l.subject_id, l.label, l.url, l.is_primary, l.created_at
                 FROM subject_links l
                 JOIN subjects sub ON sub.id = l.subject_id
                 JOIN milestones m ON m.id = sub.milestone_id
                 JOIN semesters se ON se.id = m.semester_id
                 JOIN tracks t ON t.id = se.track_id
                 WHERE l.subject_id = ?1 AND t.profile_id = ?2
                 ORDER BY l.is_primary DESC, l.created_at ASC",
            )
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![subject_id, profile_id], |row| {
                Ok(SubjectLink {
                    id: row.get(0)?,
                    subject_id: row.get(1)?,
                    label: row.get(2)?,
                    url: row.get(3)?,
                    is_primary: row.get::<_, i32>(4)? != 0,
                    created_at: row.get(5)?,
                })
            })
            .map_err(to_err)?;
        let mut links = Vec::new();
        for row in rows {
            links.push(row.map_err(to_err)?);
        }
        Ok(links)
    })
}

/// Add a bookmark link to a subject. `profile_id` is the caller's profile;
/// the subject must belong to it.
#[napi]
pub fn add_subject_link(
    profile_id: i32,
    subject_id: i32,
    label: String,
    url: String,
) -> Result<i32> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let subject_id = valid_id(subject_id, "subject_id")?;
    with_db(|conn| {
        assert_link_subject_owned_by(conn, profile_id, subject_id)?;
        conn.execute(
            "INSERT INTO subject_links (subject_id, label, url) VALUES (?1, ?2, ?3)",
            params![subject_id, label, url],
        )
        .map_err(to_err)?;
        Ok(conn.last_insert_rowid() as i32)
    })
}

/// Update a link's label and URL. `profile_id` is the caller's profile;
/// the link's subject must belong to it.
#[napi]
pub fn update_subject_link(
    profile_id: i32,
    link_id: i32,
    label: String,
    url: String,
) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let link_id = valid_id(link_id, "link_id")?;
    with_db(|conn| {
        // Resolve the link's subject_id and verify it belongs to the
        // caller's profile.
        let subject_id: i32 = conn
            .query_row(
                "SELECT subject_id FROM subject_links WHERE id = ?1",
                params![link_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        assert_link_subject_owned_by(conn, profile_id, subject_id)?;
        let n = conn
            .execute(
                "UPDATE subject_links SET label = ?2, url = ?3 WHERE id = ?1 AND subject_id = ?4",
                params![link_id, label, url, subject_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "Subject link not found in this profile",
            ));
        }
        Ok(())
    })
}

/// Delete a subject link. `profile_id` is the caller's profile.
#[napi]
pub fn delete_subject_link(profile_id: i32, link_id: i32) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let link_id = valid_id(link_id, "link_id")?;
    with_db(|conn| {
        let n = conn
            .execute(
                "DELETE FROM subject_links
                 WHERE id = ?1
                   AND subject_id IN (SELECT sub.id FROM subjects sub
                                      JOIN milestones m ON m.id = sub.milestone_id
                                      JOIN semesters se ON se.id = m.semester_id
                                      JOIN tracks t ON t.id = se.track_id
                                      WHERE t.profile_id = ?2)",
                params![link_id, profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "Subject link not found in this profile",
            ));
        }
        Ok(())
    })
}

/// Set a link as the primary (main research URL) for its subject.
/// `profile_id` is the caller's profile; the subject must belong to it.
/// Clears is_primary on other links for the same subject first.
#[napi]
pub fn set_primary_link(profile_id: i32, subject_id: i32, link_id: i32) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let subject_id = valid_id(subject_id, "subject_id")?;
    let link_id = valid_id(link_id, "link_id")?;
    with_transaction(|conn| {
        assert_link_subject_owned_by(conn, profile_id, subject_id)?;

        // Clear all primary flags for this subject
        let n_clear = conn
            .execute(
                "UPDATE subject_links SET is_primary = 0
                 WHERE subject_id = ?1
                   AND subject_id IN (SELECT sub.id FROM subjects sub
                                      JOIN milestones m ON m.id = sub.milestone_id
                                      JOIN semesters se ON se.id = m.semester_id
                                      JOIN tracks t ON t.id = se.track_id
                                      WHERE t.profile_id = ?2)",
                params![subject_id, profile_id],
            )
            .map_err(to_err)?;
        let _ = n_clear;

        // Set this link as primary
        let n = conn
            .execute(
                "UPDATE subject_links SET is_primary = 1 WHERE id = ?1 AND subject_id = ?2",
                params![link_id, subject_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "Subject link not found in this profile",
            ));
        }
        Ok(())
    })
}

/// Helper: confirm a subject exists and its chain belongs to `profile_id`.
fn assert_link_subject_owned_by(conn: &Connection, profile_id: i32, subject_id: i32) -> Result<()> {
    let n: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM subjects sub
             JOIN milestones m ON m.id = sub.milestone_id
             JOIN semesters se ON se.id = m.semester_id
             JOIN tracks t ON t.id = se.track_id
             WHERE sub.id = ?1 AND t.profile_id = ?2",
            params![subject_id, profile_id],
            |r| r.get(0),
        )
        .map_err(to_err)?;
    if n == 0 {
        return Err(coded(
            codes::NOT_OWNED,
            "Subject does not belong to this profile",
        ));
    }
    Ok(())
}
