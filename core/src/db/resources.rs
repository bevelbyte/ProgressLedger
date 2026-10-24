//! Resource management: Notes, PDF attachments, and full-text search.
//!
//! This module handles study resources including text notes, PDF attachments with
//! extracted text for search, and FTS5-powered keyword search.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

use crate::db::{attach_root, to_err, with_db, with_transaction};
use crate::errors::{coded, codes};
use crate::validate::{required_text, valid_id, MAX_BLOB, MAX_NAME, MAX_PATH};

#[napi(object)]
pub struct ResourceMeta {
    pub id: i32,
    pub subject_id: i32,
    pub kind: String,
    pub title: String,
    /// Resolved ABSOLUTE path for the UI to open (from rel_path, else legacy).
    pub file_path: Option<String>,
    /// Canonical internal relative path under the attachments root (pdf only).
    pub rel_path: Option<String>,
    pub byte_size: Option<i64>,
    pub created_at: String,
}

#[napi(object)]
pub struct Resource {
    pub id: i32,
    pub subject_id: i32,
    pub kind: String,
    pub title: String,
    /// Resolved ABSOLUTE path for the UI to open (from rel_path, else legacy).
    pub file_path: Option<String>,
    pub rel_path: Option<String>,
    pub byte_size: Option<i64>,
    pub content: String,
    pub created_at: String,
}

#[napi(object)]
pub struct SearchHit {
    pub id: i32,
    pub subject_id: i32,
    pub subject_name: String,
    pub kind: String,
    pub title: String,
    pub snippet: String,
}

fn resolve_file_path(rel: &Option<String>, legacy: &Option<String>) -> Option<String> {
    if let Some(r) = rel {
        if let Ok(root) = attach_root() {
            return Some(root.join(r).to_string_lossy().to_string());
        }
    }
    legacy.clone()
}

fn is_reparse_point(_meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        return _meta.file_attributes() & 0x0400 != 0;
    }
    #[cfg(not(windows))]
    {
        false
    }
}

pub(crate) fn ensure_attachment_profile_dir(root: &Path, profile_id: i32) -> Result<PathBuf> {
    let root_meta = std::fs::symlink_metadata(root).map_err(|e| {
        coded(codes::IO_ERROR, format!("Failed to inspect attachments root: {e}"))
    })?;
    if root_meta.file_type().is_symlink() || is_reparse_point(&root_meta) || !root_meta.is_dir() {
        return Err(coded(codes::IO_ERROR, "Attachments root is not a regular directory"));
    }
    let profile_dir = root.join(profile_id.to_string());
    if let Ok(meta) = std::fs::symlink_metadata(&profile_dir) {
        if meta.file_type().is_symlink() || is_reparse_point(&meta) || !meta.is_dir() {
            return Err(coded(codes::IO_ERROR, "Attachment directory is not a regular directory"));
        }
    } else {
        std::fs::create_dir(&profile_dir).map_err(|e| {
            coded(codes::IO_ERROR, format!("I/O error while creating attachments directory: {e}"))
        })?;
    }
    let root_real = std::fs::canonicalize(root).map_err(|e| {
        coded(codes::IO_ERROR, format!("Failed to resolve attachments root: {e}"))
    })?;
    let profile_real = std::fs::canonicalize(&profile_dir).map_err(|e| {
        coded(codes::IO_ERROR, format!("Failed to resolve attachment directory: {e}"))
    })?;
    if !profile_real.starts_with(&root_real) || profile_real == root_real {
        return Err(coded(codes::IO_ERROR, "Attachment directory escapes attachments root"));
    }
    Ok(profile_dir)
}

// ===== Resource CRUD =====

