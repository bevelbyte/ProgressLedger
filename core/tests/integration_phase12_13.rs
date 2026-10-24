//! Integration tests for Phase 12-13 features: CGPA Planner, Lab Tracker, Project Tracker, Formula Board, Focus Curtain
//!
//! These tests verify the CRUD operations and business logic for Phase 12-13 features.

use rusqlite::{Connection, Result};
use std::fs;

fn setup_test_db() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;

    // Run migrations manually by reading SQL files
    let migrations_dir = std::path::Path::new("migrations");
    let mut migration_files: Vec<_> = fs::read_dir(migrations_dir)
        .map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(
                Box::new(e) as Box<dyn std::error::Error + Send + Sync>
            )
        })?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |ext| ext == "sql"))
        .collect();
    migration_files.sort_by_key(|e| e.path());

    for entry in migration_files {
        let path = entry.path();
        let sql = fs::read_to_string(&path).map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(
                Box::new(e) as Box<dyn std::error::Error + Send + Sync>
            )
        })?;
        conn.execute_batch(&sql)?;
    }

    Ok(conn)
}

#[test]
fn test_course_crud() -> Result<()> {
    let conn = setup_test_db()?;

    // Create profile
    conn.execute(
        "INSERT INTO profiles (name, slug) VALUES ('Test', 'test')",
        [],
    )?;
    let profile_id = conn.last_insert_rowid() as i32;

    // Add course
    conn.execute(
        "INSERT INTO courses (profile_id, semester_label, course_name, credits, grade, grade_points, is_hypothetical) 
         VALUES (?1, 'Sem 1', 'Mathematics', 4, 'A', 9.0, 0)",
        [profile_id],
    )?;
    let course_id = conn.last_insert_rowid() as i32;

    // Verify course was created
    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM courses WHERE id = ?1",
        [course_id],
        |row| row.get(0),
    )?;
    assert_eq!(count, 1);

    // Update course
    conn.execute(
        "UPDATE courses SET grade_points = 8.5 WHERE id = ?1",
        [course_id],
    )?;

    let grade_points: f64 = conn.query_row(
        "SELECT grade_points FROM courses WHERE id = ?1",
        [course_id],
        |row| row.get(0),
    )?;
    assert_eq!(grade_points, 8.5);

    // Delete course
    conn.execute("DELETE FROM courses WHERE id = ?1", [course_id])?;

    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM courses WHERE id = ?1",
        [course_id],
        |row| row.get(0),
    )?;
    assert_eq!(count, 0);

    Ok(())
}

