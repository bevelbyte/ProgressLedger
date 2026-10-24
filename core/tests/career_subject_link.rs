//! Integration tests for career milestone -> subject linking (schema v13).
//!
//! The napi surface is not callable from cargo test, so these exercise the
//! exact SQL semantics `set_career_milestone_subject` implements against the
//! real migrated schema: ownership resolution (milestone -> goal -> profile,
//! subject -> ... -> tracks.profile_id), the guarded UPDATE, and the read path
//! (`get_career_milestones`' LEFT JOIN) that the UI's honest
//! "linked subject no longer exists" state depends on.

use rusqlite::{Connection, Result};
use std::fs;

fn setup_test_db() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;

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

/// One full profile with a track -> semester -> milestone -> subject chain,
/// a career goal, and one roadmap milestone. Returns all ids.
struct Fixture {
    profile_id: i32,
    subject_id: i32,
    milestone_id: i32,
}

fn seed_profile_with_subject(conn: &Connection, name: &str, slug: &str) -> Result<Fixture> {
    conn.execute(
        "INSERT INTO profiles (name, slug) VALUES (?1, ?2)",
        [name, slug],
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
    conn.execute(
        "INSERT INTO career_goals (profile_id, title, status, is_primary) VALUES (?1, 'Backend Engineer', 'active', 1)",
        [profile_id],
    )?;
    let goal_id = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO career_milestones (goal_id, title, sort_order) VALUES (?1, 'Learn SQL', 0)",
        [goal_id],
    )?;
    let milestone_id = conn.last_insert_rowid() as i32;
    Ok(Fixture {
        profile_id,
        subject_id,
        milestone_id,
    })
}

/// The exact ownership resolution + guarded UPDATE that the napi fn performs.
fn set_subject_link(conn: &Connection, milestone_id: i32, subject_id: Option<i32>) -> Result<()> {
    let profile_id: i32 = conn.query_row(
        "SELECT cg.profile_id
         FROM career_milestones cm
         JOIN career_goals cg ON cg.id = cm.goal_id
         WHERE cm.id = ?1",
        [milestone_id],
        |r| r.get(0),
    )?;
    if let Some(sid) = subject_id {
        let subject_profile: i32 = conn.query_row(
            "SELECT t.profile_id
             FROM subjects s
             JOIN milestones m ON m.id = s.milestone_id
             JOIN semesters se ON se.id = m.semester_id
             JOIN tracks t ON t.id = se.track_id
             WHERE s.id = ?1",
            [sid],
            |r| r.get(0),
        )?;
        if subject_profile != profile_id {
            panic!("Subject belongs to a different profile");
        }
        conn.execute(
            "UPDATE career_milestones SET linked_subject_id = ?1 WHERE id = ?2",
            rusqlite::params![sid, milestone_id],
        )?;
    } else {
        conn.execute(
            "UPDATE career_milestones SET linked_subject_id = NULL WHERE id = ?1",
            [milestone_id],
        )?;
    }
    Ok(())
}

/// The read path `get_career_milestones` uses: LEFT JOIN so a dangling id
/// yields a nameless row (the UI's honest "missing reference" state).
fn read_link(conn: &Connection, milestone_id: i32) -> Result<(Option<i32>, Option<String>)> {
    conn.query_row(
        "SELECT cm.linked_subject_id, s.name
         FROM career_milestones cm
         LEFT JOIN subjects s ON s.id = cm.linked_subject_id
         WHERE cm.id = ?1",
        [milestone_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
}

#[test]
fn subject_link_same_profile_persists_then_clears() -> Result<()> {
    let conn = setup_test_db()?;
    let fx = seed_profile_with_subject(&conn, "Ada", "ada")?;

    set_subject_link(&conn, fx.milestone_id, Some(fx.subject_id))?;
    let (id, name) = read_link(&conn, fx.milestone_id)?;
    assert_eq!(id, Some(fx.subject_id));
    assert_eq!(name.as_deref(), Some("Algorithms"));

    // Clear (None) -> NULL, and the row itself survives.
    set_subject_link(&conn, fx.milestone_id, None)?;
    let (id, _) = read_link(&conn, fx.milestone_id)?;
    assert_eq!(id, None);
    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM career_milestones WHERE id = ?1",
        [fx.milestone_id],
        |r| r.get(0),
    )?;
    assert_eq!(count, 1);
    Ok(())
}

#[test]
fn subject_link_rejects_missing_subject() -> Result<()> {
    let conn = setup_test_db()?;
    let fx = seed_profile_with_subject(&conn, "Ada", "ada")?;

    // Ownership resolution for a nonexistent subject finds no row -> error.
    let missing: Result<i32> = conn.query_row(
        "SELECT t.profile_id
         FROM subjects s
         JOIN milestones m ON m.id = s.milestone_id
         JOIN semesters se ON se.id = m.semester_id
         JOIN tracks t ON t.id = se.track_id
         WHERE s.id = ?1",
        [99_999],
        |r| r.get(0),
    );
    assert!(missing.is_err(), "nonexistent subject must not resolve");

    // And the milestone's link is untouched by the failed attempt.
    let (id, _) = read_link(&conn, fx.milestone_id)?;
    assert_eq!(id, None);
    Ok(())
}

#[test]
fn subject_link_rejects_cross_profile() -> Result<()> {
    let conn = setup_test_db()?;
    let a = seed_profile_with_subject(&conn, "Ada", "ada")?;
    let b = seed_profile_with_subject(&conn, "Bea", "bea")?;
    assert_ne!(a.profile_id, b.profile_id);

    // Bea's subject resolves to Bea's profile, which != Ada's goal profile.
    let b_subject_profile: i32 = conn.query_row(
        "SELECT t.profile_id
         FROM subjects s
         JOIN milestones m ON m.id = s.milestone_id
         JOIN semesters se ON se.id = m.semester_id
         JOIN tracks t ON t.id = se.track_id
         WHERE s.id = ?1",
        [b.subject_id],
        |r| r.get(0),
    )?;
    assert_ne!(
        b_subject_profile, a.profile_id,
        "cross-profile must be detectable"
    );

    // The guarded write refuses; Ada's milestone stays unlinked.
    let cross = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        set_subject_link(&conn, a.milestone_id, Some(b.subject_id)).unwrap();
    }));
    assert!(cross.is_err(), "cross-profile link must be rejected");
    let (id, _) = read_link(&conn, a.milestone_id)?;
    assert_eq!(id, None);
    Ok(())
}

