//! Focus Signals â€” single-batch read for the Academic Focus algorithm.
//!
//! The Dashboard's "Focus Now" panel is computed in JS (pure function,
//! unit-tested) from a few small pre-shaped datasets. This module exists
//! ONLY to fetch those datasets in a single bounded IPC call so the UI
//! never fans out to N+1 queries:
//!
//!   * subjects                 (one query)
//!   * active deadlines         (one query, joined to subject names)
//!   * recent study sessions    (one query, last ~30d, for inactivity lookback)
//!   * due flashcards           (one query, due today or earlier)
//!   * recent mistakes          (one query, last ~30d, capped)
//!
//! All queries are scoped by profile through the academic tree, so profile
//! isolation is preserved at the SQL boundary â€” no row from a different
//! profile can ever enter the result. No mutation, no new tables, no
//! derived/aggregated columns: just row-shaped data, pre-named so the
//! UI passes it straight to the pure algorithm.
//!
//! The cap window is 30 days; the algorithm itself owns the precise
//! "inactivity / recency" thresholds so this layer stays dumb.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::params;

use crate::db::{to_err, with_db};

/// Bounded read window. The algorithm decides what to do with rows inside
/// it; we cap the read so a profile with 10,000 historic sessions does not
/// burn IPC bandwidth on rows it cannot use.
const SIGNAL_LOOKBACK_DAYS: i32 = 30;
/// Mistakes cap. Mistakes are heavier per-row, and the algorithm only
/// counts "recent" ones; older rows are noise.
const MISTAKES_CAP: i32 = 200;
/// Sessions cap. We only need enough to find the most-recent per subject.
const SESSIONS_CAP: i32 = 500;
/// Deadlines cap. A profile with 5,000 deadlines is itself a problem; the
/// algorithm already filters by date window, but we cap to keep IPC cheap.
const DEADLINES_CAP: i32 = 500;

#[napi(object)]
pub struct FocusSubject {
    pub id: i32,
    pub name: String,
    pub code: Option<String>,
    pub status: String,
}

#[napi(object)]
pub struct FocusDeadline {
    pub id: i32,
    pub subject_id: i32,
    pub subject_name: String,
    pub deadline_date: String,
    pub title: String,
    pub completed_at: Option<String>,
}

#[napi(object)]
pub struct FocusSession {
    pub subject_id: i32,
    pub started_at: String,
}

#[napi(object)]
pub struct FocusCard {
    pub subject_id: i32,
    pub due_date: String,
}

#[napi(object)]
pub struct FocusMistake {
    pub subject_id: i32,
    pub created_at: String,
}

#[napi(object)]
pub struct FocusSignals {
    pub subjects: Vec<FocusSubject>,
    pub deadlines: Vec<FocusDeadline>,
    pub sessions: Vec<FocusSession>,
    pub cards: Vec<FocusCard>,
    pub mistakes: Vec<FocusMistake>,
    /// Local "today" date the shell will compare against. Returned by the
    /// core so the algorithm and the queries agree on the calendar day,
    /// even if a test injects a fixed clock.
    pub today: String,
    /// Local "now" timestamp, included so JS can compute exact "Nd ago"
    /// phrases if it ever needs to. The algorithm itself only uses `today`.
    pub now: String,
}

