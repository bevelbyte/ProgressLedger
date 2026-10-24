//! Integration tests for migration 018 (parent_agent_id column).
//!
//! Mirrors the SQL in `core/src/db/project_mode.rs` (napi fns aren't callable
//! here). Covers the parent→child link, survival through pm_update_agent,
//! FK ON DELETE SET NULL, and cross-project rejection.

use rusqlite::{params, Connection};

const M001: &str = include_str!("../migrations/001_initial.sql");
const M002: &str = include_str!("../migrations/002_attachments.sql");
const M003: &str = include_str!("../migrations/003_phase11_revision.sql");
const M004: &str = include_str!("../migrations/004_phase12_13.sql");
const M005: &str = include_str!("../migrations/005_data_constraints.sql");
const M006: &str = include_str!("../migrations/006_performance_indexes.sql");
const M007: &str = include_str!("../migrations/007_add_subject_codes.sql");
const M008: &str = include_str!("../migrations/008_cgpa_marks_and_scales.sql");
const M009: &str = include_str!("../migrations/009_semester_status.sql");
const M010: &str = include_str!("../migrations/010_deadline_completion.sql");
const M011: &str = include_str!("../migrations/011_career_planning.sql");
const M012: &str = include_str!("../migrations/012_career_milestone_project_link.sql");
const M013: &str = include_str!("../migrations/013_career_milestone_subject_link.sql");
const M014: &str = include_str!("../migrations/014_courses_subject_id.sql");
const M015: &str = include_str!("../migrations/015_browser_manager.sql");
const M016: &str = include_str!("../migrations/016_browser_shortcuts_pinned.sql");
const M017: &str = include_str!("../migrations/017_project_mode.sql");
const M018: &str = include_str!("../migrations/018_pm_parent_agent.sql");

/// Fresh in-memory DB with all 18 migrations applied (mirrors migrations::run).
fn fresh() -> Connection {
    let conn = Connection::open_in_memory().expect("open");
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    for (ver, sql) in [
        (1, M001),
        (2, M002),
        (3, M003),
        (4, M004),
        (5, M005),
        (6, M006),
        (7, M007),
        (8, M008),
        (9, M009),
        (10, M010),
        (11, M011),
        (12, M012),
        (13, M013),
        (14, M014),
        (15, M015),
        (16, M016),
        (17, M017),
        (18, M018),
    ] {
        let cur: i32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        if ver > cur {
            conn.execute_batch(&format!(
                "BEGIN;\n{sql}\nPRAGMA user_version = {ver};\nCOMMIT;"
            ))
            .unwrap();
        }
    }
    assert_eq!(
        18,
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i32>(0))
            .unwrap()
    );
    conn
}

/// Seed: profile A owns pm_project_a; profile B owns pm_project_b. Returns
/// (profile_a, profile_b, project_a, project_b).
fn seed_two_profiles(conn: &Connection) -> (i32, i32, i32, i32) {
    conn.execute("INSERT INTO profiles(name,slug) VALUES('A','a')", [])
        .unwrap();
    let pa = conn.last_insert_rowid() as i32;
    conn.execute("INSERT INTO profiles(name,slug) VALUES('B','b')", [])
        .unwrap();
    let pb = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO pm_projects(profile_id,name,root_path) VALUES(?1,'Pa','/tmp/pa')",
        params![pa],
    )
    .unwrap();
    let pja = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO pm_projects(profile_id,name,root_path) VALUES(?1,'Pb','/tmp/pb')",
        params![pb],
    )
    .unwrap();
    let pjb = conn.last_insert_rowid() as i32;
    (pa, pb, pja, pjb)
}

/// Helper that mirrors `pm_create_agent` with the parent_agent_id column:
/// returns NOT_OWNED if parent isn't in the same project.
fn create_agent_in_project(
    conn: &Connection,
    project_id: i32,
    objective: &str,
    parent_agent_id: Option<i32>,
) -> Result<i32, String> {
    let proj_count: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM pm_projects WHERE id = ?1",
            params![project_id],
            |r| r.get(0),
        )
        .unwrap();
    if proj_count == 0 {
        return Err("Project does not exist".into());
    }
    if let Some(pid) = parent_agent_id {
        let n: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM pm_agents WHERE id = ?1 AND project_id = ?2",
                params![pid, project_id],
                |r| r.get(0),
            )
            .unwrap();
        if n == 0 {
            return Err("Parent agent not found in this project".into());
        }
    }
    conn.execute(
        "INSERT INTO pm_agents (project_id, objective, parent_agent_id) VALUES (?1, ?2, ?3)",
        params![project_id, objective, parent_agent_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid() as i32)
}

