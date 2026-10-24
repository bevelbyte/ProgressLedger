//! Deadline Radar: Exam dates, placement deadlines, GATE dates, etc.
//!
//! This module manages deadline tracking with pace forecasting to help students
//! stay on track with their study schedule.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection};

use crate::db::{to_err, with_db};
use crate::errors::{coded, codes};
use crate::validate::{required_text, text, valid_id, MAX_CATEGORY, MAX_NAME, MAX_TAG, MAX_TEXT};

#[napi(object)]
pub struct Deadline {
    pub id: i32,
    pub subject_id: i32,
    pub subject_name: String,
    pub deadline_date: String,
    pub category: String,
    pub title: String,
    pub notes: String,
    pub created_at: String,
    /// ISO datetime when marked completed, or None while active. Independent of
    /// deadline_date: a completed deadline is never "overdue".
    pub completed_at: Option<String>,
}

#[napi(object)]
pub struct DeadlinePace {
    pub days_remaining: i32,
    pub topics_remaining: i32,
    pub topics_per_day: f64,
    pub is_overdue: bool,
}

/// Add a deadline. `profile_id` is the caller's profile; the subject must
/// belong to it.
#[napi]
pub fn add_deadline(
    profile_id: i32,
    subject_id: i32,
    deadline_date: String,
    category: String,
    title: String,
    notes: Option<String>,
) -> Result<i32> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let subject_id = valid_id(subject_id, "subject_id")?;
    let deadline_date = required_text(deadline_date, "deadline_date", MAX_TAG)?;
    let category = required_text(category, "category", MAX_CATEGORY)?;
    let title = required_text(title, "title", MAX_NAME)?;
    let notes = text(notes, "notes", MAX_TEXT)?.unwrap_or_default();
    with_db(|conn| {
        assert_deadline_subject_owned_by(conn, profile_id, subject_id)?;
        conn.execute(
            "INSERT INTO deadlines (subject_id, deadline_date, category, title, notes)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![subject_id, deadline_date, category, title, notes],
        )
        .map_err(to_err)?;
        Ok(conn.last_insert_rowid() as i32)
    })
}

#[napi]
pub fn get_deadlines(profile_id: i32) -> Result<Vec<Deadline>> {
    with_db(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT d.id, d.subject_id, s.name, d.deadline_date, d.category,
                        d.title, d.notes, d.created_at, d.completed_at
                 FROM deadlines d
                 JOIN subjects s ON s.id = d.subject_id
                 JOIN milestones m ON m.id = s.milestone_id
                 JOIN semesters se ON se.id = m.semester_id
                 JOIN tracks t ON t.id = se.track_id
                 WHERE t.profile_id = ?1
                 ORDER BY d.deadline_date ASC, d.id DESC",
            )
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![profile_id], |r| {
                Ok(Deadline {
                    id: r.get(0)?,
                    subject_id: r.get(1)?,
                    subject_name: r.get(2)?,
                    deadline_date: r.get(3)?,
                    category: r.get(4)?,
                    title: r.get(5)?,
                    notes: r.get(6)?,
                    created_at: r.get(7)?,
                    completed_at: r.get(8)?,
                })
            })
            .map_err(to_err)?;

        let mut deadlines = Vec::new();
        for row in rows {
            deadlines.push(row.map_err(to_err)?);
        }
        Ok(deadlines)
    })
}

/// Update a deadline. `profile_id` is the caller's profile; the row's
/// subject must belong to it.
#[napi]
pub fn update_deadline(
    profile_id: i32,
    id: i32,
    deadline_date: String,
    category: String,
    title: String,
    notes: Option<String>,
) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let row_id = valid_id(id, "id")?;
    let deadline_date = required_text(deadline_date, "deadline_date", MAX_TAG)?;
    let category = required_text(category, "category", MAX_CATEGORY)?;
    let title = required_text(title, "title", MAX_NAME)?;
    let notes = text(notes, "notes", MAX_TEXT)?.unwrap_or_default();
    with_db(|conn| {
        let n = conn
            .execute(
                "UPDATE deadlines
                 SET deadline_date = ?2, category = ?3, title = ?4, notes = ?5
                 WHERE id = ?1
                   AND subject_id IN (SELECT sub.id FROM subjects sub
                                      JOIN milestones m ON m.id = sub.milestone_id
                                      JOIN semesters se ON se.id = m.semester_id
                                      JOIN tracks t ON t.id = se.track_id
                                      WHERE t.profile_id = ?6)",
                params![row_id, deadline_date, category, title, notes, profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "Deadline not found in this profile",
            ));
        }
        Ok(())
    })
}

/// Delete a deadline. `profile_id` is the caller's profile.
#[napi]
pub fn delete_deadline(profile_id: i32, id: i32) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let row_id = valid_id(id, "id")?;
    with_db(|conn| {
        let n = conn
            .execute(
                "DELETE FROM deadlines
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
                "Deadline not found in this profile",
            ));
        }
        Ok(())
    })
}

