//! Academic hierarchy management: Tracks → Semesters → Milestones → Subjects.
//!
//! This module handles the core academic structure that organizes a student's
//! curriculum into a hierarchical tree.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::params;

use crate::db::{to_err, with_db};
use crate::validate::{
    enum_value, profile_id as valid_profile_id, required_text, text, valid_id, MAX_CODE, MAX_NAME,
    MAX_SLUG,
};

/// Mirrors the `profiles` table. napi camelCases -> { id, name, slug, createdAt }.
#[napi(object)]
pub struct Profile {
    pub id: i32,
    pub name: String,
    pub slug: String,
    pub created_at: String,
}

#[napi]
pub fn get_profiles() -> Result<Vec<Profile>> {
    with_db(|conn| {
        let mut stmt = conn
            .prepare("SELECT id, name, slug, created_at FROM profiles ORDER BY id DESC")
            .map_err(to_err)?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Profile {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    slug: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })
            .map_err(to_err)?;

        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(to_err)?);
        }
        Ok(out)
    })
}

/// Insert a profile; returns the created row so the UI can append without a refetch.
/// Fails clearly if the slug already exists (UNIQUE constraint).
#[napi]
pub fn add_profile(name: String, slug: String) -> Result<Profile> {
    let name = required_text(name, "name", MAX_NAME)?;
    let slug = required_text(slug, "slug", MAX_SLUG)?;
    with_db(|conn| {
        conn.execute(
            "INSERT INTO profiles (name, slug) VALUES (?1, ?2)",
            params![name, slug],
        )
        .map_err(|_| {
            crate::errors::coded(
                crate::errors::codes::DB_CONSTRAINT,
                format!("Profile slug '{slug}' is already in use"),
            )
        })?;

        let id = conn.last_insert_rowid() as i32;
        conn.query_row(
            "SELECT id, name, slug, created_at FROM profiles WHERE id = ?1",
            params![id],
            |row| {
                Ok(Profile {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    slug: row.get(2)?,
                    created_at: row.get(3)?,
                })
            },
        )
        .map_err(to_err)
    })
}

#[napi]
pub fn delete_profile(id: i32) -> Result<()> {
    with_db(|conn| {
        conn.execute("DELETE FROM profiles WHERE id = ?1", params![id])
            .map_err(to_err)?;
        Ok(())
    })
}

// ===== Academic hierarchy types =====

#[napi(object)]
pub struct SubjectNode {
    pub id: i32,
    pub milestone_id: i32,
    pub name: String,
    pub status: String,
    pub code: Option<String>,
}

#[napi(object)]
pub struct MilestoneNode {
    pub id: i32,
    pub semester_id: i32,
    pub title: String,
    pub subjects: Vec<SubjectNode>,
}

#[napi(object)]
pub struct SemesterNode {
    pub id: i32,
    pub track_id: i32,
    pub name: String,
    /// User-declared academic state: 'Upcoming' | 'In Progress' | 'Completed'.
    /// Distinct from derived progress and computed SGPA.
    pub status: String,
    pub milestones: Vec<MilestoneNode>,
}

#[napi(object)]
pub struct TrackNode {
    pub id: i32,
    pub name: String,
    pub semesters: Vec<SemesterNode>,
}

