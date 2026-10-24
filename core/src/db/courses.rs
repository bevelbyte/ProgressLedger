//! CGPA/SGPA Planner persistence: courses, marks, and per-profile grade scales.
//!
//! This module is the SQLite-authoritative store for credit-weighted CGPA. It
//! owns NO calculation rules — those live in `crate::cgpa` (pure, unit-tested).
//! Here we read/write rows and hand them to the domain calculator.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection, OptionalExtension};

use crate::cgpa::{weighted_gpa, CourseInput, GradeBand, GradeScale};
use crate::db::{to_err, with_db, with_transaction};
use crate::errors::{coded, codes};

#[napi(object)]
pub struct Course {
    pub id: i32,
    pub profile_id: i32,
    pub semester_label: String,
    pub course_name: String,
    pub credits: f64,
    pub grade: Option<String>,
    pub grade_points: Option<f64>,
    pub marks_obtained: Option<f64>,
    pub max_marks: Option<f64>,
    pub is_hypothetical: bool,
    pub created_at: String,
    /// Structural link to subjects.id (migration 014). NULL only for legacy
    /// rows the backfill could not deterministically match; identity must
    /// never be re-derived from the course name while this is set.
    pub subject_id: Option<i32>,
}

#[napi(object)]
pub struct GradeBandDto {
    pub min_percent: f64,
    pub grade_point: f64,
    pub label: String,
}

#[napi(object)]
pub struct SgpaResult {
    pub sgpa: f64,
    pub total_credits: f64,
    pub earned_points: f64,
    pub graded_count: i32,
}

#[napi(object)]
pub struct SemesterSgpa {
    pub label: String,
    pub sgpa: f64,
    pub credits: f64,
}

#[napi(object)]
pub struct CgpaResult {
    pub cgpa: f64,
    pub total_credits: f64,
    pub total_points: f64,
    pub semesters: Vec<SemesterSgpa>,
}

// ---------------------------------------------------------------------------
// Grade scale
// ---------------------------------------------------------------------------

/// Progress Ledger's fallback scale when a profile has not defined one. Example
/// 10-point Indian scheme; profiles from other institutions can overwrite it
/// via `set_grade_scale`. This is NOT treated as universal — it is only the
/// seed a user can edit.
fn default_bands() -> Vec<GradeBandDto> {
    vec![
        GradeBandDto {
            min_percent: 90.0,
            grade_point: 10.0,
            label: "O".into(),
        },
        GradeBandDto {
            min_percent: 80.0,
            grade_point: 9.0,
            label: "A+".into(),
        },
        GradeBandDto {
            min_percent: 70.0,
            grade_point: 8.0,
            label: "A".into(),
        },
        GradeBandDto {
            min_percent: 60.0,
            grade_point: 7.0,
            label: "B+".into(),
        },
        GradeBandDto {
            min_percent: 50.0,
            grade_point: 6.0,
            label: "B".into(),
        },
        GradeBandDto {
            min_percent: 40.0,
            grade_point: 5.0,
            label: "C".into(),
        },
        GradeBandDto {
            min_percent: 0.0,
            grade_point: 0.0,
            label: "F".into(),
        },
    ]
}

fn load_bands(conn: &Connection, profile_id: i32) -> Result<Vec<GradeBandDto>> {
    let mut stmt = conn
        .prepare(
            "SELECT b.min_percent, b.grade_point, b.label
             FROM grade_bands b
             JOIN grade_scales s ON s.id = b.scale_id
             WHERE s.profile_id = ?1
             ORDER BY b.min_percent DESC",
        )
        .map_err(to_err)?;
    let rows = stmt
        .query_map(params![profile_id], |row| {
            Ok(GradeBandDto {
                min_percent: row.get(0)?,
                grade_point: row.get(1)?,
                label: row.get(2)?,
            })
        })
        .map_err(to_err)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(to_err)?);
    }
    Ok(out)
}

pub(crate) fn scale_for(conn: &Connection, profile_id: i32) -> Result<GradeScale> {
    let mut bands = load_bands(conn, profile_id)?;
    if bands.is_empty() {
        bands = default_bands();
    }
    Ok(GradeScale {
        bands: bands
            .into_iter()
            .map(|b| GradeBand {
                min_percent: b.min_percent,
                grade_point: b.grade_point,
                label: b.label,
            })
            .collect(),
    })
}