#[napi]
pub fn list_resources(profile_id: i32, subject_id: i32) -> Result<Vec<ResourceMeta>> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    with_db(|conn| {
        assert_resource_subject_owned_by(conn, profile_id, subject_id)?;
        let mut stmt = conn
            .prepare(
                "SELECT id, subject_id, kind, title, rel_path, file_path, byte_size, created_at
                 FROM resources WHERE subject_id = ?1 ORDER BY created_at DESC, id DESC",
            )
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![subject_id], |r| {
                let rel: Option<String> = r.get(4)?;
                let legacy: Option<String> = r.get(5)?;
                Ok(ResourceMeta {
                    id: r.get(0)?,
                    subject_id: r.get(1)?,
                    kind: r.get(2)?,
                    title: r.get(3)?,
                    file_path: resolve_file_path(&rel, &legacy),
                    rel_path: rel,
                    byte_size: r.get(6)?,
                    created_at: r.get(7)?,
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
pub fn get_resource(profile_id: i32, id: i32) -> Result<Resource> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let id = valid_id(id, "id")?;
    with_db(|conn| {
        let row = conn
            .query_row(
                "SELECT id, subject_id, kind, title, rel_path, file_path, byte_size, content, created_at
                 FROM resources r
                 WHERE r.id = ?1
                   AND r.subject_id IN (SELECT sub.id FROM subjects sub JOIN milestones m ON m.id=sub.milestone_id JOIN semesters se ON se.id=m.semester_id JOIN tracks t ON t.id=se.track_id WHERE t.profile_id = ?2)",
                params![id, profile_id],
                |r| {
                    let rel: Option<String> = r.get(4)?;
                    let legacy: Option<String> = r.get(5)?;
                    Ok(Resource {
                        id: r.get(0)?,
                        subject_id: r.get(1)?,
                        kind: r.get(2)?,
                        title: r.get(3)?,
                        file_path: resolve_file_path(&rel, &legacy),
                        rel_path: rel,
                        byte_size: r.get(6)?,
                        content: r.get(7)?,
                        created_at: r.get(8)?,
                    })
                },
            )
            .map_err(to_err)?;
        Ok(row)
    })
}

/// Add a note. `profile_id` is the caller's profile; the subject must
/// belong to it.
#[napi]
pub fn add_note(profile_id: i32, subject_id: i32, title: String, content: String) -> Result<i32> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let subject_id = valid_id(subject_id, "subject_id")?;
    let title = required_text(title, "title", MAX_NAME)?;
    let content = required_text(content, "content", MAX_BLOB)?;
    with_db(|conn| {
        assert_resource_subject_owned_by(conn, profile_id, subject_id)?;
        conn.execute(
            "INSERT INTO resources (subject_id, kind, title, content)
             VALUES (?1, 'note', ?2, ?3)",
            params![subject_id, title, content],
        )
        .map_err(to_err)?;
        Ok(conn.last_insert_rowid() as i32)
    })
}

/// Update a note. `profile_id` is the caller's profile; the row's subject
/// must belong to it.
#[napi]
pub fn update_note(profile_id: i32, id: i32, title: String, content: String) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let row_id = valid_id(id, "id")?;
    let title = required_text(title, "title", MAX_NAME)?;
    let content = required_text(content, "content", MAX_BLOB)?;
    with_db(|conn| {
        let n = conn
            .execute(
                "UPDATE resources
                 SET title = ?2, content = ?3
                 WHERE id = ?1 AND kind = 'note'
                   AND subject_id IN (SELECT sub.id FROM subjects sub
                                      JOIN milestones m ON m.id = sub.milestone_id
                                      JOIN semesters se ON se.id = m.semester_id
                                      JOIN tracks t ON t.id = se.track_id
                                      WHERE t.profile_id = ?4)",
                params![row_id, title, content, profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(codes::NOT_OWNED, "Note not found in this profile"));
        }
        Ok(())
    })
}

/// Delete a resource. `profile_id` is the caller's profile.
#[napi]
pub fn delete_resource(profile_id: i32, id: i32) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let row_id = valid_id(id, "id")?;
    with_db(|conn| {
        let n = conn
            .execute(
                "DELETE FROM resources
                 WHERE id = ?1
                   AND subject_id IN (SELECT sub.id FROM subjects sub
                                      JOIN milestones m ON m.id = sub.milestone_id
                                      JOIN semesters se ON se.id = m.semester_id
                                      JOIN tracks t ON t.id = se.track_id
                                      WHERE t.profile_id = ?2)",
                params![row_id, profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "Resource not found in this profile",
            ));
        }
        Ok(())
    })
}

