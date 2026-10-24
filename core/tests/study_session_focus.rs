//! DB-level safety net for the FOCUS SESSION UI surface.
//!
//! Focus Session is UI-only: no new Rust fn, no new IPC channel, no migration,
//! no table. It runs a timer against a real subject and writes exactly ONE row
//! through the existing `add_study_session(...)` into `session_states`, storing
//! the session OBJECTIVE in the existing `notes` TEXT column. Study Sessions
//! remains the single source of truth.
//!
//! This file pins, at the database level, every semantic Focus depends on —
//! especially LOCAL-DATE ATTRIBUTION and MIDNIGHT BEHAVIOUR, the highest-risk
//! area. If a future "fix" changes any of these rules, these tests go red
//! instead of silently corrupting dashboards.
//!
//! The #[napi] surface is NOT called here: it routes through a process-global
//! r2d2 pool (core/src/db/mod.rs `DB_POOL`) that is unsafe to initialise from
//! parallel cargo tests. All assertions are raw SQL against the real migrated
//! schema, so the queries under test are copied verbatim from
//! core/src/db/study_sessions.rs and core/src/db/resources.rs.

use rusqlite::{params, Connection, ErrorCode, OptionalExtension, Result};
use std::collections::HashSet;
use std::error::Error;
use std::fs;
use std::path::Path;

/// Build a `Box<dyn Error>` with an unambiguous type (a bare `.into()` is
/// ambiguous with rusqlite in scope).
fn msg(err: String) -> Box<dyn Error> {
    Box::<dyn Error>::from(err)
}

/// Apply every migration from disk exactly like `migrations::run()` does: each
/// file wrapped in BEGIN..PRAGMA user_version..COMMIT, version from the filename.
fn setup_test_db() -> Result<Connection, Box<dyn Error>> {
    let conn = Connection::open_in_memory()?;
    // A fresh connection defaults PRAGMA foreign_keys = OFF, which would let
    // FK assertions below pass for the wrong reason.
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;

    let migrations_dir = Path::new("migrations"); // cargo runs with cwd = core/
    let mut files: Vec<_> = fs::read_dir(migrations_dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |ext| ext == "sql"))
        .collect();
    files.sort_by_key(|e| e.path());

    for entry in files {
        let path = entry.path();
        let ver: i32 = path
            .file_stem()
            .ok_or_else(|| msg(format!("migration {path:?} has no file stem")))?
            .to_str()
            .ok_or_else(|| msg(format!("migration {path:?} has a non-UTF8 stem")))?
            .split('_')
            .next()
            .ok_or_else(|| msg(format!("migration {path:?} has no NNN_ prefix")))?
            .parse()
            .map_err(|e| msg(format!("migration {path:?}: bad version prefix: {e}")))?;
        let sql = fs::read_to_string(&path)?;
        conn.execute_batch(&format!(
            "BEGIN;\n{sql}\nPRAGMA user_version = {ver};\nCOMMIT;"
        ))?;
    }
    Ok(conn)
}

/// One full tree: profile -> track -> semester -> milestone -> subject.
/// Column names verified against 001_initial.sql (subject.status defaults to
/// 'pending' and is trigger-gated to pending|in_progress|done).
#[derive(Debug, Clone)]
struct Tree {
    profile_id: i64,
    track_id: i64,
    semester_id: i64,
    milestone_id: i64,
    subject_id: i64,
}

fn seed_tree(conn: &Connection, name: &str, slug: &str, subject_name: &str) -> Result<Tree> {
    conn.execute(
        "INSERT INTO profiles (name, slug) VALUES (?1, ?2)",
        params![name, slug],
    )?;
    let profile_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO tracks (profile_id, name) VALUES (?1, 'Track')",
        [profile_id],
    )?;
    let track_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO semesters (track_id, name) VALUES (?1, 'Semester 1')",
        [track_id],
    )?;
    let semester_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO milestones (semester_id, title) VALUES (?1, 'Subjects')",
        [semester_id],
    )?;
    let milestone_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO subjects (milestone_id, name) VALUES (?1, ?2)",
        params![milestone_id, subject_name],
    )?;
    let subject_id = conn.last_insert_rowid();
    Ok(Tree {
        profile_id,
        track_id,
        semester_id,
        milestone_id,
        subject_id,
    })
}

/// The profile scope shared by every stats/list query in study_sessions.rs.
const SCOPE: &str = "FROM session_states ss
             JOIN subjects sub ON sub.id = ss.subject_id
             JOIN milestones m ON m.id = sub.milestone_id
             JOIN semesters se ON se.id = m.semester_id
             JOIN tracks t ON t.id = se.track_id
             WHERE t.profile_id = ?1";

/// Insert a session the way `add_study_session` does when the shell supplies a
/// timestamp. NOTE: the app rejects `duration_minutes <= 0` with `DB_CONSTRAINT`
/// BEFORE reaching the DB; these tests deliberately bypass that guard and hit
/// the DB directly to pin what the schema actually permits.
fn insert_session(
    conn: &Connection,
    subject_id: i64,
    duration_minutes: i64,
    started_at: &str,
    ended_at: Option<&str>,
    notes: Option<&str>,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO session_states (subject_id, started_at, ended_at, duration_minutes, notes)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            subject_id,
            started_at,
            ended_at,
            duration_minutes,
            notes.unwrap_or_default()
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

fn total_sessions(conn: &Connection, profile_id: i64) -> Result<i64> {
    conn.query_row(&format!("SELECT COUNT(*) {SCOPE}"), [profile_id], |r| {
        r.get(0)
    })
}

fn total_minutes(conn: &Connection, profile_id: i64) -> Result<i64> {
    conn.query_row(
        &format!("SELECT COALESCE(SUM(ss.duration_minutes),0) {SCOPE}"),
        [profile_id],
        |r| r.get(0),
    )
}

/// `minutes_today` with `date('now','localtime')` replaced by an explicit date
/// literal so the tests are valid on any calendar day. The predicate itself —
/// `date(ss.started_at) = <day>` — is unchanged from study_sessions.rs.
fn minutes_today(conn: &Connection, profile_id: i64, day: &str) -> Result<i64> {
    conn.query_row(
        &format!(
            "SELECT COALESCE(SUM(ss.duration_minutes),0) {SCOPE} AND date(ss.started_at) = ?2"
        ),
        params![profile_id, day],
        |r| r.get(0),
    )
}

fn active_days(conn: &Connection, profile_id: i64) -> Result<i64> {
    conn.query_row(
        &format!("SELECT COUNT(DISTINCT date(ss.started_at)) {SCOPE}"),
        [profile_id],
        |r| r.get(0),
    )
}

/// Session ids in the exact list order used by `get_study_sessions`.
fn session_ids(conn: &Connection, profile_id: i64) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT ss.id {SCOPE} ORDER BY ss.started_at DESC, ss.id DESC"
    ))?;
    let rows = stmt.query_map([profile_id], |r| r.get(0))?;
    rows.collect::<Result<Vec<_>>>()
}

