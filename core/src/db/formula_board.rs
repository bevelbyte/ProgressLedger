//! Formula Board: LaTeX formula sheets rendered offline via KaTeX with PDF export.
//!
//! This module manages mathematical formulas stored as LaTeX content, organized
//! by category and subject for quick reference during study sessions.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection};

use crate::db::{to_err, with_db};
use crate::errors::{coded, codes};
use crate::validate::{required_text, text, valid_id, MAX_CATEGORY, MAX_NAME, MAX_TEXT};

#[napi(object)]
pub struct Formula {
    pub id: i32,
    pub subject_id: i32,
    pub title: String,
    pub latex_content: String,
    pub category: Option<String>,
    pub created_at: String,
}

/// Add a formula. `profile_id` is the caller's profile; the subject must
/// belong to it. A renderer that supplies another profile's subject_id
/// is rejected at the boundary, not via a post-hoc FK violation.
#[napi]
pub fn add_formula(
    profile_id: i32,
    subject_id: i32,
    title: String,
    latex_content: String,
    category: Option<String>,
) -> Result<i32> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let subject_id = valid_id(subject_id, "subject_id")?;
    let title = required_text(title, "title", MAX_NAME)?;
    let latex_content = required_text(latex_content, "latex_content", MAX_TEXT)?;
    let category = text(category, "category", MAX_CATEGORY)?;
    with_db(|conn| {
        assert_formula_subject_owned_by(conn, profile_id, subject_id)?;
        conn.execute(
            "INSERT INTO formulas (subject_id, title, latex_content, category) VALUES (?1, ?2, ?3, ?4)",
            params![subject_id, title, latex_content, category],
        )
        .map_err(to_err)?;
        Ok(conn.last_insert_rowid() as i32)
    })
}

#[napi]
pub fn get_formulas(
    profile_id: i32,
    subject_id: Option<i32>,
    category: Option<String>,
) -> Result<Vec<Formula>> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    with_db(|conn| {
        let mut query =
            "SELECT f.id, f.subject_id, f.title, f.latex_content, f.category, f.created_at
             FROM formulas f
             JOIN subjects s ON s.id = f.subject_id
             JOIN milestones m ON m.id = s.milestone_id
             JOIN semesters se ON se.id = m.semester_id
             JOIN tracks t ON t.id = se.track_id
             WHERE t.profile_id = ?1"
                .to_string();
        let mut args: Vec<rusqlite::types::Value> = vec![profile_id.into()];

        if let Some(sid) = subject_id {
            query.push_str(" AND f.subject_id = ?2");
            args.push(sid.into());
        }

        if let Some(cat) = category {
            if subject_id.is_some() {
                query.push_str(" AND f.category = ?3");
            } else {
                query.push_str(" AND f.category = ?2");
            }
            args.push(cat.into());
        }

        query.push_str(" ORDER BY f.created_at DESC");

        let mut stmt = conn.prepare(&query).map_err(to_err)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(args), |row| {
                Ok(Formula {
                    id: row.get(0)?,
                    subject_id: row.get(1)?,
                    title: row.get(2)?,
                    latex_content: row.get(3)?,
                    category: row.get(4)?,
                    created_at: row.get(5)?,
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

/// Update a formula. `profile_id` is the caller's profile; the row's
/// subject must belong to it.
#[napi]
pub fn update_formula(
    profile_id: i32,
    id: i32,
    title: String,
    latex_content: String,
    category: Option<String>,
) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let row_id = valid_id(id, "id")?;
    let title = required_text(title, "title", MAX_NAME)?;
    let latex_content = required_text(latex_content, "latex_content", MAX_TEXT)?;
    let category = text(category, "category", MAX_CATEGORY)?;
    with_db(|conn| {
        let n = conn
            .execute(
                "UPDATE formulas
                 SET title = ?2, latex_content = ?3, category = ?4
                 WHERE id = ?1
                   AND subject_id IN (SELECT sub.id FROM subjects sub
                                      JOIN milestones m ON m.id = sub.milestone_id
                                      JOIN semesters se ON se.id = m.semester_id
                                      JOIN tracks t ON t.id = se.track_id
                                      WHERE t.profile_id = ?5)",
                params![row_id, title, latex_content, category, profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(codes::NOT_OWNED, "Formula not found in this profile"));
        }
        Ok(())
    })
}

/// Delete a formula. `profile_id` is the caller's profile.
#[napi]
pub fn delete_formula(profile_id: i32, id: i32) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let row_id = valid_id(id, "id")?;
    with_db(|conn| {
        let n = conn
            .execute(
                "DELETE FROM formulas
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
            return Err(coded(codes::NOT_OWNED, "Formula not found in this profile"));
        }
        Ok(())
    })
}

/// Confirm a subject exists and its chain belongs to `profile_id`.
fn assert_formula_subject_owned_by(
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
