//! Browser Manager CRUD: migration v15 application, ownership, cascade,
//! ordering and cross-CF-profile isolation for managed browser profiles.
//!
//! The #[napi] fns use the global pool created by init_db, so each test builds
//! its own throwaway database file (unique per call) and drives the exact same
//! functions the shell invokes.

use careerflow_core::db::browser_manager::{
    add_browser_profile, add_browser_shortcut, delete_browser_profile, delete_browser_shortcut,
    get_browser_profile, list_browser_profiles, list_browser_shortcuts,
    list_pinned_browser_shortcuts, rename_browser_profile, reorder_browser_profiles,
    reorder_browser_shortcuts, set_browser_profile_enabled, toggle_browser_shortcut_pin,
    touch_browser_profile, update_browser_shortcut,
};
use careerflow_core::db::{add_profile, init_db};
use std::sync::atomic::{AtomicU64, Ordering};

static DB_SEQ: AtomicU64 = AtomicU64::new(0);

/// init_db swaps the process-global connection pool, so parallel tests would
/// clobber each other's database. Serialize the whole suite instead.
static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn fresh_db(tag: &str) -> String {
    let n = DB_SEQ.fetch_add(1, Ordering::Relaxed);
    // PIDs are reusable across separate test invocations. Include a monotonic
    // wall-clock component so a new invocation can never reopen a stale DB
    // left by an earlier run with the same process id/sequence.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("cf-bm-{}-{}-{}-{}", tag, std::process::id(), nonce, n));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let path = dir.join("test.sqlite");
    init_db(path.to_string_lossy().to_string()).expect("init_db");
    path.to_string_lossy().to_string()
}

fn seed_cf_profile(name: &str) -> i32 {
    let slug = format!("{}-{}", name.to_lowercase(), unique_suffix());
    let p = add_profile(name.to_string(), slug).expect("add_profile");
    p.id
}

fn unique_suffix() -> u64 {
    static S: AtomicU64 = AtomicU64::new(0);
    S.fetch_add(1, Ordering::Relaxed)
}

#[test]
fn migration_v15_creates_tables_on_fresh_install() {
    let _serial = serial();
    // fresh_db runs init_db -> migrations; v15 must apply without error.
    fresh_db("migration");
    // Any CRUD call proves the tables exist.
    let owner = seed_cf_profile("Migration Owner");
    let rows = list_browser_profiles(owner).expect("list");
    assert!(rows.is_empty());
}

#[test]
fn add_and_list_are_scoped_to_their_owning_careerflow_profile() {
    let _serial = serial();
    let _db = fresh_db("isolation");
    let a = seed_cf_profile("Owner A");
    let b = seed_cf_profile("Owner B");

    let ra = add_browser_profile(a, "bp-a-1".to_string(), "Study Browser".into()).expect("add A");
    let rb =
        add_browser_profile(b, "bp-b-1".to_string(), "Research Browser".into()).expect("add B");

    let la = list_browser_profiles(a).expect("list A");
    let lb = list_browser_profiles(b).expect("list B");
    assert_eq!(la.len(), 1);
    assert_eq!(lb.len(), 1);
    assert_eq!(la[0].local_id, ra.local_id);
    assert_eq!(lb[0].local_id, rb.local_id);
    assert_ne!(la[0].local_id, lb[0].local_id);

    // Reads are ownership-gated: A reading B's local_id sees nothing.
    assert!(get_browser_profile(a, rb.local_id.clone())
        .unwrap()
        .is_none());
    assert!(get_browser_profile(b, rb.local_id.clone())
        .unwrap()
        .is_some());
    assert!(get_browser_profile(a, ra.local_id.clone())
        .unwrap()
        .is_some());
    assert!(list_browser_profiles(a)
        .unwrap()
        .iter()
        .all(|r| r.cf_profile_id == a));
}

#[test]
fn rename_touch_and_disable_update_only_the_target_row() {
    let _serial = serial();
    let _db = fresh_db("update");
    let owner = seed_cf_profile("Updater");
    let rec = add_browser_profile(owner, "bp-u-1".to_string(), "Before".into()).unwrap();

    rename_browser_profile(owner, rec.local_id.clone(), "After".into()).unwrap();
    touch_browser_profile(owner, rec.local_id.clone()).unwrap();
    set_browser_profile_enabled(owner, rec.local_id.clone(), false).unwrap();

    let after = get_browser_profile(owner, rec.local_id.clone())
        .unwrap()
        .unwrap();
    assert_eq!(after.display_name, "After");
    assert!(after.last_used_at.is_some());
    assert!(!after.enabled);
}

