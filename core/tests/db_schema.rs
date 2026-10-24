//! Integration tests for the CareerFlow schema+ migration SQL.
//!
//! WHY here and not `#[cfg(test)] mod tests` in db.rs:
//! `careerflow_core` is a `cdylib` napi-rs addon. A unit-test executable built
//! from it would need the N-API runtime symbols (provided by node.exe at load),
//! which aren't present when linking a plain test binary — so `cargo test` on the
//! lib itself fails to link. This integration test depends ONLY on `rusqlite`
//! (a dev-dependency) and applies the EXACT migration SQL shipped in
//! `core/migrations/`, so it validates the real schema + query contracts and
//! `cargo test` links and runs green.

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
const M019: &str = include_str!("../migrations/019_subagent_runs.sql");
const M020: &str = include_str!("../migrations/020_plan_templates.sql");
const M021: &str = include_str!("../migrations/021_pm_goals.sql");
const M022: &str = include_str!("../migrations/022_pm_run_state.sql");
const M023: &str = include_str!("../migrations/023_focus_signal_recency.sql");
const M024: &str = include_str!("../migrations/024_research_sources_captures.sql");

/// Fresh in-memory DB with all migrations applied (mirrors migrations::run).
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
        (19, M019),
        (20, M020),
        (21, M021),
        (22, M022),
        (23, M023),
        (24, M024),
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
        24,
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i32>(0))
            .unwrap()
    );
    conn
}

/// Seed a profile with one full Track→Semester→Milestone→Subject→Note chain.
/// Returns (profile_id, track_id, subject_id).
fn seed(conn: &Connection, name: &str, slug: &str, status: &str) -> (i32, i32, i32) {
    conn.execute(
        "INSERT INTO profiles(name,slug) VALUES(?1,?2)",
        params![name, slug],
    )
    .unwrap();
    let pid = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO tracks(profile_id,name) VALUES(?1,'CS BSc')",
        params![pid],
    )
    .unwrap();
    let tid = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO semesters(track_id,name) VALUES(?1,'Fall')",
        params![tid],
    )
    .unwrap();
    let sid = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO milestones(semester_id,title) VALUES(?1,'Core')",
        params![sid],
    )
    .unwrap();
    let mid = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO subjects(milestone_id,name,status) VALUES(?1,'Algorithms',?2)",
        params![mid, status],
    )
    .unwrap();
    let subj = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO resources(subject_id,kind,title,content) VALUES(?1,'note','Big-O','master theorem dynamic programming')",
        params![subj],
    ).unwrap();
    (pid, tid, subj)
}

fn count(conn: &Connection, table: &str) -> i32 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

#[test]
fn migrations_are_idempotent_and_reach_latest_schema() {
    let conn = fresh();
    // Running again applies nothing and keeps the version.
    let cur: i32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(cur, 24);
    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(resources)")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .map(|c| c.unwrap())
        .collect();
    for c in ["rel_path", "orig_path", "byte_size"] {
        assert!(cols.contains(&c.to_string()), "missing column {c}");
    }
    // Phase 11 tables should exist
    let phase11_tables = ["deadlines", "mistakes", "cards", "subject_links"];
    for table in phase11_tables {
        let count: i32 = conn
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='{}'",
                    table
                ),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "Phase 11 table {} should exist", table);
    }
}

#[test]
fn research_sources_and_captures_are_profile_scoped_deduplicated_and_cascaded() {
    let conn = fresh();
    let (profile_id, _, _) = seed(&conn, "Research A", "research-a", "in_progress");
    conn.execute(
        "INSERT INTO research_sources(profile_id,canonical_url,url,title,domain) VALUES(?1,?2,?2,?3,?4)",
        params![profile_id, "https://example.com/article", "Example article", "example.com"],
    ).unwrap();
    let source_id = conn.last_insert_rowid();
    assert!(conn.execute(
        "INSERT INTO research_sources(profile_id,canonical_url,url,title,domain) VALUES(?1,?2,?2,?3,?4)",
        params![profile_id, "https://example.com/article", "Duplicate", "example.com"],
    ).is_err(), "database uniqueness must prevent duplicate canonical sources");
    conn.execute(
        "INSERT INTO research_captures(profile_id,source_id,source_url,source_title,page_id,kind,text) VALUES(?1,?2,?3,?4,?5,'clip',?6)",
        params![profile_id, source_id, "https://example.com/article", "Example article", "bp-1", "A persisted passage"],
    ).unwrap();
    assert!(conn.execute(
        "INSERT INTO research_captures(profile_id,source_id,source_url,source_title,page_id,kind,text) VALUES(?1,?2,?3,?4,?5,'clip',?6)",
        params![profile_id, source_id, "https://example.com/article", "Example article", "bp-1", "A persisted passage"],
    ).is_err(), "the database must prevent duplicate capture rows");
    let kept: i32 = conn.query_row(
        "SELECT COUNT(*) FROM research_captures WHERE profile_id=?1 AND source_id=?2 AND kind IN ('clip','highlight')",
        params![profile_id, source_id], |row| row.get(0),
    ).unwrap();
    assert_eq!(kept, 1);
    conn.execute("DELETE FROM profiles WHERE id=?1", params![profile_id]).unwrap();
    assert_eq!(count(&conn, "research_sources"), 0);
    assert_eq!(count(&conn, "research_captures"), 0);
}