fn session_count_for_subject(conn: &Connection, subject_id: i64) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM session_states WHERE subject_id = ?1",
        [subject_id],
        |r| r.get(0),
    )
}

/// Local calendar date `offset_days` days before today. `0 days` is passed as a
/// literal (never `-0 days`) so it is unambiguous.
fn date_at(conn: &Connection, offset_days: i64) -> Result<String> {
    let modifier = if offset_days == 0 {
        "0 days".to_string()
    } else {
        format!("-{offset_days} days")
    };
    conn.query_row("SELECT date('now','localtime', ?1)", [modifier], |r| {
        r.get(0)
    })
}

/// A local "YYYY-MM-DD HH:MM:SS" timestamp on `offset_days` days before today.
fn local_ts(conn: &Connection, offset_days: i64, clock: &str) -> Result<String> {
    Ok(format!("{} {}", date_at(conn, offset_days)?, clock))
}

fn collect_days(
    conn: &Connection,
    profile_id: i64,
    sql: &str,
    days: &mut HashSet<String>,
) -> Result<()> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([profile_id], |r| r.get::<_, String>(0))?;
    for row in rows {
        days.insert(row?);
    }
    Ok(())
}

/// Exact replication of the dashboard study streak (core/src/db/resources.rs,
/// `get_dashboard_stats` ~line 440-529). All three day sources are included so
/// the arithmetic under test cannot drift from what ships:
///   days = {resource creation days} U {card review days} U {session start days}
/// then anchor at today, else yesterday, else no streak, then walk backwards
/// over CONSECUTIVE local dates, counting each day exactly once.
fn study_streak(conn: &Connection, profile_id: i64) -> Result<i64> {
    let mut days: HashSet<String> = HashSet::new();

    // `date(r.created_at,'localtime')` converts stored UTC to local because the
    // DDL default for resources.created_at is CURRENT_TIMESTAMP (UTC). Sessions
    // get bare `date(ss.started_at)` because the app always stores them ALREADY
    // local. That asymmetry is deliberate and is why the format check in
    // default_timestamp_is_localtime_not_utc matters.
    collect_days(
        conn,
        profile_id,
        "SELECT DISTINCT date(r.created_at,'localtime') FROM resources r
         JOIN subjects s ON s.id = r.subject_id
         JOIN milestones m ON m.id = s.milestone_id
         JOIN semesters se ON se.id = m.semester_id
         JOIN tracks t ON t.id = se.track_id
         WHERE t.profile_id = ?1",
        &mut days,
    )?;
    collect_days(
        conn,
        profile_id,
        "SELECT DISTINCT date(c.last_reviewed) FROM cards c
         JOIN subjects s ON s.id = c.subject_id
         JOIN milestones m ON m.id = s.milestone_id
         JOIN semesters se ON se.id = m.semester_id
         JOIN tracks t ON t.id = se.track_id
         WHERE t.profile_id = ?1 AND c.last_reviewed IS NOT NULL",
        &mut days,
    )?;
    collect_days(
        conn,
        profile_id,
        "SELECT DISTINCT date(ss.started_at) FROM session_states ss
         JOIN subjects s ON s.id = ss.subject_id
         JOIN milestones m ON m.id = s.milestone_id
         JOIN semesters se ON se.id = m.semester_id
         JOIN tracks t ON t.id = se.track_id
         WHERE t.profile_id = ?1",
        &mut days,
    )?;

    let mut current_streak = 0i64;
    let mut off = if days.contains(&date_at(conn, 0)?) {
        0
    } else if days.contains(&date_at(conn, 1)?) {
        1
    } else {
        -1
    };
    if off >= 0 {
        loop {
            let d = date_at(conn, off)?;
            if days.contains(&d) {
                current_streak += 1;
                off += 1;
            } else {
                break;
            }
        }
    }
    Ok(current_streak)
}

/// Structural check that the schema has no DB-level guard on duration_minutes:
/// no CHECK clause on the table and no trigger that inspects the column.
fn duration_minutes_is_unconstrained(conn: &Connection) -> Result<bool> {
    let ddl: String = conn.query_row(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_states'",
        [],
        |r| r.get(0),
    )?;
    let has_check = ddl.to_uppercase().contains("CHECK");
    if has_check {
        return Ok(false);
    }
    let mut stmt = conn.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'session_states'",
    )?;
    let triggers: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_>>()?;
    Ok(!triggers
        .iter()
        .any(|sql| sql.to_lowercase().contains("duration_minutes")))
}

/// Asserts the renderer's timestamp shape: `YYYY-MM-DD HH:MM:SS` — 19 chars,
/// space (not 'T') at index 10. A 'T' would mean UTC ISO-8601, which would
/// mis-date every session in a positive-offset timezone.
fn assert_app_timestamp_format(ts: &str) {
    let bytes = ts.as_bytes();
    assert_eq!(
        bytes.len(),
        19,
        "local timestamp must be exactly 'YYYY-MM-DD HH:MM:SS' (19 chars), got {ts:?}"
    );
    for (i, &b) in bytes.iter().enumerate() {
        match i {
            4 | 7 => assert_eq!(
                b, b'-',
                "timestamp byte {i} must be '-', got {b:?} (got {ts:?})"
            ),
            10 => assert_eq!(
                b, b' ',
                "timestamp byte 10 must be SPACE, got {b:?} (got {ts:?})"
            ),
            13 | 16 => assert_eq!(
                b, b':',
                "timestamp byte {i} must be ':', got {b:?} (got {ts:?})"
            ),
            _ => assert!(
                b.is_ascii_digit(),
                "timestamp byte {i} must be a digit, got {b:?} (got {ts:?})"
            ),
        }
    }
    assert!(
        !ts.contains('T'),
        "timestamp must not use an ISO-8601 'T' separator (got {ts:?})"
    );
}