#[test]
fn test_cgpa_calculation() -> Result<()> {
    let conn = setup_test_db()?;

    // Create profile
    conn.execute(
        "INSERT INTO profiles (name, slug) VALUES ('Test', 'test')",
        [],
    )?;
    let profile_id = conn.last_insert_rowid() as i32;

    // Add multiple courses
    conn.execute(
        "INSERT INTO courses (profile_id, semester_label, course_name, credits, grade, grade_points, is_hypothetical) 
         VALUES (?1, 'Sem 1', 'Mathematics', 4, 'A', 9.0, 0)",
        [profile_id],
    )?;

    conn.execute(
        "INSERT INTO courses (profile_id, semester_label, course_name, credits, grade, grade_points, is_hypothetical) 
         VALUES (?1, 'Sem 1', 'Physics', 4, 'B', 8.0, 0)",
        [profile_id],
    )?;

    conn.execute(
        "INSERT INTO courses (profile_id, semester_label, course_name, credits, grade, grade_points, is_hypothetical) 
         VALUES (?1, 'Sem 1', 'Chemistry', 3, 'A', 9.0, 0)",
        [profile_id],
    )?;

    // Calculate CGPA: (4*9.0 + 4*8.0 + 3*9.0) / (4+4+3) = (36+32+27)/11 = 95/11 = 8.636
    let (total_credits, total_points): (f64, f64) = conn.query_row(
        "SELECT SUM(credits), SUM(credits * grade_points) FROM courses WHERE profile_id = ?1 AND grade_points IS NOT NULL",
        [profile_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    let cgpa = total_points / total_credits;
    assert!((cgpa - 8.636).abs() < 0.01);

    Ok(())
}

#[test]
fn test_lab_experiment_crud() -> Result<()> {
    let conn = setup_test_db()?;

    // Create profile and academic hierarchy
    conn.execute(
        "INSERT INTO profiles (name, slug) VALUES ('Test', 'test')",
        [],
    )?;
    let profile_id = conn.last_insert_rowid() as i32;

    conn.execute(
        "INSERT INTO tracks (profile_id, name) VALUES (?1, 'Track 1')",
        [profile_id],
    )?;
    let track_id = conn.last_insert_rowid() as i32;

    conn.execute(
        "INSERT INTO semesters (track_id, name) VALUES (?1, 'Sem 1')",
        [track_id],
    )?;
    let sem_id = conn.last_insert_rowid() as i32;

    conn.execute(
        "INSERT INTO milestones (semester_id, title) VALUES (?1, 'Milestone 1')",
        [sem_id],
    )?;
    let ms_id = conn.last_insert_rowid() as i32;

    conn.execute(
        "INSERT INTO subjects (milestone_id, name) VALUES (?1, 'Subject 1')",
        [ms_id],
    )?;
    let subject_id = conn.last_insert_rowid() as i32;

    // Add lab experiment
    conn.execute(
        "INSERT INTO lab_experiments (subject_id, experiment_no, title, record_submitted, viva_done) 
         VALUES (?1, 1, 'Experiment 1', 0, 0)",
        [subject_id],
    )?;
    let exp_id = conn.last_insert_rowid() as i32;

    // Verify experiment was created
    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM lab_experiments WHERE id = ?1",
        [exp_id],
        |row| row.get(0),
    )?;
    assert_eq!(count, 1);

    // Update experiment
    conn.execute(
        "UPDATE lab_experiments SET record_submitted = 1, viva_done = 1, viva_score = '8/10' WHERE id = ?1",
        [exp_id],
    )?;

    let record_submitted: i32 = conn.query_row(
        "SELECT record_submitted FROM lab_experiments WHERE id = ?1",
        [exp_id],
        |row| row.get(0),
    )?;
    assert_eq!(record_submitted, 1);

    // Delete experiment
    conn.execute("DELETE FROM lab_experiments WHERE id = ?1", [exp_id])?;

    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM lab_experiments WHERE id = ?1",
        [exp_id],
        |row| row.get(0),
    )?;
    assert_eq!(count, 0);

    // Clean up hierarchy in reverse order (due to constraints)
    conn.execute("DELETE FROM subjects WHERE id = ?1", [subject_id])?;
    conn.execute("DELETE FROM milestones WHERE id = ?1", [ms_id])?;
    conn.execute("DELETE FROM semesters WHERE id = ?1", [sem_id])?;
    conn.execute("DELETE FROM tracks WHERE id = ?1", [track_id])?;

    Ok(())
}

#[test]
fn test_project_crud() -> Result<()> {
    let conn = setup_test_db()?;

    // Create profile
    conn.execute(
        "INSERT INTO profiles (name, slug) VALUES ('Test', 'test')",
        [],
    )?;
    let profile_id = conn.last_insert_rowid() as i32;

    // Add project
    conn.execute(
        "INSERT INTO projects (profile_id, name, project_type, status, deadline, description) 
         VALUES (?1, 'My Project', 'mini', 'planning', '2024-12-31', 'A test project')",
        [profile_id],
    )?;
    let project_id = conn.last_insert_rowid() as i32;

    // Verify project was created
    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM projects WHERE id = ?1",
        [project_id],
        |row| row.get(0),
    )?;
    assert_eq!(count, 1);

    // Add project task
    conn.execute(
        "INSERT INTO project_tasks (project_id, title, status, priority) 
         VALUES (?1, 'Task 1', 'todo', 'high')",
        [project_id],
    )?;
    let task_id = conn.last_insert_rowid() as i32;

    // Verify task was created
    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM project_tasks WHERE id = ?1",
        [task_id],
        |row| row.get(0),
    )?;
    assert_eq!(count, 1);

    // Update project
    conn.execute(
        "UPDATE projects SET status = 'in_progress' WHERE id = ?1",
        [project_id],
    )?;

    let status: String = conn.query_row(
        "SELECT status FROM projects WHERE id = ?1",
        [project_id],
        |row| row.get(0),
    )?;
    assert_eq!(status, "in_progress");

    // Delete project (should cascade delete tasks)
    conn.execute("DELETE FROM projects WHERE id = ?1", [project_id])?;

    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM project_tasks WHERE project_id = ?1",
        [project_id],
        |row| row.get(0),
    )?;
    assert_eq!(count, 0);

    Ok(())
}

