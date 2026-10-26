//! Kept research passages are counted per BROWSER profile, not per
//! workspace. The old query in core/src/db/research.rs
//! `count_kept_research_passages` summed captures across every
//! browser profile of the workspace, so the browser bar's kept
//! count showed other profiles' passages as the active page's own.
//!
//! The #[napi] surface is NOT called here: it routes through a
//! process-global r2d2 pool that is unsafe to initialise from
//! parallel cargo tests. Assertions are raw SQL against the real
//! migrated schema, with the query under test copied verbatim
//! from core/src/db/research.rs (the ?3 parameter is the active
//! page's browser profile id).

use rusqlite::{params, Connection, Result};
use std::error::Error;
use std::fs;
use std::path::Path;

fn msg(err: String) -> Box<dyn Error> {
    Box::<dyn Error>::from(err)
}

fn setup_test_db() -> Result<Connection, Box<dyn Error>> {
    let conn = Connection::open_in_memory()?;
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
            .ok_or_else(|| msg(format!("migration {path:?}: bad version prefix")))?
            .split('_')
            .next()
            .ok_or_else(|| msg(format!("migration {path:?}: bad version prefix")))?
            .parse()
            .map_err(|e| msg(format!("migration {path:?}: bad version prefix: {e}")))?;
        let sql = fs::read_to_string(&path)?;
        conn.execute_batch(&format!(
            "BEGIN;\n{sql}\nPRAGMA user_version = {ver};\nCOMMIT;"
        ))?;
    }
    Ok(conn)
}

/// The production query, verbatim from count_kept_research_passages.
fn kept_count(conn: &Connection, profile_id: i64, canonical: &str, browser: Option<&str>) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM research_captures c JOIN research_sources s ON s.id=c.source_id WHERE c.profile_id=?1 AND s.canonical_url=?2 AND c.browser_profile_id IS ?3 AND s.browser_profile_id IS ?3 AND c.kind IN ('clip','highlight')",
        params![profile_id, canonical, browser],
        |r| r.get(0),
    )
    .expect("kept count query")
}

/// The old, global query (no browser filter) — kept only to prove
/// the bug this test guards against: it sums across profiles.
fn kept_count_old(conn: &Connection, profile_id: i64, canonical: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM research_captures c JOIN research_sources s ON s.id=c.source_id WHERE c.profile_id=?1 AND s.canonical_url=?2 AND c.kind IN ('clip','highlight')",
        params![profile_id, canonical],
        |r| r.get(0),
    )
    .expect("old kept count query")
}

#[test]
fn kept_count_is_per_browser_profile() -> Result<(), Box<dyn Error>> {
    let conn = setup_test_db()?;
    conn.execute("INSERT INTO profiles (name, slug) VALUES ('P', 'p')", [])?;
    let profile_id = conn.last_insert_rowid();
    let url = "http://127.0.0.1:8933/state";
    let canonical = "http://127.0.0.1:8933/state";

    // Two browser profiles capturing the same URL, plus one manual
    // (no browser) save of the same URL.
    let seed_source = |conn: &Connection, browser: Option<&str>| -> i64 {
        conn.execute(
            "INSERT INTO research_sources (profile_id, canonical_url, url, title, domain, browser_profile_id) VALUES (?1, ?2, ?3, 'State', '127.0.0.1:8933', ?4)",
            params![profile_id, canonical, url, browser],
        )
        .unwrap();
        conn.last_insert_rowid()
    };
    let src_a = seed_source(&conn, Some("bp-aaa"));
    let src_b = seed_source(&conn, Some("bp-bbb"));
    let src_manual = seed_source(&conn, None);

    let seed_capture = |conn: &Connection, source_id: i64, browser: Option<&str>, kind: &str, text: &str| {
        conn.execute(
            "INSERT INTO research_captures (profile_id, source_id, source_url, source_title, kind, text, browser_profile_id) VALUES (?1, ?2, ?3, 'State', ?4, ?5, ?6)",
            params![profile_id, source_id, url, kind, text, browser],
        )
        .unwrap();
    };
    // A: 2 kept (clips) + 1 extraction (never kept).
    seed_capture(&conn, src_a, Some("bp-aaa"), "clip", "alpha");
    seed_capture(&conn, src_a, Some("bp-aaa"), "clip", "beta");
    seed_capture(&conn, src_a, Some("bp-aaa"), "extraction", "gamma");
    // B: 1 kept.
    seed_capture(&conn, src_b, Some("bp-bbb"), "clip", "delta");
    // Manual: 1 kept, counted only for a no-browser query.
    seed_capture(&conn, src_manual, None, "clip", "manual");
    // Temporary profile: its temp-<uuid> id must count, not error.
    let src_temp = seed_source(&conn, Some("temp-ccc"));
    seed_capture(&conn, src_temp, Some("temp-ccc"), "clip", "tempclip");

    assert_eq!(kept_count(&conn, profile_id, canonical, Some("bp-aaa")), 2);
    assert_eq!(kept_count(&conn, profile_id, canonical, Some("bp-bbb")), 1);
    assert_eq!(kept_count(&conn, profile_id, canonical, Some("temp-ccc")), 1);
    assert_eq!(kept_count(&conn, profile_id, canonical, None), 1);
    // The old query summed everything: 2 + 1 + 1 + 1 = 5 kept passages
    // for one URL in one workspace. That is the bug.
    assert_eq!(kept_count_old(&conn, profile_id, canonical), 5);
    Ok(())
}