// ===== 1. Attribution is by START day, across midnight =====================

#[test]
fn attributes_cross_midnight_session_to_the_start_day() -> Result<(), Box<dyn Error>> {
    let conn = setup_test_db()?;
    let tree = seed_tree(&conn, "Ada", "ada", "Algorithms")?;

    // Started 23:58 on the 14th, ended 00:05 on the 15th. The whole point:
    // opening the app at 00:01 must read 0 minutes today.
    let id = insert_session(
        &conn,
        tree.subject_id,
        7,
        "2026-01-14 23:58:00",
        Some("2026-01-15 00:05:00"),
        Some("wrapped past midnight"),
    )?;

    let (start_day, end_day): (String, String) = conn.query_row(
        "SELECT date(started_at), date(ended_at) FROM session_states WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(
        start_day, "2026-01-14",
        "session must be attributed to its START day"
    );
    assert_eq!(
        end_day, "2026-01-15",
        "ended_at genuinely lands on the next day"
    );

    // Counterfactual: an ended_at-based attribution WOULD count it today. Pinning
    // started_at means this stays 0 — if someone "fixes" attribution to use
    // ended_at, this assertion is what turns red.
    assert_eq!(
        minutes_today(&conn, tree.profile_id, "2026-01-15")?,
        0,
        "a 23:58->00:05 session must read 0 minutes when the app opens at 00:01"
    );
    assert_eq!(
        minutes_today(&conn, tree.profile_id, "2026-01-14")?,
        7,
        "the same session must be fully readable on its start day"
    );

    // Nothing is lost by the midnight boundary: totals and active days are intact.
    assert_eq!(total_sessions(&conn, tree.profile_id)?, 1);
    assert_eq!(total_minutes(&conn, tree.profile_id)?, 7);
    assert_eq!(active_days(&conn, tree.profile_id)?, 1);
    Ok(())
}

// ===== 2. minutes_today sums the local calendar date of START ===============

#[test]
fn minutes_today_uses_local_calendar_date_of_start() -> Result<(), Box<dyn Error>> {
    let conn = setup_test_db()?;
    let tree = seed_tree(&conn, "Ada", "ada", "Algorithms")?;

    // Yesterday 22:00 (30m) and today 09:00 (20m). "Today" is fixed to a
    // literal date so this reads the same on every run.
    let yest = insert_session(
        &conn,
        tree.subject_id,
        30,
        "2026-08-28 22:00:00",
        None,
        None,
    )?;
    let today = insert_session(
        &conn,
        tree.subject_id,
        20,
        "2026-08-29 09:00:00",
        None,
        None,
    )?;

    assert_eq!(
        minutes_today(&conn, tree.profile_id, "2026-08-29")?,
        20,
        "minutes_today must contain only the row whose START date is today"
    );
    assert_eq!(
        minutes_today(&conn, tree.profile_id, "2026-08-28")?,
        30,
        "the previous day's minutes are not silently absorbed into today"
    );
    assert_eq!(
        total_minutes(&conn, tree.profile_id)?,
        50,
        "total_minutes is date-agnostic and sums both rows"
    );

    // The 22:00 row contributes exactly nothing to today's sum. This is the
    // assertion that would catch a switch to a >= midnight-ago window query.
    let leaked: i64 = conn.query_row(
        "SELECT COALESCE(SUM(ss.duration_minutes),0) FROM session_states ss
         JOIN subjects sub ON sub.id = ss.subject_id
         JOIN milestones m ON m.id = sub.milestone_id
         JOIN semesters se ON se.id = m.semester_id
         JOIN tracks t ON t.id = se.track_id
         WHERE t.profile_id = ?1 AND ss.id = ?2 AND date(ss.started_at) = '2026-08-29'",
        params![tree.profile_id, yest],
        |r| r.get(0),
    )?;
    assert_eq!(
        leaked, 0,
        "yesterday's 22:00 row must contribute 0 to today"
    );
    assert_eq!(
        conn.query_row::<i64, _, _>(
            "SELECT COALESCE(SUM(ss.duration_minutes),0) FROM session_states ss WHERE ss.id = ?1 AND date(ss.started_at) = '2026-08-29'",
            [today],
            |r| r.get(0),
        )?,
        20,
        "today's row alone contributes its full 20 minutes"
    );
    assert_eq!(active_days(&conn, tree.profile_id)?, 2);
    Ok(())
}

// ===== 3. The stored default is LOCAL, not UTC ==============================