/// Set or clear a deadline's completion. `completed = true` stamps
/// `completed_at` with the current local datetime; `false` clears it (reopen).
/// `profile_id` is the caller's profile; the row must belong to it.
#[napi]
pub fn set_deadline_completion(profile_id: i32, id: i32, completed: bool) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let row_id = valid_id(id, "id")?;
    with_db(|conn| {
        let n = if completed {
            conn.execute(
                "UPDATE deadlines SET completed_at = datetime('now','localtime')
                 WHERE id = ?1
                   AND subject_id IN (SELECT sub.id FROM subjects sub
                                      JOIN milestones m ON m.id = sub.milestone_id
                                      JOIN semesters se ON se.id = m.semester_id
                                      JOIN tracks t ON t.id = se.track_id
                                      WHERE t.profile_id = ?2)",
                params![row_id, profile_id],
            )
            .map_err(to_err)?
        } else {
            conn.execute(
                "UPDATE deadlines SET completed_at = NULL
                 WHERE id = ?1
                   AND subject_id IN (SELECT sub.id FROM subjects sub
                                      JOIN milestones m ON m.id = sub.milestone_id
                                      JOIN semesters se ON se.id = m.semester_id
                                      JOIN tracks t ON t.id = se.track_id
                                      WHERE t.profile_id = ?2)",
                params![row_id, profile_id],
            )
            .map_err(to_err)?
        };
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "Deadline not found in this profile",
            ));
        }
        Ok(())
    })
}

/// Confirm a subject exists and its chain belongs to `profile_id`.
fn assert_deadline_subject_owned_by(
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

/// Calculate pace for a deadline: how many topics need to be covered per day.
/// Topics remaining = subjects with status != 'done' in the same milestone.
#[napi]
pub fn calculate_deadline_pace(profile_id: i32, deadline_id: i32) -> Result<DeadlinePace> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let deadline_id = valid_id(deadline_id, "deadline_id")?;
    with_db(|conn| {
        // Resolve the deadline and its owning profile atomically.
        let (subject_id, deadline_date): (i32, String) = conn
            .query_row(
                "SELECT d.subject_id, d.deadline_date
                 FROM deadlines d
                 JOIN subjects sub ON sub.id = d.subject_id
                 JOIN milestones m ON m.id = sub.milestone_id
                 JOIN semesters se ON se.id = m.semester_id
                 JOIN tracks t ON t.id = se.track_id
                 WHERE d.id = ?1 AND t.profile_id = ?2",
                params![deadline_id, profile_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    coded(codes::NOT_OWNED, "Deadline not found in this profile")
                }
                other => to_err(other),
            })?;

        // Get milestone_id from subject
        let milestone_id: i32 = conn
            .query_row(
                "SELECT milestone_id FROM subjects WHERE id = ?1",
                params![subject_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;

        // Count topics (subjects) remaining in this milestone
        let topics_remaining: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM subjects WHERE milestone_id = ?1 AND status != 'done'",
                params![milestone_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;

        // Calculate days remaining
        let today = chrono::Local::now()
            .naive_local()
            .date()
            .format("%Y-%m-%d")
            .to_string();

        // days_remaining may be negative — that is what makes is_overdue honest.
        let days_remaining = chrono::NaiveDate::parse_from_str(&deadline_date, "%Y-%m-%d")
            .and_then(|d| {
                chrono::NaiveDate::parse_from_str(&today, "%Y-%m-%d")
                    .map(|t| d.signed_duration_since(t).num_days())
            })
            .unwrap_or(0) as i32;

        let is_overdue = days_remaining < 0;
        let topics_per_day = if days_remaining > 0 {
            topics_remaining as f64 / days_remaining as f64
        } else {
            0.0
        };

        Ok(DeadlinePace {
            days_remaining,
            topics_remaining,
            topics_per_day,
            is_overdue,
        })
    })
}

#[napi(object)]
pub struct DeadlinePaceRow {
    pub deadline_id: i32,
    pub days_remaining: i32,
    pub topics_remaining: i32,
    pub topics_per_day: f64,
    pub is_overdue: bool,
}

/// Pace for EVERY active (non-completed) deadline of a profile in one query —
/// replaces the Radar's per-deadline IPC fan-out. Overdue deadlines report
/// negative days_remaining and is_overdue = true.
#[napi]
pub fn get_deadline_paces(profile_id: i32) -> Result<Vec<DeadlinePaceRow>> {
    with_db(|conn| {
        let mut stmt = conn.prepare(
            "SELECT d.id,
                    CAST(julianday(d.deadline_date) - julianday(date('now','localtime')) AS INTEGER),
                    (SELECT COUNT(*) FROM subjects s2
                       WHERE s2.milestone_id =
                             (SELECT s.milestone_id FROM subjects s WHERE s.id = d.subject_id)
                         AND s2.status != 'done')
             FROM deadlines d
             JOIN subjects s ON s.id = d.subject_id
             JOIN milestones m ON m.id = s.milestone_id
             JOIN semesters se ON se.id = m.semester_id
             JOIN tracks t ON t.id = se.track_id
             WHERE t.profile_id = ?1 AND d.completed_at IS NULL
             ORDER BY d.deadline_date ASC",
        )
        .map_err(to_err)?;
        let rows = stmt
            .query_map(params![profile_id], |r| {
                Ok((
                    r.get::<_, i32>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i32>(2)?,
                ))
            })
            .map_err(to_err)?;

        let mut out = Vec::new();
        for row in rows {
            let (id, days64, topics) = row.map_err(to_err)?;
            let days = days64 as i32;
            out.push(DeadlinePaceRow {
                deadline_id: id,
                days_remaining: days,
                topics_remaining: topics,
                topics_per_day: if days > 0 {
                    topics as f64 / days as f64
                } else {
                    0.0
                },
                is_overdue: days < 0,
            });
        }
        Ok(out)
    })
}
