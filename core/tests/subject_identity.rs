//! Integration tests for SUBJECT IDENTITY HARDENING (schema v14).
//!
//! These exist to catch the original destructive bug: subject identity decided
//! by name strings. They pin, against the real migrated schema:
//!   * migration 014 reaches schema v14 and adds courses.subject_id
//!   * the deterministic backfill links only unambiguous, same-profile rows;
//!     ambiguous/unmatched rows stay NULL (preserved, never guessed)
//!   * a RENAME keeps subjects.id and every dependent (sessions, notes/PDFs,
//!     flashcards, mistakes, labs, formulas, deadlines) plus the structural
//!     course link and the career link
//!   * subject_overview grade resolution prefers courses.subject_id and falls
//!     back to the legacy name match ONLY for NULL-linked rows
//!   * genuine deletion still destroys dependents (unchanged semantics)
//!
//! The napi surface is not callable from cargo test, so domain statements are
//! replicated verbatim; migration 014's own SQL is executed FROM THE FILE so
//! the backfill under test cannot drift from what ships.

use rusqlite::{Connection, OptionalExtension, Result};
use std::fs;

const MIGRATION_014: &str = include_str!("../migrations/014_courses_subject_id.sql");

fn setup_test_db() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;

    // Apply migrations exactly like the Rust runner does: each file wrapped in
    // BEGIN..PRAGMA user_version..COMMIT, version taken from the filename.
    let migrations_dir = std::path::Path::new("migrations");
    let mut files: Vec<_> = fs::read_dir(migrations_dir)
        .map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(
                Box::new(e) as Box<dyn std::error::Error + Send + Sync>
            )
        })?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |ext| ext == "sql"))
        .collect();
    files.sort_by_key(|e| e.path());

    for entry in files {
        let path = entry.path();
        let ver: i32 = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.split('_').next())
            .and_then(|s| s.parse().ok())
            .expect("migration filenames are NNN_description.sql");
        let sql = fs::read_to_string(&path).map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(
                Box::new(e) as Box<dyn std::error::Error + Send + Sync>
            )
        })?;
        let batch = format!("BEGIN;\n{sql}\nPRAGMA user_version = {ver};\nCOMMIT;");
        conn.execute_batch(&batch)?;
    }
    Ok(conn)
}

/// Run ONLY migration 014's backfill UPDATE (idempotency target).
fn run_014_backfill(conn: &Connection) -> Result<()> {
    let update = MIGRATION_014
        .split(';')
        .find(|stmt| stmt.contains("UPDATE courses"))
        .expect("014 contains an UPDATE courses statement");
    conn.execute_batch(update)
}

struct Fixture {
    profile_id: i32,
    subject_id: i32,
    goal_id: i32,
}

/// One profile -> track -> semester -> milestone -> subject, plus a career
/// goal + roadmap milestone ready to be linked.
fn seed_profile(conn: &Connection, name: &str, slug: &str, subject_name: &str) -> Result<Fixture> {
    conn.execute(
        "INSERT INTO profiles (name, slug) VALUES (?1, ?2)",
        [name, slug],
    )?;
    let profile_id = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO tracks (profile_id, name) VALUES (?1, 'Track')",
        [profile_id],
    )?;
    let track_id = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO semesters (track_id, name) VALUES (?1, 'Semester 1')",
        [track_id],
    )?;
    let sem_id = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO milestones (semester_id, title) VALUES (?1, 'Subjects')",
        [sem_id],
    )?;
    let ms_id = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO subjects (milestone_id, name) VALUES (?1, ?2)",
        rusqlite::params![ms_id, subject_name],
    )?;
    let subject_id = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO career_goals (profile_id, title, status, is_primary) VALUES (?1, 'Goal', 'active', 1)",
        [profile_id],
    )?;
    let goal_id = conn.last_insert_rowid() as i32;
    Ok(Fixture {
        profile_id,
        subject_id,
        goal_id,
    })
}