#[test]
fn profile_crud_and_cascade_delete() {
    let conn = fresh();
    let (pid, _, _) = seed(&conn, "Ada", "ada", "done");
    assert_eq!(count(&conn, "profiles"), 1);
    assert_eq!(count(&conn, "resources"), 1);

    conn.execute("DELETE FROM profiles WHERE id=?1", params![pid])
        .unwrap();

    for t in ["tracks", "semesters", "milestones", "subjects", "resources"] {
        assert_eq!(count(&conn, t), 0, "{t} should cascade-delete");
    }
    // FTS shadow stays in sync via the AD trigger.
    assert_eq!(count(&conn, "resources_fts"), 0);
}

#[test]
fn semester_status_defaults_persists_and_is_independent_of_marks() {
    let conn = fresh();
    let (pid, tid, _) = seed(&conn, "Grace", "grace", "pending");

    // seed() inserts a semester named 'Fall'. New semesters default to
    // 'Upcoming' regardless of any subject/course marks.
    let (sem_id, status): (i32, String) = conn
        .query_row(
            "SELECT id, status FROM semesters WHERE track_id=?1",
            params![tid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "Upcoming", "new semesters default to Upcoming");

    // Declaring a status is a plain UPDATE; it does not touch marks/courses.
    conn.execute(
        "UPDATE semesters SET status='Completed' WHERE id=?1",
        params![sem_id],
    )
    .unwrap();

    // Adding a graded course AFTER declaring status must not change it.
    conn.execute(
        "INSERT INTO courses(profile_id,semester_label,course_name,credits,marks_obtained,max_marks) \
         VALUES(?1,'Fall','Algorithms',4,40,100)",
        params![pid],
    )
    .unwrap();
    let after: String = conn
        .query_row(
            "SELECT status FROM semesters WHERE id=?1",
            params![sem_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        after, "Completed",
        "declared status is independent of course marks"
    );

    // Removing the course (a course-data change) also leaves status untouched.
    conn.execute("DELETE FROM courses WHERE profile_id=?1", params![pid])
        .unwrap();
    let still: String = conn
        .query_row(
            "SELECT status FROM semesters WHERE id=?1",
            params![sem_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(still, "Completed", "status survives course removal");
}

#[test]
fn deleting_a_track_cascades_but_leaves_siblings() {
    let conn = fresh();
    let (pid, tid, _) = seed(&conn, "Linus", "linus", "pending");
    conn.execute(
        "INSERT INTO tracks(profile_id,name) VALUES(?1,'Math')",
        params![pid],
    )
    .unwrap();

    conn.execute("DELETE FROM tracks WHERE id=?1", params![tid])
        .unwrap();

    assert_eq!(
        count(&conn, "subjects"),
        0,
        "subjects under deleted track gone"
    );
    let left: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM tracks WHERE profile_id=?1",
            params![pid],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(left, 1, "sibling track survives");
    assert_eq!(count(&conn, "profiles"), 1, "profile itself untouched");
}

#[test]
fn fts5_search_ranks_and_scopes_by_profile() {
    let conn = fresh();
    let (pid_a, _, subj_a) = seed(&conn, "A", "a", "done");
    let (pid_b, _, subj_b) = seed(&conn, "B", "b", "done");

    // Strongly relevant vs weakly relevant note, both under profile A.
    conn.execute("INSERT INTO resources(subject_id,kind,title,content) VALUES(?1,'note','Recursion recursion','recursion recursion recursion base case')", params![subj_a]).unwrap();
    conn.execute("INSERT INTO resources(subject_id,kind,title,content) VALUES(?1,'note','Side','one recursion mention only')", params![subj_a]).unwrap();
    // Profile B has the term too — must NOT leak into A's results.
    conn.execute("INSERT INTO resources(subject_id,kind,title,content) VALUES(?1,'note','Bsecret','recursion recursion in profile B')", params![subj_b]).unwrap();

    let mut stmt = conn
        .prepare(
            "SELECT r.title FROM resources_fts
         JOIN resources r ON r.id = resources_fts.rowid
         JOIN subjects s ON s.id=r.subject_id
         JOIN milestones m ON m.id=s.milestone_id
         JOIN semesters se ON se.id=m.semester_id
         JOIN tracks t ON t.id=se.track_id
         WHERE resources_fts MATCH ?1 AND t.profile_id=?2
         ORDER BY bm25(resources_fts) LIMIT 50",
        )
        .unwrap();
    let titles: Vec<String> = stmt
        .query_map(params!["\"recursion\"*", pid_a], |r| r.get(0))
        .unwrap()
        .map(|t| t.unwrap())
        .collect();

    assert!(titles.contains(&"Recursion recursion".to_string()));
    assert!(titles.contains(&"Side".to_string()));
    assert!(
        !titles.iter().any(|t| t == "Bsecret"),
        "profile scoping leaked!"
    );
    assert_eq!(
        titles[0], "Recursion recursion",
        "most relevant ranks first (bm25)"
    );

    // Sanity: profile B sees only its own hit.
    let b_hits: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM resources_fts
         JOIN resources r ON r.id=resources_fts.rowid
         JOIN subjects s ON s.id=r.subject_id
         JOIN milestones m ON m.id=s.milestone_id
         JOIN semesters se ON se.id=m.semester_id
         JOIN tracks t ON t.id=se.track_id
         WHERE resources_fts MATCH '\"recursion\"*' AND t.profile_id=?1",
            params![pid_b],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(b_hits, 1);
}

#[test]
fn dashboard_stats_aggregate_correctly() {
    let conn = fresh();
    conn.execute("INSERT INTO profiles(name,slug) VALUES('D','d')", [])
        .unwrap();
    let pid = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO tracks(profile_id,name) VALUES(?1,'T')",
        params![pid],
    )
    .unwrap();
    let tid = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO semesters(track_id,name) VALUES(?1,'S')",
        params![tid],
    )
    .unwrap();
    let sid = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO milestones(semester_id,title) VALUES(?1,'M')",
        params![sid],
    )
    .unwrap();
    let mid = conn.last_insert_rowid() as i32;

    for st in [
        "done",
        "done",
        "done",
        "done",
        "done",
        "in_progress",
        "pending",
        "pending",
    ] {
        conn.execute(
            "INSERT INTO subjects(milestone_id,name,status) VALUES(?1,'x',?2)",
            params![mid, st],
        )
        .unwrap();
    }
    let subj_any: i32 = conn
        .query_row("SELECT id FROM subjects LIMIT 1", [], |r| r.get(0))
        .unwrap();
    conn.execute(
        "INSERT INTO resources(subject_id,kind,title,content) VALUES(?1,'note','n','')",
        params![subj_any],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO resources(subject_id,kind,title,content) VALUES(?1,'pdf','p','')",
        params![subj_any],
    )
    .unwrap();

    let scoped = "FROM subjects s
        JOIN milestones m ON m.id=s.milestone_id
        JOIN semesters se ON se.id=m.semester_id
        JOIN tracks t ON t.id=se.track_id WHERE t.profile_id=?1";

    let total: i32 = conn
        .query_row(&format!("SELECT COUNT(*) {scoped}"), params![pid], |r| {
            r.get(0)
        })
        .unwrap();
    let done: i32 = conn
        .query_row(
            &format!("SELECT COUNT(*) {scoped} AND s.status='done'"),
            params![pid],
            |r| r.get(0),
        )
        .unwrap();
    let pending: i32 = conn
        .query_row(
            &format!("SELECT COUNT(*) {scoped} AND s.status='pending'"),
            params![pid],
            |r| r.get(0),
        )
        .unwrap();
    let in_progress: i32 = conn
        .query_row(
            &format!("SELECT COUNT(*) {scoped} AND s.status='in_progress'"),
            params![pid],
            |r| r.get(0),
        )
        .unwrap();

    assert_eq!((total, done, in_progress, pending), (8, 5, 1, 2));

    // completion_pct uses f64::round (half away from zero) -> 62.5 becomes 63.
    let pct = (done as f64 / total as f64 * 100.0).round() as i32;
    assert_eq!(pct, 63);

    let notes: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM resources r JOIN subjects s ON s.id=r.subject_id
         JOIN milestones m ON m.id=s.milestone_id JOIN semesters se ON se.id=m.semester_id
         JOIN tracks t ON t.id=se.track_id WHERE t.profile_id=?1 AND r.kind='note'",
            params![pid],
            |r| r.get(0),
        )
        .unwrap();
    let pdfs: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM resources r JOIN subjects s ON s.id=r.subject_id
         JOIN milestones m ON m.id=s.milestone_id JOIN semesters se ON se.id=m.semester_id
         JOIN tracks t ON t.id=se.track_id WHERE t.profile_id=?1 AND r.kind='pdf'",
            params![pid],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!((notes, pdfs), (1, 1));
}