/// Effective grade scale for a profile (stored bands, or the default seed if
/// none has been saved). Lets the UI render the scale it is calculating with.
#[napi]
pub fn get_grade_scale(profile_id: i32) -> Result<Vec<GradeBandDto>> {
    with_db(|conn| {
        let bands = load_bands(conn, profile_id)?;
        Ok(if bands.is_empty() {
            default_bands()
        } else {
            bands
        })
    })
}

/// The built-in default scale (data, not hardcoded UI). Used by "restore default".
#[napi]
pub fn get_default_grade_scale() -> Vec<GradeBandDto> {
    default_bands()
}

#[napi(object)]
pub struct GradeScaleValidation {
    pub valid: bool,
    pub error: Option<String>,
}

/// Validate a candidate scale WITHOUT persisting. The UI calls this so its
/// checks are the authoritative Rust rules, not independently reinvented.
#[napi]
pub fn validate_grade_scale(bands: Vec<GradeBandDto>) -> GradeScaleValidation {
    let scale = GradeScale {
        bands: bands
            .into_iter()
            .map(|b| GradeBand {
                min_percent: b.min_percent,
                grade_point: b.grade_point,
                label: b.label,
            })
            .collect(),
    };
    match scale.validate() {
        Ok(()) => GradeScaleValidation {
            valid: true,
            error: None,
        },
        Err(msg) => GradeScaleValidation {
            valid: false,
            error: Some(msg),
        },
    }
}

