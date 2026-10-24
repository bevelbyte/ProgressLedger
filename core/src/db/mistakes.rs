//! Mistake Ledger: Concept-tagged logging of assignment/test errors.
//!
//! This module tracks mistakes from practice tests and assignments, categorized
//! by type (conceptual, calculation, formula, silly, time_management) to help
//! students identify and address recurring issues.

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection};

use crate::db::{to_err, with_db};
use crate::errors::{coded, codes};
use crate::validate::{bounded_text, enum_value, required_text, valid_id, MAX_TEXT};

#[napi(object)]
pub struct Mistake {
    pub id: i32,
    pub subject_id: i32,
    pub subject_name: String,
    pub question_text: String,
    pub mistake_type: String,
    pub correct_approach: String,
    pub tags: String,
    pub created_at: String,
}

#[napi(object)]
pub struct MistakeStats {
    pub total_mistakes: i32,
    pub by_type: HashMap<String, i32>,
    pub by_subject: HashMap<String, i32>,
    pub top_3_types: Vec<MistakeTypeCount>,
}

#[napi(object)]
pub struct MistakeTypeCount {
    pub mistake_type: String,
    pub count: i32,
}

/// Add a mistake. `profile_id` is the caller's profile; the subject must
/// belong to it. A renderer that supplies another profile's subject_id
/// is rejected at the boundary, not via a post-hoc FK violation.
#[napi]
pub fn add_mistake(
    profile_id: i32,
    subject_id: i32,
    question_text: String,
    mistake_type: String,
    correct_approach: String,
    tags: String,
) -> Result<i32> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let subject_id = valid_id(subject_id, "subject_id")?;
    let question_text = required_text(question_text, "question_text", MAX_TEXT)?;
    let mistake_type = enum_value(
        mistake_type,
        "mistake_type",
        &[
            "conceptual",
            "calculation",
            "formula",
            "silly",
            "time_management",
        ],
    )?;
    let correct_approach = required_text(correct_approach, "correct_approach", MAX_TEXT)?;
    let tags = bounded_text(tags, "tags", MAX_TEXT)?;
    with_db(|conn| {
        assert_mistake_subject_owned_by(conn, profile_id, subject_id)?;
        conn.execute(
            "INSERT INTO mistakes (subject_id, question_text, mistake_type, correct_approach, tags)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                subject_id,
                question_text,
                mistake_type,
                correct_approach,
                tags
            ],
        )
        .map_err(to_err)?;
        Ok(conn.last_insert_rowid() as i32)
    })
}

#[napi]
pub fn get_mistakes(
    profile_id: i32,
    subject_id: Option<i32>,
    mistake_type: Option<String>,
    limit: Option<i32>,
) -> Result<Vec<Mistake>> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    with_db(|conn| {
        let mut sql = String::from(
            "SELECT m.id, m.subject_id, s.name, m.question_text, m.mistake_type,
                    m.correct_approach, m.tags, m.created_at
             FROM mistakes m
             JOIN subjects s ON s.id = m.subject_id
             JOIN milestones ms ON ms.id = s.milestone_id
             JOIN semesters se ON se.id = ms.semester_id
             JOIN tracks t ON t.id = se.track_id
             WHERE t.profile_id = ?1",
        );

        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(profile_id)];

        if let Some(sid) = subject_id {
            sql.push_str(&format!(" AND m.subject_id = ?{}", param_values.len() + 1));
            param_values.push(Box::new(sid));
        }

        if let Some(ref mt) = mistake_type {
            sql.push_str(&format!(
                " AND m.mistake_type = ?{}",
                param_values.len() + 1
            ));
            param_values.push(Box::new(mt.clone()));
        }

        sql.push_str(" ORDER BY m.created_at DESC");

        if let Some(lim) = limit {
            sql.push_str(&format!(" LIMIT ?{}", param_values.len() + 1));
            param_values.push(Box::new(lim));
        }

        let mut stmt = conn.prepare(&sql).map_err(to_err)?;
        let params_ref: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|b| b.as_ref()).collect();

        let rows = stmt
            .query_map(params_ref.as_slice(), |row| {
                Ok(Mistake {
                    id: row.get(0)?,
                    subject_id: row.get(1)?,
                    subject_name: row.get(2)?,
                    question_text: row.get(3)?,
                    mistake_type: row.get(4)?,
                    correct_approach: row.get(5)?,
                    tags: row.get(6)?,
                    created_at: row.get(7)?,
                })
            })
            .map_err(to_err)?;

        let mut mistakes = Vec::new();
        for row in rows {
            mistakes.push(row.map_err(to_err)?);
        }
        Ok(mistakes)
    })
}

