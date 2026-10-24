//! Browser Manager portability roundtrip: export a profile that owns managed
//! browser profiles + URL shortcuts, import it as a NEW CareerFlow profile,
//! and verify:
//!   * display metadata and shortcuts survive (order included)
//!   * each restored browser profile gets a FRESH local id (`imp-<pid>-<n>`)
//!     so the machine-local Donut binding can never silently re-attach
//!   * no Donut UUID is present anywhere in the exported bundle manifest

use careerflow_core::db::browser_manager::{
    add_browser_profile, add_browser_shortcut, get_browser_profile, list_browser_profiles,
    list_browser_shortcuts, list_pinned_browser_shortcuts, toggle_browser_shortcut_pin,
};
use careerflow_core::db::{add_profile, init_db};
use careerflow_core::portability::{export_profile_conn, import_bundle_conn};
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

fn unique(tag: &str) -> String {
    format!("{}-{}", tag, SEQ.fetch_add(1, Ordering::Relaxed))
}

fn unique_suffix() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

#[test]
fn browser_metadata_and_shortcuts_roundtrip_with_fresh_local_ids() {
    let tag = unique("roundtrip");
    let src_db = std::env::temp_dir().join(format!("cf-bm-src-{tag}.sqlite"));
    let _ = std::fs::remove_file(&src_db); // pid reuse can collide with stale runs
    init_db(src_db.to_string_lossy().to_string()).expect("init src db");

    // Owner + two managed browser profiles with shortcuts.
    let owner = add_profile(
        "Browser Roundtrip".into(),
        format!("bm-{}", unique_suffix()),
    )
    .expect("profile");
    let bp1 = add_browser_profile(owner.id, format!("bp-{tag}-1"), "Study Browser".into()).unwrap();
    add_browser_shortcut(
        owner.id,
        bp1.local_id.clone(),
        "GitHub".into(),
        "https://github.com".into(),
    )
    .unwrap();
    let bp2 =
        add_browser_profile(owner.id, format!("bp-{tag}-2"), "Research Browser".into()).unwrap();
    add_browser_shortcut(
        owner.id,
        bp2.local_id.clone(),
        "arXiv".into(),
        "https://arxiv.org".into(),
    )
    .unwrap();
    // Quick Actions pin: the first shortcut is pinned. The pin is portable
    // user intent; the roundtrip must preserve it on the restored row.
    let sc1_id = list_browser_shortcuts(owner.id, bp1.local_id.clone()).unwrap()[0].id;
    toggle_browser_shortcut_pin(owner.id, sc1_id, true).unwrap();

    // Export through the same connection-level entry point the shell uses.
    let out_path = std::env::temp_dir()
        .join(format!("cf-bm-export-{tag}.cfprofile"))
        .to_string_lossy()
        .to_string();
    let conn = rusqlite::Connection::open(&src_db).expect("open src");
    let manifest =
        export_profile_conn(&conn, owner.id, &out_path, None).expect("export_profile_conn");

    // No machine-local Donut UUID may appear in the portable manifest.
    let serialized = serde_json::to_string(&manifest).unwrap();
    assert!(!serialized.to_lowercase().contains("donut"));
    assert!(!serialized.contains("bfc-"));
    assert!(!serialized.contains("donutProfileId"));

    let browsers = manifest["browserProfiles"].as_array().expect("browsers");
    assert_eq!(browsers.len(), 2);
    assert_eq!(browsers[0]["displayName"], "Study Browser");
    assert_eq!(browsers[1]["displayName"], "Research Browser");
    assert_eq!(browsers[0]["shortcuts"].as_array().unwrap().len(), 1);
    assert!(browsers[0].get("donutProfileId").is_none());
    assert!(browsers[1].get("donutProfileId").is_none());
    // Pinned state is portable user intent: must be present in the manifest.
    assert_eq!(browsers[0]["shortcuts"][0]["pinned"], true);
    assert_eq!(browsers[1]["shortcuts"][0]["pinned"], false);

    // Import into a FRESH database: new CareerFlow profile, fresh local ids.
    let dst_db = std::env::temp_dir().join(format!("cf-bm-dst-{tag}.sqlite"));
    let _ = std::fs::remove_file(&dst_db);
    init_db(dst_db.to_string_lossy().to_string()).expect("init dst db");
    let dst = rusqlite::Connection::open(&dst_db).expect("open dst");
    let result = import_bundle_conn(&dst, &out_path, None).expect("import_bundle_conn");

    let restored_profiles = list_browser_profiles(result.profile_id).expect("list");
    assert_eq!(restored_profiles.len(), 2);
    assert_eq!(restored_profiles[0].display_name, "Study Browser");
    assert_eq!(restored_profiles[1].display_name, "Research Browser");

    // Fresh local ids: neither equals the source-side ids, so the machine-local
    // binding store on this machine can never accidentally match them.
    assert_ne!(restored_profiles[0].local_id, bp1.local_id);
    assert_ne!(restored_profiles[1].local_id, bp2.local_id);
    assert!(
        restored_profiles[0]
            .local_id
            .starts_with(&format!("imp-{}-", result.profile_id)),
        "restored local ids must be marked as imported"
    );

    let sc =
        list_browser_shortcuts(result.profile_id, restored_profiles[0].local_id.clone()).unwrap();
    assert_eq!(sc.len(), 1);
    assert_eq!(sc[0].label, "GitHub");
    assert_eq!(sc[0].url, "https://github.com/");

    // Adversarial: the restored row's cfProfileId must be the NEW CareerFlow
    // profile id (the one created by import), not the source profile id. A
    // restored row that pointed back at the source id would silently inherit
    // the source's Donut binding cache when the new profile's bfc-<localId>
    // resolution hits a stale entry.
    let restored_bp = get_browser_profile(result.profile_id, restored_profiles[0].local_id.clone())
        .unwrap()
        .unwrap();
    assert_eq!(
        restored_bp.cf_profile_id, result.profile_id,
        "restored row's cf_profile_id must be the new CF profile id"
    );
    // Belt-and-braces: no other CF profile in this database can claim that
    // row by guessing the local id (read returns None for any non-owner).
    let bogus_id = result.profile_id + 9_999_999;
    let leaked = get_browser_profile(bogus_id, restored_profiles[0].local_id.clone()).unwrap();
    assert!(
        leaked.is_none(),
        "restored row must not be reachable via a foreign cf_profile_id"
    );

    let _ = std::fs::remove_file(&out_path);
    let _ = std::fs::remove_file(&src_db);
    let _ = std::fs::remove_file(&dst_db);
}