// ===== PDF attachment =====

/// Attach a file. The renderer-supplied `source_path` is constrained by the
/// `dialog.showOpenDialog` flow at the IPC layer; the only renderer input
/// here is the `subject_id`. We verify the subject exists and belongs to a
/// real track/profile chain BEFORE we copy any bytes, so a renderer
/// compromise cannot write into another profile's subject directory.
#[napi]
pub fn attach_file(profile_id: i32, subject_id: i32, title: String, source_path: String) -> Result<i32> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let subject_id = valid_id(subject_id, "subject_id")?;
    let title = required_text(title, "title", MAX_NAME)?;
    let source_path = required_text(source_path, "source_path", MAX_PATH)?;
    with_transaction(|conn| {
        // Copy file to attachments/<profile_id>/<resource_id>.pdf
        let root = attach_root()?;
        assert_resource_subject_owned_by(conn, profile_id, subject_id)?;

        // Verify the subject chain is intact and grab the profile_id at the
        // same time. We resolve profile_id from the subject (no profile_id
        // argument because the file dialog flow is the source of truth for
        // the path) and explicitly fail with NOT_OWNED rather than a generic
        // FK error so a renderer bug or compromise is rejected with the
        // right code.
        let subject_profile_id: i32 = conn
            .query_row(
                "SELECT t.profile_id FROM subjects s
                 JOIN milestones m ON m.id = s.milestone_id
                 JOIN semesters se ON se.id = m.semester_id
                 JOIN tracks t ON t.id = se.track_id
                 WHERE s.id = ?1",
                params![subject_id],
                |r| r.get(0),
            )
            .map_err(|e| {
                if matches!(e, rusqlite::Error::QueryReturnedNoRows) {
                    coded(codes::NOT_OWNED, "Subject does not belong to any profile")
                } else {
                    to_err(e)
                }
            })?;

        if subject_profile_id != profile_id {
            return Err(coded(codes::NOT_OWNED, "Subject does not belong to this profile"));
        }
        let profile_dir = ensure_attachment_profile_dir(&root, profile_id)?;

        // Insert resource row first to get ID
        conn.execute(
            "INSERT INTO resources (subject_id, kind, title, file_path)
             VALUES (?1, 'pdf', ?2, ?3)",
            params![subject_id, &title, &source_path],
        )
        .map_err(to_err)?;
        let resource_id = conn.last_insert_rowid() as i32;

        // Copy to final location
        let dest_path = profile_dir.join(format!("{}.pdf", resource_id));
        std::fs::copy(&source_path, &dest_path).map_err(|e| {
            let msg = match e.kind() {
                std::io::ErrorKind::NotFound => "Source PDF not found",
                std::io::ErrorKind::PermissionDenied => "Permission denied while copying PDF",
                _ => "I/O error while copying PDF",
            };
            coded(codes::IO_ERROR, msg)
        })?;

        // Get file size
        let metadata = std::fs::metadata(&dest_path).map_err(|e| {
            let msg = match e.kind() {
                std::io::ErrorKind::NotFound => "Destination PDF not found",
                std::io::ErrorKind::PermissionDenied => {
                    "Permission denied while reading PDF metadata"
                }
                _ => "I/O error while reading PDF metadata",
            };
            coded(codes::IO_ERROR, msg)
        })?;
        let byte_size = metadata.len() as i64;

        // Update with relative path and size
        let rel_path = format!("{}/{}.pdf", profile_id, resource_id);
        conn.execute(
            "UPDATE resources SET rel_path = ?1, file_path = NULL, byte_size = ?2 WHERE id = ?3",
            params![rel_path, byte_size, resource_id],
        )
        .map_err(to_err)?;

        // Extract text in background (non-blocking)
        let dest_clone = dest_path.clone();
        let rid = resource_id;
        std::thread::spawn(move || {
            if let Ok(bytes) = std::fs::read(&dest_clone) {
                if let Ok(text) = pdf_extract::extract_text_from_mem(&bytes) {
                    let _ = with_db(|conn| {
                        let _ = conn
                            .execute(
                                "UPDATE resources SET content = ?1 WHERE id = ?2",
                                params![text, rid],
                            )
                            .map_err(to_err);
                        Ok::<(), Error>(())
                    });
                }
            }
        });

        Ok(resource_id)
    })
}

