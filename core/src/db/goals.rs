//! Goal Mode — orchestration tables (see migrations/021_pm_goals.sql).
//!
//! Goals are a thin orchestration layer over the proven Project Mode
//! agent loop. A "goal" is the user-facing unit of autonomous work
//! ("refactor X, update tests, ensure verification passes"). This module
//! owns the SQL boundary; the orchestration itself (creating the linked
//! agent, driving the loop, observing its lifecycle) lives in the shell
//! services layer (`shell/src/services/goals/engine.js`).
//!
//! Ownership is enforced at the SQL boundary: every read/write takes
//! `profile_id` and either joins through `pm_projects` (for `project_id`
//! gating) or directly carries `profile_id` in the row. Cross-profile
//! reads return 0 rows.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection};

use crate::db::{to_err, with_db};
use crate::errors::{coded, codes};
use crate::validate::{
    profile_id as valid_profile_id, required_text, text, valid_id, MAX_NAME, MAX_TEXT,
};

const MAX_OBJECTIVE: usize = 8_000;
const MAX_REASON: usize = 2_000;
const MAX_STATE: usize = 32;
const MAX_EVENT_MSG: usize = 4_000;

const ALLOWED_KINDS: &[&str] = &["code_change", "research", "analysis"];
const ALLOWED_PRIORITIES: &[&str] = &["low", "normal", "high"];
const ALLOWED_STATES: &[&str] = &[
    "created",
    "starting",
    "running",
    "verifying",
    "completed",
    "failed",
    "cancelled",
];
const TERMINAL_STATES: &[&str] = &["completed", "failed", "cancelled"];

// State-machine transitions. Enforced at the SQL boundary so a buggy
// shell caller cannot stomp a goal's state into a junk value.
//
//   created -> starting | cancelled
//   starting -> running | failed | cancelled
//   running -> verifying | failed | cancelled
//   verifying -> completed | failed | cancelled
//   completed / failed / cancelled -> (terminal, no transitions out)
fn is_valid_transition(from: &str, to: &str) -> bool {
    if from == to {
        // Idempotent transitions allowed for the goal engine's polling
        // path (e.g. running -> running when a progress event arrives).
        return true;
    }
    matches!(
        (from, to),
        ("created", "starting")
            | ("created", "cancelled")
            | ("starting", "running")
            | ("starting", "failed")
            | ("starting", "cancelled")
            | ("running", "verifying")
            | ("running", "completed")   // recovery: agent loop completed without entering verifying
            | ("running", "failed")
            | ("running", "cancelled")
            | ("verifying", "completed")
            | ("verifying", "failed")
            | ("verifying", "cancelled")
    )
}

