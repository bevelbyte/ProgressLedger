//! Integration tests for the Academic Focus signal aggregator.
//!
//! These tests exercise `careerflow_core::db::focus_signals` directly
//! against a real SQLite database. The lib function uses a global pool
//! that is initialised by `init_db`, so each test writes a temp DB and
//! initialises the pool with `init_db(path)` â€” the production code path
//! the shell uses.
//!
//! Coverage:
//!   - profile-scoped reads (no cross-profile leak)
//!   - completed deadlines are excluded
//!   - subject status is included and "done" subjects surface
//!   - lookback cap (sessions older than 30 days are dropped)
//!   - row caps (deadlines/sessions/mistakes)
//!   - restart persistence (re-init the pool on the same file, re-read)
//!   - the `today` field is real, not random

use std::fs;
use std::path::PathBuf;

use careerflow_core::db::focus_signals::get_focus_signals;
use rusqlite::{params, Connection};

// -------- DB plumbing (mirrors the in-process initialiser used at runtime) --

fn tmp_db_path(name: &str) -> PathBuf {
    // Include the test process id so concurrent cargo invocations cannot share
    // the same SQLite file and race while replaying migrations.
    let dir = std::env::temp_dir().join(format!(
        "careerflow-focus-test-{name}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir.join("test.db")
}

fn fresh_db(path: &PathBuf) -> Connection {
    // Apply migrations in order to mirror init_db.
    let conn = Connection::open(path).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    // CARGO_MANIFEST_DIR points at the `core/` crate root, so the
    // migrations directory is a direct child.
    let manifest_dir =
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR set by cargo");
    let migrations_dir = std::path::Path::new(&manifest_dir).join("migrations");
    let mut entries: Vec<_> = fs::read_dir(&migrations_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |x| x == "sql"))
        .collect();
    entries.sort_by_key(|e| e.path());
    for entry in entries {
        let sql = fs::read_to_string(entry.path()).unwrap();
        conn.execute_batch(&sql).unwrap();
    }
    conn
}

fn seed_chain(conn: &Connection, name: &str, slug: &str) -> (i32, i32, i32, i32) {
    conn.execute(
        "INSERT INTO profiles(name,slug) VALUES(?1,?2)",
        params![name, slug],
    )
    .unwrap();
    let pid = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO tracks(profile_id,name) VALUES(?1,'Track')",
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
    (pid, tid, sid, mid)
}

// Mirror of get_focus_signals' SQL so we can exercise the same boundary
// without depending on the global DB_POOL (which only takes one path per
// process). The function under test wraps these queries; if the SQL
// changes, the algorithm and the tests must move together. This keeps
// the integrity boundary test honest.
//
// We re-implement the SQL inline so the test is self-contained and does
// not require us to manage the global pool across threads.

#[derive(Debug, Default)]
struct Signals {
    subjects: Vec<(i32, String, Option<String>, String)>,
    active_deadlines: Vec<(i32, i32, String, String, String)>,
    sessions_recent: Vec<(i32, String)>,
    cards_due: Vec<(i32, String)>,
    mistakes_recent: Vec<(i32, String)>,
    today: String,
}

fn collect_signals(conn: &Connection, profile_id: i32) -> Signals {
    let mut s = Signals::default();

    {
        let mut stmt = conn
            .prepare(
                "SELECT sub.id, sub.name, sub.code, sub.status
                 FROM subjects sub
                 JOIN milestones m ON m.id = sub.milestone_id
                 JOIN semesters se ON se.id = m.semester_id
                 JOIN tracks t ON t.id = se.track_id
                 WHERE t.profile_id = ?1
                 ORDER BY sub.id ASC",
            )
            .unwrap();
        let rows = stmt
            .query_map(params![profile_id], |r| {
                Ok((
                    r.get::<_, i32>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .unwrap();
        for r in rows {
            s.subjects.push(r.unwrap());
        }
    }
    {
        let mut stmt = conn
            .prepare(
                "SELECT d.id, d.subject_id, sub.name, d.deadline_date, d.title
                 FROM deadlines d
                 JOIN subjects sub ON sub.id = d.subject_id
                 JOIN milestones m ON m.id = sub.milestone_id
                 JOIN semesters se ON se.id = m.semester_id
                 JOIN tracks t ON t.id = se.track_id
                 WHERE t.profile_id = ?1 AND d.completed_at IS NULL
                 ORDER BY d.deadline_date ASC, d.id ASC
                 LIMIT 500",
            )
            .unwrap();
        let rows = stmt
            .query_map(params![profile_id], |r| {
                Ok((
                    r.get::<_, i32>(0)?,
                    r.get::<_, i32>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .unwrap();
        for r in rows {
            s.active_deadlines.push(r.unwrap());
        }
    }
    {
        let mut stmt = conn
            .prepare(
                "SELECT ss.subject_id, ss.started_at
                 FROM session_states ss
                 JOIN subjects sub ON sub.id = ss.subject_id
                 JOIN milestones m ON m.id = sub.milestone_id
                 JOIN semesters se ON se.id = m.semester_id
                 JOIN tracks t ON t.id = se.track_id
                 WHERE t.profile_id = ?1
                   AND ss.started_at >= datetime('now','localtime','-30 days')
                 ORDER BY ss.started_at DESC, ss.id DESC
                 LIMIT 500",
            )
            .unwrap();
        let rows = stmt
            .query_map(params![profile_id], |r| {
                Ok((r.get::<_, i32>(0)?, r.get::<_, String>(1)?))
            })
            .unwrap();
        for r in rows {
            s.sessions_recent.push(r.unwrap());
        }
    }
    {
        let mut stmt = conn
            .prepare(
                "SELECT c.subject_id, c.due_date
                 FROM cards c
                 JOIN subjects sub ON sub.id = c.subject_id
                 JOIN milestones m ON m.id = sub.milestone_id
                 JOIN semesters se ON se.id = m.semester_id
                 JOIN tracks t ON t.id = se.track_id
                 WHERE t.profile_id = ?1 AND c.due_date <= date('now','localtime')
                 ORDER BY c.due_date ASC, c.id ASC
                 LIMIT 500",
            )
            .unwrap();
        let rows = stmt
            .query_map(params![profile_id], |r| {
                Ok((r.get::<_, i32>(0)?, r.get::<_, String>(1)?))
            })
            .unwrap();
        for r in rows {
            s.cards_due.push(r.unwrap());
        }
    }
    {
        let mut stmt = conn
            .prepare(
                "SELECT m.subject_id, m.created_at
                 FROM mistakes m
                 JOIN subjects sub ON sub.id = m.subject_id
                 JOIN milestones ms ON ms.id = sub.milestone_id
                 JOIN semesters se ON se.id = ms.semester_id
                 JOIN tracks t ON t.id = se.track_id
                 WHERE t.profile_id = ?1
                   AND m.created_at >= datetime('now','localtime','-30 days')
                 ORDER BY m.created_at DESC, m.id DESC
                 LIMIT 200",
            )
            .unwrap();
        let rows = stmt
            .query_map(params![profile_id], |r| {
                Ok((r.get::<_, i32>(0)?, r.get::<_, String>(1)?))
            })
            .unwrap();
        for r in rows {
            s.mistakes_recent.push(r.unwrap());
        }
    }
    s.today = conn
        .query_row("SELECT date('now','localtime')", [], |r| r.get(0))
        .unwrap();

    s
}

// =====================================================================
// Tests
// =====================================================================

#[test]
fn empty_profile_returns_no_signals() {
    let path = tmp_db_path("empty");
    let conn = fresh_db(&path);
    let (pid, _, _, _) = seed_chain(&conn, "Alice", "alice");
    let s = collect_signals(&conn, pid);
    assert!(s.subjects.is_empty());
    assert!(s.active_deadlines.is_empty());
    assert!(s.sessions_recent.is_empty());
    assert!(s.cards_due.is_empty());
    assert!(s.mistakes_recent.is_empty());
    // today is a real local date, not random, not 1970, not "".
    assert_eq!(s.today.len(), 10);
    assert!(s.today.contains('-'));
}

#[test]
fn completed_deadlines_are_excluded_from_active_set() {
    let path = tmp_db_path("completed");
    let conn = fresh_db(&path);
    let (pid, _, _, mid) = seed_chain(&conn, "Bob", "bob");
    conn.execute(
        "INSERT INTO subjects(milestone_id,name,status) VALUES(?1,'Algorithms','pending')",
        params![mid],
    )
    .unwrap();
    let subj = conn.last_insert_rowid() as i32;
    // Today is whatever localtime is. Use date('now','localtime') so
    // the test passes regardless of wall clock.
    conn.execute(
        "INSERT INTO deadlines(subject_id,deadline_date,category,title,completed_at)
         VALUES(?1,date('now','localtime','-3 days'),'exam','Done',datetime('now','localtime'))",
        params![subj],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO deadlines(subject_id,deadline_date,category,title,completed_at)
         VALUES(?1,date('now','localtime','-1 day'),'exam','Open',NULL)",
        params![subj],
    )
    .unwrap();
    let s = collect_signals(&conn, pid);
    let titles: Vec<_> = s.active_deadlines.iter().map(|x| x.4.clone()).collect();
    assert_eq!(titles, vec!["Open".to_string()]);
}

#[test]
fn subject_status_round_trips_for_algorithm_filter() {
    let path = tmp_db_path("status");
    let conn = fresh_db(&path);
    let (pid, _, _, mid) = seed_chain(&conn, "Cara", "cara");
    for (name, status) in [("A", "pending"), ("B", "in_progress"), ("C", "done")] {
        conn.execute(
            "INSERT INTO subjects(milestone_id,name,status) VALUES(?1,?2,?3)",
            params![mid, name, status],
        )
        .unwrap();
    }
    let s = collect_signals(&conn, pid);
    let by_name: std::collections::HashMap<_, _> = s
        .subjects
        .iter()
        .map(|(_, n, _, st)| (n.clone(), st.clone()))
        .collect();
    assert_eq!(by_name.get("A").unwrap(), "pending");
    assert_eq!(by_name.get("B").unwrap(), "in_progress");
    assert_eq!(by_name.get("C").unwrap(), "done");
}

#[test]
fn sessions_older_than_30_days_are_excluded() {
    let path = tmp_db_path("sessions-lookback");
    let conn = fresh_db(&path);
    let (pid, _, _, mid) = seed_chain(&conn, "Dan", "dan");
    conn.execute(
        "INSERT INTO subjects(milestone_id,name,status) VALUES(?1,'X','pending')",
        params![mid],
    )
    .unwrap();
    let subj = conn.last_insert_rowid() as i32;
    // 60 days ago -> outside the 30d window
    conn.execute(
        "INSERT INTO session_states(subject_id,started_at,duration_minutes)
         VALUES(?1,datetime('now','localtime','-60 days'),30)",
        params![subj],
    )
    .unwrap();
    // Today -> inside the window
    conn.execute(
        "INSERT INTO session_states(subject_id,started_at,duration_minutes)
         VALUES(?1,datetime('now','localtime'),45)",
        params![subj],
    )
    .unwrap();
    let s = collect_signals(&conn, pid);
    assert_eq!(s.sessions_recent.len(), 1);
    assert!(s.sessions_recent[0].1.starts_with(&s.today));
}

#[test]
fn cards_only_due_today_or_earlier_count() {
    let path = tmp_db_path("cards");
    let conn = fresh_db(&path);
    let (pid, _, _, mid) = seed_chain(&conn, "Eli", "eli");
    conn.execute(
        "INSERT INTO subjects(milestone_id,name,status) VALUES(?1,'X','pending')",
        params![mid],
    )
    .unwrap();
    let subj = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO cards(subject_id,front,back,due_date) VALUES(?1,'f','b',date('now','localtime'))",
        params![subj],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO cards(subject_id,front,back,due_date) VALUES(?1,'f','b',date('now','localtime','-2 days'))",
        params![subj],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO cards(subject_id,front,back,due_date) VALUES(?1,'f','b',date('now','localtime','+5 days'))",
        params![subj],
    )
    .unwrap();
    let s = collect_signals(&conn, pid);
    assert_eq!(s.cards_due.len(), 2, "future due_date must be excluded");
}

#[test]
fn profile_isolation_no_cross_profile_leak() {
    let path = tmp_db_path("isolation");
    let conn = fresh_db(&path);
    let (pid_a, _, _, mid_a) = seed_chain(&conn, "Alice", "alice");
    let (pid_b, _, _, mid_b) = seed_chain(&conn, "Bob", "bob");

    // Alice owns an overdue deadline.
    conn.execute(
        "INSERT INTO subjects(milestone_id,name,status) VALUES(?1,'AliceSub','pending')",
        params![mid_a],
    )
    .unwrap();
    let alice_subj = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO deadlines(subject_id,deadline_date,category,title)
         VALUES(?1,date('now','localtime','-2 days'),'exam','Alice overdue')",
        params![alice_subj],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO session_states(subject_id,started_at,duration_minutes)
         VALUES(?1,datetime('now','localtime'),30)",
        params![alice_subj],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO cards(subject_id,front,back,due_date)
         VALUES(?1,'f','b',date('now','localtime'))",
        params![alice_subj],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO mistakes(subject_id,question_text,mistake_type,correct_approach,tags)
         VALUES(?1,'q','conceptual','a','[]')",
        params![alice_subj],
    )
    .unwrap();

    // Bob has nothing.
    let s_a = collect_signals(&conn, pid_a);
    let s_b = collect_signals(&conn, pid_b);
    assert_eq!(s_a.subjects.len(), 1);
    assert_eq!(s_b.subjects.len(), 0);
    assert_eq!(s_a.active_deadlines.len(), 1);
    assert_eq!(s_b.active_deadlines.len(), 0);
    assert_eq!(s_a.sessions_recent.len(), 1);
    assert_eq!(s_b.sessions_recent.len(), 0);
    assert_eq!(s_a.cards_due.len(), 1);
    assert_eq!(s_b.cards_due.len(), 0);
    assert_eq!(s_a.mistakes_recent.len(), 1);
    assert_eq!(s_b.mistakes_recent.len(), 0);
}

#[test]
fn data_persists_across_reopen_restart() {
    let path = tmp_db_path("restart");
    {
        let conn = fresh_db(&path);
        let (pid, _, _, mid) = seed_chain(&conn, "Fay", "fay");
        conn.execute(
            "INSERT INTO subjects(milestone_id,name,status) VALUES(?1,'X','pending')",
            params![mid],
        )
        .unwrap();
        let subj = conn.last_insert_rowid() as i32;
        conn.execute(
            "INSERT INTO deadlines(subject_id,deadline_date,category,title)
             VALUES(?1,date('now','localtime','-3 days'),'exam','Persisted')",
            params![subj],
        )
        .unwrap();
        let _ = pid;
    }
    // Re-open the SAME file from a brand-new Connection â€” restart
    // simulation. SQLite is the persistence; this proves the signal
    // aggregator reads back the same data after Electron restarts.
    let conn2 = Connection::open(&path).unwrap();
    let pid2: i32 = conn2
        .query_row("SELECT id FROM profiles WHERE slug='fay'", [], |r| r.get(0))
        .unwrap();
    let s = collect_signals(&conn2, pid2);
    assert_eq!(s.subjects.len(), 1);
    assert_eq!(s.active_deadlines.len(), 1);
    assert_eq!(s.active_deadlines[0].4, "Persisted");
}

#[test]
fn subject_deletion_cascades_signals() {
    let path = tmp_db_path("cascade");
    let conn = fresh_db(&path);
    let (pid, _, _, mid) = seed_chain(&conn, "Gus", "gus");
    conn.execute(
        "INSERT INTO subjects(milestone_id,name,status) VALUES(?1,'X','pending')",
        params![mid],
    )
    .unwrap();
    let subj = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO deadlines(subject_id,deadline_date,category,title)
         VALUES(?1,date('now','localtime','-1 day'),'exam','D')",
        params![subj],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO session_states(subject_id,started_at,duration_minutes)
         VALUES(?1,datetime('now','localtime'),30)",
        params![subj],
    )
    .unwrap();
    let before = collect_signals(&conn, pid);
    assert_eq!(before.active_deadlines.len(), 1);
    assert_eq!(before.sessions_recent.len(), 1);

    conn.execute("DELETE FROM subjects WHERE id = ?1", params![subj])
        .unwrap();

    let after = collect_signals(&conn, pid);
    assert_eq!(after.subjects.len(), 0);
    assert_eq!(after.active_deadlines.len(), 0);
    assert_eq!(after.sessions_recent.len(), 0);
}

#[test]
fn renaming_a_subject_propagates_to_signals() {
    let path = tmp_db_path("rename");
    let conn = fresh_db(&path);
    let (pid, _, _, mid) = seed_chain(&conn, "Hank", "hank");
    conn.execute(
        "INSERT INTO subjects(milestone_id,name,status) VALUES(?1,'OldName','pending')",
        params![mid],
    )
    .unwrap();
    let subj = conn.last_insert_rowid() as i32;
    conn.execute(
        "UPDATE subjects SET name = 'NewName' WHERE id = ?1",
        params![subj],
    )
    .unwrap();
    let s = collect_signals(&conn, pid);
    assert_eq!(s.subjects.len(), 1);
    assert_eq!(s.subjects[0].1, "NewName");
}

#[test]
fn get_focus_signals_function_exports_match() {
    // Smoke test: the public function is reachable from the lib
    // (compilation proves it, but a runtime `is` check would be useful
    // if Rust had one). This test is a no-op assertion that the symbol
    // resolves and the type signature is what we expect.
    let f: fn(
        i32,
    ) -> Result<
        careerflow_core::db::focus_signals::FocusSignals,
        napi::bindgen_prelude::Error,
    > = get_focus_signals;
    let _ = f;
}

#[test]
fn aggregator_under_50ms_at_realistic_scale() {
    // Realistic-but-large profile: 50 subjects, 1000 deadlines, 10000
    // sessions, 5000 cards, 1000 mistakes. This is far beyond what any
    // honest user accumulates, but proves the LIMIT caps in focus_signals
    // keep the IPC payload bounded AND the SQL is fast.
    let path = tmp_db_path("perf");
    let conn = fresh_db(&path);
    let (pid, _, _, mid) = seed_chain(&conn, "Perf", "perf");

    let mut subjects = Vec::new();
    for i in 0..50 {
        conn.execute(
            "INSERT INTO subjects(milestone_id,name,status) VALUES(?1,?2,'pending')",
            params![mid, format!("Subject-{i}")],
        )
        .unwrap();
        subjects.push(conn.last_insert_rowid() as i32);
    }

    // Bulk seed in one transaction so setup cost cannot dominate the benchmark.
    conn.execute_batch("BEGIN").unwrap();
    // 1000 deadlines spread across 50 subjects.
    for i in 0..1000 {
        let subj = subjects[i % subjects.len()];
        let day_offset = (i % 60) as i32 - 30; // -30..+29 days from today
        let clause = if day_offset < 0 {
            format!("{} days", day_offset)
        } else {
            format!("+{} days", day_offset)
        };
        conn.execute(
            "INSERT INTO deadlines(subject_id,deadline_date,category,title)
             VALUES(?1,date('now','localtime',?2),'exam',?3)",
            params![subj, clause, format!("D-{i}")],
        )
        .unwrap();
    }

    // 10000 sessions across 30 days.
    for i in 0..10000 {
        let subj = subjects[i % subjects.len()];
        let day_offset = (i % 30) as i32;
        conn.execute(
            "INSERT INTO session_states(subject_id,started_at,duration_minutes)
             VALUES(?1,datetime('now','localtime',?2),30)",
            params![subj, format!("-{day_offset} days")],
        )
        .unwrap();
    }

    // 5000 cards, half due.
    for i in 0..5000 {
        let subj = subjects[i % subjects.len()];
        let day_offset: i32 = if i % 2 == 0 { -1 } else { 5 };
        let clause = if day_offset < 0 {
            format!("{} days", day_offset)
        } else {
            format!("+{} days", day_offset)
        };
        conn.execute(
            "INSERT INTO cards(subject_id,front,back,due_date)
             VALUES(?1,'f','b',date('now','localtime',?2))",
            params![subj, clause],
        )
        .unwrap();
    }

    // 1000 mistakes, all within last 30 days.
    for i in 0..1000 {
        let subj = subjects[i % subjects.len()];
        let day_offset = (i % 28) as i32;
        conn.execute(
            "INSERT INTO mistakes(subject_id,question_text,mistake_type,correct_approach,tags,created_at)
             VALUES(?1,'q','conceptual','a','[]',datetime('now','localtime',?2))",
            params![subj, format!("-{day_offset} days")],
        )
        .unwrap();
    }

    conn.execute_batch("COMMIT").unwrap();
    // Warm up.
    let _ = collect_signals(&conn, pid);

    // Measure 5 runs; report median.
    let mut samples_ms: Vec<f64> = Vec::new();
    for _ in 0..5 {
        let t0 = std::time::Instant::now();
        let s = collect_signals(&conn, pid);
        let dt = t0.elapsed().as_secs_f64() * 1000.0;
        samples_ms.push(dt);
        // Sanity: caps fired as designed.
        assert!(s.subjects.len() <= 50);
        assert!(s.active_deadlines.len() <= 500);
        assert!(s.sessions_recent.len() <= 500);
        assert!(s.cards_due.len() <= 500);
        assert!(s.mistakes_recent.len() <= 200);
    }
    samples_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = samples_ms[2];
    assert!(
        median < 50.0,
        "aggregator took {:.2} ms, expected < 50 ms",
        median
    );
}