/// Read all the inputs the Academic Focus algorithm needs in a single
/// bounded call. Profile-scoped at every query â€” no cross-profile leak
/// is possible because each query filters by `t.profile_id = ?1`.
///
/// Date filters are inclusive-of-today and look back `SIGNAL_LOOKBACK_DAYS`.
/// Deadlines are NOT date-filtered here: the algorithm applies its own
/// "overdue / today / soon / later / ignore" rules. Filtering too early
/// would silently drop future deadlines the algorithm wants to count.
#[napi]
pub fn get_focus_signals(profile_id: i32) -> Result<FocusSignals> {
    with_db(|conn| {
        // E2E runs pin Chromium/JS to UTC so date fixtures are deterministic.
        // Keep production semantics on the user's local calendar.
        let today_expr = if std::env::var_os("CAREERFLOW_E2E").is_some() {
            "date('now')"
        } else {
            "date('now','localtime')"
        };
        let today_lookback_expr = if std::env::var_os("CAREERFLOW_E2E").is_some() {
            "date('now',?2)"
        } else {
            "date('now','localtime',?2)"
        };
        // ---- Subjects (one query, includes status) ---------------------
        let subjects: Vec<FocusSubject> = {
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
                .map_err(to_err)?;
            let rows = stmt
                .query_map(params![profile_id], |r| {
                    Ok(FocusSubject {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        code: r.get(2)?,
                        status: r.get(3)?,
                    })
                })
                .map_err(to_err)?;
            rows.map(|r| r.map_err(to_err))
                .collect::<Result<Vec<_>>>()?
        };

        // ---- Active deadlines (not completed, profile-scoped) -----------
        let deadlines: Vec<FocusDeadline> = {
            let mut stmt = conn
                .prepare(
                    "SELECT d.id, d.subject_id, sub.name, d.deadline_date, d.title, d.completed_at
                     FROM deadlines d
                     JOIN subjects sub ON sub.id = d.subject_id
                     JOIN milestones m ON m.id = sub.milestone_id
                     JOIN semesters se ON se.id = m.semester_id
                     JOIN tracks t ON t.id = se.track_id
                     WHERE t.profile_id = ?1 AND d.completed_at IS NULL
                     ORDER BY d.deadline_date ASC, d.id ASC
                     LIMIT ?2",
                )
                .map_err(to_err)?;
            let rows = stmt
                .query_map(params![profile_id, DEADLINES_CAP as i64], |r| {
                    Ok(FocusDeadline {
                        id: r.get(0)?,
                        subject_id: r.get(1)?,
                        subject_name: r.get(2)?,
                        deadline_date: r.get(3)?,
                        title: r.get(4)?,
                        completed_at: r.get(5)?,
                    })
                })
                .map_err(to_err)?;
            rows.map(|r| r.map_err(to_err))
                .collect::<Result<Vec<_>>>()?
        };

        // ---- Recent study sessions (last 30 days) ----------------------
        // We only need subject_id + started_at; the algorithm finds the
        // latest per subject itself.
        let sessions: Vec<FocusSession> = {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT ss.subject_id, ss.started_at
                     FROM session_states ss
                     JOIN subjects sub ON sub.id = ss.subject_id
                     JOIN milestones m ON m.id = sub.milestone_id
                     JOIN semesters se ON se.id = m.semester_id
                     JOIN tracks t ON t.id = se.track_id
                     WHERE t.profile_id = ?1
                       AND ss.started_at >= {today_lookback_expr}
                       ORDER BY ss.started_at DESC, ss.id DESC
                     LIMIT ?3"
                ))
                .map_err(to_err)?;
            let rows = stmt
                .query_map(
                    params![
                        profile_id,
                        format!("-{SIGNAL_LOOKBACK_DAYS} days"),
                        SESSIONS_CAP as i64
                    ],
                    |r| {
                        Ok(FocusSession {
                            subject_id: r.get(0)?,
                            started_at: r.get(1)?,
                        })
                    },
                )
                .map_err(to_err)?;
            rows.map(|r| r.map_err(to_err))
                .collect::<Result<Vec<_>>>()?
        };

        // ---- Due flashcards (due today or earlier) ---------------------
        let cards: Vec<FocusCard> = {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT c.subject_id, c.due_date
                     FROM cards c
                     JOIN subjects sub ON sub.id = c.subject_id
                     JOIN milestones m ON m.id = sub.milestone_id
                     JOIN semesters se ON se.id = m.semester_id
                     JOIN tracks t ON t.id = se.track_id
                     WHERE t.profile_id = ?1 AND c.due_date <= {today_expr}
                     ORDER BY c.due_date ASC, c.id ASC
                     LIMIT 500"
                ))
                .map_err(to_err)?;
            let rows = stmt
                .query_map(params![profile_id], |r| {
                    Ok(FocusCard {
                        subject_id: r.get(0)?,
                        due_date: r.get(1)?,
                    })
                })
                .map_err(to_err)?;
            rows.map(|r| r.map_err(to_err))
                .collect::<Result<Vec<_>>>()?
        };

        // ---- Recent mistakes (last 30 days, capped) --------------------
        let mistakes: Vec<FocusMistake> = {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT m.subject_id, m.created_at
                     FROM mistakes m
                     JOIN subjects sub ON sub.id = m.subject_id
                     JOIN milestones ms ON ms.id = sub.milestone_id
                     JOIN semesters se ON se.id = ms.semester_id
                     JOIN tracks t ON t.id = se.track_id
                     WHERE t.profile_id = ?1
                       AND m.created_at >= {today_lookback_expr}
                     ORDER BY m.created_at DESC, m.id DESC
                     LIMIT ?3"
                ))
                .map_err(to_err)?;
            let rows = stmt
                .query_map(
                    params![
                        profile_id,
                        format!("-{SIGNAL_LOOKBACK_DAYS} days"),
                        MISTAKES_CAP as i64
                    ],
                    |r| {
                        Ok(FocusMistake {
                            subject_id: r.get(0)?,
                            created_at: r.get(1)?,
                        })
                    },
                )
                .map_err(to_err)?;
            rows.map(|r| r.map_err(to_err))
                .collect::<Result<Vec<_>>>()?
        };

        // ---- Today / now ------------------------------------------------
        let today: String = conn
            .query_row(&format!("SELECT {today_expr}"), [], |r| r.get(0))
            .map_err(to_err)?;
        let now: String = conn
            .query_row(
                &format!(
                    "SELECT {}",
                    if std::env::var_os("CAREERFLOW_E2E").is_some() {
                        "datetime('now')"
                    } else {
                        "datetime('now','localtime')"
                    }
                ),
                [],
                |r| r.get(0),
            )
            .map_err(to_err)?;

        Ok(FocusSignals {
            subjects,
            deadlines,
            sessions,
            cards,
            mistakes,
            today,
            now,
        })
    })
}