/// Insert one dependent row of each kind hanging off the subject.
fn seed_dependents(conn: &Connection, f: &Fixture) -> Result<()> {
    conn.execute(
        "INSERT INTO session_states (subject_id, started_at, duration_minutes) VALUES (?1, datetime('now','localtime'), 25)",
        [f.subject_id],
    )?;
    conn.execute(
        "INSERT INTO resources (subject_id, kind, title, content) VALUES (?1, 'note', 'Note', 'body')",
        [f.subject_id],
    )?;
    conn.execute(
        "INSERT INTO cards (subject_id, front, back, ease_factor, interval_days, repetitions, due_date)
         VALUES (?1, 'Q', 'A', 2.5, 1, 0, date('now','localtime'))",
        [f.subject_id],
    )?;
    conn.execute(
        "INSERT INTO mistakes (subject_id, question_text, mistake_type, correct_approach) VALUES (?1, 'q', 'conceptual', 'a')",
        [f.subject_id],
    )?;
    conn.execute(
        "INSERT INTO lab_experiments (subject_id, experiment_no, title) VALUES (?1, 1, 'Exp')",
        [f.subject_id],
    )?;
    conn.execute(
        "INSERT INTO formulas (subject_id, title, latex_content, category) VALUES (?1, 'F', 'x^2', 'alg')",
        [f.subject_id],
    )?;
    conn.execute(
        "INSERT INTO deadlines (subject_id, deadline_date, category, title) VALUES (?1, date('now','localtime'), 'exam', 'Mid')",
        [f.subject_id],
    )?;
    Ok(())
}

fn count_where(conn: &Connection, table: &str, subject_id: i32) -> Result<i64> {
    let n: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM {table} WHERE subject_id = ?1"),
        [subject_id],
        |r| r.get(0),
    )?;
    Ok(n)
}

/// The exact rename the planner issues: metadata-only UPDATE, id untouched.
fn rename_subject(conn: &Connection, subject_id: i32, new_name: &str) -> Result<()> {
    conn.execute(
        "UPDATE subjects SET name = ?2 WHERE id = ?1",
        rusqlite::params![subject_id, new_name],
    )?;
    Ok(())
}

/// Overview grade resolution: PRIMARY by courses.subject_id, LEGACY fallback
/// only for NULL-linked rows (mirrors subject_overview.rs).
fn resolve_grade(
    conn: &Connection,
    f: &Fixture,
    semester_label: &str,
    subject_name: &str,
) -> Result<Option<(f64, Option<f64>, Option<f64>)>> {
    let primary = conn
        .query_row(
            "SELECT credits, marks_obtained, max_marks FROM courses WHERE subject_id = ?1 ORDER BY id LIMIT 1",
            [f.subject_id],
            |r| Ok((r.get::<_, f64>(0)?, r.get::<_, Option<f64>>(1)?, r.get::<_, Option<f64>>(2)?)),
        )
        .optional()?;
    if primary.is_some() {
        return Ok(primary);
    }
    conn.query_row(
        "SELECT credits, marks_obtained, max_marks FROM courses
         WHERE profile_id = ?1 AND semester_label = ?2 AND subject_id IS NULL
           AND lower(trim(course_name)) = lower(trim(?3)) LIMIT 1",
        rusqlite::params![f.profile_id, semester_label, subject_name],
        |r| {
            Ok((
                r.get::<_, f64>(0)?,
                r.get::<_, Option<f64>>(1)?,
                r.get::<_, Option<f64>>(2)?,
            ))
        },
    )
    .optional()
}

#[test]
fn migration_014_reaches_at_least_v14_and_adds_structural_link() -> Result<()> {
    let conn = setup_test_db()?;
    let ver: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    assert!(
        ver >= 14,
        "fresh install must land on schema v14 or later (got {ver})"
    );
    // Column exists and starts fully NULL on a fresh install.
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM courses", [], |r| r.get(0))?;
    let linked: i64 = conn.query_row(
        "SELECT COUNT(*) FROM courses WHERE subject_id IS NOT NULL",
        [],
        |r| r.get(0),
    )?;
    assert_eq!((total, linked), (0, 0));
    Ok(())
}