#[test]
fn deleting_a_browser_profile_cascades_its_shortcuts() {
    let _serial = serial();
    let _db = fresh_db("cascade");
    let owner = seed_cf_profile("Cascade Owner");
    let rec = add_browser_profile(owner, "bp-c-1".to_string(), "Cascading".into()).unwrap();
    add_browser_shortcut(
        owner,
        rec.local_id.clone(),
        "GitHub".into(),
        "https://github.com".into(),
    )
    .unwrap();

    delete_browser_profile(owner, rec.local_id.clone()).unwrap();

    assert!(get_browser_profile(owner, rec.local_id.clone())
        .unwrap()
        .is_none());
    assert!(
        list_browser_shortcuts(owner, rec.local_id.clone())
            .unwrap()
            .is_empty(),
        "shortcuts must cascade with their browser profile"
    );
}

#[test]
fn shortcut_crud_and_explicit_reordering_work() {
    let _serial = serial();
    let _db = fresh_db("shortcuts");
    let owner = seed_cf_profile("Shortcut Owner");
    let rec = add_browser_profile(owner, "bp-s-1".to_string(), "Shortcuts".into()).unwrap();

    let gh = add_browser_shortcut(
        owner,
        rec.local_id.clone(),
        "GitHub".into(),
        "https://github.com".into(),
    )
    .unwrap();
    let arx = add_browser_shortcut(
        owner,
        rec.local_id.clone(),
        "arXiv".into(),
        "https://arxiv.org".into(),
    )
    .unwrap();

    update_browser_shortcut(
        owner,
        arx.id,
        "arXiv (mirror)".into(),
        "https://arxiv.org/mirror".into(),
    )
    .unwrap();
    delete_browser_shortcut(owner, gh.id).unwrap();

    reorder_browser_shortcuts(owner, rec.local_id.clone(), vec![arx.id]).unwrap();
    let listed = list_browser_shortcuts(owner, rec.local_id.clone()).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].label, "arXiv (mirror)");
    assert_eq!(listed[0].position, 1);
}

#[test]
fn browser_profile_reordering_is_persisted_per_owner() {
    let _serial = serial();
    let _db = fresh_db("reorder");
    let owner = seed_cf_profile("Reorder Owner");
    let p1 = add_browser_profile(owner, "bp-r-1".to_string(), "One".into()).unwrap();
    let p2 = add_browser_profile(owner, "bp-r-2".to_string(), "Two".into()).unwrap();

    reorder_browser_profiles(owner, vec![p2.local_id.clone(), p1.local_id.clone()]).unwrap();

    let listed = list_browser_profiles(owner).unwrap();
    assert_eq!(listed[0].local_id, p2.local_id);
    assert_eq!(listed[1].local_id, p1.local_id);
}

#[test]
fn schema_v15_is_recorded_and_manager_tables_exist() {
    let _serial = serial();
    let path = fresh_db("schema");
    // Re-open and verify user_version + table presence through the same pool.
    let conn = rusqlite::Connection::open(&path).expect("reopen");
    let ver: i32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .expect("user_version");
    assert!(
        ver >= 15,
        "migration runner must land on schema v15 or later (got {ver})"
    );
    for table in ["browser_profiles", "browser_shortcuts"] {
        let n: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |r| r.get(0),
            )
            .expect("sqlite_master");
        assert_eq!(n, 1, "{table} missing");
    }
}

// ----------------------------------------------------------------
// Ownership invariant — adversarial cross-profile tests.
// Every mutation in browser_manager.rs MUST be rejected when the
// supplied cf_profile_id does not own the target row.
// ----------------------------------------------------------------