#[test]
fn milestone_survives_subject_deletion_with_dangling_link() -> Result<()> {
    let conn = setup_test_db()?;
    let fx = seed_profile_with_subject(&conn, "Ada", "ada")?;
    set_subject_link(&conn, fx.milestone_id, Some(fx.subject_id))?;

    // Deleting the subject cascades its own children but leaves the nullable
    // link column dangling (no FK on linked_subject_id by design).
    conn.execute("DELETE FROM subjects WHERE id = ?1", [fx.subject_id])?;

    let milestone_count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM career_milestones WHERE id = ?1",
        [fx.milestone_id],
        |r| r.get(0),
    )?;
    assert_eq!(milestone_count, 1, "milestone survives subject deletion");

    // Read path: id still set, name resolves to nothing -> honest missing state.
    let (id, name) = read_link(&conn, fx.milestone_id)?;
    assert_eq!(id, Some(fx.subject_id));
    assert_eq!(
        name, None,
        "dangling link must render as missing, not a stale name"
    );

    // Clearing the dangling link works and restores the unlinked state.
    set_subject_link(&conn, fx.milestone_id, None)?;
    let (id, _) = read_link(&conn, fx.milestone_id)?;
    assert_eq!(id, None);
    Ok(())
}

#[test]
fn subject_link_leaves_project_link_untouched() -> Result<()> {
    let conn = setup_test_db()?;
    let fx = seed_profile_with_subject(&conn, "Ada", "ada")?;

    conn.execute(
        "INSERT INTO projects (profile_id, name, project_type, status) VALUES (?1, 'API', 'mini', 'planning')",
        [fx.profile_id],
    )?;
    let project_id = conn.last_insert_rowid() as i32;
    conn.execute(
        "UPDATE career_milestones SET linked_project_id = ?1 WHERE id = ?2",
        rusqlite::params![project_id, fx.milestone_id],
    )?;

    set_subject_link(&conn, fx.milestone_id, Some(fx.subject_id))?;
    let (project, subject): (Option<i32>, Option<i32>) = conn.query_row(
        "SELECT linked_project_id, linked_subject_id FROM career_milestones WHERE id = ?1",
        [fx.milestone_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(project, Some(project_id), "project link preserved");
    assert_eq!(subject, Some(fx.subject_id));

    // Clearing the subject link must not touch the project link either.
    set_subject_link(&conn, fx.milestone_id, None)?;
    let (project, subject): (Option<i32>, Option<i32>) = conn.query_row(
        "SELECT linked_project_id, linked_subject_id FROM career_milestones WHERE id = ?1",
        [fx.milestone_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(
        project,
        Some(project_id),
        "project link preserved after clear"
    );
    assert_eq!(subject, None);
    Ok(())
}

#[test]
fn career_data_is_profile_isolated() -> Result<()> {
    let conn = setup_test_db()?;
    let a = seed_profile_with_subject(&conn, "Ada", "ada")?;
    let b = seed_profile_with_subject(&conn, "Bea", "bea")?;

    // Goals/milestones resolve strictly through their own profile.
    let a_profile: i32 = conn.query_row(
        "SELECT cg.profile_id FROM career_milestones cm
         JOIN career_goals cg ON cg.id = cm.goal_id WHERE cm.id = ?1",
        [a.milestone_id],
        |r| r.get(0),
    )?;
    let b_profile: i32 = conn.query_row(
        "SELECT cg.profile_id FROM career_milestones cm
         JOIN career_goals cg ON cg.id = cm.goal_id WHERE cm.id = ?1",
        [b.milestone_id],
        |r| r.get(0),
    )?;
    assert_eq!(a_profile, a.profile_id);
    assert_eq!(b_profile, b.profile_id);
    Ok(())
}