#[test]
fn backfill_is_deterministic_and_never_guesses() -> Result<()> {
    let conn = setup_test_db()?;
    let a = seed_profile(&conn, "Ada", "ada", "Algorithms")?;

    // Course created the legacy way (no link yet) -> unique match attaches.
    conn.execute(
        "INSERT INTO courses (profile_id, semester_label, course_name, credits, marks_obtained, max_marks)
         VALUES (?1, 'Semester 1', 'algorithms ', 4, 80, 100)",
        [a.profile_id], // deliberately different casing/whitespace
    )?;
    run_014_backfill(&conn)?;
    let linked: Option<i32> = conn.query_row(
        "SELECT subject_id FROM courses WHERE course_name = 'algorithms '",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(
        linked,
        Some(a.subject_id),
        "unique match must link through trim/case-insensitive name"
    );

    // AMBIGUOUS: two subjects share the same name inside one semester ->
    // the second course must stay NULL rather than guess.
    conn.execute("INSERT INTO milestones (semester_id, title) SELECT semester_id, 'Lab' FROM milestones WHERE id = (
        SELECT m.id FROM milestones m JOIN subjects s ON s.milestone_id = m.id WHERE s.id = ?1)",
        [a.subject_id])?;
    let lab_ms: i32 = conn.query_row(
        "SELECT m.id FROM milestones m JOIN subjects s ON s.milestone_id = m.id WHERE s.id = ?1",
        [a.subject_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO subjects (milestone_id, name) VALUES (?1, 'Algorithms')",
        [lab_ms],
    )?;
    conn.execute(
        "INSERT INTO courses (profile_id, semester_label, course_name, credits) VALUES (?1, 'Semester 1', 'Algorithms', 3)",
        [a.profile_id],
    )?;
    run_014_backfill(&conn)?;
    let ambiguous: Option<i32> = conn.query_row(
        "SELECT subject_id FROM courses WHERE course_name = 'Algorithms'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(
        ambiguous, None,
        "ambiguous mapping must be preserved as NULL, never guessed"
    );

    // UNMATCHED: no such subject anywhere -> stays NULL.
    conn.execute(
        "INSERT INTO courses (profile_id, semester_label, course_name, credits) VALUES (?1, 'Semester 1', 'Ghost', 2)",
        [a.profile_id],
    )?;
    run_014_backfill(&conn)?;
    let unmatched: Option<i32> = conn.query_row(
        "SELECT subject_id FROM courses WHERE course_name = 'Ghost'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(unmatched, None);
    Ok(())
}

#[test]
fn backfill_respects_profile_boundaries() -> Result<()> {
    let conn = setup_test_db()?;
    let a = seed_profile(&conn, "Ada", "ada", "Algorithms")?;
    let b = seed_profile(&conn, "Bea", "bea", "Algorithms")?;
    assert_ne!(a.subject_id, b.subject_id);

    // Bea's legacy course shares the name with Ada's subject too; the backfill
    // must resolve strictly through Bea's own tree.
    conn.execute(
        "INSERT INTO courses (profile_id, semester_label, course_name, credits) VALUES (?1, 'Semester 1', 'Algorithms', 4)",
        [b.profile_id],
    )?;
    run_014_backfill(&conn)?;
    let got: Option<i32> = conn.query_row(
        "SELECT subject_id FROM courses WHERE profile_id = ?1",
        [b.profile_id],
        |r| r.get(0),
    )?;
    assert_eq!(got, Some(b.subject_id));
    assert_ne!(got, Some(a.subject_id));

    // And Ada has no course at all — nothing was attached across profiles.
    let a_courses: i64 = conn.query_row(
        "SELECT COUNT(*) FROM courses WHERE profile_id = ?1",
        [a.profile_id],
        |r| r.get(0),
    )?;
    assert_eq!(a_courses, 0);
    Ok(())
}

#[test]
fn rename_preserves_identity_and_every_dependent() -> Result<()> {
    let conn = setup_test_db()?;
    let f = seed_profile(&conn, "Ada", "ada", "Algorithms")?;
    seed_dependents(&conn, &f)?;

    // Structural course + career link exist BEFORE the rename.
    conn.execute(
        "INSERT INTO courses (profile_id, semester_label, course_name, credits, marks_obtained, max_marks, subject_id)
         VALUES (?1, 'Semester 1', 'Algorithms', 4, 88, 100, ?2)",
        rusqlite::params![f.profile_id, f.subject_id],
    )?;
    conn.execute(
        "INSERT INTO career_milestones (goal_id, title, sort_order, linked_subject_id) VALUES (?1, 'Learn SQL', 0, ?2)",
        rusqlite::params![f.goal_id, f.subject_id],
    )?;

    rename_subject(&conn, f.subject_id, "Distributed Systems")?;

    // Identity itself is untouched.
    let (id, name): (i32, String) = conn.query_row(
        "SELECT id, name FROM subjects WHERE id = ?1",
        [f.subject_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(id, f.subject_id);
    assert_eq!(name, "Distributed Systems");

    // Every dependent survived, still pointing at the SAME id.
    for table in [
        "session_states",
        "resources",
        "cards",
        "mistakes",
        "lab_experiments",
        "formulas",
        "deadlines",
    ] {
        assert_eq!(
            count_where(&conn, table, f.subject_id)?,
            1,
            "{table} must survive rename"
        );
    }

    // Grade still resolves THROUGH THE STRUCTURAL LINK even though the course
    // name now differs from the subject name (the old code lost this).
    let grade = resolve_grade(&conn, &f, "Semester 1", "Distributed Systems")?;
    assert_eq!(grade, Some((4.0, Some(88.0), Some(100.0))));

    // Career link follows automatically (same id, fresh name via LEFT JOIN).
    let (linked_id, linked_name): (Option<i32>, Option<String>) = conn.query_row(
        "SELECT cm.linked_subject_id, s.name
         FROM career_milestones cm LEFT JOIN subjects s ON s.id = cm.linked_subject_id
         WHERE cm.goal_id = ?1",
        [f.goal_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(linked_id, Some(f.subject_id));
    assert_eq!(linked_name.as_deref(), Some("Distributed Systems"));
    Ok(())
}

#[test]
fn legacy_null_link_fallback_still_resolves_by_name() -> Result<()> {
    let conn = setup_test_db()?;
    let f = seed_profile(&conn, "Ada", "ada", "Algorithms")?;

    // A course the backfill could not link (kept NULL, per policy).
    conn.execute(
        "INSERT INTO courses (profile_id, semester_label, course_name, credits, marks_obtained, max_marks)
         VALUES (?1, 'Semester 1', 'Algorithms', 3, 70, 100)",
        [f.profile_id],
    )?;
    let grade = resolve_grade(&conn, &f, "Semester 1", "Algorithms")?;
    assert_eq!(
        grade,
        Some((3.0, Some(70.0), Some(100.0))),
        "legacy fallback must keep unlinked rows working"
    );

    // But once renamed with no structural link, the legacy match correctly
    // finds nothing — this is exactly why the structural link is primary.
    rename_subject(&conn, f.subject_id, "Distributed Systems")?;
    let grade_after = resolve_grade(&conn, &f, "Semester 1", "Distributed Systems")?;
    assert_eq!(
        grade_after, None,
        "NULL-linked rows must not be name-guessed after rename"
    );
    Ok(())
}

#[test]
fn cross_profile_attachment_is_rejected_by_domain_guard() -> Result<()> {
    let conn = setup_test_db()?;
    let a = seed_profile(&conn, "Ada", "ada", "Algorithms")?;
    let b = seed_profile(&conn, "Bea", "bea", "Zoology")?;

    // Mirror validate_course_subject: resolve candidate subject's owner.
    let owner: Option<i32> = conn
        .query_row(
            "SELECT t.profile_id
             FROM subjects s
             JOIN milestones m ON m.id = s.milestone_id
             JOIN semesters se ON se.id = m.semester_id
             JOIN tracks t ON t.id = se.track_id
             WHERE s.id = ?1",
            [b.subject_id],
            |r| r.get(0),
        )
        .optional()?;
    // Guard used by add/update course: Some(owner != me) -> reject.
    let rejected = match owner {
        None => true,                     // missing subject -> coded error
        Some(pid) => pid != a.profile_id, // foreign subject -> coded error
    };
    assert!(rejected, "B's subject must not attach to A's course");
    Ok(())
}

#[test]
fn genuine_deletion_remains_destructive_for_dependents() -> Result<()> {
    let conn = setup_test_db()?;
    let f = seed_profile(&conn, "Ada", "ada", "Algorithms")?;
    seed_dependents(&conn, &f)?;

    conn.execute("DELETE FROM subjects WHERE id = ?1", [f.subject_id])?;

    for table in [
        "session_states",
        "resources",
        "cards",
        "mistakes",
        "lab_experiments",
        "formulas",
        "deadlines",
    ] {
        assert_eq!(
            count_where(&conn, table, f.subject_id)?,
            0,
            "{table} must cascade on real deletion"
        );
    }
    // Career milestone survives with an honest dangling reference.
    conn.execute(
        "INSERT INTO career_milestones (goal_id, title, sort_order, linked_subject_id) VALUES (?1, 'M', 0, ?2)",
        rusqlite::params![f.goal_id, f.subject_id],
    )?;
    let name: Option<String> = conn.query_row(
        "SELECT s.name FROM career_milestones cm LEFT JOIN subjects s ON s.id = cm.linked_subject_id WHERE cm.goal_id = ?1",
        [f.goal_id],
        |r| r.get(0),
    )?;
    assert_eq!(
        name, None,
        "dangling career link renders as missing, not stale"
    );
    Ok(())
}