#[test]
fn test_project_tasks_are_profile_scoped() -> Result<()> {
    let conn = setup_test_db()?;
    conn.execute("PRAGMA foreign_keys = ON", [])?;
    conn.execute(
        "INSERT INTO profiles (name, slug) VALUES ('Owner A', 'owner-a')",
        [],
    )?;
    let profile_a = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO profiles (name, slug) VALUES ('Owner B', 'owner-b')",
        [],
    )?;
    let profile_b = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO projects (profile_id, name, project_type, status) VALUES (?1, 'A Project', 'mini', 'planning')",
        [profile_a],
    )?;
    let project_a = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO project_tasks (project_id, title, status, priority) VALUES (?1, 'Private Task', 'todo', 'high')",
        [project_a],
    )?;

    // The SQL layer itself must not expose another profile's task. The Rust
    // API adds the same ownership guard before issuing this query.
    let owner_a_count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM project_tasks pt JOIN projects p ON p.id = pt.project_id WHERE pt.project_id = ?1 AND p.profile_id = ?2",
        rusqlite::params![project_a, profile_a],
        |row| row.get(0),
    )?;
    let owner_b_count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM project_tasks pt JOIN projects p ON p.id = pt.project_id WHERE pt.project_id = ?1 AND p.profile_id = ?2",
        rusqlite::params![project_a, profile_b],
        |row| row.get(0),
    )?;
    assert_eq!(owner_a_count, 1);
    assert_eq!(owner_b_count, 0);
    Ok(())
}

#[test]
fn test_formula_crud() -> Result<()> {
    let conn = setup_test_db()?;

    // Create profile and academic hierarchy
    conn.execute(
        "INSERT INTO profiles (name, slug) VALUES ('Test', 'test')",
        [],
    )?;
    let profile_id = conn.last_insert_rowid() as i32;

    conn.execute(
        "INSERT INTO tracks (profile_id, name) VALUES (?1, 'Track 1')",
        [profile_id],
    )?;
    let track_id = conn.last_insert_rowid() as i32;

    conn.execute(
        "INSERT INTO semesters (track_id, name) VALUES (?1, 'Sem 1')",
        [track_id],
    )?;
    let sem_id = conn.last_insert_rowid() as i32;

    conn.execute(
        "INSERT INTO milestones (semester_id, title) VALUES (?1, 'Milestone 1')",
        [sem_id],
    )?;
    let ms_id = conn.last_insert_rowid() as i32;

    conn.execute(
        "INSERT INTO subjects (milestone_id, name) VALUES (?1, 'Subject 1')",
        [ms_id],
    )?;
    let subject_id = conn.last_insert_rowid() as i32;

    // Add formula
    conn.execute(
        "INSERT INTO formulas (subject_id, title, latex_content, category) 
         VALUES (?1, 'Pythagorean Theorem', 'a^2 + b^2 = c^2', 'geometry')",
        [subject_id],
    )?;
    let formula_id = conn.last_insert_rowid() as i32;

    // Verify formula was created
    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM formulas WHERE id = ?1",
        [formula_id],
        |row| row.get(0),
    )?;
    assert_eq!(count, 1);

    // Update formula
    conn.execute(
        "UPDATE formulas SET category = 'trigonometry' WHERE id = ?1",
        [formula_id],
    )?;

    let category: String = conn.query_row(
        "SELECT category FROM formulas WHERE id = ?1",
        [formula_id],
        |row| row.get(0),
    )?;
    assert_eq!(category, "trigonometry");

    // Delete formula
    conn.execute("DELETE FROM formulas WHERE id = ?1", [formula_id])?;

    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM formulas WHERE id = ?1",
        [formula_id],
        |row| row.get(0),
    )?;
    assert_eq!(count, 0);

    // Clean up hierarchy in reverse order (due to constraints)
    conn.execute("DELETE FROM subjects WHERE id = ?1", [subject_id])?;
    conn.execute("DELETE FROM milestones WHERE id = ?1", [ms_id])?;
    conn.execute("DELETE FROM semesters WHERE id = ?1", [sem_id])?;
    conn.execute("DELETE FROM tracks WHERE id = ?1", [track_id])?;

    Ok(())
}