#[test]
fn cross_profile_mutation_is_rejected_without_mutating_owner() {
    let _serial = serial();
    let _db = fresh_db("cross-mut");
    let a = seed_cf_profile("Owner A");
    let b = seed_cf_profile("Owner B");
    let bp = add_browser_profile(a, "bp-x-1".to_string(), "Owned By A".into()).unwrap();
    let sc = add_browser_shortcut(
        a,
        bp.local_id.clone(),
        "GitHub".into(),
        "https://github.com".into(),
    )
    .unwrap();

    // A owns Browser A. B must not rename, enable, disable, delete,
    // reorder, edit, add a shortcut under, delete, or reorder A's
    // shortcut. Every one of these must fail with a NOT_OWNED error
    // and leave A's data untouched.

    let mut any = false;
    let cases: Vec<Box<dyn Fn() -> Result<(), napi::Error>>> = vec![
        // rename
        Box::new(|| rename_browser_profile(b, bp.local_id.clone(), "Hijacked".into())),
        // set-enabled
        Box::new(|| set_browser_profile_enabled(b, bp.local_id.clone(), false)),
        // touch
        Box::new(|| touch_browser_profile(b, bp.local_id.clone())),
        // delete
        Box::new(|| delete_browser_profile(b, bp.local_id.clone())),
        // shortcut CRUD
        Box::new(|| {
            add_browser_shortcut(
                b,
                bp.local_id.clone(),
                "Evil".into(),
                "https://example.com/evil".into(),
            )
            .map(|_| ())
        }),
        Box::new(|| {
            update_browser_shortcut(b, sc.id, "Hijack".into(), "https://example.com/x".into())
        }),
        Box::new(|| delete_browser_shortcut(b, sc.id)),
    ];
    for f in cases {
        if f().is_ok() {
            any = true;
        }
    }
    assert!(!any, "at least one cross-profile mutation slipped through");

    // Reorder: a foreign reorder list must be rejected wholesale.
    let reorder_err = reorder_browser_profiles(b, vec![bp.local_id.clone()]).err();
    assert!(
        reorder_err.is_some(),
        "reorder with foreign cf_profile_id must fail"
    );
    let reorder_sc_err = reorder_browser_shortcuts(b, bp.local_id.clone(), vec![sc.id]).err();
    assert!(
        reorder_sc_err.is_some(),
        "shortcut reorder with foreign cf_profile_id must fail"
    );

    // A's row is intact: original name still wins, original shortcut still there.
    let a_row = get_browser_profile(a, bp.local_id.clone())
        .unwrap()
        .unwrap();
    assert_eq!(a_row.display_name, "Owned By A");
    assert!(
        a_row.enabled,
        "A's row must still be enabled (B's disable must not have applied)"
    );
    let a_shorts = list_browser_shortcuts(a, bp.local_id.clone()).unwrap();
    assert_eq!(a_shorts.len(), 1);
    assert_eq!(a_shorts[0].id, sc.id);
    assert_eq!(a_shorts[0].label, "GitHub");
    // URL is stored as the validator-serialized form (trailing slash on
    // a bare host is the canonical serialization of the `url` crate).
    assert_eq!(a_shorts[0].url, "https://github.com/");
    assert!(a_shorts[0].cf_profile_id == a);
}

#[test]
fn cross_profile_read_does_not_discover_foreign_rows() {
    let _serial = serial();
    let _db = fresh_db("cross-read");
    let a = seed_cf_profile("Owner A");
    let b = seed_cf_profile("Owner B");
    let bp = add_browser_profile(a, "bp-r-1".to_string(), "A Only".into()).unwrap();
    add_browser_shortcut(
        a,
        bp.local_id.clone(),
        "A's Shortcut".into(),
        "https://example.com/a".into(),
    )
    .unwrap();

    // B listing A's local_id sees no rows and no shortcuts.
    let bp_from_b = get_browser_profile(b, bp.local_id.clone()).unwrap();
    assert!(
        bp_from_b.is_none(),
        "B must not see A's browser profile row"
    );
    let shorts_from_b = list_browser_shortcuts(b, bp.local_id.clone()).unwrap();
    assert!(shorts_from_b.is_empty(), "B must not see A's shortcut rows");
}

#[test]
fn add_rejects_unknown_cf_profile_id() {
    let _serial = serial();
    let _db = fresh_db("unknown-cf");
    let err = add_browser_profile(99_999, "bp-u-1".to_string(), "Ghost".into()).err();
    assert!(
        err.is_some(),
        "add with a non-existent cf_profile_id must be rejected"
    );
}

