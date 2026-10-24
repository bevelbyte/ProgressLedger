//! Study Sessions: log time spent studying a subject.
//!
//! Persists to the existing `session_states` table (subject-scoped, cascades
//! with the subject). A session records start/end and a duration in minutes,
//! plus an optional note. Sessions feed the dashboard study streak and give
//! students a record of actual study activity — distinct from resources
//! (what they have) and marks (how they scored).

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection};

use crate::db::{to_err, with_db};
use crate::errors::{coded, codes};
use crate::validate::{text, valid_id, MAX_TEXT};

#[napi(object)]
pub struct StudySession {
    pub id: i32,
    pub subject_id: i32,
    pub subject_name: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub duration_minutes: i32,
    pub notes: String,
}

#[napi(object)]
pub struct StudySessionStats {
    pub total_sessions: i32,
    pub total_minutes: i32,
    /// Minutes studied today (local date of `started_at`).
    pub minutes_today: i32,
    /// Distinct calendar days with at least one session.
    pub active_days: i32,
}

/// Log a completed study session. `duration_minutes` must be > 0. `started_at`
/// / `ended_at` are ISO strings supplied by the shell (local clock); when
/// omitted the DB default timestamps the row.
/// `profile_id` is the caller's profile; the subject must belong to it.
#[napi]
pub fn add_study_session(
    profile_id: i32,
    subject_id: i32,
    duration_minutes: i32,
    started_at: Option<String>,
    ended_at: Option<String>,
    notes: Option<String>,
) -> Result<i32> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let subject_id = valid_id(subject_id, "subject_id")?;
    if duration_minutes <= 0 {
        return Err(coded(
            codes::DB_CONSTRAINT,
            "duration_minutes must be greater than zero",
        ));
    }
    let notes_str = text(notes.clone(), "notes", MAX_TEXT)?.unwrap_or_default();
    with_db(|conn| {
        assert_session_subject_owned_by(conn, profile_id, subject_id)?;
        // Insert with explicit timestamps when provided, else let defaults apply.
        match started_at {
            Some(start) => {
                conn.execute(
                    "INSERT INTO session_states (subject_id, started_at, ended_at, duration_minutes, notes)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![subject_id, start, ended_at, duration_minutes, notes_str],
                )
                .map_err(to_err)?;
            }
            None => {
                // Default to LOCAL 'now' (not UTC CURRENT_TIMESTAMP): every
                // "today"/streak query compares against localtime dates, so a
                // UTC default silently filed late-evening sessions on the
                // wrong calendar day.
                conn.execute(
                    "INSERT INTO session_states (subject_id, started_at, duration_minutes, notes)
                     VALUES (?1, datetime('now','localtime'), ?2, ?3)",
                    params![subject_id, duration_minutes, notes_str],
                )
                .map_err(to_err)?;
            }
        }
        Ok(conn.last_insert_rowid() as i32)
    })
}

/// Recent study sessions for a profile, newest first (bounded by `limit`).
#[napi]
pub fn get_study_sessions(profile_id: i32, limit: Option<i32>) -> Result<Vec<StudySession>> {
    let cap = limit.unwrap_or(50).clamp(1, 500);
    with_db(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT ss.id, ss.subject_id, sub.name, ss.started_at, ss.ended_at, ss.duration_minutes, ss.notes
                 FROM session_states ss
                 JOIN subjects sub ON sub.id = ss.subject_id
                 JOIN milestones m ON m.id = sub.milestone_id
                 JOIN semesters se ON se.id = m.semester_id
                 JOIN tracks t ON t.id = se.track_id
                 WHERE t.profile_id = ?1
                 ORDER BY ss.started_at DESC, ss.id DESC
                 LIMIT ?2",
            )
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![profile_id, cap], |r| {
                Ok(StudySession {
                    id: r.get(0)?,
                    subject_id: r.get(1)?,
                    subject_name: r.get(2)?,
                    started_at: r.get(3)?,
                    ended_at: r.get(4)?,
                    duration_minutes: r.get(5)?,
                    notes: r.get(6)?,
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

/// Delete a study session. `profile_id` is the caller's profile.
#[napi]
pub fn delete_study_session(profile_id: i32, id: i32) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let row_id = valid_id(id, "id")?;
    with_db(|conn| {
        let n = conn
            .execute(
                "DELETE FROM session_states
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
                "Study session not found in this profile",
            ));
        }
        Ok(())
    })
}

/// Confirm a subject exists and its chain belongs to `profile_id`.
fn assert_session_subject_owned_by(
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

/// Aggregate study-time stats for a profile.
#[napi]
pub fn get_study_session_stats(profile_id: i32) -> Result<StudySessionStats> {
    with_db(|conn| {
        let base = "FROM session_states ss
             JOIN subjects sub ON sub.id = ss.subject_id
             JOIN milestones m ON m.id = sub.milestone_id
             JOIN semesters se ON se.id = m.semester_id
             JOIN tracks t ON t.id = se.track_id
             WHERE t.profile_id = ?1";

        let (total_sessions, total_minutes): (i32, i32) = conn
            .query_row(
                &format!("SELECT COUNT(*), COALESCE(SUM(ss.duration_minutes),0) {base}"),
                params![profile_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(to_err)?;

        let minutes_today: i32 = conn
            .query_row(
                &format!(
                    "SELECT COALESCE(SUM(ss.duration_minutes),0) {base} AND date(ss.started_at) = date('now','localtime')"
                ),
                params![profile_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;

        let active_days: i32 = conn
            .query_row(
                &format!("SELECT COUNT(DISTINCT date(ss.started_at)) {base}"),
                params![profile_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;

        Ok(StudySessionStats {
            total_sessions,
            total_minutes,
            minutes_today,
            active_days,
        })
    })
}