#[test]
fn test_focus_settings_crud() -> Result<()> {
    let conn = setup_test_db()?;

    // Create profile
    conn.execute(
        "INSERT INTO profiles (name, slug) VALUES ('Test', 'test')",
        [],
    )?;
    let profile_id = conn.last_insert_rowid() as i32;

    // Add focus settings
    conn.execute(
        "INSERT INTO focus_settings (profile_id, is_enabled, blocked_domains) 
         VALUES (?1, 1, 'youtube.com,twitter.com')",
        [profile_id],
    )?;

    // Verify settings were created
    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM focus_settings WHERE profile_id = ?1",
        [profile_id],
        |row| row.get(0),
    )?;
    assert_eq!(count, 1);

    // Update settings (should use ON CONFLICT)
    conn.execute(
        "INSERT INTO focus_settings (profile_id, is_enabled, blocked_domains) 
         VALUES (?1, 0, 'facebook.com')
         ON CONFLICT(profile_id) DO UPDATE SET is_enabled = 0, blocked_domains = 'facebook.com'",
        [profile_id],
    )?;

    let is_enabled: i32 = conn.query_row(
        "SELECT is_enabled FROM focus_settings WHERE profile_id = ?1",
        [profile_id],
        |row| row.get(0),
    )?;
    assert_eq!(is_enabled, 0);

    Ok(())
}

#[test]
fn test_database_constraints() -> Result<()> {
    let conn = setup_test_db()?;

    // Create profile
    conn.execute(
        "INSERT INTO profiles (name, slug) VALUES ('Test', 'test')",
        [],
    )?;
    let profile_id = conn.last_insert_rowid() as i32;

    // Test CHECK constraint: credits must be positive
    let result = conn.execute(
        "INSERT INTO courses (profile_id, semester_label, course_name, credits, grade, grade_points, is_hypothetical) 
         VALUES (?1, 'Sem 1', 'Mathematics', -1, 'A', 9.0, 0)",
        [profile_id],
    );
    assert!(result.is_err());

    // Test CHECK constraint: grade_points must be <= 10
    let result = conn.execute(
        "INSERT INTO courses (profile_id, semester_label, course_name, credits, grade, grade_points, is_hypothetical) 
         VALUES (?1, 'Sem 1', 'Mathematics', 4, 'A', 11.0, 0)",
        [profile_id],
    );
    assert!(result.is_err());

    // Test CHECK constraint: ease_factor must be >= 1.3
    conn.execute(
        "INSERT INTO tracks (profile_id, name) VALUES (?1, 'Track 1')",
        [profile_id],
    )?;
    let track_id = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO semesters (track_id, name) VALUES (?1, 'Sem 1')",
        [track_id],
    )?;
    let sem_id = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO milestones (semester_id, title) VALUES (?1, 'Milestone 1')",
        [sem_id],
    )?;
    let ms_id = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO subjects (milestone_id, name) VALUES (?1, 'Subject 1')",
        [ms_id],
    )?;
    let subject_id = conn.last_insert_rowid() as i32;

    let result = conn.execute(
        "INSERT INTO cards (subject_id, front, back, ease_factor, interval_days, repetitions, due_date) 
         VALUES (?1, 'Q', 'A', 1.0, 0, 0, '2024-01-01')",
        [subject_id],
    );
    assert!(result.is_err());

    // Clean up hierarchy in reverse order (due to constraints)
    conn.execute("DELETE FROM subjects WHERE id = ?1", [subject_id])?;
    conn.execute("DELETE FROM milestones WHERE id = ?1", [ms_id])?;
    conn.execute("DELETE FROM semesters WHERE id = ?1", [sem_id])?;
    conn.execute("DELETE FROM tracks WHERE id = ?1", [track_id])?;

    Ok(())
}