#[test]
fn add_rejects_blank_inputs() {
    let _serial = serial();
    let _db = fresh_db("blank-inputs");
    let owner = seed_cf_profile("Blank Owner");
    let blank_local = add_browser_profile(owner, "   ".to_string(), "Name".into()).err();
    assert!(blank_local.is_some(), "blank local_id must be rejected");
    let blank_name = add_browser_profile(owner, "bp-b-1".to_string(), "  ".into()).err();
    assert!(blank_name.is_some(), "blank display_name must be rejected");
}

#[test]
fn shortcut_storage_rejects_invalid_url_schemes() {
    let _serial = serial();
    let _db = fresh_db("bad-urls");
    let owner = seed_cf_profile("URL Owner");
    let bp = add_browser_profile(owner, "bp-u-1".to_string(), "Bad URL Browser".into()).unwrap();
    for bad in [
        "javascript:alert(1)",
        "file:///c/secret",
        "data:text/html,x",
        "vbscript:msgbox(1)",
        "ftp://example.com",
        "not a url",
        "",
        "  ",
    ] {
        let err = add_browser_shortcut(owner, bp.local_id.clone(), "Evil".into(), bad.into()).err();
        assert!(err.is_some(), "add with url {bad:?} must be rejected");
    }
    // update path is also gated
    let sc = add_browser_shortcut(
        owner,
        bp.local_id.clone(),
        "Start".into(),
        "https://example.com/initial".into(),
    )
    .unwrap();
    for bad in ["javascript:alert(2)", "file:///c/secret", ""] {
        let err = update_browser_shortcut(owner, sc.id, "Updated".into(), bad.into()).err();
        assert!(err.is_some(), "update with url {bad:?} must be rejected");
    }
    // The original valid URL survives every failed update.
    let still = list_browser_shortcuts(owner, bp.local_id.clone()).unwrap();
    assert_eq!(still[0].url, "https://example.com/initial");
}

#[test]
fn shortcut_storage_preserves_storage_and_open_time_validation() {
    let _serial = serial();
    let _db = fresh_db("valid-urls");
    let owner = seed_cf_profile("Valid URL Owner");
    let bp = add_browser_profile(owner, "bp-v-1".to_string(), "Good Browser".into()).unwrap();
    for (label, url) in [
        ("GitHub", "https://github.com"),
        ("Docs", "https://docs.example.com/path?x=1"),
        ("Localhost", "http://127.0.0.1:8080/health"),
    ] {
        add_browser_shortcut(owner, bp.local_id.clone(), label.into(), url.into()).unwrap();
    }
    let listed = list_browser_shortcuts(owner, bp.local_id.clone()).unwrap();
    assert_eq!(listed.len(), 3);
    for r in &listed {
        assert!(r.url.starts_with("http://") || r.url.starts_with("https://"));
        assert!(!r.url.is_empty());
    }
}

#[test]
fn concurrent_adds_with_different_local_ids_do_not_collide() {
    let _serial = serial();
    let _db = fresh_db("concurrent-adds");
    let owner = seed_cf_profile("Concurrent Owner");
    // 20 parallel adds, each with its own local_id. The unique-PK invariant
    // means they must all succeed and the listing must contain them all in
    // insertion order.
    let mut handles = Vec::new();
    for i in 0..20 {
        let local = format!("bp-c-{i}");
        let owner_clone = owner;
        handles.push(std::thread::spawn(move || {
            add_browser_profile(owner_clone, local, format!("Browser {i}").into())
                .expect("parallel add")
        }));
    }
    let added: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(added.len(), 20);
    let listed = list_browser_profiles(owner).expect("list");
    assert_eq!(listed.len(), 20);
}

#[test]
fn concurrent_adds_with_the_same_local_id_lose_exactly_one() {
    let _serial = serial();
    let _db = fresh_db("same-local");
    let owner = seed_cf_profile("Same Local Owner");
    // 20 parallel adds with the same local_id: the UNIQUE PK on local_id
    // (schema v15) means exactly one wins. The race is benign: no foreign
    // profile is ever written because the call is scoped to the same
    // cf_profile_id.
    let mut handles = Vec::new();
    for _ in 0..20 {
        let local = "bp-collision".to_string();
        let owner_clone = owner;
        handles.push(std::thread::spawn(move || {
            add_browser_profile(owner_clone, local, "Racing".into())
        }));
    }
    let outcomes: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let wins = outcomes.iter().filter(|r| r.is_ok()).count();
    let losses = outcomes.iter().filter(|r| r.is_err()).count();
    assert_eq!(wins, 1, "exactly one parallel add must win");
    assert_eq!(losses, 19);
    let listed = list_browser_profiles(owner).expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].display_name, "Racing");
}