/// Fetch one profile's full Track -> Semester -> Milestone -> Subject tree.
#[napi]
pub fn get_academic_tree(profile_id: i32) -> Result<Vec<TrackNode>> {
    with_db(|conn| {
        use std::collections::HashMap;

        // Subjects grouped by milestone.
        let mut subjects_by_ms: HashMap<i32, Vec<SubjectNode>> = HashMap::new();
        {
            crate::db::log_debug("info", "[SQL Query Start] SELECT id, milestone_id, name, status, code FROM subjects ORDER BY id");
            let mut stmt = conn
                .prepare("SELECT id, milestone_id, name, status, code FROM subjects ORDER BY id")
                .map_err(to_err)?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i32>(0)?,
                        r.get::<_, i32>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, Option<String>>(4)?,
                    ))
                })
                .map_err(to_err)?;
            let mut count = 0;
            for row in rows {
                let (id, milestone_id, name, status, code) = row.map_err(to_err)?;
                count += 1;
                subjects_by_ms
                    .entry(milestone_id)
                    .or_default()
                    .push(SubjectNode {
                        id,
                        milestone_id,
                        name,
                        status,
                        code,
                    });
            }
            crate::db::log_debug(
                "info",
                &format!(
                    "[SQL Query End] [Subject Query] Retrieved {} subjects",
                    count
                ),
            );
        }

        // Milestones grouped by semester.
        let mut milestones_by_sem: HashMap<i32, Vec<MilestoneNode>> = HashMap::new();
        {
            let mut stmt = conn
                .prepare("SELECT id, semester_id, title FROM milestones ORDER BY id")
                .map_err(to_err)?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i32>(0)?,
                        r.get::<_, i32>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })
                .map_err(to_err)?;
            for row in rows {
                let (id, semester_id, title) = row.map_err(to_err)?;
                let subjects = subjects_by_ms.remove(&id).unwrap_or_default();
                milestones_by_sem
                    .entry(semester_id)
                    .or_default()
                    .push(MilestoneNode {
                        id,
                        semester_id,
                        title,
                        subjects,
                    });
            }
        }

        // Semesters grouped by track.
        let mut semesters_by_track: HashMap<i32, Vec<SemesterNode>> = HashMap::new();
        {
            let mut stmt = conn
                .prepare("SELECT id, track_id, name, status FROM semesters ORDER BY id")
                .map_err(to_err)?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i32>(0)?,
                        r.get::<_, i32>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })
                .map_err(to_err)?;
            for row in rows {
                let (id, track_id, name, status) = row.map_err(to_err)?;
                let milestones = milestones_by_sem.remove(&id).unwrap_or_default();
                semesters_by_track
                    .entry(track_id)
                    .or_default()
                    .push(SemesterNode {
                        id,
                        track_id,
                        name,
                        status,
                        milestones,
                    });
            }
        }

        // Tracks for the profile.
        let mut stmt = conn
            .prepare("SELECT id, name FROM tracks WHERE profile_id = ?1 ORDER BY id")
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![profile_id], |r| {
                Ok((r.get::<_, i32>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(to_err)?;

        let mut tracks = Vec::new();
        for row in rows {
            let (id, name) = row.map_err(to_err)?;
            let semesters = semesters_by_track.remove(&id).unwrap_or_default();
            tracks.push(TrackNode {
                id,
                name,
                semesters,
            });
        }

        Ok(tracks)
    })
}

// ===== Academic hierarchy CRUD =====

#[napi]
pub fn add_track(profile_id: i32, name: String) -> Result<i32> {
    let profile_id = valid_profile_id(profile_id)?;
    let name = required_text(name, "name", MAX_NAME)?;
    with_db(|conn| {
        conn.execute(
            "INSERT INTO tracks (profile_id, name) VALUES (?1, ?2)",
            params![profile_id, name],
        )
        .map_err(to_err)?;
        Ok(conn.last_insert_rowid() as i32)
    })
}

#[napi]
pub fn add_semester(profile_id: i32, track_id: i32, name: String) -> Result<i32> {
    let profile_id = valid_profile_id(profile_id)?;
    let track_id = valid_id(track_id, "track_id")?;
    let name = required_text(name, "name", MAX_NAME)?;
    with_db(|conn| {
        let owner: i32 = conn
            .query_row(
                "SELECT profile_id FROM tracks WHERE id = ?1",
                params![track_id],
                |r| r.get(0),
            )
            .map_err(|_| {
                crate::errors::coded(
                    crate::errors::codes::NOT_OWNED,
                    "Track not found in this profile",
                )
            })?;
        if owner != profile_id {
            return Err(crate::errors::coded(
                crate::errors::codes::NOT_OWNED,
                "Track not found in this profile",
            ));
        }
        conn.execute(
            "INSERT INTO semesters (track_id, name) VALUES (?1, ?2)",
            params![track_id, name],
        )
        .map_err(to_err)?;
        Ok(conn.last_insert_rowid() as i32)
    })
}

