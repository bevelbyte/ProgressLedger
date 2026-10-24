//! Cross-profile ownership for academic profile-scoped reads and mutations.
//! These tests call the exact NAPI functions exposed to the shell against a
//! real migrated database. No SQL model is duplicated here.

use progress_ledger_core::db::{
    add_deadline, add_experiment, add_formula, add_mistake, add_profile, add_subject_link,
    calculate_deadline_pace, delete_deadline, delete_experiment, delete_formula, delete_mistake,
    delete_subject_link, get_deadline_paces, get_deadlines, get_experiments, get_formulas,
    get_mistakes, get_subject_links, init_db, set_deadline_completion, set_primary_link,
    update_deadline, update_experiment, update_formula, update_mistake, update_subject_link,
};
use rusqlite::{Connection, Result};
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

static DB_SEQ: AtomicU64 = AtomicU64::new(0);
static TEST_LOCK: Mutex<()> = Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn fresh_db() -> String {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let n = DB_SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "cf-academic-ownership-{}-{}-{}",
        std::process::id(),
        nonce,
        n
    ));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("test.sqlite");
    init_db(path.to_string_lossy().to_string()).unwrap();
    path.to_string_lossy().to_string()
}

struct Fixture {
    subject_id: i32,
    milestone_id: i32,
}

fn seed_profile(conn: &Connection, profile_id: i32) -> Fixture {
    conn.execute(
        "INSERT INTO tracks (profile_id, name) VALUES (?1, 'Track')",
        [profile_id],
    )
    .unwrap();
    let track_id = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO semesters (track_id, name) VALUES (?1, 'Sem 1')",
        [track_id],
    )
    .unwrap();
    let semester_id = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO milestones (semester_id, title) VALUES (?1, 'Subjects')",
        [semester_id],
    )
    .unwrap();
    let milestone_id = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO subjects (milestone_id, name) VALUES (?1, 'Algorithms')",
        [milestone_id],
    )
    .unwrap();
    Fixture {
        subject_id: conn.last_insert_rowid() as i32,
        milestone_id,
    }
}

fn count(conn: &Connection, table: &str) -> i32 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

#[test]
fn profile_scoped_academic_reads_and_mutations_reject_foreign_resources() -> Result<()> {
    let _serial = serial();
    let db_path = fresh_db();
    let a = add_profile("Owner A".into(), "owner-a".into()).unwrap().id;
    let b = add_profile("Owner B".into(), "owner-b".into()).unwrap().id;
    let conn = Connection::open(&db_path)?;
    let fa = seed_profile(&conn, a);
    let fb = seed_profile(&conn, b);
    drop(conn);

    let mistake = add_mistake(
        b,
        fb.subject_id,
        "B question".into(),
        "conceptual".into(),
        "B fix".into(),
        "".into(),
    )
    .unwrap();
    let formula = add_formula(b, fb.subject_id, "B formula".into(), "x^2".into(), None).unwrap();
    let experiment = add_experiment(b, fb.subject_id, 1, "B lab".into()).unwrap();
    let link = add_subject_link(
        b,
        fb.subject_id,
        "B link".into(),
        "https://b.example".into(),
    )
    .unwrap();
    let deadline = add_deadline(
        b,
        fb.subject_id,
        "2030-01-01".into(),
        "exam".into(),
        "B deadline".into(),
        None,
    )
    .unwrap();

    assert!(get_mistakes(a, Some(fb.subject_id), None, None)
        .unwrap()
        .is_empty());
    assert_eq!(
        get_mistakes(b, Some(fb.subject_id), None, None)
            .unwrap()
            .len(),
        1
    );
    assert!(get_formulas(a, Some(fb.subject_id), None)
        .unwrap()
        .is_empty());
    assert_eq!(get_formulas(b, Some(fb.subject_id), None).unwrap().len(), 1);
    assert!(get_experiments(a, fb.subject_id).unwrap().is_empty());
    assert_eq!(get_experiments(b, fb.subject_id).unwrap().len(), 1);
    assert!(get_subject_links(a, fb.subject_id).unwrap().is_empty());
    assert_eq!(get_subject_links(b, fb.subject_id).unwrap().len(), 1);
    assert!(get_deadlines(a).unwrap().is_empty());
    assert_eq!(get_deadlines(b).unwrap().len(), 1);
    assert!(get_deadline_paces(a).unwrap().is_empty());
    assert_eq!(get_deadline_paces(b).unwrap().len(), 1);
    assert!(calculate_deadline_pace(a, deadline).is_err());
    assert!(calculate_deadline_pace(b, deadline).is_ok());

    assert!(add_mistake(
        a,
        fb.subject_id,
        "x".into(),
        "conceptual".into(),
        "x".into(),
        "".into()
    )
    .is_err());
    assert!(add_formula(a, fb.subject_id, "x".into(), "x".into(), None).is_err());
    assert!(add_experiment(a, fb.subject_id, 2, "x".into()).is_err());
    assert!(add_subject_link(a, fb.subject_id, "x".into(), "https://x.example".into()).is_err());
    assert!(add_deadline(
        a,
        fb.subject_id,
        "2030-01-01".into(),
        "exam".into(),
        "x".into(),
        None
    )
    .is_err());

    assert!(update_mistake(
        a,
        mistake,
        "x".into(),
        "calculation".into(),
        "x".into(),
        "".into()
    )
    .is_err());
    assert!(update_formula(a, formula, "x".into(), "x".into(), None).is_err());
    assert!(update_experiment(
        a,
        experiment,
        "x".into(),
        true,
        true,
        Some("10".into()),
        None
    )
    .is_err());
    assert!(update_subject_link(a, link, "x".into(), "https://x.example".into()).is_err());
    assert!(update_deadline(
        a,
        deadline,
        "2030-02-01".into(),
        "exam".into(),
        "x".into(),
        None
    )
    .is_err());
    assert!(set_deadline_completion(a, deadline, true).is_err());
    assert!(set_primary_link(a, fb.subject_id, link).is_err());
    assert!(delete_mistake(a, mistake).is_err());
    assert!(delete_formula(a, formula).is_err());
    assert!(delete_experiment(a, experiment).is_err());
    assert!(delete_subject_link(a, link).is_err());
    assert!(delete_deadline(a, deadline).is_err());

    let conn = Connection::open(&db_path)?;
    assert_eq!(count(&conn, "mistakes"), 1);
    assert_eq!(count(&conn, "formulas"), 1);
    assert_eq!(count(&conn, "lab_experiments"), 1);
    assert_eq!(count(&conn, "subject_links"), 1);
    assert_eq!(count(&conn, "deadlines"), 1);
    assert!(fa.subject_id != fb.subject_id && fa.milestone_id != fb.milestone_id);
    Ok(())
}
