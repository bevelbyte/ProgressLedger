//! Integration tests for Phase 11 features: Deadline Radar, Mistake Ledger, Recall Deck, Subject Links
//!
//! These tests verify the CRUD operations and business logic for Phase 11 features.

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
fn test_deadline_crud() -> Result<()> {
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

    // Add deadline
    conn.execute(
        "INSERT INTO deadlines (subject_id, deadline_date, category, title, notes) 
         VALUES (?1, '2024-12-31', 'exam', 'Final Exam', 'Study hard')",
        [subject_id],
    )?;
    let deadline_id = conn.last_insert_rowid() as i32;

    // Verify deadline was created
    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM deadlines WHERE id = ?1",
        [deadline_id],
        |row| row.get(0),
    )?;
    assert_eq!(count, 1);

    // Update deadline
    conn.execute(
        "UPDATE deadlines SET title = 'Updated Exam' WHERE id = ?1",
        [deadline_id],
    )?;

    let title: String = conn.query_row(
        "SELECT title FROM deadlines WHERE id = ?1",
        [deadline_id],
        |row| row.get(0),
    )?;
    assert_eq!(title, "Updated Exam");

    // Delete deadline
    conn.execute("DELETE FROM deadlines WHERE id = ?1", [deadline_id])?;

    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM deadlines WHERE id = ?1",
        [deadline_id],
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
fn test_mistake_crud() -> Result<()> {
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

    // Add mistake
    conn.execute(
        "INSERT INTO mistakes (subject_id, question_text, mistake_type, correct_approach, tags) 
         VALUES (?1, 'What is 2+2?', 'calculation', 'Use calculator', 'math,basic')",
        [subject_id],
    )?;
    let mistake_id = conn.last_insert_rowid() as i32;

    // Verify mistake was created
    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM mistakes WHERE id = ?1",
        [mistake_id],
        |row| row.get(0),
    )?;
    assert_eq!(count, 1);

    // Update mistake
    conn.execute(
        "UPDATE mistakes SET correct_approach = 'Mental math' WHERE id = ?1",
        [mistake_id],
    )?;

    let approach: String = conn.query_row(
        "SELECT correct_approach FROM mistakes WHERE id = ?1",
        [mistake_id],
        |row| row.get(0),
    )?;
    assert_eq!(approach, "Mental math");

    // Delete mistake
    conn.execute("DELETE FROM mistakes WHERE id = ?1", [mistake_id])?;

    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM mistakes WHERE id = ?1",
        [mistake_id],
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
fn test_card_crud() -> Result<()> {
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

    // Add card with default SM-2 values
    conn.execute(
        "INSERT INTO cards (subject_id, front, back, ease_factor, interval_days, repetitions, due_date) 
         VALUES (?1, 'Question', 'Answer', 2.5, 0, 0, '2024-01-01')",
        [subject_id],
    )?;
    let card_id = conn.last_insert_rowid() as i32;

    // Verify card was created with correct defaults
    let ef: f64 = conn.query_row(
        "SELECT ease_factor FROM cards WHERE id = ?1",
        [card_id],
        |row| row.get(0),
    )?;
    assert_eq!(ef, 2.5);

    let interval: i32 = conn.query_row(
        "SELECT interval_days FROM cards WHERE id = ?1",
        [card_id],
        |row| row.get(0),
    )?;
    assert_eq!(interval, 0);

    // Update card
    conn.execute(
        "UPDATE cards SET front = 'Updated Question', back = 'Updated Answer' WHERE id = ?1",
        [card_id],
    )?;

    let front: String =
        conn.query_row("SELECT front FROM cards WHERE id = ?1", [card_id], |row| {
            row.get(0)
        })?;
    assert_eq!(front, "Updated Question");

    // Delete card
    conn.execute("DELETE FROM cards WHERE id = ?1", [card_id])?;

    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM cards WHERE id = ?1",
        [card_id],
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
fn test_subject_links_crud() -> Result<()> {
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

    // Add subject link
    conn.execute(
        "INSERT INTO subject_links (subject_id, label, url, is_primary) 
         VALUES (?1, 'Wikipedia', 'https://wikipedia.org', 0)",
        [subject_id],
    )?;
    let link_id = conn.last_insert_rowid() as i32;

    // Verify link was created
    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM subject_links WHERE id = ?1",
        [link_id],
        |row| row.get(0),
    )?;
    assert_eq!(count, 1);

    // Set as primary
    conn.execute(
        "UPDATE subject_links SET is_primary = 1 WHERE id = ?1",
        [link_id],
    )?;

    let is_primary: i32 = conn.query_row(
        "SELECT is_primary FROM subject_links WHERE id = ?1",
        [link_id],
        |row| row.get(0),
    )?;
    assert_eq!(is_primary, 1);

    // Delete link
    conn.execute("DELETE FROM subject_links WHERE id = ?1", [link_id])?;

    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM subject_links WHERE id = ?1",
        [link_id],
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