#[test]
fn test_study_session_persist_and_stats() -> Result<()> {
    let conn = setup_test_db()?;

    // Build the full hierarchy a study session needs.
    conn.execute(
        "INSERT INTO profiles (name, slug) VALUES ('Test', 'test')",
        [],
    )?;
    let profile_id = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO tracks (profile_id, name) VALUES (?1, 'Track 1')",
        [profile_id],
    )?;
    let track_id = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO semesters (track_id, name) VALUES (?1, 'Sem 1')",
        [track_id],
    )?;
    let sem_id = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO milestones (semester_id, title) VALUES (?1, 'Subjects')",
        [sem_id],
    )?;
    let ms_id = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO subjects (milestone_id, name) VALUES (?1, 'Algorithms')",
        [ms_id],
    )?;
    let subject_id = conn.last_insert_rowid() as i32;

    // Two sessions today (45 + 30) using localtime, plus one on an explicit past day.
    conn.execute(
        "INSERT INTO session_states (subject_id, started_at, duration_minutes, notes)
         VALUES (?1, datetime('now','localtime'), 45, 'focus')",
        [subject_id],
    )?;
    conn.execute(
        "INSERT INTO session_states (subject_id, started_at, duration_minutes, notes)
         VALUES (?1, datetime('now','localtime'), 30, '')",
        [subject_id],
    )?;
    conn.execute(
        "INSERT INTO session_states (subject_id, started_at, duration_minutes, notes)
         VALUES (?1, '2024-01-01 10:00:00', 60, 'past')",
        [subject_id],
    )?;

    // Totals across the profile.
    let (count, total): (i32, i32) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(ss.duration_minutes),0)
         FROM session_states ss
         JOIN subjects sub ON sub.id = ss.subject_id
         JOIN milestones m ON m.id = sub.milestone_id
         JOIN semesters se ON se.id = m.semester_id
         JOIN tracks t ON t.id = se.track_id
         WHERE t.profile_id = ?1",
        [profile_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(count, 3);
    assert_eq!(total, 135);

    // Minutes today = 75 (the two localtime rows), independent of the past row.
    let today: i32 = conn.query_row(
        "SELECT COALESCE(SUM(duration_minutes),0) FROM session_states
         WHERE subject_id = ?1 AND date(started_at) = date('now','localtime')",
        [subject_id],
        |r| r.get(0),
    )?;
    assert_eq!(today, 75);

    // Distinct active days = 2 (today + 2024-01-01).
    let active_days: i32 = conn.query_row(
        "SELECT COUNT(DISTINCT date(started_at)) FROM session_states WHERE subject_id = ?1",
        [subject_id],
        |r| r.get(0),
    )?;
    assert_eq!(active_days, 2);

    // Sessions cascade-delete with their subject.
    conn.execute("DELETE FROM subjects WHERE id = ?1", [subject_id])?;
    let remaining: i32 = conn.query_row(
        "SELECT COUNT(*) FROM session_states WHERE subject_id = ?1",
        [subject_id],
        |r| r.get(0),
    )?;
    assert_eq!(remaining, 0, "sessions cascade-delete with subject");

    Ok(())
}