#[test]
fn parent_agent_id_column_exists_and_indexes_parent() {
    let conn = fresh();
    // Column exists and defaults to NULL.
    let (pa, _, pja, _) = seed_two_profiles(&conn);
    let id = create_agent_in_project(&conn, pja, "root", None).unwrap();
    let parent: Option<i32> = conn
        .query_row(
            "SELECT parent_agent_id FROM pm_agents WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(parent.is_none(), "new agents default to NULL parent");

    // Index exists.
    let idx_count: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_pm_agents_parent'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(idx_count, 1, "idx_pm_agents_parent must exist");

    // Sanity: column is reachable in pm_get_agent-style SELECT.
    let _: (i32, Option<i32>) = conn
        .query_row(
            "SELECT id, parent_agent_id FROM pm_agents WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let _ = pa;
}

#[test]
fn set_parent_and_list_children_roundtrip() {
    let conn = fresh();
    let (_pa, _pb, pja, _pjb) = seed_two_profiles(&conn);
    // Parent + two children in project A.
    let parent = create_agent_in_project(&conn, pja, "root", None).unwrap();
    let c1 = create_agent_in_project(&conn, pja, "child 1", Some(parent)).unwrap();
    let c2 = create_agent_in_project(&conn, pja, "child 2", Some(parent)).unwrap();

    // pm_get_children-style query: list children of `parent`.
    let mut stmt = conn
        .prepare(
            "SELECT a.id, a.parent_agent_id FROM pm_agents a
             JOIN pm_projects p ON p.id = a.project_id
             WHERE a.parent_agent_id = ?1 AND p.profile_id = ?2
             ORDER BY a.created_at DESC, a.id DESC",
        )
        .unwrap();
    let rows: Vec<(i32, Option<i32>)> = stmt
        .query_map(params![parent, _pa], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert_eq!(rows.len(), 2);
    let ids: Vec<i32> = rows.iter().map(|(id, _)| *id).collect();
    assert!(ids.contains(&c1));
    assert!(ids.contains(&c2));
    for (_, p) in &rows {
        assert_eq!(*p, Some(parent));
    }
}

#[test]
fn parent_link_survives_pm_update_agent() {
    let conn = fresh();
    let (_pa, _pb, pja, _pjb) = seed_two_profiles(&conn);
    let parent = create_agent_in_project(&conn, pja, "root", None).unwrap();
    let child = create_agent_in_project(&conn, pja, "child", Some(parent)).unwrap();

    // Mirror pm_update_agent: rewrite state + plan_json + tokens. The
    // parent_agent_id column must NOT be touched.
    conn.execute(
        "UPDATE pm_agents
         SET state = ?2, plan_json = ?3, tokens_in = ?4, tokens_out = ?5,
             updated_at = datetime('now','localtime')
         WHERE id = ?1",
        params![child, "executing_tool", "[]", 100, 200],
    )
    .unwrap();

    // Parent link is intact.
    let p: Option<i32> = conn
        .query_row(
            "SELECT parent_agent_id FROM pm_agents WHERE id = ?1",
            params![child],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(p, Some(parent), "parent_agent_id survives pm_update_agent");
}

#[test]
fn deleting_parent_sets_child_parent_to_null() {
    let conn = fresh();
    let (_pa, _pb, pja, _pjb) = seed_two_profiles(&conn);
    let parent = create_agent_in_project(&conn, pja, "root", None).unwrap();
    let child = create_agent_in_project(&conn, pja, "child", Some(parent)).unwrap();

    // The schema uses ON DELETE SET NULL, so deleting the parent row
    // must NOT cascade-delete the child (the child still has its own
    // project_id row, and we want history preserved).
    conn.execute("DELETE FROM pm_agents WHERE id = ?1", params![parent])
        .unwrap();
    let still: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM pm_agents WHERE id = ?1",
            params![child],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(still, 1, "child is NOT cascade-deleted with parent");
    let p: Option<i32> = conn
        .query_row(
            "SELECT parent_agent_id FROM pm_agents WHERE id = ?1",
            params![child],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        p.is_none(),
        "child.parent_agent_id is auto-cleared to NULL via ON DELETE SET NULL"
    );
}

#[test]
fn setting_parent_to_foreign_project_is_refused() {
    let conn = fresh();
    let (_pa, pb, _pja, pjb) = seed_two_profiles(&conn);
    let parent_a = create_agent_in_project(&conn, _pja, "root in A", None).unwrap();

    // Try to attach a child in project B with parent from project A.
    let res = create_agent_in_project(&conn, pjb, "child in B", Some(parent_a));
    assert!(res.is_err(), "cross-project parent must be refused");
    assert!(
        res.as_ref()
            .err()
            .unwrap()
            .contains("Parent agent not found in this project"),
        "expected ownership error, got: {res:?}"
    );

    // Try the cross-project check via the SQL the pm_set_parent path
    // uses: the parent isn't in the same project as the child.
    let n: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM pm_agents WHERE id = ?1 AND project_id = ?2",
            params![parent_a, pjb],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0, "parent in project A is not visible from project B");

    let _ = pb;
}

#[test]
fn profile_isolation_of_pm_get_children() {
    let conn = fresh();
    let (pa, pb, pja, pjb) = seed_two_profiles(&conn);
    // Parent in A; child in A.
    let parent_a = create_agent_in_project(&conn, pja, "root in A", None).unwrap();
    let _child_a = create_agent_in_project(&conn, pja, "child in A", Some(parent_a)).unwrap();
    // Unrelated agent in B — must NOT appear when querying children of
    // parent_a from profile B.
    let _stranger = create_agent_in_project(&conn, pjb, "stranger in B", None).unwrap();

    // Profile A sees 1 child.
    let n_a: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM pm_agents a
             JOIN pm_projects p ON p.id = a.project_id
             WHERE a.parent_agent_id = ?1 AND p.profile_id = ?2",
            params![parent_a, pa],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n_a, 1);

    // Profile B sees 0 children of parent_a.
    let n_b: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM pm_agents a
             JOIN pm_projects p ON p.id = a.project_id
             WHERE a.parent_agent_id = ?1 AND p.profile_id = ?2",
            params![parent_a, pb],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n_b, 0, "profile B must not see profile A's children");
}

#[test]
fn clear_parent_with_pm_set_parent_zero() {
    let conn = fresh();
    let (_pa, _pb, pja, _pjb) = seed_two_profiles(&conn);
    let parent = create_agent_in_project(&conn, pja, "root", None).unwrap();
    let child = create_agent_in_project(&conn, pja, "child", Some(parent)).unwrap();

    // Mirror pm_set_parent(agent_id, parent_agent_id=0): clear the link.
    conn.execute(
        "UPDATE pm_agents
         SET parent_agent_id = NULL, updated_at = datetime('now','localtime')
         WHERE id = ?1
           AND project_id IN (SELECT id FROM pm_projects WHERE profile_id = ?2)",
        params![child, _pa],
    )
    .unwrap();

    let p: Option<i32> = conn
        .query_row(
            "SELECT parent_agent_id FROM pm_agents WHERE id = ?1",
            params![child],
            |r| r.get(0),
        )
        .unwrap();
    assert!(p.is_none(), "pm_set_parent(_, 0) clears the link");
}

#[test]
fn parent_cycle_is_rejected() {
    let conn = fresh();
    let (_pa, _pb, pja, _pjb) = seed_two_profiles(&conn);
    let root = create_agent_in_project(&conn, pja, "root", None).unwrap();
    let child = create_agent_in_project(&conn, pja, "child", Some(root)).unwrap();

    // A self-parent is a cycle and must be rejected.
    let self_cycle: i32 = conn
        .query_row(
            "WITH RECURSIVE descendants(id) AS (
                 SELECT ?1
                 UNION
                 SELECT a.id FROM pm_agents a JOIN descendants d ON a.parent_agent_id = d.id
             )
             SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?2)",
            params![child, child],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(self_cycle, 1);

    // The proposed root->child link would make root a descendant of itself.
    let longer_cycle: i32 = conn
        .query_row(
            "WITH RECURSIVE descendants(id) AS (
                 SELECT ?1
                 UNION
                 SELECT a.id FROM pm_agents a JOIN descendants d ON a.parent_agent_id = d.id
             )
             SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?2)",
            params![root, child],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(longer_cycle, 1);
}

#[test]
fn pm_insert_subagent_run_proves_child_ownership_before_persisting_reference() {
    // child_agent_id is nullable and intentionally has no FK in migration 019.
    // The API must therefore prove the child is in the parent's same project
    // and profile before persisting telemetry that references it.
    let src = std::fs::read_to_string("src/db/project_mode.rs").expect("read project mode implementation");
    let start = src.find("pub fn pm_insert_subagent_run").expect("insert API exists");
    let body = &src[start..];
    let child_check = body.find("if let Some(child_id) = child_agent_id").expect("child ownership check exists");
    let insert = body.find("INSERT INTO subagent_runs").expect("telemetry insert exists");
    assert!(child_check < insert, "child ownership must be checked before telemetry persistence");
    assert!(body[child_check..insert].contains("child.id = ?1"));
    assert!(body[child_check..insert].contains("parent.id = ?2"));
    assert!(body[child_check..insert].contains("cp.profile_id = ?3"));
}