#[test]
fn default_timestamp_is_localtime_not_utc() -> Result<(), Box<dyn Error>> {
    let conn = setup_test_db()?;
    let tree = seed_tree(&conn, "Ada", "ada", "Algorithms")?;

    // Exactly the INSERT the app issues when `started_at` is None
    // (study_sessions.rs: `datetime('now','localtime')`).
    //
    // NOTE: the DDL default for started_at in 005_data_constraints.sql is
    // `CURRENT_TIMESTAMP`, which is UTC. That default is dead for the app path
    // ONLY because Rust always supplies an explicit localtime value. A future
    // caller that omits started_at would silently file late-evening sessions on
    // the previous calendar day in any positive-offset timezone — this test
    // exists so nobody notices until a dashboard is already wrong.
    let before = chrono::Local::now().format("%F").to_string();
    conn.execute(
        "INSERT INTO session_states (subject_id, started_at, duration_minutes, notes)
         VALUES (?1, datetime('now','localtime'), ?2, ?3)",
        params![tree.subject_id, 25, ""],
    )?;
    let id = conn.last_insert_rowid();
    let after = chrono::Local::now().format("%F").to_string();

    let (stored, stored_day): (String, String) = conn.query_row(
        "SELECT started_at, date(started_at) FROM session_states WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;

    assert_app_timestamp_format(&stored);
    // The Rust clock read can straddle midnight relative to the INSERT, so
    // accept whichever local date it landed on. Anything else is a real bug.
    assert!(
        stored.starts_with(&before) || stored.starts_with(&after),
        "stored default {stored:?} must carry the Rust local date read before or after the INSERT"
    );
    assert_eq!(
        stored.as_bytes()[10],
        b' ',
        "local format uses a space, not ISO-8601 'T'"
    );
    assert_eq!(
        &stored[..10],
        stored_day.as_str(),
        "date(started_at) must round-trip the stored prefix exactly"
    );

    // And the row must land in "today" for the app's own predicate.
    assert_eq!(
        minutes_today(&conn, tree.profile_id, &stored[..10])?,
        25,
        "a default-timestamped session must count towards its own local day"
    );
    assert_eq!(
        conn.query_row::<i64, _, _>(
            "SELECT (date(started_at) = date('now','localtime')) FROM session_states WHERE id = ?1",
            [id],
            |r| r.get(0),
        )?,
        1,
        "date(started_at) must equal SQLite's own local today"
    );

    // Prove the dead DDL default is UTC: a row that RELIES on it stores the UTC
    // wall clock, so it matches datetime('now') rather than datetime('now',
    // 'localtime'). Both are read in one query so only the date prefix is
    // compared — no wall-clock window to race.
    conn.execute(
        "INSERT INTO session_states (subject_id, duration_minutes) VALUES (?1, 1)",
        [tree.subject_id],
    )?;
    let ddl_row = conn.last_insert_rowid();
    let (utc_default, utc_now): (String, String) = conn.query_row(
        "SELECT started_at, datetime('now') FROM session_states WHERE id = ?1",
        [ddl_row],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(
        &utc_default[..10],
        &utc_now[..10],
        "the DDL CURRENT_TIMESTAMP default is UTC, not localtime — omitted started_at is unsafe"
    );

    // Deterministic corollary, independent of the clock: if the host has a
    // non-zero UTC offset, reading the stored UTC string as local must shift it.
    // A row written by this default would therefore be mis-dated by the app's
    // own `date(ss.started_at)` predicate. (Skipped in a UTC timezone, where
    // the two are identical by definition.)
    let utc_offset: i64 = conn.query_row(
        "SELECT CAST(strftime('%s','now','localtime') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER)",
        [],
        |r| r.get(0),
    )?;
    if utc_offset != 0 {
        let as_local: String = conn.query_row(
            "SELECT datetime(started_at, 'localtime') FROM session_states WHERE id = ?1",
            [ddl_row],
            |r| r.get(0),
        )?;
        assert_ne!(
            as_local, utc_default,
            "with a UTC offset of {utc_offset}s the DDL default is provably mis-dated by a local read"
        );
    }
    Ok(())
}

// ===== 4. duration_minutes = 0 reaches the DB ================================

#[test]
fn zero_duration_is_permitted_by_the_db_despite_the_app_rule() -> Result<(), Box<dyn Error>> {
    let conn = setup_test_db()?;
    let tree = seed_tree(&conn, "Ada", "ada", "Algorithms")?;

    assert!(
        duration_minutes_is_unconstrained(&conn)?,
        "premise: session_states has no DB-level duration guard (CHECK or trigger)"
    );

    // The app returns DB_CONSTRAINT for duration_minutes <= 0 before ever
    // touching the DB. The DB itself happily accepts 0.
    let id = insert_session(
        &conn,
        tree.subject_id,
        0,
        "2026-08-29 09:00:00",
        None,
        Some("warm-up that never started"),
    )?;
    assert!(
        id > 0,
        "duration_minutes = 0 must be insertable at the DB level"
    );

    // Pollution: a 0-minute row inflates BOTH activity counters while adding
    // nothing to any minute sum. A student with only such rows shows "1 active
    // day" and "1 session" with 0 minutes.
    assert_eq!(
        total_sessions(&conn, tree.profile_id)?,
        1,
        "a 0-minute row still increments total_sessions"
    );
    assert_eq!(
        active_days(&conn, tree.profile_id)?,
        1,
        "a 0-minute row still counts as an active day (COUNT DISTINCT date)"
    );
    assert_eq!(
        total_minutes(&conn, tree.profile_id)?,
        0,
        "the same row adds 0 to total_minutes, so counts and minutes disagree"
    );
    assert_eq!(
        minutes_today(&conn, tree.profile_id, "2026-08-29")?,
        0,
        "minutes_today is unaffected but the session is still listed"
    );

    // A gap, not a crash: this is reachable today because
    // core/src/portability.rs imports backup sessions with
    // `s["durationMinutes"].as_i64().unwrap_or(0)` — any missing/malformed
    // duration in a backup import materialises as a 0-minute row.
    Ok(())
}

// ===== 4b. (extra) Backup import default "now" is a moving target ==========

/// EXTRA beyond the requested 13 — pinning a real import hazard found while
/// writing test 4.
///
/// `core/src/portability.rs` (~line 1111) imports backup sessions with
/// `str_or(&s, "startedAt", "now")`. So a session missing `startedAt` in a
/// backup gets the literal TEXT `now`. SQLite's date functions treat the string
/// `"now"` as the special "current time" keyword, so:
///   * `date(started_at)` re-evaluates on every query — it is not a fixed
///     date, the row silently migrates forward in history each day;
///   * that keyword resolves in UTC, not localtime. In a positive-offset
///     timezone this is the PREVIOUS local calendar day between local midnight
///     and the offset boundary, so the row is mis-attributed precisely in the
///     early-morning window Focus is most likely to be used;
///   * the raw text sorts FIRST in `ORDER BY started_at DESC` because 'n'
///     (0x6E) outranks any digit, so it heads the session list every time.
/// All three are asserted below so a future import-format change is detectable.
#[test]
fn backup_import_default_now_re_evaluates_in_utc_not_local() -> Result<(), Box<dyn Error>> {
    let conn = setup_test_db()?;
    let tree = seed_tree(&conn, "Ada", "ada", "Algorithms")?;

    // Insert the exact literal the importer writes when startedAt is absent.
    let id = insert_session(&conn, tree.subject_id, 30, "now", None, None)?;

    // It parses as "now", not as a fixed historical instant.
    let (stored, derived, utc_today, local_today): (String, String, String, String) = conn
        .query_row(
            "SELECT started_at, date(started_at), date('now'), date('now','localtime')
             FROM session_states WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
    assert_eq!(
        stored, "now",
        "the importer's literal must round-trip unchanged"
    );
    assert_eq!(
        derived, utc_today,
        "the stored literal 'now' is re-evaluated as the current UTC date on every read, not a fixed date"
    );

    // And critically, SQLite's keyword resolution is UTC — the app's convention
    // is localtime. In a positive-offset timezone, between local midnight and
    // the offset boundary, that is the PREVIOUS local calendar day. So a
    // backup-imported session silently lands on the wrong day, in exactly the
    // early-morning window Focus is most likely to be used.
    if local_today != utc_today {
        assert_ne!(
            derived, local_today,
            "the importer default mis-attributes to the UTC day instead of the local day"
        );
    }
    assert_eq!(
        minutes_today(&conn, tree.profile_id, &utc_today)?,
        30,
        "such a row counts towards minutes_today on the UTC day it is queried"
    );

    // And it heads the list regardless of real timestamps.
    insert_session(
        &conn,
        tree.subject_id,
        10,
        "2099-01-01 00:00:00",
        None,
        None,
    )?;
    insert_session(
        &conn,
        tree.subject_id,
        10,
        "2000-01-01 00:00:00",
        None,
        None,
    )?;
    assert_eq!(
        session_ids(&conn, tree.profile_id)?[0],
        id,
        "'now' sorts ahead of every numeric timestamp, so it leads the list"
    );
    Ok(())
}

// ===== 5. duration_minutes < 0 reaches the DB too ============================

#[test]
fn negative_duration_is_permitted_by_the_db_too() -> Result<(), Box<dyn Error>> {
    let conn = setup_test_db()?;
    let tree = seed_tree(&conn, "Ada", "ada", "Algorithms")?;

    assert!(
        duration_minutes_is_unconstrained(&conn)?,
        "premise: session_states has no DB-level duration guard (CHECK or trigger)"
    );

    let neg = insert_session(
        &conn,
        tree.subject_id,
        -15,
        "2026-08-29 10:00:00",
        None,
        Some("import artefact"),
    )?;
    assert!(
        neg > 0,
        "duration_minutes = -15 must be insertable at the DB level"
    );

    assert_eq!(
        total_minutes(&conn, tree.profile_id)?,
        -15,
        "a negative duration is subtracted from the profile total, not clamped"
    );

    // Two real rows + one negative row: the negative value actively reduces a
    // legitimate total, which can drive minutes_today below zero in a week view.
    insert_session(
        &conn,
        tree.subject_id,
        60,
        "2026-08-29 11:00:00",
        None,
        None,
    )?;
    insert_session(
        &conn,
        tree.subject_id,
        30,
        "2026-08-29 12:00:00",
        None,
        None,
    )?;
    assert_eq!(
        total_minutes(&conn, tree.profile_id)?,
        75,
        "-15 must visibly net against 60+30"
    );
    assert_eq!(
        minutes_today(&conn, tree.profile_id, "2026-08-29")?,
        75,
        "minutes_today can be understated by imported negative rows"
    );
    assert_eq!(
        total_sessions(&conn, tree.profile_id)?,
        3,
        "the negative row still counts as a session"
    );
    assert_eq!(
        active_days(&conn, tree.profile_id)?,
        1,
        "the negative row still counts as an active day"
    );
    Ok(())
}

// ===== 6. Deleting a subject destroys its sessions ===========================

#[test]
fn subject_deletion_cascades_all_sessions() -> Result<(), Box<dyn Error>> {
    let conn = setup_test_db()?;
    let tree = seed_tree(&conn, "Ada", "ada", "Algorithms")?;

    // A sibling subject in the same milestone, to prove the cascade is scoped.
    conn.execute(
        "INSERT INTO subjects (milestone_id, name) VALUES (?1, 'Zoology')",
        [tree.milestone_id],
    )?;
    let sibling_id = conn.last_insert_rowid();

    insert_session(
        &conn,
        tree.subject_id,
        25,
        "2026-08-27 10:00:00",
        None,
        None,
    )?;
    insert_session(
        &conn,
        tree.subject_id,
        40,
        "2026-08-28 10:00:00",
        None,
        None,
    )?;
    insert_session(
        &conn,
        tree.subject_id,
        55,
        "2026-08-29 10:00:00",
        None,
        None,
    )?;
    insert_session(&conn, sibling_id, 15, "2026-08-29 11:00:00", None, None)?;

    let before_sessions = total_sessions(&conn, tree.profile_id)?;
    let before_minutes = total_minutes(&conn, tree.profile_id)?;
    assert_eq!(
        before_sessions, 4,
        "fixture must have 3 + 1 sibling sessions"
    );
    assert_eq!(before_minutes, 135);

    conn.execute("DELETE FROM subjects WHERE id = ?1", [tree.subject_id])?;

    assert_eq!(
        session_count_for_subject(&conn, tree.subject_id)?,
        0,
        "all sessions must cascade when the subject is deleted"
    );
    let survivor: Option<i64> = conn
        .query_row(
            "SELECT id FROM subjects WHERE id = ?1",
            [tree.subject_id],
            |r| r.get(0),
        )
        .optional()?;
    assert_eq!(survivor, None, "the deleted subject's own row must be gone");

    // Totals dropped by exactly the 3 cascaded sessions, not the sibling's.
    assert_eq!(
        total_sessions(&conn, tree.profile_id)?,
        1,
        "profile session count must fall by 3, keeping the sibling's row"
    );
    assert_eq!(
        total_minutes(&conn, tree.profile_id)?,
        135 - (25 + 40 + 55),
        "profile minutes must fall by exactly the cascaded sessions"
    );
    assert_eq!(
        total_minutes(&conn, tree.profile_id)?,
        15,
        "only the sibling subject's minutes remain"
    );
    assert_eq!(
        session_count_for_subject(&conn, sibling_id)?,
        1,
        "sibling subject must survive"
    );

    // The deleted subject's days must vanish from active-day accounting.
    assert_eq!(
        active_days(&conn, tree.profile_id)?,
        1,
        "only the surviving subject's day remains active"
    );
    Ok(())
}

// ===== 7. Foreign key rejects unknown subjects ===============================

#[test]
fn invalid_subject_id_rejected_by_foreign_key() -> Result<(), Box<dyn Error>> {
    let conn = setup_test_db()?;
    let tree = seed_tree(&conn, "Ada", "ada", "Algorithms")?;

    assert_eq!(
        conn.query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0))?,
        1,
        "premise: this connection enforces foreign keys"
    );

    let outcome = conn.execute(
        "INSERT INTO session_states (subject_id, started_at, duration_minutes)
         VALUES (?1, ?2, ?3)",
        params![999_999i64, "2026-08-29 09:00:00", 25],
    );
    match outcome {
        Ok(n) => {
            panic!("inserting a session for a non-existent subject must fail, inserted {n} row(s)")
        }
        Err(e) => {
            // rusqlite 0.31 exposes only the BASE code through
            // sqlite_error_code(), so assert the base ConstraintViolation code
            // AND the extended code to prove it is specifically the FK rule.
            let base = e.sqlite_error_code();
            assert_eq!(
                base,
                Some(ErrorCode::ConstraintViolation),
                "expected a constraint violation for subject_id 999999, got {e}"
            );
            let extended = e
                .sqlite_error()
                .map_or(0, |sqlite_err| sqlite_err.extended_code);
            assert_eq!(
                extended,
                rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY,
                "expected the FK extended code, got {extended} ({e})"
            );
        }
    }

    // The failed INSERT must leave no trace anywhere in the profile scope.
    assert_eq!(
        total_sessions(&conn, tree.profile_id)?,
        0,
        "a rejected insert must not appear in any profile-scoped total"
    );
    assert_eq!(
        conn.query_row::<i64, _, _>(
            "SELECT COUNT(*) FROM session_states WHERE subject_id = ?1",
            [999_999i64],
            |r| r.get(0),
        )?,
        0,
        "no orphaned session row may remain for the bogus subject"
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM session_states", [], |r| r
            .get::<_, i64>(0))?,
        0,
        "the table must be entirely empty after the rejected insert"
    );
    Ok(())
}