/// Confirm a subject exists and its chain belongs to `profile_id`.
fn assert_resource_subject_owned_by(
    conn: &Connection,
    profile_id: i32,
    subject_id: i32,
) -> Result<()> {
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

// ===== FTS5 Search =====

#[napi]
pub fn search_resources(profile_id: i32, query: String) -> Result<Vec<SearchHit>> {
    with_db(|conn| {
        let match_q = format!("\"{}\"*", query.replace('"', "\"\""));
        let mut stmt = conn
            .prepare(
                "SELECT r.id, r.subject_id, r.kind, r.title, snippet(resources_fts, -1, '<mark>', '</mark>', '...', 20) as snippet, s.name
                 FROM resources_fts
                 JOIN resources  r  ON r.id = resources_fts.rowid
                 JOIN subjects   s  ON s.id = r.subject_id
                 JOIN milestones m  ON m.id = s.milestone_id
                 JOIN semesters  se ON se.id = m.semester_id
                 JOIN tracks     t  ON t.id = se.track_id
                 WHERE resources_fts MATCH ?1 AND t.profile_id = ?2
                 ORDER BY bm25(resources_fts)
                 LIMIT 50",
            )
            .map_err(to_err)?;

        let rows = stmt
            .query_map(params![match_q, profile_id], |r| {
                Ok(SearchHit {
                    id: r.get(0)?,
                    subject_id: r.get(1)?,
                    kind: r.get(2)?,
                    title: r.get(3)?,
                    snippet: r.get(4)?,
                    subject_name: r.get(5)?,
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

// ===== Dashboard Stats =====

#[napi(object)]
pub struct ActivityItem {
    pub kind: String,
    pub title: String,
    pub subject_name: String,
    pub created_at: String,
}

#[napi(object)]
pub struct StatusBreakdown {
    pub pending: i32,
    pub in_progress: i32,
    pub done: i32,
}

#[napi(object)]
pub struct DashboardStats {
    pub track_count: i32,
    pub semester_count: i32,
    pub milestone_count: i32,
    pub subject_count: i32,
    pub note_count: i32,
    pub pdf_count: i32,
    pub resource_count: i32,
    pub completion_pct: f64,
    pub status: StatusBreakdown,
    pub current_streak: i32,
    pub recent: Vec<ActivityItem>,
}

#[napi]
pub fn get_dashboard_stats(profile_id: i32) -> Result<DashboardStats> {
    with_db(|conn| {
        // Basic counts
        let track_count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM tracks WHERE profile_id = ?1",
                params![profile_id],
                |row| row.get(0),
            )
            .map_err(to_err)?;

        let semester_count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM semesters se
                 JOIN tracks t ON t.id = se.track_id
                 WHERE t.profile_id = ?1",
                params![profile_id],
                |row| row.get(0),
            )
            .map_err(to_err)?;

        let milestone_count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM milestones m
                 JOIN semesters se ON se.id = m.semester_id
                 JOIN tracks t ON t.id = se.track_id
                 WHERE t.profile_id = ?1",
                params![profile_id],
                |row| row.get(0),
            )
            .map_err(to_err)?;

        // Subject status breakdown
        let (mut pending, mut in_progress, mut done) = (0, 0, 0);
        {
            let mut stmt = conn
                .prepare(
                    "SELECT s.status, COUNT(*) FROM subjects s
                     JOIN milestones m ON m.id = s.milestone_id
                     JOIN semesters se ON se.id = m.semester_id
                     JOIN tracks t ON t.id = se.track_id
                     WHERE t.profile_id = ?1 GROUP BY s.status",
                )
                .map_err(to_err)?;
            let rows = stmt
                .query_map(params![profile_id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i32>(1)?))
                })
                .map_err(to_err)?;
            for row in rows {
                let (st, c) = row.map_err(to_err)?;
                match st.as_str() {
                    "pending" => pending = c,
                    "in_progress" => in_progress = c,
                    "done" => done = c,
                    _ => {}
                }
            }
        }
        let subject_count = pending + in_progress + done;
        let completion_pct = if subject_count > 0 {
            (done as f64) / (subject_count as f64) * 100.0
        } else {
            0.0
        };

        // Resource counts by kind.
        let (mut note_count, mut pdf_count) = (0, 0);
        {
            let mut stmt = conn
                .prepare(
                    "SELECT r.kind, COUNT(*) FROM resources r
                     JOIN subjects s ON s.id = r.subject_id
                     JOIN milestones m ON m.id = s.milestone_id
                     JOIN semesters se ON se.id = m.semester_id
                     JOIN tracks t ON t.id = se.track_id
                     WHERE t.profile_id = ?1 GROUP BY r.kind",
                )
                .map_err(to_err)?;
            let rows = stmt
                .query_map(params![profile_id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i32>(1)?))
                })
                .map_err(to_err)?;
            for row in rows {
                let (k, c) = row.map_err(to_err)?;
                match k.as_str() {
                    "note" => note_count = c,
                    "pdf" => pdf_count = c,
                    _ => {}
                }
            }
        }

        // Recent activity feed (latest resources).
        let mut recent = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT r.kind, r.title, s.name, r.created_at FROM resources r
                     JOIN subjects s ON s.id = r.subject_id
                     JOIN milestones m ON m.id = s.milestone_id
                     JOIN semesters se ON se.id = m.semester_id
                     JOIN tracks t ON t.id = se.track_id
                     WHERE t.profile_id = ?1
                     ORDER BY r.created_at DESC, r.id DESC LIMIT 8",
                )
                .map_err(to_err)?;
            let rows = stmt
                .query_map(params![profile_id], |r| {
                    Ok(ActivityItem {
                        kind: r.get(0)?,
                        title: r.get(1)?,
                        subject_name: r.get(2)?,
                        created_at: r.get(3)?,
                    })
                })
                .map_err(to_err)?;
            for row in rows {
                recent.push(row.map_err(to_err)?);
            }
        }

        // Study streak: distinct activity days (resources created + cards reviewed)
        // ending today/yesterday.
        let mut days: std::collections::HashSet<String> = std::collections::HashSet::new();

        // Days with resource creation
        {
            let mut stmt = conn
                .prepare(
                    "SELECT DISTINCT date(r.created_at,'localtime') FROM resources r
                     JOIN subjects s ON s.id = r.subject_id
                     JOIN milestones m ON m.id = s.milestone_id
                     JOIN semesters se ON se.id = m.semester_id
                     JOIN tracks t ON t.id = se.track_id
                     WHERE t.profile_id = ?1",
                )
                .map_err(to_err)?;
            let rows = stmt
                .query_map(params![profile_id], |r| r.get::<_, String>(0))
                .map_err(to_err)?;
            for row in rows {
                days.insert(row.map_err(to_err)?);
            }
        }

        // Also count days with card reviews
        {
            let mut stmt = conn
                .prepare(
                    "SELECT DISTINCT date(c.last_reviewed) FROM cards c
                     JOIN subjects s ON s.id = c.subject_id
                     JOIN milestones m ON m.id = s.milestone_id
                     JOIN semesters se ON se.id = m.semester_id
                     JOIN tracks t ON t.id = se.track_id
                     WHERE t.profile_id = ?1 AND c.last_reviewed IS NOT NULL",
                )
                .map_err(to_err)?;
            let rows = stmt
                .query_map(params![profile_id], |r| r.get::<_, String>(0))
                .map_err(to_err)?;
            for row in rows {
                days.insert(row.map_err(to_err)?);
            }
        }

        // Also count days with logged study sessions — actual study activity.
        {
            let mut stmt = conn
                .prepare(
                    "SELECT DISTINCT date(ss.started_at) FROM session_states ss
                     JOIN subjects s ON s.id = ss.subject_id
                     JOIN milestones m ON m.id = s.milestone_id
                     JOIN semesters se ON se.id = m.semester_id
                     JOIN tracks t ON t.id = se.track_id
                     WHERE t.profile_id = ?1",
                )
                .map_err(to_err)?;
            let rows = stmt
                .query_map(params![profile_id], |r| r.get::<_, String>(0))
                .map_err(to_err)?;
            for row in rows {
                days.insert(row.map_err(to_err)?);
            }
        }
        let date_at = |off: i32| -> Result<String> {
            conn.query_row(
                "SELECT date('now','localtime', ?1)",
                params![format!("-{off} days")],
                |r| r.get(0),
            )
            .map_err(to_err)
        };
        let mut current_streak = 0;
        let mut off = if days.contains(&date_at(0)?) {
            0
        } else if days.contains(&date_at(1)?) {
            1
        } else {
            -1
        };
        if off >= 0 {
            loop {
                let d = date_at(off)?;
                if days.contains(&d) {
                    current_streak += 1;
                    off += 1;
                } else {
                    break;
                }
            }
        }

        Ok(DashboardStats {
            track_count,
            semester_count,
            milestone_count,
            subject_count,
            note_count,
            pdf_count,
            resource_count: note_count + pdf_count,
            completion_pct,
            status: StatusBreakdown {
                pending,
                in_progress,
                done,
            },
            current_streak,
            recent,
        })
    })
}