#[napi(object)]
pub struct PmGoal {
    pub id: i32,
    pub profile_id: i32,
    pub project_id: i32,
    pub title: String,
    pub objective: String,
    pub kind: String,
    pub state: String,
    pub priority: String,
    pub require_verification: bool,
    pub linked_agent_id: Option<i32>,
    pub failure_reason: String,
    pub result_text: String,
    pub plan_step_count: i32,
    pub created_at: String,
    pub started_at: Option<String>,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

#[napi(object)]
pub struct PmGoalEvent {
    pub id: i32,
    pub goal_id: i32,
    pub event: String,
    pub message: String,
    pub payload_json: Option<String>,
    pub created_at: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn assert_goal_owned_by(conn: &Connection, profile_id: i32, goal_id: i32) -> Result<()> {
    let n: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM pm_goals WHERE id = ?1 AND profile_id = ?2",
            params![goal_id, profile_id],
            |r| r.get(0),
        )
        .map_err(to_err)?;
    if n == 0 {
        return Err(coded(codes::NOT_OWNED, "Goal not found in this profile"));
    }
    Ok(())
}

fn assert_project_owned_by(conn: &Connection, profile_id: i32, project_id: i32) -> Result<()> {
    let n: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM pm_projects WHERE id = ?1 AND profile_id = ?2",
            params![project_id, profile_id],
            |r| r.get(0),
        )
        .map_err(to_err)?;
    if n == 0 {
        return Err(coded(codes::NOT_OWNED, "Project not found in this profile"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Goal CRUD
// ---------------------------------------------------------------------------

/// Create a new goal. The goal starts in `state='created'` and has no
/// linked agent yet — the goal engine (shell side) will create the
/// linked agent and transition the state to `starting`/`running`.
#[napi]
pub fn pm_create_goal(
    profile_id: i32,
    project_id: i32,
    title: String,
    objective: String,
    kind: Option<String>,
    priority: Option<String>,
    require_verification: Option<bool>,
) -> Result<i32> {
    let profile_id = valid_profile_id(profile_id)?;
    let project_id = valid_id(project_id, "project_id")?;
    let title = required_text(title, "title", MAX_NAME)?;
    let objective = required_text(objective, "objective", MAX_OBJECTIVE)?;
    let kind = kind.unwrap_or_else(|| "code_change".to_string());
    if !ALLOWED_KINDS.contains(&kind.as_str()) {
        return Err(coded(
            codes::INVALID_INPUT,
            format!("kind must be one of: {}", ALLOWED_KINDS.join(", ")),
        ));
    }
    let priority = priority.unwrap_or_else(|| "normal".to_string());
    if !ALLOWED_PRIORITIES.contains(&priority.as_str()) {
        return Err(coded(
            codes::INVALID_INPUT,
            format!("priority must be one of: {}", ALLOWED_PRIORITIES.join(", ")),
        ));
    }
    let require_verification = match require_verification {
        Some(b) => b,
        None => kind == "code_change", // default: code_change requires verify
    };
    with_db(|conn| {
        assert_project_owned_by(conn, profile_id, project_id)?;
        conn.execute(
            "INSERT INTO pm_goals
                (profile_id, project_id, title, objective, kind, priority, require_verification)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                profile_id,
                project_id,
                title,
                objective,
                kind,
                priority,
                if require_verification { 1 } else { 0 },
            ],
        )
        .map_err(to_err)?;
        let id = conn.last_insert_rowid() as i32;
        // Seed the event log with a 'created' entry so the timeline is
        // never empty.
        conn.execute(
            "INSERT INTO pm_goal_events (goal_id, event, message, payload_json)
             VALUES (?1, 'created', ?2, ?3)",
            params![
                id,
                format!("Goal created: {}", title),
                Some(format!(
                    "{{\"kind\":\"{}\",\"require_verification\":{}}}",
                    kind, require_verification
                )),
            ],
        )
        .map_err(to_err)?;
        Ok(id)
    })
}

/// Fetch a single goal by id. Ownership is gated through profile_id.
#[napi]
pub fn pm_get_goal(profile_id: i32, goal_id: i32) -> Result<PmGoal> {
    let profile_id = valid_profile_id(profile_id)?;
    let goal_id = valid_id(goal_id, "goal_id")?;
    with_db(|conn| {
        let row = conn
            .query_row(
                "SELECT id, profile_id, project_id, title, objective, kind, state, priority,
                        require_verification, linked_agent_id, failure_reason, result_text,
                        plan_step_count, created_at, started_at, updated_at, completed_at
                 FROM pm_goals WHERE id = ?1 AND profile_id = ?2",
                params![goal_id, profile_id],
                |r| {
                    Ok(PmGoal {
                        id: r.get(0)?,
                        profile_id: r.get(1)?,
                        project_id: r.get(2)?,
                        title: r.get(3)?,
                        objective: r.get(4)?,
                        kind: r.get(5)?,
                        state: r.get(6)?,
                        priority: r.get(7)?,
                        require_verification: r.get::<_, i32>(8)? != 0,
                        linked_agent_id: r.get(9)?,
                        failure_reason: r.get(10)?,
                        result_text: r.get(11)?,
                        plan_step_count: r.get(12)?,
                        created_at: r.get(13)?,
                        started_at: r.get(14)?,
                        updated_at: r.get(15)?,
                        completed_at: r.get(16)?,
                    })
                },
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    coded(codes::NOT_OWNED, "Goal not found in this profile")
                }
                _ => to_err(e),
            })?;
        Ok(row)
    })
}

/// List goals for a profile, newest-first. `state` is an optional filter
/// (e.g. 'running', 'completed'). `limit` is clamped to [1, 500].
#[napi]
pub fn pm_list_goals(
    profile_id: i32,
    state: Option<String>,
    limit: Option<i32>,
) -> Result<Vec<PmGoal>> {
    let profile_id = valid_profile_id(profile_id)?;
    let state = text(state, "state", MAX_STATE)?;
    if let Some(ref s) = state {
        if !ALLOWED_STATES.contains(&s.as_str()) {
            return Err(coded(
                codes::INVALID_INPUT,
                format!("state must be one of: {}", ALLOWED_STATES.join(", ")),
            ));
        }
    }
    let raw_limit = limit.unwrap_or(100);
    let limit = if raw_limit < 1 {
        1
    } else if raw_limit > 500 {
        500
    } else {
        raw_limit
    };
    with_db(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT id, profile_id, project_id, title, objective, kind, state, priority,
                        require_verification, linked_agent_id, failure_reason, result_text,
                        plan_step_count, created_at, started_at, updated_at, completed_at
                 FROM pm_goals
                 WHERE profile_id = ?1
                   AND (?2 IS NULL OR state = ?2)
                 ORDER BY updated_at DESC, id DESC
                 LIMIT ?3",
            )
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![profile_id, state, limit], |r| {
                Ok(PmGoal {
                    id: r.get(0)?,
                    profile_id: r.get(1)?,
                    project_id: r.get(2)?,
                    title: r.get(3)?,
                    objective: r.get(4)?,
                    kind: r.get(5)?,
                    state: r.get(6)?,
                    priority: r.get(7)?,
                    require_verification: r.get::<_, i32>(8)? != 0,
                    linked_agent_id: r.get(9)?,
                    failure_reason: r.get(10)?,
                    result_text: r.get(11)?,
                    plan_step_count: r.get(12)?,
                    created_at: r.get(13)?,
                    started_at: r.get(14)?,
                    updated_at: r.get(15)?,
                    completed_at: r.get(16)?,
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

/// Delete a goal. Cancellations and failures stay in the table for the
/// audit log; this is a hard delete and is intended for the UI's "remove
/// from list" affordance.
#[napi]
pub fn pm_delete_goal(profile_id: i32, goal_id: i32) -> Result<()> {
    let profile_id = valid_profile_id(profile_id)?;
    let goal_id = valid_id(goal_id, "goal_id")?;
    let n = with_db(|conn| {
        // Prove ownership before touching the independently stored event log.
        // pm_goal_events intentionally has no FK, so deleting by goal_id first
        // would let another profile erase this goal's timeline.
        assert_goal_owned_by(conn, profile_id, goal_id)?;
        // Events cascade-delete is manual: pm_goal_events has no FK.
        let _ = conn.execute(
            "DELETE FROM pm_goal_events WHERE goal_id = ?1",
            params![goal_id],
        );
        let n = conn
            .execute(
                "DELETE FROM pm_goals WHERE id = ?1 AND profile_id = ?2",
                params![goal_id, profile_id],
            )
            .map_err(to_err)?;
        Ok(n)
    })?;
    if n == 0 {
        return Err(coded(codes::NOT_OWNED, "Goal not found in this profile"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/// Transition a goal to a new state. The transition is validated against
/// `is_valid_transition` so a buggy caller cannot stomp the state machine.
/// Terminal states (`completed` / `failed` / `cancelled`) cannot be left.
///
/// Side effects:
///   * Updates `started_at` the first time the goal leaves `created`.
///   * Updates `completed_at` when entering a terminal state.
///   * Appends a `state_changed` event to `pm_goal_events`.
///   * Writes `failure_reason` if supplied and state is `failed`.
///   * Writes `result_text` if supplied and state is `completed`.
#[napi]
pub fn pm_transition_goal(
    profile_id: i32,
    goal_id: i32,
    to_state: String,
    failure_reason: Option<String>,
    result_text: Option<String>,
) -> Result<()> {
    let profile_id = valid_profile_id(profile_id)?;
    let goal_id = valid_id(goal_id, "goal_id")?;
    let to_state = required_text(to_state, "to_state", MAX_STATE)?;
    if !ALLOWED_STATES.contains(&to_state.as_str()) {
        return Err(coded(
            codes::INVALID_INPUT,
            format!("to_state must be one of: {}", ALLOWED_STATES.join(", ")),
        ));
    }
    let failure_reason = text(failure_reason, "failure_reason", MAX_REASON)?.unwrap_or_default();
    let result_text = text(result_text, "result_text", MAX_TEXT)?.unwrap_or_default();
    with_db(|conn| {
        assert_goal_owned_by(conn, profile_id, goal_id)?;
        // Read the current state for the transition guard + the event log.
        let from_state: String = conn
            .query_row(
                "SELECT state FROM pm_goals WHERE id = ?1",
                params![goal_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        if TERMINAL_STATES.contains(&from_state.as_str()) && from_state != to_state {
            return Err(coded(
                codes::INVALID_INPUT,
                format!(
                    "Goal is already terminal ({}); cannot transition to {}",
                    from_state, to_state
                ),
            ));
        }
        if !is_valid_transition(&from_state, &to_state) {
            return Err(coded(
                codes::INVALID_INPUT,
                format!("Invalid goal transition: {} -> {}", from_state, to_state),
            ));
        }
        let now_expr = "datetime('now','localtime')";
        let started_clause = if from_state == "created" {
            format!(", started_at = COALESCE(started_at, {})", now_expr)
        } else {
            String::new()
        };
        let completed_clause = if TERMINAL_STATES.contains(&to_state.as_str()) {
            format!(", completed_at = COALESCE(completed_at, {})", now_expr)
        } else {
            String::new()
        };
        // Update the row. failure_reason / result_text are only meaningful
        // for their respective terminal states but we always overwrite
        // when given so the goal engine can patch them later if needed.
        let sql = format!(
            "UPDATE pm_goals
             SET state = ?2,
                 failure_reason = CASE WHEN ?3 = '' THEN failure_reason ELSE ?3 END,
                 result_text = CASE WHEN ?4 = '' THEN result_text ELSE ?4 END,
                 updated_at = {}{}{}
             WHERE id = ?1",
            now_expr, started_clause, completed_clause,
        );
        conn.execute(
            &sql,
            params![goal_id, to_state, failure_reason, result_text],
        )
        .map_err(to_err)?;
        // Append the state_changed event for the timeline.
        let payload = format!(
            "{{\"from\":\"{}\",\"to\":\"{}\"}}",
            from_state.replace('"', "\\\""),
            to_state.replace('"', "\\\""),
        );
        conn.execute(
            "INSERT INTO pm_goal_events (goal_id, event, message, payload_json)
             VALUES (?1, 'state_changed', ?2, ?3)",
            params![
                goal_id,
                format!("{} -> {}", from_state, to_state),
                Some(payload),
            ],
        )
        .map_err(to_err)?;
        Ok(())
    })
}

/// Link a goal to its driving agent row. The agent must belong to a
/// project owned by `profile_id` AND the goal's project must match the
/// agent's project (no cross-project linking).
#[napi]
pub fn pm_link_goal_agent(profile_id: i32, goal_id: i32, agent_id: i32) -> Result<()> {
    let profile_id = valid_profile_id(profile_id)?;
    let goal_id = valid_id(goal_id, "goal_id")?;
    let agent_id = valid_id(agent_id, "agent_id")?;
    with_db(|conn| {
        // Verify ownership of both rows.
        assert_goal_owned_by(conn, profile_id, goal_id)?;
        let goal_project_id: i32 = conn
            .query_row(
                "SELECT project_id FROM pm_goals WHERE id = ?1",
                params![goal_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        let n: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM pm_agents a
                 JOIN pm_projects p ON p.id = a.project_id
                 WHERE a.id = ?1 AND p.profile_id = ?2 AND a.project_id = ?3",
                params![agent_id, profile_id, goal_project_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "Agent not found in this goal's project",
            ));
        }
        conn.execute(
            "UPDATE pm_goals SET linked_agent_id = ?2, updated_at = datetime('now','localtime')
             WHERE id = ?1",
            params![goal_id, agent_id],
        )
        .map_err(to_err)?;
        // Append a timeline event.
        conn.execute(
            "INSERT INTO pm_goal_events (goal_id, event, message, payload_json)
             VALUES (?1, 'agent_linked', ?2, ?3)",
            params![
                goal_id,
                format!("Linked agent #{}", agent_id),
                Some(format!("{{\"agent_id\":{}}}", agent_id))
            ],
        )
        .map_err(to_err)?;
        Ok(())
    })
}

/// Update the cached plan-step count. The goal engine calls this when it
/// reads the linked agent's plan; UI panels use the cached value to
/// avoid re-joining every render.
#[napi]
pub fn pm_update_goal_plan_step_count(
    profile_id: i32,
    goal_id: i32,
    plan_step_count: i32,
) -> Result<()> {
    let profile_id = valid_profile_id(profile_id)?;
    let goal_id = valid_id(goal_id, "goal_id")?;
    let plan_step_count = if plan_step_count < 0 {
        0
    } else {
        plan_step_count
    };
    let n = with_db(|conn| {
        let n = conn
            .execute(
                "UPDATE pm_goals SET plan_step_count = ?2, updated_at = datetime('now','localtime')
                 WHERE id = ?1 AND profile_id = ?3",
                params![goal_id, plan_step_count, profile_id],
            )
            .map_err(to_err)?;
        Ok(n)
    })?;
    if n == 0 {
        return Err(coded(codes::NOT_OWNED, "Goal not found in this profile"));
    }
    Ok(())
}

/// Append a free-form `note` event to the goal's timeline. The goal
/// engine uses this for progress breadcrumbs ("verifying", "fix-retry N",
/// etc.). Other event kinds should go through `pm_transition_goal` or
/// `pm_link_goal_agent` so the state stays consistent.
#[napi]
pub fn pm_append_goal_event(
    profile_id: i32,
    goal_id: i32,
    message: String,
    payload_json: Option<String>,
) -> Result<i32> {
    let profile_id = valid_profile_id(profile_id)?;
    let goal_id = valid_id(goal_id, "goal_id")?;
    let message = required_text(message, "message", MAX_EVENT_MSG)?;
    let payload_json = text(payload_json, "payload_json", MAX_TEXT)?;
    with_db(|conn| {
        assert_goal_owned_by(conn, profile_id, goal_id)?;
        conn.execute(
            "INSERT INTO pm_goal_events (goal_id, event, message, payload_json)
             VALUES (?1, 'note', ?2, ?3)",
            params![goal_id, message, payload_json],
        )
        .map_err(to_err)?;
        Ok(conn.last_insert_rowid() as i32)
    })
}

/// List timeline events for a goal, newest-first. `limit` clamped [1,200].
#[napi]
pub fn pm_list_goal_events(
    profile_id: i32,
    goal_id: i32,
    limit: Option<i32>,
) -> Result<Vec<PmGoalEvent>> {
    let profile_id = valid_profile_id(profile_id)?;
    let goal_id = valid_id(goal_id, "goal_id")?;
    let raw_limit = limit.unwrap_or(100);
    let limit = if raw_limit < 1 {
        1
    } else if raw_limit > 200 {
        200
    } else {
        raw_limit
    };
    with_db(|conn| {
        // We want NOT_OWNED (not DB_ERROR) when the goal is missing so the
        // IPC layer can surface a clean "goal-not-found" envelope.
        assert_goal_owned_by(conn, profile_id, goal_id)?;
        let mut stmt = conn
            .prepare(
                "SELECT id, goal_id, event, message, payload_json, created_at
                 FROM pm_goal_events
                 WHERE goal_id = ?1
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?2",
            )
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![goal_id, limit], |r| {
                Ok(PmGoalEvent {
                    id: r.get(0)?,
                    goal_id: r.get(1)?,
                    event: r.get(2)?,
                    message: r.get(3)?,
                    payload_json: r.get(4)?,
                    created_at: r.get(5)?,
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

/// Resolve the linked agent row id for a goal, if any. Used by the UI to
/// jump straight from the goal detail view to the existing Project Mode
/// agent transcript (which is the detailed execution view).
#[napi]
pub fn pm_get_goal_agent_id(profile_id: i32, goal_id: i32) -> Result<Option<i32>> {
    let profile_id = valid_profile_id(profile_id)?;
    let goal_id = valid_id(goal_id, "goal_id")?;
    with_db(|conn| {
        assert_goal_owned_by(conn, profile_id, goal_id)?;
        // Rusqlite returns NULL columns as Err(QueryReturnedNoRows) under
        // `.optional()` when the column is non-nullable but the row's
        // value IS NULL — we coerce that to None explicitly. Reading via
        // a raw Option<i32> works because rusqlite maps SQLite NULL to
        // None for nullable columns.
        let agent_id: Option<i32> = match conn.query_row(
            "SELECT linked_agent_id FROM pm_goals WHERE id = ?1",
            params![goal_id],
            |r| r.get::<_, Option<i32>>(0),
        ) {
            Ok(v) => v,
            Err(rusqlite::Error::InvalidColumnType(_, _, _)) => None,
            Err(e) => return Err(to_err(e)),
        };
        Ok(agent_id)
    })
}
