//! Semester Progress overview: one bounded aggregate read for a whole semester.
//!
//! Answers "How is my semester going?" by composing data the app already owns —
//! academic performance (credit-weighted SGPA via the pure `crate::cgpa` domain),
//! completion (graded/status counts from real rows), study time (session_states
//! joined through subjects), deadlines (grouped overdue/soon/upcoming), and a
//! per-subject attention list built from TRANSPARENT signals (not a risk score).
//!
//! Ownership is unchanged: this reads from courses/subjects/session_states/
//! deadlines; it does not mutate or duplicate any of them. Calculation of grade
//! points stays in `crate::cgpa`. Queries are bounded (a fixed handful), never
//! one-per-subject.
//!
//! Study/deadline → semester association is derived through the existing
//! relationship subject → milestone → semester (no new semester_id columns).
//! Courses associate by (profile_id, semester_label == semester name), matching
//! how the CGPA planner already persists them.

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::params;

use crate::cgpa::{percentage, weighted_gpa, CourseInput};
use crate::errors::{coded, codes};
use crate::validate::valid_id;
use crate::db::courses::scale_for;
use crate::db::{to_err, with_db};

#[napi(object)]
pub struct SemesterAcademic {
    pub sgpa: f64,
    pub graded_credits: f64,
    pub graded_course_count: i32,
}

#[napi(object)]
pub struct SemesterCompletion {
    pub total_subjects: i32,
    pub graded_subjects: i32,
    pub done_subjects: i32,
    pub in_progress_subjects: i32,
    pub pending_subjects: i32,
}

#[napi(object)]
pub struct SemesterStudy {
    pub total_minutes: i32,
    pub session_count: i32,
    pub minutes_last7: i32,
}

#[napi(object)]
pub struct SemesterDeadlines {
    pub overdue: i32,
    pub due_soon: i32, // today..=+7 days (local)
    pub upcoming: i32, // > 7 days out
    pub next_title: Option<String>,
    pub next_date: Option<String>,
    pub next_subject_id: Option<i32>,
}

#[napi(object)]
pub struct SemesterSubject {
    pub subject_id: i32,
    pub name: String,
    pub code: Option<String>,
    pub status: String,
    pub graded: bool,
    pub grade_point: Option<f64>,
    pub study_minutes: i32,
    pub next_deadline_date: Option<String>,
    /// Transparent, human-readable attention flags (e.g. "Needs marks",
    /// "Deadline soon", "No study logged"). Empty when nothing stands out.
    pub attention: Vec<String>,
}

#[napi(object)]
pub struct SemesterOverview {
    pub semester_id: i32,
    pub name: String,
    pub status: String,
    pub track_name: String,
    pub academic: SemesterAcademic,
    pub completion: SemesterCompletion,
    pub study: SemesterStudy,
    pub deadlines: SemesterDeadlines,
    pub subjects: Vec<SemesterSubject>,
}