#[napi]
pub fn cleanup_orphan_attachments() -> Result<()> {
    with_db(|conn| {
        let mut stmt = conn
            .prepare("SELECT rel_path FROM resources WHERE rel_path IS NOT NULL")
            .map_err(to_err)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(to_err)?;

        let mut db_paths = std::collections::HashSet::new();
        for r in rows {
            if let Ok(path) = r {
                db_paths.insert(path.replace('\\', "/"));
            }
        }

        let root = attach_root()?;
        let root_meta = std::fs::symlink_metadata(&root).map_err(|e| {
            coded(codes::IO_ERROR, format!("Failed to inspect attachments root: {e}"))
        })?;
        if root_meta.file_type().is_symlink() || is_reparse_point(&root_meta) {
            return Err(coded(codes::IO_ERROR, "Attachments root is a symbolic link"));
        }
        if !root.exists() {
            return Ok(());
        }

        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                let meta = match std::fs::symlink_metadata(&path) {
                    Ok(meta) => meta,
                    Err(_) => continue,
                };
                // Never recurse through a symlink/reparse directory: cleanup
                // must not follow an attacker-controlled junction out of the
                // attachments root and delete unrelated files.
                if meta.file_type().is_symlink() || is_reparse_point(&meta) || !meta.is_dir() {
                    continue;
                }
                if meta.is_dir() {
                    let profile_dir_name = entry.file_name().to_string_lossy().into_owned();
                    let mut is_empty = true;
                    if let Ok(sub_entries) = std::fs::read_dir(&path) {
                        for sub_entry in sub_entries.flatten() {
                            let file_path = sub_entry.path();
                            let file_meta = match std::fs::symlink_metadata(&file_path) {
                                Ok(meta) => meta,
                                Err(_) => {
                                    is_empty = false;
                                    continue;
                                }
                            };
                            if file_meta.file_type().is_symlink() || is_reparse_point(&file_meta) {
                                is_empty = false;
                            } else if file_meta.is_file() {
                                let file_name =
                                    sub_entry.file_name().to_string_lossy().into_owned();
                                let rel_path = format!("{}/{}", profile_dir_name, file_name);
                                if !db_paths.contains(&rel_path) {
                                    let _ = std::fs::remove_file(&file_path);
                                } else {
                                    is_empty = false;
                                }
                            } else {
                                is_empty = false;
                            }
                        }
                    }
                    if is_empty {
                        let _ = std::fs::remove_dir(&path);
                    }
                }
            }
        }

        Ok(())
    })
}
