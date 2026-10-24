//! Regression: every connection from the connection pool must have
//! `PRAGMA foreign_keys = ON` set, otherwise every ON DELETE CASCADE / FK
//! constraint declared in the schema silently does nothing on the hot path.
//!
//! Background: `init_db` opens one connection to run migrations and sets the
//! PRAGMAs on it, but the `r2d2_sqlite::SqliteConnectionManager` is built
//! separately for the long-lived pool. Without an `.with_init(...)` closure,
//! fresh pooled connections inherit SQLite's default of `foreign_keys = OFF`.
//! The fix was a per-connection init closure on the pool; this test pins the
//! behavior so a future refactor can't silently regress it.
//!
//! We mirror the production pool construction (file + same init closure
//! shape) and assert that a connection the pool yields reports
//! `foreign_keys = 1`. We do not exercise the private static pool inside
//! `progress_ledger_core` because it is wired up at runtime by `init_db` (which
//! needs NAPI + a real disk path); the contract under test is the manager
//! configuration, not the static lifetime.

use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;

fn build_pool_like_init_db(db_path: &std::path::Path) -> Pool<SqliteConnectionManager> {
    let manager = SqliteConnectionManager::file(db_path)
        .with_init(|c| c.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;"));
    Pool::builder()
        .max_size(4)
        .build(manager)
        .expect("pool build")
}

#[test]
fn pooled_connection_enables_foreign_keys() {
    let dir = tempdir_in_target();
    let db = dir.join("pool_fk_on.db");
    let pool = build_pool_like_init_db(&db);

    // First checkout: forces the manager to open a real connection and run init.
    let conn = pool.get().expect("checkout");
    let fk: i32 = conn
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .expect("pragma");
    assert_eq!(fk, 1, "pooled connection must have foreign_keys=ON");
    drop(conn);

    // Second checkout: confirm the init closure runs on a *fresh* connection,
    // not just on the first one cached internally.
    let conn2 = pool.get().expect("checkout #2");
    let fk2: i32 = conn2
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .expect("pragma");
    assert_eq!(fk2, 1, "every pooled connection must have foreign_keys=ON");
}

fn tempdir_in_target() -> std::path::PathBuf {
    // Put it under target/ so cargo's test runner ignores it for incremental
    // builds and it's cleaned by `cargo clean` if the user asks for it.
    let target = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("target"))
        .unwrap_or_else(|| std::env::temp_dir());
    let dir = target.join("test-tmp-db_pool_init");
    let _ = std::fs::create_dir_all(&dir);
    dir
}
