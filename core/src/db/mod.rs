//! Database layer - organized into logical modules for maintainability.
//!
//! This module provides the core database operations for CareerFlow, organized
//! by feature domain. Each sub-module handles a specific area of functionality.

mod academic;
pub mod browser_manager;
mod career;
mod goals;
mod project_mode;
mod run_state;

/// Re-exports used by integration tests and the shell's profile surface.
pub use academic::{add_profile, delete_profile, get_profiles};
pub use deadlines::{
    add_deadline, calculate_deadline_pace, delete_deadline, get_deadline_paces, get_deadlines,
    set_deadline_completion, update_deadline,
};
pub use formula_board::{add_formula, delete_formula, get_formulas, update_formula};
pub use lab_tracker::{add_experiment, delete_experiment, get_experiments, update_experiment};
pub use mistakes::{add_mistake, delete_mistake, get_mistakes, update_mistake};
pub use subject_links::{
    add_subject_link, delete_subject_link, get_subject_links, set_primary_link, update_subject_link,
};
mod cards;
mod courses;
mod deadlines;
mod focus;
pub mod focus_signals;
mod formula_board;
mod lab_tracker;
mod mistakes;
mod projects;
mod resources;
pub mod research;
mod semester_overview;
mod study_sessions;
mod subject_links;
mod subject_overview;

pub(crate) use resources::ensure_attachment_profile_dir;

use napi::bindgen_prelude::*;
use rusqlite::Connection;
use std::sync::Mutex;

use crate::errors::{coded, codes};

use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;

// Connection pool for concurrent database access
static DB_POOL: Mutex<Option<Pool<SqliteConnectionManager>>> = Mutex::new(None);

// Root dir for copied PDF attachments: <userData>/attachments. Set by init_db.
static ATTACH_ROOT: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

pub(crate) fn attach_root() -> Result<std::path::PathBuf> {
    ATTACH_ROOT
        .lock()
        .map_err(|_| coded(codes::INTERNAL, "attachments root poisoned"))?
        .clone()
        .ok_or_else(|| {
            coded(
                codes::DB_NOT_INITIALIZED,
                "Attachments root not set Ã¢â‚¬â€ call init_db first",
            )
        })
}

pub fn log_debug(level: &str, message: &str) {
    let mut log_path = None;
    if let Ok(cwd) = std::env::current_dir() {
        if cwd.join("package.json").exists() {
            let logs_dir = cwd.join("logs");
            let _ = std::fs::create_dir_all(&logs_dir);
            log_path = Some(logs_dir.join("careerflow.log"));
        }
    }

    let path = log_path.unwrap_or_else(|| {
        if let Ok(mut root) = attach_root() {
            root.pop();
            root.join("careerflow.log")
        } else {
            std::path::PathBuf::from("careerflow.log")
        }
    });

    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write;
        let timestamp = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f");
        let _ = writeln!(file, "[{}] [{}] [RUST] {}", timestamp, level, message);
        eprintln!("[{}] [{}] [RUST] {}", timestamp, level, message);
    }
}

/// Map a rusqlite error to a coded napi error.
///
/// We intentionally do NOT pass `e.to_string()` straight to the renderer.
/// SQLite's formatted error includes the offending column + value, which
/// would let a renderer probe extract schema/constraint details and
/// adjacent stored values. We collapse to a stable coded message; full
/// details remain available in `careerflow.log` (stderr) for diagnosis.
pub(crate) fn to_err(e: rusqlite::Error) -> Error {
    use rusqlite::{Error::SqliteFailure, ErrorCode};
    let _ = e; // detail is logged but not returned to the renderer
    log_debug("error", &format!("db: {e}"));
    match e {
        SqliteFailure(inner, _) if inner.code == ErrorCode::ConstraintViolation => {
            coded(codes::DB_CONSTRAINT, "Database constraint violated")
        }
        SqliteFailure(inner, _) if inner.code == ErrorCode::DatabaseBusy => {
            coded(codes::DB_ERROR, "Database is busy; please retry")
        }
        _ => coded(codes::DB_ERROR, "Database error"),
    }
}

/// Run a closure with a connection from the pool, or fail if init_db wasn't called.
pub(crate) fn with_db<T>(f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    let guard = DB_POOL
        .lock()
        .map_err(|_| coded(codes::INTERNAL, "DB pool mutex poisoned"))?;
    let pool = guard.as_ref().ok_or_else(|| {
        coded(
            codes::DB_NOT_INITIALIZED,
            "Database not initialized Ã¢â‚¬â€ call init_db first",
        )
    })?;

    let conn = pool.get().map_err(|e| {
        coded(
            codes::DB_ERROR,
            format!("Failed to get connection from pool: {e}"),
        )
    })?;

    f(&*conn)
}

/// Run a closure within a database transaction. Automatically commits on success,
/// rolls back on error.
pub(crate) fn with_transaction<T>(f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    with_db(|conn| {
        let tx = conn.unchecked_transaction().map_err(to_err)?;
        match f(&*tx) {
            Ok(result) => {
                tx.commit().map_err(to_err)?;
                Ok(result)
            }
            Err(e) => {
                tx.rollback().map_err(to_err)?;
                Err(e)
            }
        }
    })
}