// ===== 8. Profile isolation both ways =======================================

#[test]
fn sessions_are_profile_isolated() -> Result<(), Box<dyn Error>> {
    let conn = setup_test_db()?;
    let a = seed_tree(&conn, "Ada", "ada", "Algorithms")?;
    let b = seed_tree(&conn, "Bea", "bea", "Zoology")?;
    // The two trees must be disjoint at every level — the scope chain
    // subject -> milestone -> semester -> track -> profile has no shared link.
    assert_ne!(a.profile_id, b.profile_id);
    assert_ne!(a.track_id, b.track_id);
    assert_ne!(a.semester_id, b.semester_id);
    assert_ne!(a.milestone_id, b.milestone_id);
    assert_ne!(
        a.subject_id, b.subject_id,
        "two profiles must own distinct subjects"
    );

    // All activity is logged under Ada's subject only.
    insert_session(&conn, a.subject_id, 30, "2026-08-27 10:00:00", None, None)?;
    insert_session(&conn, a.subject_id, 25, "2026-08-28 10:00:00", None, None)?;
    insert_session(&conn, a.subject_id, 40, "2026-08-29 09:00:00", None, None)?;

    // Bea sees nothing — every counter, not just one of them.
    assert_eq!(
        total_sessions(&conn, b.profile_id)?,
        0,
        "Bea must have zero sessions"
    );
    assert_eq!(
        total_minutes(&conn, b.profile_id)?,
        0,
        "Bea must have zero minutes"
    );
    assert_eq!(
        minutes_today(&conn, b.profile_id, "2026-08-29")?,
        0,
        "Bea's minutes_today must be 0 despite Ada logging today"
    );
    assert_eq!(
        active_days(&conn, b.profile_id)?,
        0,
        "Bea must have zero active days"
    );
    assert_eq!(
        session_ids(&conn, b.profile_id)?,
        Vec::<i64>::new(),
        "Bea's session list must be empty"
    );

    // Reverse direction: Ada still sees exactly her own three rows.
    assert_eq!(
        total_sessions(&conn, a.profile_id)?,
        3,
        "Ada must still see her own sessions"
    );
    assert_eq!(
        total_minutes(&conn, a.profile_id)?,
        95,
        "Ada's minutes must be unaffected"
    );
    assert_eq!(
        minutes_today(&conn, a.profile_id, "2026-08-29")?,
        40,
        "Ada must see only her own today-minute row"
    );
    assert_eq!(active_days(&conn, a.profile_id)?, 3);
    assert_eq!(
        session_ids(&conn, a.profile_id)?.len(),
        3,
        "Ada's list must hold 3 ids"
    );

    // No session row may resolve through Bea's track via the stats join.
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM session_states ss
             JOIN subjects sub ON sub.id = ss.subject_id
             JOIN milestones m ON m.id = sub.milestone_id
             JOIN semesters se ON se.id = m.semester_id
             JOIN tracks t ON t.id = se.track_id
             WHERE t.profile_id = ?1",
            [b.profile_id],
            |r| r.get::<_, i64>(0),
        )?,
        0,
        "the profile join must not leak Ada's rows into Bea's scope"
    );
    Ok(())
}