#[napi]
pub fn add_milestone(profile_id: i32, semester_id: i32, title: String) -> Result<i32> {
    let profile_id = valid_profile_id(profile_id)?;
    let semester_id = valid_id(semester_id, "semester_id")?;
    let title = required_text(title, "title", MAX_NAME)?;
    with_db(|conn| {
        let owner: i32 = conn.query_row(
            "SELECT t.profile_id FROM semesters s JOIN tracks t ON t.id = s.track_id WHERE s.id = ?1",
            params![semester_id], |r| r.get(0),
        ).map_err(|_| crate::errors::coded(crate::errors::codes::NOT_OWNED, "Semester not found in this profile"))?;
        if owner != profile_id {
            return Err(crate::errors::coded(
                crate::errors::codes::NOT_OWNED,
                "Semester not found in this profile",
            ));
        }
        conn.execute(
            "INSERT INTO milestones (semester_id, title) VALUES (?1, ?2)",
            params![semester_id, title],
        )
        .map_err(to_err)?;
        Ok(conn.last_insert_rowid() as i32)
    })
}

#[napi]
pub fn add_subject(
    profile_id: i32,
    milestone_id: i32,
    name: String,
    code: Option<String>,
) -> Result<i32> {
    let profile_id = valid_profile_id(profile_id)?;
    let milestone_id = valid_id(milestone_id, "milestone_id")?;
    let name = required_text(name, "name", MAX_NAME)?;
    let code = text(code, "code", MAX_CODE)?;
    with_db(|conn| {
        let owner: i32 = conn.query_row(
            "SELECT t.profile_id FROM milestones m JOIN semesters s ON s.id = m.semester_id JOIN tracks t ON t.id = s.track_id WHERE m.id = ?1",
            params![milestone_id], |r| r.get(0),
        ).map_err(|_| crate::errors::coded(crate::errors::codes::NOT_OWNED, "Milestone not found in this profile"))?;
        if owner != profile_id {
            return Err(crate::errors::coded(
                crate::errors::codes::NOT_OWNED,
                "Milestone not found in this profile",
            ));
        }
        conn.execute(
            "INSERT INTO subjects (milestone_id, name, code) VALUES (?1, ?2, ?3)",
            params![milestone_id, name, code],
        )
        .map_err(to_err)?;
        Ok(conn.last_insert_rowid() as i32)
    })
}

#[napi]
pub fn update_subject(profile_id: i32, id: i32, name: String, code: Option<String>) -> Result<()> {
    let profile_id = valid_profile_id(profile_id)?;
    let id = crate::validate::valid_id(id, "id")?;
    let name = required_text(name, "name", MAX_NAME)?;
    let code = text(code, "code", MAX_CODE)?;
    with_db(|conn| {
        conn.execute(
            "UPDATE subjects SET name = ?2, code = ?3 WHERE id = ?1 AND milestone_id IN (SELECT m.id FROM milestones m JOIN semesters s ON s.id = m.semester_id JOIN tracks t ON t.id = s.track_id WHERE t.profile_id = ?4)",
            params![id, name, code, profile_id],
        )
        .map_err(to_err)?;
        Ok(())
    })
}

// ===== Delete nodes (children cascade automatically) =====

