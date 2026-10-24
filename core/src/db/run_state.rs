//! Crash/resume registry (Phase 15).
//!
//! One row per (profile_id, agent_id) in `pm_run_state`. The agent
//! loop writes here whenever it starts / transitions / finishes a
//! run, and the recovery sweep reads it on startup to determine
//! which non-terminal agents need user-driven resume.
//!
//! Design constraints:
//!   * NAPI handlers are thin: validate inputs, run a single SQL
//!     statement, return a small DTO.
//!   * Ownership is gated via profile_id at every read/write.
//!   * The `recovery` column is the authoritative hint for the
//!     sweep — the agent loop is the only writer.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection, OptionalExtension};

use crate::db::{to_err, with_db};
use crate::errors::{coded, codes};
use crate::validate::{profile_id as valid_profile_id, text, valid_id};

const MAX_ROLE: usize = 64;
const MAX_PHASE: usize = 32;
const MAX_STATE: usize = 32;
const MAX_RECOVERY: usize = 32;
const MAX_RUN_ID: usize = 64;
const MAX_PARENT_RUN_ID: usize = 64;

const ALLOWED_PHASES: &[&str] = &[
    "preparing",
    "planning",
    "executing",
    "verifying",
    "awaiting_approval",
    "idle",
    "unknown",
];
const ALLOWED_STATES: &[&str] = &["running", "paused", "completed", "failed", "cancelled"];
const ALLOWED_RECOVERY: &[&str] = &["safe-resume", "requires-user", "stale"];

#[napi(object)]
pub struct PmRunState {
    pub id: i32,
    pub profile_id: i32,
    pub agent_id: i32,
    pub run_id: String,
    pub role: Option<String>,
    pub is_sub_agent: Option<String>,
    pub parent_run_id: Option<String>,
    pub phase: String,
    pub state: String,
    pub tokens_in: i32,
    pub tokens_out: i32,
    pub recovery: String,
    pub last_event_at: String,
    pub created_at: String,
    pub updated_at: String,
}

fn assert_owned(conn: &Connection, profile_id: i32, agent_id: i32) -> Result<()> {
    let n: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM pm_agents a
             JOIN pm_projects p ON p.id = a.project_id
             WHERE a.id = ?1 AND p.profile_id = ?2",
            params![agent_id, profile_id],
            |r| r.get(0),
        )
        .map_err(to_err)?;
    if n == 0 {
        return Err(coded(codes::NOT_OWNED, "Agent not found in this profile"));
    }
    Ok(())
}