// ===== 9. subject_id is the only scope — cross-profile insert succeeds ======

#[test]
fn subject_id_is_the_only_scope_and_cross_profile_insert_succeeds() -> Result<(), Box<dyn Error>> {
    let conn = setup_test_db()?;
    let a = seed_tree(&conn, "Ada", "ada", "Algorithms")?;
    let b = seed_tree(&conn, "Bea", "bea", "Zoology")?;

    // STRUCTURAL PIN: session_states has no profile column at all. Scope is
    // derived at query time by walking subject -> milestone -> semester ->
    // track -> profile. The DB therefore has no notion of a CALLING profile:
    // a caller can log a session against any subject id it can name. This is a
    // pre-existing IDOR-shaped boundary (the course path has a Rust-side
    // validate_course_subject guard; study_sessions.rs has none). Pinning it
    // here means any future ownership validation, or its removal, is detectable.
    let has_profile_column = conn
        .prepare("SELECT profile_id FROM session_states WHERE id = 1")
        .is_err();
    assert!(
        has_profile_column,
        "session_states must have no profile column — scope is implied by the subject tree"
    );

    // A caller acting "as Bea" names Ada's subject id. The insert SUCCEEDS.
    let id = insert_session(
        &conn,
        a.subject_id,
        45,
        "2026-08-29 10:00:00",
        None,
        Some("logged through Ada's subject id while posing as Bea"),
    )?;
    assert!(
        id > 0,
        "inserting against a foreign profile's subject id must succeed at the DB level"
    );

    // Attribution follows the SUBJECT'S owner, never any notion of caller.
    let owner_profile: Option<i64> = conn
        .query_row(
            "SELECT t.profile_id FROM subjects s
             JOIN milestones m ON m.id = s.milestone_id
             JOIN semesters se ON se.id = m.semester_id
             JOIN tracks t ON t.id = se.track_id
             WHERE s.id = ?1",
            [a.subject_id],
            |r| r.get(0),
        )
        .optional()?;
    assert_eq!(
        owner_profile,
        Some(a.profile_id),
        "the named subject belongs to profile A"
    );

    assert_eq!(
        total_sessions(&conn, a.profile_id)?,
        1,
        "the cross-profile insert must be attributed to the subject's owner (A)"
    );
    assert_eq!(
        total_minutes(&conn, a.profile_id)?,
        45,
        "the minutes must land on A, not on the caller"
    );
    assert_eq!(
        minutes_today(&conn, a.profile_id, "2026-08-29")?,
        45,
        "A's minutes_today must include the foreign insert"
    );

    // And nothing leaks to B — B has no way to see or claim it.
    assert_eq!(
        total_sessions(&conn, b.profile_id)?,
        0,
        "profile B must see nothing"
    );
    assert_eq!(
        total_minutes(&conn, b.profile_id)?,
        0,
        "profile B must see no minutes"
    );
    assert_eq!(
        minutes_today(&conn, b.profile_id, "2026-08-29")?,
        0,
        "profile B's minutes_today must stay 0"
    );
    assert_eq!(session_ids(&conn, b.profile_id)?, Vec::<i64>::new());
    Ok(())
}