/// Phase 11: Cards table (SM-2 spaced repetition) CRUD + cascade delete.
#[test]
fn cards_crud_and_cascade_delete() {
    let conn = fresh();
    let (pid, _, subj) = seed(&conn, "CardUser", "carduser", "in_progress");

    // Insert a card with default SM-2 values
    conn.execute(
        "INSERT INTO cards(subject_id, front, back, due_date) VALUES(?1, 'Q1', 'A1', date('now'))",
        params![subj],
    )
    .unwrap();
    let card_id = conn.last_insert_rowid() as i32;

    // Verify card was created
    let (front, back, ef, interval, reps): (String, String, f64, i32, i32) = conn
        .query_row(
            "SELECT front, back, ease_factor, interval_days, repetitions FROM cards WHERE id=?1",
            params![card_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .unwrap();
    assert_eq!(front, "Q1");
    assert_eq!(back, "A1");
    assert!((ef - 2.5).abs() < 0.01); // Default EF
    assert_eq!(interval, 0); // Default interval
    assert_eq!(reps, 0); // Default reps

    // Update card with review (simulate SM-2 algorithm)
    conn.execute(
        "UPDATE cards SET ease_factor=?2, interval_days=?3, repetitions=?4, due_date=?5, last_reviewed=?6 WHERE id=?1",
        params![card_id, 2.5, 1, 1, "2026-07-01", "2026-07-02 10:00:00"],
    )
    .unwrap();

    // Verify update
    let (new_interval, new_reps, last_reviewed): (i32, i32, Option<String>) = conn
        .query_row(
            "SELECT interval_days, repetitions, last_reviewed FROM cards WHERE id=?1",
            params![card_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(new_interval, 1);
    assert_eq!(new_reps, 1);
    assert!(last_reviewed.is_some());

    // Test counting due cards
    let due_count: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM cards c
             JOIN subjects s ON s.id=c.subject_id
             JOIN milestones m ON m.id=s.milestone_id
             JOIN semesters se ON se.id=m.semester_id
             JOIN tracks t ON t.id=se.track_id
             WHERE t.profile_id=?1 AND c.due_date <= date('now')",
            params![pid],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(due_count, 1);

    // Cascade delete: delete subject -> card should be deleted
    conn.execute("DELETE FROM subjects WHERE id=?1", params![subj])
        .unwrap();
    let card_count: i32 = conn
        .query_row("SELECT COUNT(*) FROM cards", [], |r| r.get(0))
        .unwrap();
    assert_eq!(card_count, 0, "Card should cascade-delete with subject");
}

#[test]
fn subject_overview_aggregates_are_scoped_to_the_subject() {
    // Mirrors the SQL in get_subject_overview (which is a napi fn, not callable
    // from this rusqlite-only test binary): grade lookup, study time, and the
    // related-activity counts must all scope strictly to one subject.
    let conn = fresh();
    let (pid, tid, subj) = seed(&conn, "Grace", "grace", "in_progress");
    // seed() creates track tid, semester 'Fall', milestone 'Core', subject 'Algorithms' (subj).

    // A graded course matched by (profile, semester_label, course_name).
    conn.execute(
        "INSERT INTO courses(profile_id,semester_label,course_name,credits,marks_obtained,max_marks)
         VALUES(?1,'Fall','Algorithms',4,80,100)",
        params![pid],
    ).unwrap();

    // Study sessions for the subject (30 today + 60 on a past day).
    conn.execute(
        "INSERT INTO session_states(subject_id,started_at,duration_minutes) VALUES(?1, datetime('now','localtime'), 30)",
        params![subj],
    ).unwrap();
    conn.execute(
        "INSERT INTO session_states(subject_id,started_at,duration_minutes) VALUES(?1, '2024-01-01 09:00:00', 60)",
        params![subj],
    ).unwrap();

    // One upcoming + one past deadline; only the upcoming should count.
    conn.execute(
        "INSERT INTO deadlines(subject_id,deadline_date,category,title) VALUES(?1, date('now','localtime','+3 days'),'exam','Midterm')",
        params![subj],
    ).unwrap();
    conn.execute(
        "INSERT INTO deadlines(subject_id,deadline_date,category,title) VALUES(?1, '2020-01-01','exam','Old')",
        params![subj],
    ).unwrap();

    // A due and a not-due flashcard.
    conn.execute(
        "INSERT INTO cards(subject_id,front,back,ease_factor,interval_days,repetitions,due_date)
         VALUES(?1,'q1','a1',2.5,1,1, date('now','localtime'))",
        params![subj],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO cards(subject_id,front,back,ease_factor,interval_days,repetitions,due_date)
         VALUES(?1,'q2','a2',2.5,10,3, date('now','localtime','+10 days'))",
        params![subj],
    )
    .unwrap();

    // A mistake and an extra note beyond the seed's one note.
    conn.execute(
        "INSERT INTO mistakes(subject_id,question_text,mistake_type,correct_approach,tags) VALUES(?1,'q','conceptual','x','')",
        params![subj],
    ).unwrap();
    conn.execute(
        "INSERT INTO resources(subject_id,kind,title,content) VALUES(?1,'note','Extra','body')",
        params![subj],
    )
    .unwrap();

    // Grade lookup.
    let (credits, mo, mm): (f64, f64, f64) = conn
        .query_row(
            "SELECT credits, marks_obtained, max_marks FROM courses
         WHERE profile_id=?1 AND semester_label='Fall' AND lower(trim(course_name))='algorithms'",
            params![pid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!((credits, mo, mm), (4.0, 80.0, 100.0));

    // Study totals + today.
    let (total, count): (i32, i32) = conn.query_row(
        "SELECT COALESCE(SUM(duration_minutes),0), COUNT(*) FROM session_states WHERE subject_id=?1",
        params![subj], |r| Ok((r.get(0)?, r.get(1)?)),
    ).unwrap();
    assert_eq!((total, count), (90, 2));
    let today: i32 = conn.query_row(
        "SELECT COALESCE(SUM(duration_minutes),0) FROM session_states WHERE subject_id=?1 AND date(started_at)=date('now','localtime')",
        params![subj], |r| r.get(0),
    ).unwrap();
    assert_eq!(today, 30);

    // Upcoming deadlines only.
    let upcoming: i32 = conn.query_row(
        "SELECT COUNT(*) FROM deadlines WHERE subject_id=?1 AND date(deadline_date) >= date('now','localtime')",
        params![subj], |r| r.get(0),
    ).unwrap();
    assert_eq!(upcoming, 1);

    // Resource counts by kind (seed note 'Big-O' + 'Extra' = 2 notes, 0 pdf).
    let (notes, pdfs): (i32, i32) = conn
        .query_row(
            "SELECT COALESCE(SUM(CASE WHEN kind='note' THEN 1 ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN kind='pdf' THEN 1 ELSE 0 END),0)
         FROM resources WHERE subject_id=?1",
            params![subj],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((notes, pdfs), (2, 0));

    // Flashcards: 2 total, 1 due.
    let (fc_total, fc_due): (i32, i32) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(CASE WHEN due_date <= date('now','localtime') THEN 1 ELSE 0 END),0)
         FROM cards WHERE subject_id=?1",
        params![subj], |r| Ok((r.get(0)?, r.get(1)?)),
    ).unwrap();
    assert_eq!((fc_total, fc_due), (2, 1));

    // Mistakes.
    let mistakes: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM mistakes WHERE subject_id=?1",
            params![subj],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(mistakes, 1);

    // Scoping sanity: a sibling subject shares none of these counts.
    conn.execute("INSERT INTO subjects(milestone_id,name,status) SELECT milestone_id,'Other','pending' FROM subjects WHERE id=?1", params![subj]).unwrap();
    let other = conn.last_insert_rowid() as i32;
    let other_sessions: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_states WHERE subject_id=?1",
            params![other],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(other_sessions, 0);
    let _ = tid;
}

#[test]
fn semester_overview_aggregates_scope_to_the_semester() {
    // Mirrors get_semester_overview's SQL (napi fn, not callable here): SGPA/
    // credits, completion counts, study minutes, and deadline buckets must all
    // scope to ONE semester via subject -> milestone -> semester, and courses via
    // (profile, semester_label == semester name).
    let conn = fresh();
    let (pid, tid, subj_a) = seed(&conn, "Term", "term", "done");
    // seed(): track tid, semester 'Fall', milestone 'Core', subject 'Algorithms'(subj_a, done).
    let sem_id: i32 = conn
        .query_row(
            "SELECT id FROM semesters WHERE track_id=?1",
            params![tid],
            |r| r.get(0),
        )
        .unwrap();
    let ms_id: i32 = conn
        .query_row(
            "SELECT id FROM milestones WHERE semester_id=?1",
            params![sem_id],
            |r| r.get(0),
        )
        .unwrap();

    // A second, ungraded subject in the same semester.
    conn.execute(
        "INSERT INTO subjects(milestone_id,name,status) VALUES(?1,'Networks','pending')",
        params![ms_id],
    )
    .unwrap();
    let subj_b = conn.last_insert_rowid() as i32;

    // A subject in a DIFFERENT semester — must be excluded from all aggregates.
    conn.execute(
        "INSERT INTO semesters(track_id,name,status) VALUES(?1,'Spring','Upcoming')",
        params![tid],
    )
    .unwrap();
    let sem2 = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO milestones(semester_id,title) VALUES(?1,'Core')",
        params![sem2],
    )
    .unwrap();
    let ms2 = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO subjects(milestone_id,name,status) VALUES(?1,'Databases','pending')",
        params![ms2],
    )
    .unwrap();
    let subj_c = conn.last_insert_rowid() as i32;

    // Courses: Algorithms graded 80/100 @4cr in Fall; Databases graded in Spring (must not leak).
    conn.execute(
        "INSERT INTO courses(profile_id,semester_label,course_name,credits,marks_obtained,max_marks) VALUES(?1,'Fall','Algorithms',4,80,100)",
        params![pid],
    ).unwrap();
    conn.execute(
        "INSERT INTO courses(profile_id,semester_label,course_name,credits,marks_obtained,max_marks) VALUES(?1,'Spring','Databases',4,90,100)",
        params![pid],
    ).unwrap();

    // Study: 30m on Algorithms (Fall), 99m on Databases (Spring, excluded).
    conn.execute("INSERT INTO session_states(subject_id,started_at,duration_minutes) VALUES(?1, datetime('now','localtime'), 30)", params![subj_a]).unwrap();
    conn.execute("INSERT INTO session_states(subject_id,started_at,duration_minutes) VALUES(?1, datetime('now','localtime'), 99)", params![subj_c]).unwrap();

    // Deadlines: one overdue + one due-soon in Fall; one in Spring (excluded).
    conn.execute("INSERT INTO deadlines(subject_id,deadline_date,category,title) VALUES(?1,'2020-01-01','exam','Old')", params![subj_a]).unwrap();
    conn.execute("INSERT INTO deadlines(subject_id,deadline_date,category,title) VALUES(?1, date('now','localtime','+2 days'),'exam','Quiz')", params![subj_b]).unwrap();
    conn.execute("INSERT INTO deadlines(subject_id,deadline_date,category,title) VALUES(?1, date('now','localtime','+3 days'),'exam','Spring')", params![subj_c]).unwrap();

    // SGPA over Fall graded courses: only Algorithms (80% -> 8.0 on the seeded default-ish scale).
    // The rusqlite test has no grade_scales rows, so replicate the default 10-pt mapping used by scale_for's fallback.
    // 80% falls in the 80-89 band -> 9.0 in the shipped default. Assert credits + graded count deterministically:
    let (fall_credits, fall_graded): (f64, i32) = conn.query_row(
        "SELECT COALESCE(SUM(credits),0), COUNT(*) FROM courses
         WHERE profile_id=?1 AND semester_label='Fall' AND marks_obtained IS NOT NULL AND max_marks IS NOT NULL",
        params![pid], |r| Ok((r.get(0)?, r.get(1)?)),
    ).unwrap();
    assert_eq!((fall_credits, fall_graded), (4.0, 1));

    // Completion: 2 subjects in Fall (Algorithms done, Networks pending); 1 graded.
    let total: i32 = conn.query_row(
        "SELECT COUNT(*) FROM subjects sub JOIN milestones m ON m.id=sub.milestone_id WHERE m.semester_id=?1",
        params![sem_id], |r| r.get(0)).unwrap();
    assert_eq!(total, 2);
    let done: i32 = conn.query_row(
        "SELECT COUNT(*) FROM subjects sub JOIN milestones m ON m.id=sub.milestone_id WHERE m.semester_id=?1 AND sub.status='done'",
        params![sem_id], |r| r.get(0)).unwrap();
    assert_eq!(done, 1);

    // Study scoped to Fall = 30 (not 129).
    let fall_study: i32 = conn.query_row(
        "SELECT COALESCE(SUM(ss.duration_minutes),0) FROM session_states ss
         JOIN subjects sub ON sub.id=ss.subject_id JOIN milestones m ON m.id=sub.milestone_id WHERE m.semester_id=?1",
        params![sem_id], |r| r.get(0)).unwrap();
    assert_eq!(fall_study, 30);

    // Deadline buckets scoped to Fall: 1 overdue, 1 due-soon, 0 upcoming.
    let (overdue, soon, upcoming): (i32, i32, i32) = conn.query_row(
        "SELECT
           COALESCE(SUM(CASE WHEN date(d.deadline_date) < date('now','localtime') THEN 1 ELSE 0 END),0),
           COALESCE(SUM(CASE WHEN date(d.deadline_date) >= date('now','localtime') AND date(d.deadline_date) <= date('now','localtime','+7 days') THEN 1 ELSE 0 END),0),
           COALESCE(SUM(CASE WHEN date(d.deadline_date) > date('now','localtime','+7 days') THEN 1 ELSE 0 END),0)
         FROM deadlines d JOIN subjects sub ON sub.id=d.subject_id JOIN milestones m ON m.id=sub.milestone_id
         WHERE m.semester_id=?1",
        params![sem_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
    assert_eq!((overdue, soon, upcoming), (1, 1, 0));

    let _ = subj_b;
}

#[test]
fn deadline_completion_defaults_toggles_and_excludes_from_active() {
    // Mirrors set_deadline_completion + the active-only aggregation SQL (napi fns
    // aren't callable here). completed_at is independent of deadline_date.
    let conn = fresh();
    let (_pid, _tid, subj) = seed(&conn, "Dl", "dl", "in_progress");

    // A past-dated (overdue) deadline; new rows default to completed_at = NULL.
    conn.execute(
        "INSERT INTO deadlines(subject_id,deadline_date,category,title) VALUES(?1,'2020-01-01','assignment','Lab Report')",
        params![subj],
    ).unwrap();
    let did = conn.last_insert_rowid() as i32;
    let default_completed: Option<String> = conn
        .query_row(
            "SELECT completed_at FROM deadlines WHERE id=?1",
            params![did],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        default_completed.is_none(),
        "new deadlines default to active (NULL)"
    );

    // Active overdue count = 1 (completed_at IS NULL AND date < today).
    let active_overdue = |conn: &Connection| -> i32 {
        conn.query_row(
            "SELECT COUNT(*) FROM deadlines WHERE subject_id=?1 AND completed_at IS NULL AND date(deadline_date) < date('now','localtime')",
            params![subj], |r| r.get(0)).unwrap()
    };
    assert_eq!(active_overdue(&conn), 1);

    // Complete it: stamp completed_at with localtime (independent of the 2020 date).
    conn.execute(
        "UPDATE deadlines SET completed_at = datetime('now','localtime') WHERE id=?1",
        params![did],
    )
    .unwrap();
    let after: Option<String> = conn
        .query_row(
            "SELECT completed_at FROM deadlines WHERE id=?1",
            params![did],
            |r| r.get(0),
        )
        .unwrap();
    assert!(after.is_some(), "completed deadline has a timestamp");
    // Now excluded from active overdue even though its date is in the past.
    assert_eq!(
        active_overdue(&conn),
        0,
        "completed deadline is not overdue"
    );
    // But it still EXISTS (history preserved, not deleted).
    let total: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM deadlines WHERE id=?1",
            params![did],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(total, 1);

    // Reopen: clear completed_at -> active + overdue again.
    conn.execute(
        "UPDATE deadlines SET completed_at = NULL WHERE id=?1",
        params![did],
    )
    .unwrap();
    assert_eq!(
        active_overdue(&conn),
        1,
        "reopened past-dated deadline is overdue again"
    );
}

#[test]
fn career_goals_and_milestones_lifecycle_and_isolation() {
    // Mirrors the career module SQL (napi fns aren't callable here): goal + ordered
    // milestones, single-primary invariant, completion, cascade, profile isolation.
    let conn = fresh();
    let (pa, _, _) = seed(&conn, "Ada", "ada", "in_progress");
    let (pb, _, _) = seed(&conn, "Bea", "bea", "in_progress");

    // Two goals for A; second is primary and must demote the first.
    conn.execute(
        "INSERT INTO career_goals(profile_id,title,is_primary) VALUES(?1,'Backend Eng',1)",
        params![pa],
    )
    .unwrap();
    let g1 = conn.last_insert_rowid() as i32;
    conn.execute(
        "UPDATE career_goals SET is_primary = 0 WHERE profile_id = ?1",
        params![pa],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO career_goals(profile_id,title,is_primary) VALUES(?1,'Data Eng',1)",
        params![pa],
    )
    .unwrap();
    let g2 = conn.last_insert_rowid() as i32;
    let primaries: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM career_goals WHERE profile_id=?1 AND is_primary=1",
            params![pa],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(primaries, 1, "exactly one primary goal per profile");

    // Goal for B (isolation).
    conn.execute(
        "INSERT INTO career_goals(profile_id,title,is_primary) VALUES(?1,'Researcher',1)",
        params![pb],
    )
    .unwrap();

    // Milestones for g2 with append ordering (max+1).
    for (i, t) in ["Learn SQL", "Build ETL", "Internship"].iter().enumerate() {
        let next: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order),-1)+1 FROM career_milestones WHERE goal_id=?1",
                params![g2],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(next, i as i32);
        conn.execute(
            "INSERT INTO career_milestones(goal_id,title,sort_order) VALUES(?1,?2,?3)",
            params![g2, t, next],
        )
        .unwrap();
    }
    let m_ids: Vec<i32> = {
        let mut s = conn
            .prepare("SELECT id FROM career_milestones WHERE goal_id=?1 ORDER BY sort_order")
            .unwrap();
        s.query_map(params![g2], |r| r.get(0))
            .unwrap()
            .map(|x| x.unwrap())
            .collect()
    };
    assert_eq!(m_ids.len(), 3);

    // Complete the middle milestone: completed_at set, row preserved.
    conn.execute(
        "UPDATE career_milestones SET completed_at=datetime('now','localtime') WHERE id=?1",
        params![m_ids[1]],
    )
    .unwrap();
    let done: Option<String> = conn
        .query_row(
            "SELECT completed_at FROM career_milestones WHERE id=?1",
            params![m_ids[1]],
            |r| r.get(0),
        )
        .unwrap();
    assert!(done.is_some());
    // Reopen.
    conn.execute(
        "UPDATE career_milestones SET completed_at=NULL WHERE id=?1",
        params![m_ids[1]],
    )
    .unwrap();
    let reopened: Option<String> = conn
        .query_row(
            "SELECT completed_at FROM career_milestones WHERE id=?1",
            params![m_ids[1]],
            |r| r.get(0),
        )
        .unwrap();
    assert!(reopened.is_none());

    // Reorder: reverse; sort_order becomes index.
    let reversed: Vec<i32> = m_ids.iter().rev().cloned().collect();
    for (idx, mid) in reversed.iter().enumerate() {
        conn.execute(
            "UPDATE career_milestones SET sort_order=?2 WHERE id=?1 AND goal_id=?3",
            params![mid, idx as i32, g2],
        )
        .unwrap();
    }
    let first_after: i32 = conn
        .query_row(
            "SELECT id FROM career_milestones WHERE goal_id=?1 ORDER BY sort_order LIMIT 1",
            params![g2],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(first_after, m_ids[2], "reorder persisted");

    // Profile isolation: A's goals never include B's.
    let a_goals: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM career_goals WHERE profile_id=?1",
            params![pa],
            |r| r.get(0),
        )
        .unwrap();
    let b_goals: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM career_goals WHERE profile_id=?1",
            params![pb],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!((a_goals, b_goals), (2, 1));

    // Deleting a goal cascades its milestones.
    conn.execute("DELETE FROM career_goals WHERE id=?1", params![g2])
        .unwrap();
    let orphaned: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM career_milestones WHERE goal_id=?1",
            params![g2],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(orphaned, 0, "milestones cascade-delete with goal");

    // Deleting profile A cascades its remaining goal; B untouched.
    conn.execute("DELETE FROM profiles WHERE id=?1", params![pa])
        .unwrap();
    let a_left: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM career_goals WHERE profile_id=?1",
            params![pa],
            |r| r.get(0),
        )
        .unwrap();
    let b_left: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM career_goals WHERE profile_id=?1",
            params![pb],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!((a_left, b_left), (0, 1));
    let _ = g1;
}