/// Insert or update a run-state row. The agent loop calls this on every
/// state transition. The (profile_id, agent_id) pair is the primary key
/// — re-issuing the call with new state/phase updates the row in place.
#[napi]
pub fn pm_upsert_run_state(
    profile_id: i32,
    agent_id: i32,
    run_id: String,
    role: Option<String>,
    is_sub_agent: Option<String>,
    parent_run_id: Option<String>,
    phase: String,
    state: String,
    tokens_in: i32,
    tokens_out: i32,
    recovery: String,
) -> Result<()> {
    let profile_id = valid_profile_id(profile_id)?;
    let agent_id = valid_id(agent_id, "agent_id")?;
    let run_id = text(Some(run_id), "run_id", MAX_RUN_ID)?
        .ok_or_else(|| coded(codes::INVALID_INPUT, "run_id is required"))?;
    let role = text(role, "role", MAX_ROLE)?;
    let is_sub_agent = text(is_sub_agent, "is_sub_agent", 16)?;
    let parent_run_id = text(parent_run_id, "parent_run_id", MAX_PARENT_RUN_ID)?;
    let phase = required_text(phase, "phase", MAX_PHASE)?;
    if !ALLOWED_PHASES.contains(&phase.as_str()) {
        return Err(coded(
            codes::INVALID_INPUT,
            format!("phase must be one of: {}", ALLOWED_PHASES.join(", ")),
        ));
    }
    let state = required_text(state, "state", MAX_STATE)?;
    if !ALLOWED_STATES.contains(&state.as_str()) {
        return Err(coded(
            codes::INVALID_INPUT,
            format!("state must be one of: {}", ALLOWED_STATES.join(", ")),
        ));
    }
    let recovery = required_text(recovery, "recovery", MAX_RECOVERY)?;
    if !ALLOWED_RECOVERY.contains(&recovery.as_str()) {
        return Err(coded(
            codes::INVALID_INPUT,
            format!("recovery must be one of: {}", ALLOWED_RECOVERY.join(", ")),
        ));
    }
    with_db(|conn| {
        assert_owned(conn, profile_id, agent_id)?;
        conn.execute(
            "INSERT INTO pm_run_state
                (profile_id, agent_id, run_id, role, is_sub_agent, parent_run_id,
                 phase, state, tokens_in, tokens_out, recovery, last_event_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now','localtime'))
             ON CONFLICT(profile_id, agent_id) DO UPDATE SET
                run_id = excluded.run_id,
                role = excluded.role,
                is_sub_agent = excluded.is_sub_agent,
                parent_run_id = excluded.parent_run_id,
                phase = excluded.phase,
                state = excluded.state,
                tokens_in = excluded.tokens_in,
                tokens_out = excluded.tokens_out,
                recovery = excluded.recovery,
                last_event_at = datetime('now','localtime'),
                updated_at = datetime('now','localtime')",
            params![
                profile_id,
                agent_id,
                run_id,
                role,
                is_sub_agent,
                parent_run_id,
                phase,
                state,
                tokens_in,
                tokens_out,
                recovery,
            ],
        )
        .map_err(to_err)?;
        Ok(())
    })
}

/// Delete the run-state row for an agent. Called by the loop on terminal
/// completion (so the sweep sees a clean slate).
#[napi]
pub fn pm_delete_run_state(profile_id: i32, agent_id: i32) -> Result<()> {
    let profile_id = valid_profile_id(profile_id)?;
    let agent_id = valid_id(agent_id, "agent_id")?;
    let n = with_db(|conn| {
        let n = conn
            .execute(
                "DELETE FROM pm_run_state WHERE profile_id = ?1 AND agent_id = ?2",
                params![profile_id, agent_id],
            )
            .map_err(to_err)?;
        Ok(n)
    })?;
    if n == 0 {
        return Err(coded(
            codes::NOT_OWNED,
            "Run state not found in this profile",
        ));
    }
    Ok(())
}

/// List non-terminal run-state rows for a profile. The sweep uses this
/// to determine which agents may need resume. Rows older than
/// `stale_after_minutes` (default 30) are returned with a synthetic
/// `recovery = 'stale'` to the caller (we never mutate them in this
/// endpoint — the sweep can decide what to do).
#[napi]
pub fn pm_list_resumable_runs(
    profile_id: i32,
    stale_after_minutes: Option<i32>,
) -> Result<Vec<PmRunState>> {
    let profile_id = valid_profile_id(profile_id)?;
    let stale_after = stale_after_minutes.unwrap_or(30);
    if stale_after < 1 {
        return Err(coded(
            codes::INVALID_INPUT,
            "stale_after_minutes must be >= 1",
        ));
    }
    with_db(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT id, profile_id, agent_id, run_id, role, is_sub_agent, parent_run_id,
                        phase, state, tokens_in, tokens_out, recovery, last_event_at,
                        created_at, updated_at
                 FROM pm_run_state
                 WHERE profile_id = ?1
                   AND state IN ('running', 'paused')
                   AND (
                        ?2 = 0 OR
                        (julianday('now','localtime') - julianday(last_event_at)) * 24 * 60 <= ?2
                   )
                 ORDER BY last_event_at DESC, id DESC",
            )
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![profile_id, stale_after], |r| {
                Ok(PmRunState {
                    id: r.get(0)?,
                    profile_id: r.get(1)?,
                    agent_id: r.get(2)?,
                    run_id: r.get(3)?,
                    role: r.get(4)?,
                    is_sub_agent: r.get(5)?,
                    parent_run_id: r.get(6)?,
                    phase: r.get(7)?,
                    state: r.get(8)?,
                    tokens_in: r.get(9)?,
                    tokens_out: r.get(10)?,
                    recovery: r.get(11)?,
                    last_event_at: r.get(12)?,
                    created_at: r.get(13)?,
                    updated_at: r.get(14)?,
                })
            })
            .map_err(to_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(to_err)?);
        }
        Ok(out)
    })
}