// ===== 10. active_days counts DISTINCT calendar days =========================

#[test]
fn active_days_counts_distinct_calendar_days_not_sessions() -> Result<(), Box<dyn Error>> {
    let conn = setup_test_db()?;
    let tree = seed_tree(&conn, "Ada", "ada", "Algorithms")?;

    // Four sessions, two of them twice on the same local date.
    insert_session(
        &conn,
        tree.subject_id,
        30,
        "2026-08-27 08:00:00",
        None,
        None,
    )?;
    insert_session(
        &conn,
        tree.subject_id,
        15,
        "2026-08-27 21:00:00",
        None,
        None,
    )?;
    insert_session(
        &conn,
        tree.subject_id,
        45,
        "2026-08-29 09:00:00",
        None,
        None,
    )?;
    insert_session(
        &conn,
        tree.subject_id,
        10,
        "2026-08-29 22:30:00",
        None,
        None,
    )?;

    assert_eq!(
        total_sessions(&conn, tree.profile_id)?,
        4,
        "total_sessions must count every row"
    );
    assert_eq!(
        active_days(&conn, tree.profile_id)?,
        2,
        "active_days must count DISTINCT local dates, not rows"
    );
    assert_eq!(
        total_minutes(&conn, tree.profile_id)?,
        100,
        "minutes are not de-duplicated the way days are"
    );
    assert_eq!(
        minutes_today(&conn, tree.profile_id, "2026-08-29")?,
        55,
        "minutes_today sums both same-day rows while active_days counts the day once"
    );
    assert_eq!(
        minutes_today(&conn, tree.profile_id, "2026-08-28")?,
        0,
        "a day with no sessions is not counted active"
    );
    Ok(())
}

// ===== 11. notes is where the session objective lives =======================