/// Run a write transaction with SQLite's RESERVED lock acquired before the closure reads any state. This prevents concurrent read-then-write sequences from observing the same value.
pub(crate) fn with_immediate_transaction<T>(
    f: impl FnOnce(&Connection) -> Result<T>,
) -> Result<T> {
    with_db(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE;").map_err(to_err)?;
        match f(conn) {
            Ok(result) => {
                conn.execute_batch("COMMIT;").map_err(to_err)?;
                Ok(result)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                Err(e)
            }
        }
    })
}

/// Open (or create) the SQLite file at `db_path` and ensure the schema exists.
/// `db_path` is supplied by Electron from app.getPath('userData').
#[napi]
pub fn init_db(db_path: String) -> Result<()> {
    let conn = Connection::open(&db_path).map_err(|e| {
        coded(
            codes::DB_ERROR,
            format!("Failed to open DB at {db_path}: {e}"),
        )
    })?;

    // Connection-level pragmas must live OUTSIDE a transaction (the migration
    // runner wraps each migration in BEGIN/COMMIT, so it can't set these).
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
        .map_err(to_err)?;

    // Apply any pending ordered migrations (tracked via PRAGMA user_version).
    // New installs get the full schema; existing DBs upgrade with no data loss.
    crate::migrations::run(&conn)?;

    // Attachments live alongside the DB file: <userData>/attachments/.
    let root = std::path::Path::new(&db_path)
        .parent()
        .map(|p| p.join("attachments"))
        .unwrap_or_else(|| std::path::PathBuf::from("attachments"));
    std::fs::create_dir_all(&root).map_err(|e| {
        coded(
            codes::IO_ERROR,
            format!("Failed to create attachments dir: {e}"),
        )
    })?;
    *ATTACH_ROOT
        .lock()
        .map_err(|_| coded(codes::INTERNAL, "attachments root poisoned"))? = Some(root);

    log_debug(
        "info",
        &format!("Database opened successfully at: {}", db_path),
    );
    if let Ok(ver) = conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i32>(0)) {
        log_debug("info", &format!("Current schema version: {}", ver));
    }

    // Create connection pool with reasonable defaults for a desktop app.
    //
    // The init closure runs on EVERY connection the pool creates (initial
    // plus every later checkout). Without it, fresh pooled connections inherit
    // SQLite's default of foreign_keys=OFF, silently disabling every ON DELETE
    // CASCADE / FK constraint declared in the schema. We re-apply the two
    // connection-level pragmas that protect data integrity here, mirroring
    // the statements run on the migration connection above. WAL is a database
    // file property so it only needs to be set once, but repeating it is
    // harmless and keeps the init self-contained.
    let manager = SqliteConnectionManager::file(&db_path)
        .with_init(|c| c.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;"));
    let pool = Pool::builder()
        .max_size(10) // Allow up to 10 concurrent connections
        .build(manager)
        .map_err(|e| {
            coded(
                codes::DB_ERROR,
                format!("Failed to build connection pool: {e}"),
            )
        })?;

    *DB_POOL
        .lock()
        .map_err(|_| coded(codes::INTERNAL, "DB pool mutex poisoned"))? = Some(pool);

    // Reconcile files left behind by an interrupted attachment import before
    // the application starts serving resources. Imports stage files before
    // their DB commit, so a process crash can leave an unreferenced file; the
    // cleanup is safe because only files absent from the committed DB index
    // are removed.
    resources::cleanup_orphan_attachments()?;

    Ok(())
}

#[napi(object)]
pub struct VerifyDbResult {
    pub success: bool,
    pub message: String,
}

/// Flush a legacy SQLite WAL into the main database file before a filesystem
/// migration copies it. A migration that copies only `careerflow.db` while a
/// committed write still lives in `careerflow.db-wal` silently loses data.
#[napi]
pub fn checkpoint_db(db_path: String) -> Result<()> {
    let conn = Connection::open(&db_path).map_err(|e| {
        coded(
            codes::DB_ERROR,
            format!("Failed to open DB for checkpoint at {db_path}: {e}"),
        )
    })?;

    let busy: i32 = conn
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
        .map_err(to_err)?;
    if busy != 0 {
        return Err(coded(
            codes::DB_ERROR,
            format!("SQLite WAL checkpoint is busy for {db_path}"),
        ));
    }
    Ok(())
}

/// Verify the SQLite database integrity at the given path.
#[napi]
pub fn verify_db(db_path: String) -> VerifyDbResult {
    let conn = match Connection::open(&db_path) {
        Ok(c) => c,
        Err(e) => {
            return VerifyDbResult {
                success: false,
                message: format!("Failed to open database: {}", e),
            }
        }
    };

    let result: rusqlite::Result<String> =
        conn.query_row("PRAGMA integrity_check", [], |row| row.get(0));

    match result {
        Ok(res) if res.to_lowercase() == "ok" => VerifyDbResult {
            success: true,
            message: "ok".to_string(),
        },
        Ok(res) => VerifyDbResult {
            success: false,
            message: format!("Integrity check failed: {}", res),
        },
        Err(e) => VerifyDbResult {
            success: false,
            message: format!("Error executing integrity check: {}", e),
        },
    }
}
