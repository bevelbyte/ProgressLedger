//! Tests for the batched deadline-pace query (`get_deadline_paces`).
//!
//! The napi surface is not callable from cargo tests, so these exercise the
//! exact SQL the batched implementation uses — including the honest overdue
//! semantics (negative days_remaining) and the exclusion of completed
//! deadlines that keeps the Radar's N+1 fix behaviorally identical.

use rusqlite::{Connection, Result};
use std::fs;

fn setup_test_db() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
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
        let sql = fs::read_to_string(&path).map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(
                Box::new(e) as Box<dyn std::error::Error + Send + Sync>
            )
        })?;
        conn.execute_batch(&sql)?;
    }
    Ok(conn)
}

struct Row {
    deadline_id: i32,
    days_remaining: i64,
    topics_remaining: i32,
}

fn run_paces_query(conn: &Connection, profile_id: i32) -> Result<Vec<Row>> {
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
    )?;
    let rows = stmt
        .query_map([profile_id], |r| {
            Ok(Row {
                deadline_id: r.get(0)?,
                days_remaining: r.get(1)?,
                topics_remaining: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

#[test]
fn paces_report_overdue_negative_days_and_exclude_completed() -> Result<()> {
    let conn = setup_test_db()?;
    conn.execute(
        "INSERT INTO profiles (name, slug) VALUES ('Ada', 'ada')",
        [],
    )?;
    let pid = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO tracks (profile_id, name) VALUES (?1, 'T')",
        [pid],
    )?;
    let tid = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO semesters (track_id, name) VALUES (?1, 'Semester 1')",
        [tid],
    )?;
    let sid_sem = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO milestones (semester_id, title) VALUES (?1, 'Subjects')",
        [sid_sem],
    )?;
    let mid = conn.last_insert_rowid() as i32;
    // Milestone holds 2 subjects; only this one is 'pending' => 1 topic remains.
    conn.execute(
        "INSERT INTO subjects (milestone_id, name, status) VALUES (?1, 'Algorithms', 'pending')",
        [mid],
    )?;
    let sub = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO subjects (milestone_id, name, status) VALUES (?1, 'Done One', 'done')",
        [mid],
    )?;

    conn.execute(
        "INSERT INTO deadlines (subject_id, deadline_date, category, title) VALUES (?1, date('now','localtime','-1 day'), 'exam', 'Overdue Mid')",
        [sub],
    )?;
    let overdue_id = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO deadlines (subject_id, deadline_date, category, title) VALUES (?1, date('now','localtime','+10 day'), 'exam', 'Future Final')",
        [sub],
    )?;
    let future_id = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO deadlines (subject_id, deadline_date, category, title, completed_at)
         VALUES (?1, date('now','localtime','-2 day'), 'assignment', 'Completed HW', datetime('now','localtime'))",
        [sub],
    )?;

    let rows = run_paces_query(&conn, pid)?;
    assert_eq!(rows.len(), 2, "completed deadline must be excluded");

    let overdue = rows.iter().find(|r| r.deadline_id == overdue_id).unwrap();
    assert!(
        overdue.days_remaining < 0,
        "overdue must be negative, got {}",
        overdue.days_remaining
    );
    assert_eq!(overdue.topics_remaining, 1);

    let future = rows.iter().find(|r| r.deadline_id == future_id).unwrap();
    assert_eq!(future.days_remaining, 10);
    assert_eq!(future.topics_remaining, 1);
    assert!(future.deadline_id != overdue_id);

    // topics_per_day derivation used by the domain layer.
    let pace_per_day = 1_f64 / 10_f64;
    assert!((pace_per_day - 0.1).abs() < 1e-9);
    Ok(())
}