// ----------------------------------------------------------------
// Quick Actions pin/ownership/cascade (Phase 3 of Quick Actions).
// ----------------------------------------------------------------

#[test]
fn pin_is_rejected_by_foreign_profile_and_shortcut_routes_to_owner() {
    let _serial = serial();
    let _db = fresh_db("pin-ownership");
    let a = seed_cf_profile("Pin Owner A");
    let b = seed_cf_profile("Pin Owner B");
    let bp = add_browser_profile(a, "bp-p-1".to_string(), "Pinned Browser".into()).unwrap();
    let sc = add_browser_shortcut(
        a,
        bp.local_id.clone(),
        "GitHub".into(),
        "https://github.com".into(),
    )
    .unwrap();

    // B cannot pin or unpin A's shortcut.
    assert!(toggle_browser_shortcut_pin(b, sc.id, true).is_err());
    assert!(toggle_browser_shortcut_pin(b, sc.id, false).is_err());

    // A can pin and unpin its own shortcut.
    toggle_browser_shortcut_pin(a, sc.id, true).unwrap();
    let listed = list_pinned_browser_shortcuts(a).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, sc.id);
    assert!(listed[0].pinned);
    toggle_browser_shortcut_pin(a, sc.id, false).unwrap();
    let after = list_pinned_browser_shortcuts(a).unwrap();
    assert!(after.is_empty());
}

#[test]
fn pinned_listing_is_scoped_per_careerflow_profile() {
    let _serial = serial();
    let _db = fresh_db("pin-isolation");
    let a = seed_cf_profile("Iso A");
    let b = seed_cf_profile("Iso B");
    let bp_a = add_browser_profile(a, "bp-ia-1".to_string(), "A's Browser".into()).unwrap();
    let bp_b = add_browser_profile(b, "bp-ib-1".to_string(), "B's Browser".into()).unwrap();
    let sc_a = add_browser_shortcut(
        a,
        bp_a.local_id.clone(),
        "Facebook".into(),
        "https://facebook.com".into(),
    )
    .unwrap();
    let sc_b = add_browser_shortcut(
        b,
        bp_b.local_id.clone(),
        "Instagram".into(),
        "https://instagram.com".into(),
    )
    .unwrap();
    toggle_browser_shortcut_pin(a, sc_a.id, true).unwrap();
    toggle_browser_shortcut_pin(b, sc_b.id, true).unwrap();

    let pinned_a = list_pinned_browser_shortcuts(a).unwrap();
    let pinned_b = list_pinned_browser_shortcuts(b).unwrap();
    assert_eq!(pinned_a.len(), 1);
    assert_eq!(pinned_a[0].id, sc_a.id);
    assert_eq!(pinned_b.len(), 1);
    assert_eq!(pinned_b[0].id, sc_b.id);
    // No leakage either way.
    assert!(pinned_a.iter().all(|s| s.cf_profile_id == a));
    assert!(pinned_b.iter().all(|s| s.cf_profile_id == b));
}

#[test]
fn deleting_a_shortcut_drops_its_pin_immediately() {
    let _serial = serial();
    let _db = fresh_db("pin-cascade-shortcut");
    let owner = seed_cf_profile("Pin Cascade");
    let bp = add_browser_profile(owner, "bp-c-1".to_string(), "Cascading Pin".into()).unwrap();
    let sc = add_browser_shortcut(
        owner,
        bp.local_id.clone(),
        "Mood".into(),
        "https://mood.example.com".into(),
    )
    .unwrap();
    toggle_browser_shortcut_pin(owner, sc.id, true).unwrap();
    assert_eq!(list_pinned_browser_shortcuts(owner).unwrap().len(), 1);
    delete_browser_shortcut(owner, sc.id).unwrap();
    assert!(list_pinned_browser_shortcuts(owner).unwrap().is_empty());
}