/// Update a mistake. `profile_id` is the caller's profile; the row's
/// subject must belong to it.
#[napi]
pub fn update_mistake(
    profile_id: i32,
    mistake_id: i32,
    question_text: String,
    mistake_type: String,
    correct_approach: String,
    tags: String,
) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let mistake_id = valid_id(mistake_id, "mistake_id")?;
    let question_text = required_text(question_text, "question_text", MAX_TEXT)?;
    let mistake_type = enum_value(
        mistake_type,
        "mistake_type",
        &[
            "conceptual",
            "calculation",
            "formula",
            "silly",
            "time_management",
        ],
    )?;
    let correct_approach = required_text(correct_approach, "correct_approach", MAX_TEXT)?;
    let tags = bounded_text(tags, "tags", MAX_TEXT)?;
    with_db(|conn| {
        let n = conn
            .execute(
                "UPDATE mistakes
                 SET question_text = ?2, mistake_type = ?3, correct_approach = ?4, tags = ?5
                 WHERE id = ?1
                   AND subject_id IN (SELECT sub.id FROM subjects sub
                                      JOIN milestones m ON m.id = sub.milestone_id
                                      JOIN semesters se ON se.id = m.semester_id
                                      JOIN tracks t ON t.id = se.track_id
                                      WHERE t.profile_id = ?6)",
                params![
                    mistake_id,
                    question_text,
                    mistake_type,
                    correct_approach,
                    tags,
                    profile_id
                ],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(codes::NOT_OWNED, "Mistake not found in this profile"));
        }
        Ok(())
    })
}

/// Delete a mistake. `profile_id` is the caller's profile.
#[napi]
pub fn delete_mistake(profile_id: i32, mistake_id: i32) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let mistake_id = valid_id(mistake_id, "mistake_id")?;
    with_db(|conn| {
        let n = conn
            .execute(
                "DELETE FROM mistakes
                 WHERE id = ?1
                   AND subject_id IN (SELECT sub.id FROM subjects sub
                                      JOIN milestones m ON m.id = sub.milestone_id
                                      JOIN semesters se ON se.id = m.semester_id
                                      JOIN tracks t ON t.id = se.track_id
                                      WHERE t.profile_id = ?2)",
                params![mistake_id, profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(codes::NOT_OWNED, "Mistake not found in this profile"));
        }
        Ok(())
    })
}

/// Confirm a subject exists and its chain belongs to `profile_id`.
fn assert_mistake_subject_owned_by(
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

#[napi]
pub fn get_mistake_stats(profile_id: i32) -> Result<MistakeStats> {
    with_db(|conn| {
        // Total mistakes
        let total_mistakes: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM mistakes m
                 JOIN subjects s ON s.id = m.subject_id
                 JOIN milestones ms ON ms.id = s.milestone_id
                 JOIN semesters se ON se.id = ms.semester_id
                 JOIN tracks t ON t.id = se.track_id
                 WHERE t.profile_id = ?1",
                params![profile_id],
                |row| row.get(0),
            )
            .map_err(to_err)?;

        // By type
        let mut by_type: HashMap<String, i32> = HashMap::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT m.mistake_type, COUNT(*) FROM mistakes m
                     JOIN subjects s ON s.id = m.subject_id
                     JOIN milestones ms ON ms.id = s.milestone_id
                     JOIN semesters se ON se.id = ms.semester_id
                     JOIN tracks t ON t.id = se.track_id
                     WHERE t.profile_id = ?1
                     GROUP BY m.mistake_type",
                )
                .map_err(to_err)?;
            let rows = stmt
                .query_map(params![profile_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?))
                })
                .map_err(to_err)?;
            for row in rows {
                let (k, v) = row.map_err(to_err)?;
                by_type.insert(k, v);
            }
        }

        // By subject
        let mut by_subject: HashMap<String, i32> = HashMap::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT s.name, COUNT(*) FROM mistakes m
                     JOIN subjects s ON s.id = m.subject_id
                     JOIN milestones ms ON ms.id = s.milestone_id
                     JOIN semesters se ON se.id = ms.semester_id
                     JOIN tracks t ON t.id = se.track_id
                     WHERE t.profile_id = ?1
                     GROUP BY s.name",
                )
                .map_err(to_err)?;
            let rows = stmt
                .query_map(params![profile_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?))
                })
                .map_err(to_err)?;
            for row in rows {
                let (k, v) = row.map_err(to_err)?;
                by_subject.insert(k, v);
            }
        }

        // Top 3 mistake types
        let mut top_3_types: Vec<MistakeTypeCount> = by_type
            .iter()
            .map(|(k, v)| MistakeTypeCount {
                mistake_type: k.clone(),
                count: *v,
            })
            .collect();
        top_3_types.sort_by(|a, b| b.count.cmp(&a.count));
        top_3_types.truncate(3);

        Ok(MistakeStats {
            total_mistakes,
            by_type,
            by_subject,
            top_3_types,
        })
    })
}