/// List STALE rows (older than `stale_after_minutes`). The sweep uses
/// these to clean up after a crashed Electron that never finished
/// write transactions for stale rows.
#[napi]
pub fn pm_list_stale_runs(
    profile_id: i32,
    stale_after_minutes: Option<i32>,
) -> Result<Vec<PmRunState>> {
    let profile_id = valid_profile_id(profile_id)?;
    let stale_after = stale_after_minutes.unwrap_or(30);
    if stale_after < 1 {
        return Err(coded(
            codes::INVALID_INPUT,
            "stale_after_minutes must be >= 1",
        ));
    }
    with_db(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT id, profile_id, agent_id, run_id, role, is_sub_agent, parent_run_id,
                        phase, state, tokens_in, tokens_out, recovery, last_event_at,
                        created_at, updated_at
                 FROM pm_run_state
                 WHERE profile_id = ?1
                   AND state IN ('running', 'paused')
                   AND (julianday('now','localtime') - julianday(last_event_at)) * 24 * 60 > ?2
                 ORDER BY last_event_at DESC, id DESC",
            )
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![profile_id, stale_after], |r| {
                Ok(PmRunState {
                    id: r.get(0)?,
                    profile_id: r.get(1)?,
                    agent_id: r.get(2)?,
                    run_id: r.get(3)?,
                    role: r.get(4)?,
                    is_sub_agent: r.get(5)?,
                    parent_run_id: r.get(6)?,
                    phase: r.get(7)?,
                    state: r.get(8)?,
                    tokens_in: r.get(9)?,
                    tokens_out: r.get(10)?,
                    recovery: r.get(11)?,
                    last_event_at: r.get(12)?,
                    created_at: r.get(13)?,
                    updated_at: r.get(14)?,
                })
            })
            .map_err(to_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(to_err)?);
        }
        Ok(out)
    })
}

/// Single-row fetch (profile ownership gated).
#[napi]
pub fn pm_get_run_state(profile_id: i32, agent_id: i32) -> Result<Option<PmRunState>> {
    let profile_id = valid_profile_id(profile_id)?;
    let agent_id = valid_id(agent_id, "agent_id")?;
    with_db(|conn| {
        let row = conn
            .query_row(
                "SELECT id, profile_id, agent_id, run_id, role, is_sub_agent, parent_run_id,
                        phase, state, tokens_in, tokens_out, recovery, last_event_at,
                        created_at, updated_at
                 FROM pm_run_state WHERE profile_id = ?1 AND agent_id = ?2",
                params![profile_id, agent_id],
                |r| {
                    Ok(PmRunState {
                        id: r.get(0)?,
                        profile_id: r.get(1)?,
                        agent_id: r.get(2)?,
                        run_id: r.get(3)?,
                        role: r.get(4)?,
                        is_sub_agent: r.get(5)?,
                        parent_run_id: r.get(6)?,
                        phase: r.get(7)?,
                        state: r.get(8)?,
                        tokens_in: r.get(9)?,
                        tokens_out: r.get(10)?,
                        recovery: r.get(11)?,
                        last_event_at: r.get(12)?,
                        created_at: r.get(13)?,
                        updated_at: r.get(14)?,
                    })
                },
            )
            .optional()
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    coded(codes::NOT_OWNED, "Run state not found")
                }
                _ => to_err(e),
            })?;
        Ok(row)
    })
}

// Helper: required_text was brought in from validate; the import path
// is valid for the macro chain below. Re-declared here so we don't have
// to thread a new symbol through the validate module surface just for
// this file.
use crate::validate::required_text;
