//! Subject Workspace overview: one aggregated read for a single subject.
//!
//! The Subject is Progress Ledger's central entity. This assembles, in one call,
//! the data scattered across features so the UI can render a connected
//! workspace without fanning out to many services:
//!   * academic placement (track / semester / status)
//!   * grade (marks -> percentage -> grade point via the profile's scale) + credits
//!   * study time (today / total minutes, session count)
//!   * counts for upcoming deadlines, notes, PDFs, links, flashcards (due), mistakes
//!
//! Calculation of the grade point stays in the pure `crate::cgpa` domain; this
//! module only reads rows and delegates. Detailed lists (the actual deadlines,
//! resources, cards) remain served by their existing per-feature APIs — this is
//! a summary, not a replacement for them.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::params;
use rusqlite::OptionalExtension;

use crate::cgpa::percentage;
use crate::db::courses::scale_for;
use crate::db::{to_err, with_db};
use crate::errors::{coded, codes};
use crate::validate::valid_id;

#[napi(object)]
pub struct SubjectOverview {
    pub subject_id: i32,
    pub name: String,
    pub code: Option<String>,
    pub status: String,
    pub track_name: String,
    pub semester_name: String,

    // Academic / grade (None when the subject has no graded course yet).
    pub credits: Option<f64>,
    pub marks_obtained: Option<f64>,
    pub max_marks: Option<f64>,
    pub percentage: Option<f64>,
    pub grade_point: Option<f64>,
    pub grade_label: Option<String>,

    // Study time.
    pub study_minutes_total: i32,
    pub study_minutes_today: i32,
    pub study_session_count: i32,

    // Related-activity counts.
    pub upcoming_deadline_count: i32,
    pub note_count: i32,
    pub pdf_count: i32,
    pub link_count: i32,
    pub flashcard_total: i32,
    pub flashcard_due: i32,
    pub mistake_count: i32,
}

/// Assemble the workspace overview for a single subject.
#[napi]
pub fn get_subject_overview(profile_id: i32, subject_id: i32) -> Result<SubjectOverview> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let subject_id = valid_id(subject_id, "subject_id")?;
    with_db(|conn| {
        let owned: i32 = conn.query_row("SELECT COUNT(*) FROM subjects s JOIN milestones m ON m.id=s.milestone_id JOIN semesters se ON se.id=m.semester_id JOIN tracks t ON t.id=se.track_id WHERE s.id=?1 AND t.profile_id=?2", params![subject_id, profile_id], |r| r.get(0)).map_err(to_err)?;
        if owned == 0 { return Err(coded(codes::NOT_OWNED, "Subject not found in this profile")); }
        // Placement: subject + its semester/track names and profile id.
        let (name, code, status, semester_name, track_name, profile_id): (
            String,
            Option<String>,
            String,
            String,
            String,
            i32,
        ) = conn
            .query_row(
                "SELECT sub.name, sub.code, sub.status, se.name, t.name, t.profile_id
                 FROM subjects sub
                 JOIN milestones m ON m.id = sub.milestone_id
                 JOIN semesters se ON se.id = m.semester_id
                 JOIN tracks t ON t.id = se.track_id
                 WHERE sub.id = ?1",
                params![subject_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .map_err(to_err)?;

        // Grade: PRIMARY resolution is structural (courses.subject_id set by
        // migration 014 and maintained by the planner). LEGACY FALLBACK is the
        // old (profile, semester_label, lower(course_name)) match, used ONLY
        // for rows the deterministic backfill could not link (subject_id IS
        // NULL) — identity is never re-derived from the name while a
        // structural link exists.
        let course: Option<(f64, Option<f64>, Option<f64>)> = conn
            .query_row(
                "SELECT credits, marks_obtained, max_marks FROM courses
                 WHERE subject_id = ?1
                 ORDER BY id LIMIT 1",
                params![subject_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(to_err)?
            .or_else(|| {
                conn.query_row(
                    "SELECT credits, marks_obtained, max_marks FROM courses
                     WHERE profile_id = ?1 AND semester_label = ?2
                       AND subject_id IS NULL
                       AND lower(trim(course_name)) = lower(trim(?3))
                     LIMIT 1",
                    params![profile_id, semester_name, name],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .ok()
            });

        let (credits, marks_obtained, max_marks, pct, grade_point, grade_label) = match course {
            Some((cr, mo, mm)) => {
                let pct = percentage(mo, mm);
                let (gp, label) = match pct {
                    Some(p) => {
                        let scale = scale_for(conn, profile_id)?;
                        (Some(scale.grade_point(p)), scale.label(p))
                    }
                    None => (None, None),
                };
                (Some(cr), mo, mm, pct, gp, label)
            }
            None => (None, None, None, None, None, None),
        };

        // Study time (session_states is subject-scoped).
        let (study_total, study_count): (i32, i32) = conn
            .query_row(
                "SELECT COALESCE(SUM(duration_minutes),0), COUNT(*)
                 FROM session_states WHERE subject_id = ?1",
                params![subject_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(to_err)?;
        let study_today: i32 = conn
            .query_row(
                "SELECT COALESCE(SUM(duration_minutes),0) FROM session_states
                 WHERE subject_id = ?1 AND date(started_at) = date('now','localtime')",
                params![subject_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;

        // Upcoming deadlines (today or later) that are still ACTIVE (not completed).
        let upcoming_deadline_count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM deadlines
                 WHERE subject_id = ?1 AND completed_at IS NULL
                   AND date(deadline_date) >= date('now','localtime')",
                params![subject_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;

        // Resource counts by kind.
        let (note_count, pdf_count): (i32, i32) = conn
            .query_row(
                "SELECT
                   COALESCE(SUM(CASE WHEN kind='note' THEN 1 ELSE 0 END),0),
                   COALESCE(SUM(CASE WHEN kind='pdf' THEN 1 ELSE 0 END),0)
                 FROM resources WHERE subject_id = ?1",
                params![subject_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(to_err)?;

        let link_count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM subject_links WHERE subject_id = ?1",
                params![subject_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;

        let (flashcard_total, flashcard_due): (i32, i32) = conn
            .query_row(
                "SELECT COUNT(*),
                        COALESCE(SUM(CASE WHEN due_date <= date('now','localtime') THEN 1 ELSE 0 END),0)
                 FROM cards WHERE subject_id = ?1",
                params![subject_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(to_err)?;

        let mistake_count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM mistakes WHERE subject_id = ?1",
                params![subject_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;

        Ok(SubjectOverview {
            subject_id,
            name,
            code,
            status,
            track_name,
            semester_name,
            credits,
            marks_obtained,
            max_marks,
            percentage: pct,
            grade_point,
            grade_label,
            study_minutes_total: study_total,
            study_minutes_today: study_today,
            study_session_count: study_count,
            upcoming_deadline_count,
            note_count,
            pdf_count,
            link_count,
            flashcard_total,
            flashcard_due,
            mistake_count,
        })
    })
}