#[napi]
pub fn delete_track(profile_id: i32, id: i32) -> Result<()> {
    let profile_id = valid_profile_id(profile_id)?;
    let row_id = valid_id(id, "id")?;
    with_db(|conn| {
        let n = conn
            .execute(
                "DELETE FROM tracks WHERE id = ?1 AND profile_id = ?2",
                params![row_id, profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(crate::errors::coded(
                crate::errors::codes::NOT_OWNED,
                "Track not found in this profile",
            ));
        }
        Ok(())
    })
}

#[napi]
pub fn delete_semester(profile_id: i32, id: i32) -> Result<()> {
    let profile_id = valid_profile_id(profile_id)?;
    let row_id = valid_id(id, "id")?;
    with_db(|conn| {
        let n = conn.execute("DELETE FROM semesters WHERE id = ?1 AND track_id IN (SELECT id FROM tracks WHERE profile_id = ?2)", params![row_id, profile_id])
            .map_err(to_err)?;
        if n == 0 {
            return Err(crate::errors::coded(
                crate::errors::codes::NOT_OWNED,
                "Semester not found in this profile",
            ));
        }
        Ok(())
    })
}

#[napi]
pub fn delete_milestone(profile_id: i32, id: i32) -> Result<()> {
    let profile_id = valid_profile_id(profile_id)?;
    let row_id = valid_id(id, "id")?;
    with_db(|conn| {
        let n = conn.execute("DELETE FROM milestones WHERE id = ?1 AND semester_id IN (SELECT s.id FROM semesters s JOIN tracks t ON t.id = s.track_id WHERE t.profile_id = ?2)", params![row_id, profile_id])
            .map_err(to_err)?;
        if n == 0 {
            return Err(crate::errors::coded(
                crate::errors::codes::NOT_OWNED,
                "Milestone not found in this profile",
            ));
        }
        Ok(())
    })
}

#[napi]
pub fn delete_subject(profile_id: i32, id: i32) -> Result<()> {
    let profile_id = valid_profile_id(profile_id)?;
    let row_id = valid_id(id, "id")?;
    with_db(|conn| {
        let n = conn.execute("DELETE FROM subjects WHERE id = ?1 AND milestone_id IN (SELECT m.id FROM milestones m JOIN semesters s ON s.id = m.semester_id JOIN tracks t ON t.id = s.track_id WHERE t.profile_id = ?2)", params![row_id, profile_id])
            .map_err(to_err)?;
        if n == 0 {
            return Err(crate::errors::coded(
                crate::errors::codes::NOT_OWNED,
                "Subject not found in this profile",
            ));
        }
        Ok(())
    })
}

/// Update a subject's status. Allowlist mirrors the UI dropdown so an
/// out-of-band status string can never silently land in the DB.
#[napi]
pub fn set_subject_status(profile_id: i32, id: i32, status: String) -> Result<()> {
    let profile_id = valid_profile_id(profile_id)?;
    let row_id = valid_id(id, "id")?;
    let status = enum_value(status, "status", &["pending", "in_progress", "done"])?;
    with_db(|conn| {
        conn.execute(
            "UPDATE subjects SET status = ?2 WHERE id = ?1 AND milestone_id IN (SELECT m.id FROM milestones m JOIN semesters s ON s.id = m.semester_id JOIN tracks t ON t.id = s.track_id WHERE t.profile_id = ?3)",
            params![row_id, status, profile_id],
        )
        .map_err(to_err)?;
        Ok(())
    })
}

/// Update a semester's user-declared status (Upcoming | In Progress | Completed).
/// This is the student's declaration; it is intentionally independent of course
/// marks and never recomputed from them.
#[napi]
pub fn set_semester_status(profile_id: i32, id: i32, status: String) -> Result<()> {
    let profile_id = valid_profile_id(profile_id)?;
    let id = valid_id(id, "id")?;
    with_db(|conn| {
        conn.execute(
            "UPDATE semesters SET status = ?2 WHERE id = ?1 AND track_id IN (SELECT id FROM tracks WHERE profile_id = ?3)",
            params![id, status, profile_id],
        )
        .map_err(to_err)?;
        Ok(())
    })
}