/// Replace a profile's grade scale wholesale. The scale is validated against
/// the domain rules (see `GradeScale::validate`) and rejected with a coded
/// error if invalid, so an inconsistent scale can never reach SQLite.
#[napi]
pub fn set_grade_scale(profile_id: i32, bands: Vec<GradeBandDto>) -> Result<()> {
    let scale = GradeScale {
        bands: bands
            .iter()
            .map(|b| GradeBand {
                min_percent: b.min_percent,
                grade_point: b.grade_point,
                label: b.label.clone(),
            })
            .collect(),
    };
    scale
        .validate()
        .map_err(|msg| coded(codes::DB_CONSTRAINT, msg))?;

    with_transaction(|conn| {
        conn.execute(
            "INSERT INTO grade_scales (profile_id, name) VALUES (?1, 'Default')
             ON CONFLICT(profile_id) DO NOTHING",
            params![profile_id],
        )
        .map_err(to_err)?;
        let scale_id: i32 = conn
            .query_row(
                "SELECT id FROM grade_scales WHERE profile_id = ?1",
                params![profile_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        conn.execute(
            "DELETE FROM grade_bands WHERE scale_id = ?1",
            params![scale_id],
        )
        .map_err(to_err)?;
        for (i, b) in bands.iter().enumerate() {
            conn.execute(
                "INSERT INTO grade_bands (scale_id, min_percent, grade_point, label, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![scale_id, b.min_percent, b.grade_point, b.label, i as i32],
            )
            .map_err(to_err)?;
        }
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Courses CRUD
// ---------------------------------------------------------------------------

/// Resolve a subject's owning profile through the academic tree. Returns
/// Ok(None) when the id does not exist — callers turn that into a coded error.
fn subject_profile_id(conn: &Connection, subject_id: i32) -> Result<Option<i32>> {
    conn.query_row(
        "SELECT t.profile_id
         FROM subjects s
         JOIN milestones m ON m.id = s.milestone_id
         JOIN semesters se ON se.id = m.semester_id
         JOIN tracks t ON t.id = se.track_id
         WHERE s.id = ?1",
        params![subject_id],
        |r| r.get::<_, i32>(0),
    )
    .optional()
    .map_err(to_err)
}

/// Validate that `subject_id` exists and belongs to `profile_id`. Coded
/// DB_CONSTRAINT errors; no partial state is possible because every caller
/// runs inside a transaction.
fn validate_course_subject(conn: &Connection, profile_id: i32, subject_id: i32) -> Result<()> {
    match subject_profile_id(conn, subject_id)? {
        None => Err(coded(
            codes::DB_CONSTRAINT,
            format!("Subject {} not found", subject_id),
        )),
        Some(pid) if pid != profile_id => Err(coded(
            codes::DB_CONSTRAINT,
            "Subject belongs to a different profile",
        )),
        Some(_) => Ok(()),
    }
}

#[napi]
#[allow(clippy::too_many_arguments)]
pub fn add_course(
    profile_id: i32,
    semester_label: String,
    course_name: String,
    credits: f64,
    grade: Option<String>,
    grade_points: Option<f64>,
    marks_obtained: Option<f64>,
    max_marks: Option<f64>,
    is_hypothetical: Option<bool>,
    subject_id: Option<i32>,
) -> Result<i32> {
    with_transaction(|conn| {
        if let Some(sid) = subject_id {
            validate_course_subject(conn, profile_id, sid)?;
        }
        conn.execute(
            "INSERT INTO courses (profile_id, semester_label, course_name, credits, grade, grade_points, marks_obtained, max_marks, is_hypothetical, subject_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                profile_id, semester_label, course_name, credits, grade, grade_points,
                marks_obtained, max_marks, is_hypothetical.unwrap_or(false) as i32,
                subject_id
            ],
        )
        .map_err(to_err)?;
        Ok(conn.last_insert_rowid() as i32)
    })
}

#[napi]
pub fn get_courses(profile_id: i32, semester_label: Option<String>) -> Result<Vec<Course>> {
    with_db(|conn| {
        let mut query = "SELECT id, profile_id, semester_label, course_name, credits, grade, grade_points, marks_obtained, max_marks, is_hypothetical, created_at, subject_id FROM courses WHERE profile_id = ?1".to_string();
        let mut args: Vec<rusqlite::types::Value> = vec![profile_id.into()];

        if let Some(sem) = semester_label {
            query.push_str(" AND semester_label = ?2");
            args.push(sem.into());
        }
        query.push_str(" ORDER BY created_at ASC");

        let mut stmt = conn.prepare(&query).map_err(to_err)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(args), |row| {
                Ok(Course {
                    id: row.get(0)?,
                    profile_id: row.get(1)?,
                    semester_label: row.get(2)?,
                    course_name: row.get(3)?,
                    credits: row.get(4)?,
                    grade: row.get(5)?,
                    grade_points: row.get(6)?,
                    marks_obtained: row.get(7)?,
                    max_marks: row.get(8)?,
                    is_hypothetical: row.get(9).map(|v: i32| v != 0).unwrap_or(false),
                    created_at: row.get(10)?,
                    subject_id: row.get(11)?,
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

/// Update marks/credits/name and (optionally) the structural subject link.
/// `subject_id = None` leaves the existing link untouched; `Some(id)` is
/// validated against the course's own profile before anything is written.
///
/// `profile_id` is the caller's profile. The function refuses to write if
/// the row does not belong to that profile — a renderer compromise cannot
/// patch or delete another profile's courses.
#[napi]
#[allow(clippy::too_many_arguments)]
pub fn update_course(
    profile_id: i32,
    id: i32,
    course_name: String,
    credits: f64,
    grade: Option<String>,
    grade_points: Option<f64>,
    marks_obtained: Option<f64>,
    max_marks: Option<f64>,
    subject_id: Option<i32>,
) -> Result<()> {
    with_transaction(|conn| {
        // Always resolve the course's profile first; it is the single
        // source of truth for ownership. The if/else branches then both
        // use WHERE id = ?N AND profile_id = ?P so the row cannot be
        // touched by a renderer that supplies the wrong profile.
        let course_profile: i32 = conn
            .query_row(
                "SELECT profile_id FROM courses WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .map_err(|_| coded(codes::DB_CONSTRAINT, format!("Course {} not found", id)))?;
        if course_profile != profile_id {
            return Err(coded(
                codes::NOT_OWNED,
                "Course belongs to a different profile",
            ));
        }
        if let Some(sid) = subject_id {
            validate_course_subject(conn, course_profile, sid)?;
            conn.execute(
                "UPDATE courses SET course_name = ?1, credits = ?2, grade = ?3, grade_points = ?4, marks_obtained = ?5, max_marks = ?6, subject_id = ?7 WHERE id = ?8 AND profile_id = ?9",
                params![course_name, credits, grade, grade_points, marks_obtained, max_marks, sid, id, profile_id],
            )
            .map_err(to_err)?;
        } else {
            conn.execute(
                "UPDATE courses SET course_name = ?1, credits = ?2, grade = ?3, grade_points = ?4, marks_obtained = ?5, max_marks = ?6 WHERE id = ?7 AND profile_id = ?8",
                params![course_name, credits, grade, grade_points, marks_obtained, max_marks, id, profile_id],
            )
            .map_err(to_err)?;
        }
        Ok(())
    })
}

/// Delete a course. `profile_id` is the caller's profile; the function
/// refuses to delete rows owned by another profile.
#[napi]
pub fn delete_course(profile_id: i32, id: i32) -> Result<()> {
    with_db(|conn| {
        let n = conn
            .execute(
                "DELETE FROM courses WHERE id = ?1 AND profile_id = ?2",
                params![id, profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(codes::NOT_OWNED, "Course not found in this profile"));
        }
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Calculations — thin wrappers that delegate to the pure domain layer.
// ---------------------------------------------------------------------------

fn course_inputs(
    conn: &Connection,
    profile_id: i32,
    semester_label: Option<&str>,
) -> Result<Vec<(String, CourseInput)>> {
    let mut query = "SELECT semester_label, credits, marks_obtained, max_marks, grade_points FROM courses WHERE profile_id = ?1".to_string();
    let mut args: Vec<rusqlite::types::Value> = vec![profile_id.into()];
    if let Some(sem) = semester_label {
        query.push_str(" AND semester_label = ?2");
        args.push(sem.to_string().into());
    }
    let mut stmt = conn.prepare(&query).map_err(to_err)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args), |row| {
            let label: String = row.get(0)?;
            Ok((
                label,
                CourseInput {
                    credits: row.get(1)?,
                    obtained: row.get(2)?,
                    max: row.get(3)?,
                    grade_point_override: row.get(4)?,
                },
            ))
        })
        .map_err(to_err)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(to_err)?);
    }
    Ok(out)
}

#[napi]
pub fn calculate_sgpa(profile_id: i32, semester_label: String) -> Result<SgpaResult> {
    with_db(|conn| {
        let scale = scale_for(conn, profile_id)?;
        let inputs: Vec<CourseInput> = course_inputs(conn, profile_id, Some(&semester_label))?
            .into_iter()
            .map(|(_, c)| c)
            .collect();
        let r = weighted_gpa(&inputs, &scale);
        Ok(SgpaResult {
            sgpa: r.gpa,
            total_credits: r.graded_credits,
            earned_points: r.weighted_points,
            graded_count: r.graded_count as i32,
        })
    })
}

#[napi]
pub fn calculate_cgpa(profile_id: i32) -> Result<CgpaResult> {
    with_db(|conn| {
        let scale = scale_for(conn, profile_id)?;
        let all = course_inputs(conn, profile_id, None)?;

        // Group by semester, preserving first-seen order.
        let mut order: Vec<String> = Vec::new();
        let mut groups: std::collections::HashMap<String, Vec<CourseInput>> =
            std::collections::HashMap::new();
        for (label, c) in all {
            if !groups.contains_key(&label) {
                order.push(label.clone());
            }
            groups.entry(label).or_default().push(c);
        }

        let mut semesters = Vec::new();
        let mut overall_credits = 0.0;
        let mut overall_points = 0.0;
        for label in order {
            let inputs = &groups[&label];
            let r = weighted_gpa(inputs, &scale);
            overall_credits += r.graded_credits;
            overall_points += r.weighted_points;
            semesters.push(SemesterSgpa {
                label,
                sgpa: r.gpa,
                credits: r.graded_credits,
            });
        }

        let cgpa = if overall_credits > 0.0 {
            overall_points / overall_credits
        } else {
            0.0
        };
        Ok(CgpaResult {
            cgpa,
            total_credits: overall_credits,
            total_points: overall_points,
            semesters,
        })
    })
}
