//! Lab Record & Viva Tracker: Checklists of experiments, record submission, and viva results.
//!
//! This module manages laboratory experiments with tracking for record submission
//! and viva examination results.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection};

use crate::db::{to_err, with_db};
use crate::errors::{coded, codes};
use crate::validate::{required_text, text, valid_id, MAX_NAME, MAX_TEXT};

#[napi(object)]
pub struct LabExperiment {
    pub id: i32,
    pub subject_id: i32,
    pub experiment_no: i32,
    pub title: String,
    pub record_submitted: bool,
    pub viva_done: bool,
    pub viva_score: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
}

#[napi(object)]
pub struct LabSummary {
    pub total: i32,
    pub records_submitted: i32,
    pub vivas_done: i32,
    pub record_percent: f64,
    pub viva_percent: f64,
}

/// Add an experiment. `profile_id` is the caller's profile; the subject must
/// belong to it.
#[napi]
pub fn add_experiment(
    profile_id: i32,
    subject_id: i32,
    experiment_no: i32,
    title: String,
) -> Result<i32> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let subject_id = valid_id(subject_id, "subject_id")?;
    let title = required_text(title, "title", MAX_NAME)?;
    with_db(|conn| {
        assert_lab_subject_owned_by(conn, profile_id, subject_id)?;
        conn.execute(
            "INSERT INTO lab_experiments (subject_id, experiment_no, title) VALUES (?1, ?2, ?3)",
            params![subject_id, experiment_no, title],
        )
        .map_err(to_err)?;
        Ok(conn.last_insert_rowid() as i32)
    })
}

#[napi]
pub fn get_experiments(profile_id: i32, subject_id: i32) -> Result<Vec<LabExperiment>> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let subject_id = valid_id(subject_id, "subject_id")?;
    with_db(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT l.id, l.subject_id, l.experiment_no, l.title, l.record_submitted,
                        l.viva_done, l.viva_score, l.notes, l.created_at
                 FROM lab_experiments l
                 JOIN subjects sub ON sub.id = l.subject_id
                 JOIN milestones m ON m.id = sub.milestone_id
                 JOIN semesters se ON se.id = m.semester_id
                 JOIN tracks t ON t.id = se.track_id
                 WHERE l.subject_id = ?1 AND t.profile_id = ?2
                 ORDER BY l.experiment_no ASC",
            )
            .map_err(to_err)?;

        let rows = stmt
            .query_map(params![subject_id, profile_id], |row| {
                Ok(LabExperiment {
                    id: row.get(0)?,
                    subject_id: row.get(1)?,
                    experiment_no: row.get(2)?,
                    title: row.get(3)?,
                    record_submitted: row.get::<_, i32>(4)? != 0,
                    viva_done: row.get::<_, i32>(5)? != 0,
                    viva_score: row.get(6)?,
                    notes: row.get(7)?,
                    created_at: row.get(8)?,
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

/// Update an experiment. `profile_id` is the caller's profile; the row's
/// subject must belong to it.
#[napi]
pub fn update_experiment(
    profile_id: i32,
    id: i32,
    title: String,
    record_submitted: bool,
    viva_done: bool,
    viva_score: Option<String>,
    notes: Option<String>,
) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let row_id = valid_id(id, "id")?;
    let title = required_text(title, "title", MAX_NAME)?;
    let viva_score = text(viva_score, "viva_score", MAX_TEXT)?;
    let notes = text(notes, "notes", MAX_TEXT)?;
    with_db(|conn| {
        let n = conn
            .execute(
                "UPDATE lab_experiments
                 SET title = ?2, record_submitted = ?3, viva_done = ?4, viva_score = ?5, notes = ?6
                 WHERE id = ?1
                   AND subject_id IN (SELECT sub.id FROM subjects sub
                                      JOIN milestones m ON m.id = sub.milestone_id
                                      JOIN semesters se ON se.id = m.semester_id
                                      JOIN tracks t ON t.id = se.track_id
                                      WHERE t.profile_id = ?7)",
                params![
                    row_id,
                    title,
                    record_submitted as i32,
                    viva_done as i32,
                    viva_score,
                    notes,
                    profile_id
                ],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "Lab experiment not found in this profile",
            ));
        }
        Ok(())
    })
}

/// Delete an experiment. `profile_id` is the caller's profile.
#[napi]
pub fn delete_experiment(profile_id: i32, id: i32) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let row_id = valid_id(id, "id")?;
    with_db(|conn| {
        let n = conn
            .execute(
                "DELETE FROM lab_experiments
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
                "Lab experiment not found in this profile",
            ));
        }
        Ok(())
    })
}

#[napi]
pub fn get_lab_summary(profile_id: i32) -> Result<LabSummary> {
    with_db(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT COUNT(l.id), SUM(l.record_submitted), SUM(l.viva_done)
             FROM lab_experiments l
             JOIN subjects s ON l.subject_id = s.id
             JOIN milestones m ON s.milestone_id = m.id
             JOIN semesters sem ON m.semester_id = sem.id
             JOIN tracks t ON sem.track_id = t.id
             WHERE t.profile_id = ?1",
            )
            .map_err(to_err)?;

        let (total, records, vivas) = stmt
            .query_row(params![profile_id], |row| {
                let total: i32 = row.get(0).unwrap_or(0);
                let records: Option<i32> = row.get(1)?;
                let vivas: Option<i32> = row.get(2)?;
                Ok((total, records.unwrap_or(0), vivas.unwrap_or(0)))
            })
            .unwrap_or((0, 0, 0));

        let record_percent = if total > 0 {
            (records as f64 / total as f64) * 100.0
        } else {
            0.0
        };
        let viva_percent = if total > 0 {
            (vivas as f64 / total as f64) * 100.0
        } else {
            0.0
        };

        Ok(LabSummary {
            total,
            records_submitted: records,
            vivas_done: vivas,
            record_percent,
            viva_percent,
        })
    })
}

/// Confirm a subject exists and its chain belongs to `profile_id`.
fn assert_lab_subject_owned_by(conn: &Connection, profile_id: i32, subject_id: i32) -> Result<()> {
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