#[test]
fn deleting_a_browser_profile_drops_its_pinned_shortcuts() {
    let _serial = serial();
    let _db = fresh_db("pin-cascade-bp");
    let owner = seed_cf_profile("Pin Cascade BP");
    let bp = add_browser_profile(owner, "bp-cb-1".to_string(), "Cascading BP".into()).unwrap();
    let sc1 = add_browser_shortcut(
        owner,
        bp.local_id.clone(),
        "GitHub".into(),
        "https://github.com".into(),
    )
    .unwrap();
    let sc2 = add_browser_shortcut(
        owner,
        bp.local_id.clone(),
        "Docs".into(),
        "https://docs.example.com".into(),
    )
    .unwrap();
    toggle_browser_shortcut_pin(owner, sc1.id, true).unwrap();
    toggle_browser_shortcut_pin(owner, sc2.id, true).unwrap();
    assert_eq!(list_pinned_browser_shortcuts(owner).unwrap().len(), 2);
    delete_browser_profile(owner, bp.local_id.clone()).unwrap();
    assert!(list_pinned_browser_shortcuts(owner).unwrap().is_empty());
}

#[test]
fn disabled_browser_profile_hides_its_pinned_shortcuts() {
    let _serial = serial();
    let _db = fresh_db("pin-disabled");
    let owner = seed_cf_profile("Pin Disabled");
    let bp = add_browser_profile(owner, "bp-d-1".to_string(), "Disabled Browser".into()).unwrap();
    let sc = add_browser_shortcut(
        owner,
        bp.local_id.clone(),
        "Docs".into(),
        "https://docs.example.com".into(),
    )
    .unwrap();
    toggle_browser_shortcut_pin(owner, sc.id, true).unwrap();
    assert_eq!(list_pinned_browser_shortcuts(owner).unwrap().len(), 1);
    set_browser_profile_enabled(owner, bp.local_id.clone(), false).unwrap();
    // The shortcut is still pinned at the row level, but the panel must
    // hide it because the owning browser profile is disabled.
    assert!(list_pinned_browser_shortcuts(owner).unwrap().is_empty());
    // Re-enable and it reappears.
    set_browser_profile_enabled(owner, bp.local_id.clone(), true).unwrap();
    assert_eq!(list_pinned_browser_shortcuts(owner).unwrap().len(), 1);
}

#[test]
fn pinned_listing_orders_by_browser_profile_then_shortcut_position() {
    let _serial = serial();
    let _db = fresh_db("pin-order");
    let owner = seed_cf_profile("Pin Order");
    let bp1 = add_browser_profile(owner, "bp-o-1".to_string(), "Social".into()).unwrap();
    let bp2 = add_browser_profile(owner, "bp-o-2".to_string(), "Dev".into()).unwrap();
    // bp2 is created AFTER bp1, so position sorts bp1 first.
    // Pin two shortcuts on each.
    let s1a = add_browser_shortcut(
        owner,
        bp1.local_id.clone(),
        "Facebook".into(),
        "https://facebook.com".into(),
    )
    .unwrap();
    let s1b = add_browser_shortcut(
        owner,
        bp1.local_id.clone(),
        "Instagram".into(),
        "https://instagram.com".into(),
    )
    .unwrap();
    let s2a = add_browser_shortcut(
        owner,
        bp2.local_id.clone(),
        "GitHub".into(),
        "https://github.com".into(),
    )
    .unwrap();
    let s2b = add_browser_shortcut(
        owner,
        bp2.local_id.clone(),
        "Docs".into(),
        "https://docs.example.com".into(),
    )
    .unwrap();
    for s in [&s1a, &s1b, &s2a, &s2b] {
        toggle_browser_shortcut_pin(owner, s.id, true).unwrap();
    }
    let pinned = list_pinned_browser_shortcuts(owner).unwrap();
    let labels: Vec<_> = pinned.iter().map(|p| p.label.clone()).collect();
    assert_eq!(labels, vec!["Facebook", "Instagram", "GitHub", "Docs"]);
}

#[test]
fn pin_unknown_shortcut_is_an_error_not_a_silent_noop() {
    let _serial = serial();
    let _db = fresh_db("pin-unknown");
    let owner = seed_cf_profile("Pin Unknown");
    assert!(toggle_browser_shortcut_pin(owner, 999_999, true).is_err());
    assert!(list_pinned_browser_shortcuts(owner).unwrap().is_empty());
}

#[test]
fn pin_on_unknown_cf_profile_is_an_error() {
    let _serial = serial();
    let _db = fresh_db("pin-unknown-cf");
    assert!(list_pinned_browser_shortcuts(424_242).is_err());
}
