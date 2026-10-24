//! Ordered, idempotent schema migrationstracked via `PRAGMA user_version`.
//!
//! Design (lightweight, zero-dependency, embedded-in-binary):
//!   * Each migration is an ordered `(version, sql)` pair. The SQL files live in
//!     `core/migrations/` and are baked into the binary with `include_str!`, so a
//!     packaged build never needs them on disk.
//!   * `run()` reads the DB's current `user_version`, then applies every
//!     migration whose version is greater, each inside its own transaction, and
//!     bumps `user_version` to match. Re-running is a no-op (idempotent).
//!   * New installs apply 001..=N in order (full schema). Existing DBs upgrade
//!     from wherever they are — no `Remove-Item progress-ledger-v2.db`, no data loss.
//!
//! Adding a migration: drop `migrations/00X_name.sql` and append a line below.
//! NEVER edit a shipped migration — always add a new one.

use rusqlite::Connection;

use napi::bindgen_prelude::*;

use crate::errors::{coded, codes};

/// The ordered migration set. Versions must be contiguous and ascending.
const MIGRATIONS: &[(i32, &str)] = &[
    (1, include_str!("../migrations/001_initial.sql")),
    (2, include_str!("../migrations/002_attachments.sql")),
    (3, include_str!("../migrations/003_phase11_revision.sql")),
    (4, include_str!("../migrations/004_phase12_13.sql")),
    (5, include_str!("../migrations/005_data_constraints.sql")),
    (6, include_str!("../migrations/006_performance_indexes.sql")),
    (7, include_str!("../migrations/007_add_subject_codes.sql")),
    (
        8,
        include_str!("../migrations/008_cgpa_marks_and_scales.sql"),
    ),
    (9, include_str!("../migrations/009_semester_status.sql")),
    (
        10,
        include_str!("../migrations/010_deadline_completion.sql"),
    ),
    (11, include_str!("../migrations/011_career_planning.sql")),
    (
        12,
        include_str!("../migrations/012_career_milestone_project_link.sql"),
    ),
    (
        13,
        include_str!("../migrations/013_career_milestone_subject_link.sql"),
    ),
    (14, include_str!("../migrations/014_courses_subject_id.sql")),
    (15, include_str!("../migrations/015_browser_manager.sql")),
    (
        16,
        include_str!("../migrations/016_browser_shortcuts_pinned.sql"),
    ),
    (17, include_str!("../migrations/017_project_mode.sql")),
    (18, include_str!("../migrations/018_pm_parent_agent.sql")),
    (19, include_str!("../migrations/019_subagent_runs.sql")),
    (20, include_str!("../migrations/020_plan_templates.sql")),
    (21, include_str!("../migrations/021_pm_goals.sql")),
    (22, include_str!("../migrations/022_pm_run_state.sql")),
    (23, include_str!("../migrations/023_focus_signal_recency.sql")),
    (24, include_str!("../migrations/024_research_sources_captures.sql")),
];

/// Read the DB's current schema version.
pub fn current_version(conn: &Connection) -> Result<i32> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| coded(codes::DB_ERROR, format!("read user_version: {e}")))
}

/// Apply all pending migrations in order. Each runs in its own transaction so a
/// failure leaves the DB at the last good version rather than half-migrated.
pub fn run(conn: &Connection) -> Result<()> {
    let current = current_version(conn)?;
    for (ver, sql) in MIGRATIONS {
        if *ver > current {
            // PRAGMA user_version is allowed inside a transaction; bumping it in
            // the same batch makes each migration atomic.
            let batch = format!("BEGIN;\n{sql}\nPRAGMA user_version = {ver};\nCOMMIT;");
            conn.execute_batch(&batch).map_err(|e| {
                coded(
                    codes::DB_ERROR,
                    format!("migration {ver} failed (DB left at version {current}): {e}"),
                )
            })?;
        }
    }
    Ok(())
}