/// Assemble the semester progress overview. Bounded queries only.
#[napi]
pub fn get_semester_overview(profile_id: i32, semester_id: i32) -> Result<SemesterOverview> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let semester_id = valid_id(semester_id, "semester_id")?;
    with_db(|conn| {
        let owned: i32 = conn.query_row("SELECT COUNT(*) FROM semesters s JOIN tracks t ON t.id=s.track_id WHERE s.id=?1 AND t.profile_id=?2", params![semester_id, profile_id], |r| r.get(0)).map_err(to_err)?;
        if owned == 0 { return Err(coded(codes::NOT_OWNED, "Semester not found in this profile")); }
        // Semester identity + owning track + profile.
        let (name, status, track_name, profile_id): (String, String, String, i32) = conn
            .query_row(
                "SELECT se.name, se.status, t.name, t.profile_id
                 FROM semesters se JOIN tracks t ON t.id = se.track_id
                 WHERE se.id = ?1",
                params![semester_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(to_err)?;

        // Subjects in this semester (one query), with study minutes + next
        // upcoming deadline folded in via LEFT JOINs / correlated subqueries.
        struct Row {
            id: i32,
            name: String,
            code: Option<String>,
            status: String,
            study_minutes: i32,
            next_deadline: Option<String>,
        }
        let mut stmt = conn
            .prepare(
                "SELECT sub.id, sub.name, sub.code, sub.status,
                        COALESCE((SELECT SUM(ss.duration_minutes) FROM session_states ss WHERE ss.subject_id = sub.id), 0),
                        (SELECT MIN(d.deadline_date) FROM deadlines d
                          WHERE d.subject_id = sub.id AND d.completed_at IS NULL
                            AND date(d.deadline_date) >= date('now','localtime'))
                 FROM subjects sub
                 JOIN milestones m ON m.id = sub.milestone_id
                 WHERE m.semester_id = ?1
                 ORDER BY sub.id",
            )
            .map_err(to_err)?;
        let rows_iter = stmt
            .query_map(params![semester_id], |r| {
                Ok(Row {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    code: r.get(2)?,
                    status: r.get(3)?,
                    study_minutes: r.get(4)?,
                    next_deadline: r.get(5)?,
                })
            })
            .map_err(to_err)?;
        let mut rows = Vec::new();
        for r in rows_iter {
            rows.push(r.map_err(to_err)?);
        }

        // Courses for this profile+semester_label (one query) → marks by lower name.
        // These drive SGPA (credit-weighted, from the pure domain) and per-subject
        // graded/grade-point. Association matches the CGPA planner's persistence.
        let scale = scale_for(conn, profile_id)?;
        let mut course_by_name: HashMap<String, (f64, Option<f64>, Option<f64>)> = HashMap::new();
        {
            let mut cstmt = conn
                .prepare(
                    "SELECT course_name, credits, marks_obtained, max_marks
                     FROM courses WHERE profile_id = ?1 AND semester_label = ?2",
                )
                .map_err(to_err)?;
            let crows = cstmt
                .query_map(params![profile_id, name], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, f64>(1)?,
                        r.get::<_, Option<f64>>(2)?,
                        r.get::<_, Option<f64>>(3)?,
                    ))
                })
                .map_err(to_err)?;
            for cr in crows {
                let (cn, credits, mo, mm) = cr.map_err(to_err)?;
                course_by_name.insert(cn.trim().to_lowercase(), (credits, mo, mm));
            }
        }

        // SGPA over graded courses in this semester (pure domain).
        let inputs: Vec<CourseInput> = course_by_name
            .values()
            .map(|(credits, mo, mm)| CourseInput {
                credits: *credits,
                obtained: *mo,
                max: *mm,
                grade_point_override: None,
            })
            .collect();
        let gpa = weighted_gpa(&inputs, &scale);
        let academic = SemesterAcademic {
            sgpa: gpa.gpa,
            graded_credits: gpa.graded_credits,
            graded_course_count: gpa.graded_count as i32,
        };

        // Completion counts from real subject rows.
        let total_subjects = rows.len() as i32;
        let mut done = 0;
        let mut in_progress = 0;
        let mut pending = 0;
        let mut graded_subjects = 0;

        // Study aggregates for the semester.
        let mut study_total = 0i32;
        let mut study_sessions = 0i32;

        // Build per-subject attention list.
        let mut subjects = Vec::with_capacity(rows.len());
        for row in &rows {
            match row.status.as_str() {
                "done" => done += 1,
                "in_progress" => in_progress += 1,
                _ => pending += 1,
            }
            study_total += row.study_minutes;
            if row.study_minutes > 0 {
                study_sessions += 1; // subjects with any study; refined below
            }

            let course = course_by_name.get(&row.name.trim().to_lowercase());
            let (graded, grade_point) = match course {
                Some((_, mo, mm)) => match percentage(*mo, *mm) {
                    Some(p) => (true, Some(scale.grade_point(p))),
                    None => (false, None),
                },
                None => (false, None),
            };
            if graded {
                graded_subjects += 1;
            }

            // Transparent attention flags — no scores.
            let mut attention = Vec::new();
            if !graded && row.status != "done" {
                attention.push("Needs marks".to_string());
            }
            if let Some(dl) = &row.next_deadline {
                let soon: bool = conn
                    .query_row(
                        "SELECT date(?1) <= date('now','localtime','+7 days')",
                        params![dl],
                        |r| r.get::<_, i32>(0),
                    )
                    .map(|v| v != 0)
                    .unwrap_or(false);
                if soon {
                    attention.push("Deadline soon".to_string());
                }
            }
            if row.study_minutes == 0 && row.status != "done" {
                attention.push("No study logged".to_string());
            }

            subjects.push(SemesterSubject {
                subject_id: row.id,
                name: row.name.clone(),
                code: row.code.clone(),
                status: row.status.clone(),
                graded,
                grade_point,
                study_minutes: row.study_minutes,
                next_deadline_date: row.next_deadline.clone(),
                attention,
            });
        }

        // Precise session count + last-7-days minutes for the semester (one query each).
        let (sess_count, minutes_last7): (i32, i32) = conn
            .query_row(
                "SELECT COUNT(*),
                        COALESCE(SUM(CASE WHEN date(ss.started_at) >= date('now','localtime','-7 days')
                                          THEN ss.duration_minutes ELSE 0 END),0)
                 FROM session_states ss
                 JOIN subjects sub ON sub.id = ss.subject_id
                 JOIN milestones m ON m.id = sub.milestone_id
                 WHERE m.semester_id = ?1",
                params![semester_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(to_err)?;
        let _ = study_sessions; // subject-with-study count not surfaced; keep precise count below
        let study = SemesterStudy {
            total_minutes: study_total,
            session_count: sess_count,
            minutes_last7,
        };

        // Deadline buckets for the semester (one query). Active (not completed) only.
        let (overdue, due_soon, upcoming): (i32, i32, i32) = conn
            .query_row(
                "SELECT
                   COALESCE(SUM(CASE WHEN date(d.deadline_date) < date('now','localtime') THEN 1 ELSE 0 END),0),
                   COALESCE(SUM(CASE WHEN date(d.deadline_date) >= date('now','localtime')
                                     AND date(d.deadline_date) <= date('now','localtime','+7 days') THEN 1 ELSE 0 END),0),
                   COALESCE(SUM(CASE WHEN date(d.deadline_date) > date('now','localtime','+7 days') THEN 1 ELSE 0 END),0)
                 FROM deadlines d
                 JOIN subjects sub ON sub.id = d.subject_id
                 JOIN milestones m ON m.id = sub.milestone_id
                 WHERE m.semester_id = ?1 AND d.completed_at IS NULL",
                params![semester_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(to_err)?;

        // Next upcoming ACTIVE deadline (title/date/subject) — one query.
        let next = conn
            .query_row(
                "SELECT d.title, d.deadline_date, d.subject_id
                 FROM deadlines d
                 JOIN subjects sub ON sub.id = d.subject_id
                 JOIN milestones m ON m.id = sub.milestone_id
                 WHERE m.semester_id = ?1 AND d.completed_at IS NULL
                   AND date(d.deadline_date) >= date('now','localtime')
                 ORDER BY d.deadline_date ASC LIMIT 1",
                params![semester_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i32>(2)?,
                    ))
                },
            )
            .ok();
        let deadlines = SemesterDeadlines {
            overdue,
            due_soon,
            upcoming,
            next_title: next.as_ref().map(|n| n.0.clone()),
            next_date: next.as_ref().map(|n| n.1.clone()),
            next_subject_id: next.as_ref().map(|n| n.2),
        };

        Ok(SemesterOverview {
            semester_id,
            name,
            status,
            track_name,
            academic,
            completion: SemesterCompletion {
                total_subjects,
                graded_subjects,
                done_subjects: done,
                in_progress_subjects: in_progress,
                pending_subjects: pending,
            },
            study,
            deadlines,
            subjects,
        })
    })
}
