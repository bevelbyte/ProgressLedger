//! Phase 10 data-integrity regression test for the Browser Manager.
//!
//! Complements tests/browser_manager_crud.rs (which covers CRUD) with the
//! specific invariants called out in the brief: FK CASCADE, UNIQUE
//! (cf_profile_id, local_id), ordering, and cross-profile isolation at
//! the data layer (not just the Rust API).

use careerflow_core::db::browser_manager::{
    add_browser_profile, add_browser_shortcut, delete_browser_profile, list_browser_shortcuts,
};
use careerflow_core::db::{add_profile, init_db};
use std::sync::atomic::{AtomicU64, Ordering};

static DB_SEQ: AtomicU64 = AtomicU64::new(0);
static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn fresh_db(tag: &str) -> String {
    let n = DB_SEQ.fetch_add(1, Ordering::Relaxed);
    // PIDs are reusable across separate test invocations. Include a monotonic
    // wall-clock component so a new invocation can never reopen a stale DB
    // left by an earlier run with the same process id/sequence (which would
    // make the very first seed collide with that run's rows). Mirrors
    // browser_manager_crud.rs::fresh_db.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("cf-bm-di-{}-{}-{}-{}", tag, std::process::id(), nonce, n));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let path = dir.join("test.sqlite");
    init_db(path.to_string_lossy().to_string()).expect("init_db");
    path.to_string_lossy().to_string()
}

fn unique() -> u64 {
    static S: AtomicU64 = AtomicU64::new(0);
    S.fetch_add(1, Ordering::Relaxed)
}

fn seed_cf_profile(name: &str) -> i32 {
    add_profile(
        name.to_string(),
        format!("{}-{}", name.to_lowercase(), unique()),
    )
    .expect("add_profile")
    .id
}

#[test]
fn deleting_a_browser_profile_cascades_its_shortcuts() {
    let _g = serial();
    let _ = fresh_db("cascade");
    let cf = seed_cf_profile("CascadeUser");

    let profile = add_browser_profile(cf, "study".into(), "Study".into()).expect("add");
    let _shortcut1 = add_browser_shortcut(
        cf,
        profile.local_id.clone(),
        "Google".into(),
        "https://google.com".into(),
    )
    .expect("add shortcut");
    let _shortcut2 = add_browser_shortcut(
        cf,
        profile.local_id.clone(),
        "GitHub".into(),
        "https://github.com".into(),
    )
    .expect("add shortcut 2");

    let before = list_browser_shortcuts(cf, profile.local_id.clone()).expect("list");
    assert_eq!(before.len(), 2, "both shortcuts present before delete");

    delete_browser_profile(cf, profile.local_id.clone()).expect("delete profile");

    let after = list_browser_shortcuts(cf, profile.local_id.clone()).expect("list after");
    assert_eq!(
        after.len(),
        0,
        "shortcuts CASCADE-deleted with their parent browser profile"
    );
}

#[test]
fn profile_local_id_is_unique_within_a_cf_profile() {
    let _g = serial();
    let _ = fresh_db("unique");
    let cf = seed_cf_profile("UniqueUser");

    add_browser_profile(cf, "study".into(), "Study".into()).expect("first add");
    // Re-adding the same localId under the same CF profile must fail
    // (UNIQUE(cf_profile_id, local_id) is enforced).
    let err = add_browser_profile(cf, "study".into(), "Study Again".into());
    assert!(err.is_err(), "duplicate localId must be rejected");
}

#[test]
fn local_id_is_globally_unique_not_per_cf_profile() {
    // browser_profiles.local_id is the SQLite PRIMARY KEY — globally
    // unique across the whole database. Two different CF profiles cannot
    // both use the localId "study". The audit's "per-cf-profile" intuition
    // is wrong; this test pins the actual schema invariant.
    let _g = serial();
    let _ = fresh_db("reuse");
    let cf_a = seed_cf_profile("ReuseA");
    let cf_b = seed_cf_profile("ReuseB");

    add_browser_profile(cf_a, "study".into(), "A's Study".into()).expect("a add");
    let err = add_browser_profile(cf_b, "study".into(), "B's Study".into());
    assert!(
        err.is_err(),
        "localId is the global primary key; a duplicate must be rejected across CF profiles"
    );

    // A distinct localId under cf_b works.
    add_browser_profile(cf_b, "browsing".into(), "B's Browsing".into())
        .expect("b add unique localId");
}

#[test]
fn shortcuts_are_not_visible_to_other_cf_profiles() {
    let _g = serial();
    let _ = fresh_db("isolation");
    let cf_a = seed_cf_profile("IsolA");
    let cf_b = seed_cf_profile("IsolB");

    let p_a = add_browser_profile(cf_a, "a".into(), "A".into()).expect("a profile");
    let p_b = add_browser_profile(cf_b, "b".into(), "B".into()).expect("b profile");

    add_browser_shortcut(
        cf_a,
        p_a.local_id.clone(),
        "A's site".into(),
        "https://a.example/".into(),
    )
    .expect("a shortcut");
    add_browser_shortcut(
        cf_b,
        p_b.local_id.clone(),
        "B's site".into(),
        "https://b.example/".into(),
    )
    .expect("b shortcut");

    // A queries B's profile by localId: should see zero shortcuts, because
    // the list query is scoped by cf_profile_id.
    let a_view_of_b = list_browser_shortcuts(cf_a, p_b.local_id.clone()).expect("a view of b");
    assert_eq!(
        a_view_of_b.len(),
        0,
        "A's list query is scoped to cf_profile_id; cannot enumerate B's shortcuts"
    );

    let b_view_of_a = list_browser_shortcuts(cf_b, p_a.local_id.clone()).expect("b view of a");
    assert_eq!(
        b_view_of_a.len(),
        0,
        "symmetric: B cannot see A's shortcuts"
    );
}