#[test]
fn notes_column_carries_the_session_objective() -> Result<(), Box<dyn Error>> {
    let conn = setup_test_db()?;
    let tree = seed_tree(&conn, "Ada", "ada", "Algorithms")?;

    // Schema-level pin: the Rust struct reads `notes: String` (non-Option), so a
    // NULL here would be a type error at read time. Focus stores the objective
    // in this column to avoid a migration.
    let notnull: i64 = conn.query_row(
        "SELECT \"notnull\" FROM pragma_table_info('session_states') WHERE name = 'notes'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(
        notnull, 1,
        "session_states.notes must be NOT NULL — a NULL objective would break the Rust read"
    );

    let objective = "Finish Unit 4 revision";
    let id = insert_session(
        &conn,
        tree.subject_id,
        45,
        "2026-08-29 09:00:00",
        Some("2026-08-29 09:45:00"),
        Some(objective),
    )?;

    let (back, subject): (String, i64) = conn.query_row(
        "SELECT notes, subject_id FROM session_states WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(
        back, objective,
        "the session objective must round-trip through notes byte-for-byte"
    );
    assert_eq!(subject, tree.subject_id);

    // And through the real list query Focus's history view is fed by.
    let mut stmt = conn.prepare(&format!(
        "SELECT ss.notes {SCOPE} ORDER BY ss.id DESC LIMIT 1"
    ))?;
    let listed: String = stmt
        .query_map([tree.profile_id], |r| r.get(0))?
        .next()
        .ok_or("no row")??;
    assert_eq!(
        listed, objective,
        "the objective must survive the profile-scoped list query"
    );

    // Omitted objective -> empty string, never NULL. This is what makes "the
    // objective persists with no schema change" true for both branches.
    let bare_id = insert_session(
        &conn,
        tree.subject_id,
        20,
        "2026-08-29 14:00:00",
        None,
        None,
    )?;
    let (bare, is_null): (String, bool) = conn.query_row(
        "SELECT notes, notes IS NULL FROM session_states WHERE id = ?1",
        [bare_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(
        bare, "",
        "an omitted objective must default to the empty string"
    );
    assert!(!is_null, "an omitted objective must never be NULL");

    // Explicit empty string is indistinguishable from omitted — Focus cannot
    // distinguish "no objective" from "clear objective". Pinning that now.
    let empty_id = insert_session(
        &conn,
        tree.subject_id,
        20,
        "2026-08-29 15:00:00",
        None,
        Some(""),
    )?;
    let empty: String = conn.query_row(
        "SELECT notes FROM session_states WHERE id = ?1",
        [empty_id],
        |r| r.get(0),
    )?;
    assert_eq!(empty, "", "an explicit empty objective stores as ''");
    Ok(())
}

// ===== 12. The streak is distinct local days, with a gap break ==============

#[test]
fn streak_uses_distinct_local_days_of_sessions() -> Result<(), Box<dyn Error>> {
    let conn = setup_test_db()?;

    // (a) Three sessions on three consecutive local days ending today.
    let a = seed_tree(&conn, "Ada", "ada", "Algorithms")?;
    insert_session(
        &conn,
        a.subject_id,
        30,
        &local_ts(&conn, 0, "09:00:00")?,
        None,
        None,
    )?;
    insert_session(
        &conn,
        a.subject_id,
        30,
        &local_ts(&conn, 1, "09:00:00")?,
        None,
        None,
    )?;
    insert_session(
        &conn,
        a.subject_id,
        30,
        &local_ts(&conn, 2, "09:00:00")?,
        None,
        None,
    )?;
    assert_eq!(
        study_streak(&conn, a.profile_id)?,
        3,
        "three distinct local days ending today must give a 3-day streak"
    );

    // (b) Two sessions on the SAME local day must not double-count.
    let b = seed_tree(&conn, "Bea", "bea", "Zoology")?;
    insert_session(
        &conn,
        b.subject_id,
        30,
        &local_ts(&conn, 0, "09:00:00")?,
        None,
        None,
    )?;
    insert_session(
        &conn,
        b.subject_id,
        30,
        &local_ts(&conn, 0, "19:00:00")?,
        None,
        None,
    )?;
    assert_eq!(
        study_streak(&conn, b.profile_id)?,
        1,
        "two sessions on one day must count as exactly one streak day"
    );
    assert_eq!(active_days(&conn, b.profile_id)?, 1);

    // (c) A gap day breaks the streak: today and 2-days-ago, nothing in between.
    let c = seed_tree(&conn, "Cal", "cal", "Chemistry")?;
    insert_session(
        &conn,
        c.subject_id,
        30,
        &local_ts(&conn, 0, "09:00:00")?,
        None,
        None,
    )?;
    insert_session(
        &conn,
        c.subject_id,
        30,
        &local_ts(&conn, 2, "09:00:00")?,
        None,
        None,
    )?;
    assert_eq!(
        study_streak(&conn, c.profile_id)?,
        1,
        "the real streak query stops at the first missing day — a gap breaks it"
    );

    // (d) No session today: the query anchors at yesterday and counts backwards.
    //     Today is NOT backdated, so this is 2 not 3.
    let d = seed_tree(&conn, "Dan", "dan", "Physics")?;
    insert_session(
        &conn,
        d.subject_id,
        30,
        &local_ts(&conn, 1, "09:00:00")?,
        None,
        None,
    )?;
    insert_session(
        &conn,
        d.subject_id,
        30,
        &local_ts(&conn, 2, "09:00:00")?,
        None,
        None,
    )?;
    assert_eq!(
        study_streak(&conn, d.profile_id)?,
        2,
        "with no session today the streak anchors at yesterday and counts 2"
    );

    // (e) No sessions at all.
    let e = seed_tree(&conn, "Eve", "eve", "Economics")?;
    assert_eq!(
        study_streak(&conn, e.profile_id)?,
        0,
        "no sessions must give a zero streak"
    );
    Ok(())
}

// ===== 13. List ordering ====================================================

#[test]
fn list_orders_newest_first_by_started_at_then_id() -> Result<(), Box<dyn Error>> {
    let conn = setup_test_db()?;
    let tree = seed_tree(&conn, "Ada", "ada", "Algorithms")?;

    // Inserted out of chronological order so id and started_at disagree.
    // s1 and s2 share a timestamp to exercise the `ss.id DESC` tie-break.
    let s1 = insert_session(
        &conn,
        tree.subject_id,
        10,
        "2026-01-10 09:00:00",
        None,
        None,
    )?;
    let s2 = insert_session(
        &conn,
        tree.subject_id,
        20,
        "2026-01-12 09:00:00",
        None,
        None,
    )?;
    let s3 = insert_session(
        &conn,
        tree.subject_id,
        30,
        "2026-01-11 09:00:00",
        None,
        None,
    )?;
    let s4 = insert_session(
        &conn,
        tree.subject_id,
        40,
        "2026-01-12 09:00:00",
        None,
        None,
    )?;

    let got = session_ids(&conn, tree.profile_id)?;
    assert_eq!(
        got,
        vec![s4, s2, s3, s1],
        "list must be started_at DESC, then id DESC for equal timestamps"
    );
    assert_eq!(
        got[0], s4,
        "the later-inserted twin must sort first on the id tie-break"
    );
    assert!(
        got.iter().all(|id| *id > 0),
        "every listed session must be a real row"
    );

    // ORDER BY is LEXICAL on TEXT, so it is only equivalent to chronological
    // for the fixed-width local format. date() itself happily parses an
    // ISO-8601 'T' separator, but 'T' (0x54) sorts after ' ' (0x20), so a
    // 'T'-formatted row jumps ahead of every same-day space-separated row and
    // heads the list. The renderer must therefore always emit the space form.
    let wrong = insert_session(
        &conn,
        tree.subject_id,
        50,
        "2026-01-12T23:00:00",
        None,
        None,
    )?;
    let after = session_ids(&conn, tree.profile_id)?;
    assert_eq!(
        after[0], wrong,
        "an ISO-8601 'T' timestamp sorts ahead of same-day space-separated rows — the renderer must not emit this"
    );
    Ok(())
}
