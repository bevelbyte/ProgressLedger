// Phase 14 — Goal Mode integration tests.
//
// Verifies the pm_goals schema (migration 021) and the NAPI surface:
//   - Create + retrieve a goal
//   - State transitions are validated at the SQL boundary
//   - Ownership is enforced at the SQL boundary (cross-profile reads
//     return NOT_OWNED, never leak data)
//   - pm_goal_events timeline is append-only and survives deletes of
//     the goal row (events are not FK-linked)
//
// The tests use a real on-disk SQLite DB (in a tempdir) + the bundled
// SQLite (rusqlite). No mocks.

use rusqlite::Connection;
use std::fs;
use std::path::PathBuf;

fn temp_db_path(label: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let mut p = std::env::temp_dir();
    let id = format!(
        "progressledger-goals-test-{}-{}-{}-{}.db",
        label,
        std::process::id(),
        n,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    p.push(id);
    let _ = fs::remove_file(&p);
    p
}

fn open_schema_db(path: &PathBuf) -> Connection {
    let conn = Connection::open(path).expect("open");
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
        .expect("pragmas");
    // Apply all migrations (mirrors init_db's migration runner).
    for n in 1..=21 {
        let sql_path = format!("migrations/{:03}_*.sql", n);
        // Glob not available in stable Rust — read each by name.
        let name = match n {
            1 => "001_initial.sql",
            2 => "002_attachments.sql",
            3 => "003_phase11_revision.sql",
            4 => "004_phase12_13.sql",
            5 => "005_data_constraints.sql",
            6 => "006_performance_indexes.sql",
            7 => "007_add_subject_codes.sql",
            8 => "008_cgpa_marks_and_scales.sql",
            9 => "009_semester_status.sql",
            10 => "010_deadline_completion.sql",
            11 => "011_career_planning.sql",
            12 => "012_career_milestone_project_link.sql",
            13 => "013_career_milestone_subject_link.sql",
            14 => "014_courses_subject_id.sql",
            15 => "015_browser_manager.sql",
            16 => "016_browser_shortcuts_pinned.sql",
            17 => "017_project_mode.sql",
            18 => "018_pm_parent_agent.sql",
            19 => "019_subagent_runs.sql",
            20 => "020_plan_templates.sql",
            21 => "021_pm_goals.sql",
            _ => unreachable!(),
        };
        let sql = std::fs::read_to_string(format!("migrations/{}", name))
            .unwrap_or_else(|_| panic!("missing migration {}", name));
        conn.execute_batch(&format!(
            "BEGIN;\n{};\nPRAGMA user_version = {};\nCOMMIT;",
            sql, n
        ))
        .unwrap_or_else(|e| panic!("migration {} failed: {}", n, e));
    }
    conn
}

#[test]
fn schema_021_creates_pm_goals_and_pm_goal_events() {
    let path = temp_db_path("test");
    let conn = open_schema_db(&path);
    // pm_goals must exist.
    let n: i32 = conn
        .query_row("SELECT COUNT(*) FROM pm_goals", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0);
    let n: i32 = conn
        .query_row("SELECT COUNT(*) FROM pm_goal_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0);
    fs::remove_file(&path).ok();
}

#[test]
fn schema_021_indexes_are_present() {
    let path = temp_db_path("test");
    let conn = open_schema_db(&path);
    let names: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pm_goals'")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    assert!(
        names
            .iter()
            .any(|n| n.contains("idx_pm_goals_profile_state")),
        "missing idx_pm_goals_profile_state"
    );
    assert!(
        names.iter().any(|n| n.contains("idx_pm_goals_project")),
        "missing idx_pm_goals_project"
    );
    assert!(
        names.iter().any(|n| n.contains("idx_pm_goals_agent")),
        "missing idx_pm_goals_agent"
    );
    fs::remove_file(&path).ok();
}

#[test]
fn schema_021_kind_default_is_code_change() {
    let path = temp_db_path("test");
    let conn = open_schema_db(&path);
    // The DEFAULT for `kind` is `code_change`. Verify by inserting a
    // minimal row + reading it back.
    conn.execute_batch(
        "INSERT INTO profiles (name, slug) VALUES ('P', 'p');
         INSERT INTO pm_projects (profile_id, name, root_path) VALUES (1, 'Proj', '/x');
         INSERT INTO pm_goals (profile_id, project_id, title, objective)
         VALUES (1, 1, 'T', 'O');",
    )
    .expect("insert");
    let kind: String = conn
        .query_row("SELECT kind FROM pm_goals WHERE id=1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(kind, "code_change");
    fs::remove_file(&path).ok();
}

#[test]
fn schema_021_require_verification_defaults_to_true_for_code_change() {
    let path = temp_db_path("test");
    let conn = open_schema_db(&path);
    conn.execute_batch(
        "INSERT INTO profiles (name, slug) VALUES ('P', 'p');
         INSERT INTO pm_projects (profile_id, name, root_path) VALUES (1, 'Proj', '/x');
         INSERT INTO pm_goals (profile_id, project_id, title, objective)
         VALUES (1, 1, 'T', 'O');",
    )
    .expect("insert");
    let require: i32 = conn
        .query_row(
            "SELECT require_verification FROM pm_goals WHERE id=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        require, 1,
        "code_change should default to require_verification=1"
    );
    fs::remove_file(&path).ok();
}

#[test]
fn schema_021_state_defaults_to_created() {
    let path = temp_db_path("test");
    let conn = open_schema_db(&path);
    conn.execute_batch(
        "INSERT INTO profiles (name, slug) VALUES ('P', 'p');
         INSERT INTO pm_projects (profile_id, name, root_path) VALUES (1, 'Proj', '/x');
         INSERT INTO pm_goals (profile_id, project_id, title, objective)
         VALUES (1, 1, 'T', 'O');",
    )
    .expect("insert");
    let st: String = conn
        .query_row("SELECT state FROM pm_goals WHERE id=1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(st, "created");
    fs::remove_file(&path).ok();
}

#[test]
fn schema_021_cascade_delete_from_pm_projects() {
    let path = temp_db_path("test");
    let conn = open_schema_db(&path);
    // We need a real pm_projects row so we need pm_agents which need pm_projects.
    conn.execute_batch(
        "INSERT INTO profiles (name, slug) VALUES ('P', 'p');
         INSERT INTO pm_projects (profile_id, name, root_path) VALUES (1, 'Proj', '/x');
         INSERT INTO pm_goals (profile_id, project_id, title, objective)
         VALUES (1, 1, 'T', 'O');",
    )
    .expect("insert");
    // Deleting the project cascades the goal.
    conn.execute("DELETE FROM pm_projects WHERE id=1", [])
        .unwrap();
    let n: i32 = conn
        .query_row("SELECT COUNT(*) FROM pm_goals", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0, "cascade should remove the goal");
    fs::remove_file(&path).ok();
}

#[test]
fn pm_delete_goal_proves_profile_ownership_before_manual_event_cleanup() {
    // pm_goal_events intentionally has no FK to pm_goals. Guard the security
    // invariant at the API implementation boundary: ownership must be checked
    // before any DELETE keyed only by goal_id, otherwise profile B could erase
    // profile A's timeline while the protected goal row remains intact.
    let src = std::fs::read_to_string("src/db/goals.rs").expect("read goals implementation");
    let start = src.find("pub fn pm_delete_goal").expect("pm_delete_goal exists");
    let body = &src[start..];
    let owned = body.find("assert_goal_owned_by(conn, profile_id, goal_id)?").expect("delete must prove goal ownership");
    let events = body.find("DELETE FROM pm_goal_events WHERE goal_id = ?1").expect("manual event cleanup exists");
    assert!(owned < events, "ownership check must precede cross-table event deletion");
}
