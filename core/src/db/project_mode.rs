//! Project Mode Ã¢â‚¬â€ first-class agentic project workspace.
//!
//! This module owns the Rust side of the pm_projects / pm_agents /
//! pm_messages schema (see migrations/017_project_mode.sql). It exposes a
//! small NAPI surface for the main-process agent; the agent loop itself
//! lives in shell-side TypeScript because it is dominated by I/O
//! (model provider, tool invocation) and policy (approval flow), and
//! the SQLite layer is best kept thin.
//!
//! The renderer NEVER has raw access to any of these functions. The
//! shell's IPC layer (shell/src/ipc/project_mode.js, built next) is the
//! only caller. Profile ownership is enforced at the SQL boundary: every
//! write takes `profile_id` and refuses to touch a row owned by another
//! profile.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection, OptionalExtension};

use crate::db::{to_err, with_db, with_immediate_transaction};
use crate::errors::{coded, codes};
use crate::validate::{
    profile_id as valid_profile_id, required_text, text, valid_id, MAX_NAME, MAX_PATH, MAX_TEXT,
};

const MAX_OBJECTIVE: usize = 4_000;
const MAX_CONFIG_JSON: usize = 16_000;
const MAX_MESSAGE_CONTENT: usize = 200_000;

#[napi(object)]
pub struct PmProject {
    pub id: i32,
    pub profile_id: i32,
    pub name: String,
    pub description: String,
    pub root_path: String,
    pub config_json: String,
    pub created_at: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct PmAgent {
    pub id: i32,
    pub project_id: i32,
    pub objective: String,
    pub state: String,
    pub plan_json: String,
    pub tokens_in: i32,
    pub tokens_out: i32,
    pub finished_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub parent_agent_id: Option<i32>,
}

#[napi(object)]
pub struct PmMessage {
    pub id: i32,
    pub agent_id: i32,
    pub seq: i32,
    pub role: String,
    pub content: String,
    pub name: Option<String>,
    pub payload_json: Option<String>,
    pub created_at: String,
}

// ---------------------------------------------------------------------------
// pm_projects CRUD
// ---------------------------------------------------------------------------

/// Create a Project Mode project. `root_path` is validated for shape; the
/// agent's tools enforce path-inside-root at the tool boundary.
#[napi]
pub fn pm_create_project(
    profile_id: i32,
    name: String,
    description: Option<String>,
    root_path: String,
    config_json: Option<String>,
) -> Result<i32> {
    let profile_id = valid_profile_id(profile_id)?;
    let name = required_text(name, "name", MAX_NAME)?;
    let description = text(description, "description", MAX_TEXT)?.unwrap_or_default();
    let root_path = required_text(root_path, "root_path", MAX_PATH)?;
    let config_json =
        text(config_json, "config_json", MAX_CONFIG_JSON)?.unwrap_or_else(|| "{}".into());
    with_db(|conn| {
        // Verify the CF profile actually exists; otherwise the FK would
        // surface a generic SQL error string (which we sanitise at
        // to_err) but with no actionable context for the renderer.
        let n: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM profiles WHERE id = ?1",
                params![profile_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(codes::NOT_OWNED, "Profile does not exist"));
        }
        conn.execute(
            "INSERT INTO pm_projects (profile_id, name, description, root_path, config_json)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![profile_id, name, description, root_path, config_json],
        )
        .map_err(to_err)?;
        Ok(conn.last_insert_rowid() as i32)
    })
}

#[napi]
pub fn pm_list_projects(profile_id: i32) -> Result<Vec<PmProject>> {
    let profile_id = valid_profile_id(profile_id)?;
    with_db(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT id, profile_id, name, description, root_path, config_json, created_at, updated_at
                 FROM pm_projects WHERE profile_id = ?1 ORDER BY updated_at DESC, id DESC",
            )
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![profile_id], |r| {
                Ok(PmProject {
                    id: r.get(0)?,
                    profile_id: r.get(1)?,
                    name: r.get(2)?,
                    description: r.get(3)?,
                    root_path: r.get(4)?,
                    config_json: r.get(5)?,
                    created_at: r.get(6)?,
                    updated_at: r.get(7)?,
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

#[napi]
pub fn pm_get_project(profile_id: i32, project_id: i32) -> Result<PmProject> {
    let profile_id = valid_profile_id(profile_id)?;
    let project_id = valid_id(project_id, "project_id")?;
    with_db(|conn| {
        let row = conn
            .query_row(
                "SELECT id, profile_id, name, description, root_path, config_json, created_at, updated_at
                 FROM pm_projects WHERE id = ?1 AND profile_id = ?2",
                params![project_id, profile_id],
                |r| {
                    Ok(PmProject {
                        id: r.get(0)?,
                        profile_id: r.get(1)?,
                        name: r.get(2)?,
                        description: r.get(3)?,
                        root_path: r.get(4)?,
                        config_json: r.get(5)?,
                        created_at: r.get(6)?,
                        updated_at: r.get(7)?,
                    })
                },
            )
            .map_err(to_err)?;
        Ok(row)
    })
}

/// Delete a Project Mode project. Cascades to pm_agents / pm_messages via
/// the schema's ON DELETE CASCADE.
#[napi]
pub fn pm_delete_project(profile_id: i32, project_id: i32) -> Result<()> {
    let profile_id = valid_profile_id(profile_id)?;
    let project_id = valid_id(project_id, "project_id")?;
    with_db(|conn| {
        let n = conn
            .execute(
                "DELETE FROM pm_projects WHERE id = ?1 AND profile_id = ?2",
                params![project_id, profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(codes::NOT_OWNED, "Project not found in this profile"));
        }
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// pm_agents CRUD
// ---------------------------------------------------------------------------

/// Create a new agent in a project. The agent's `state` defaults to
/// 'idle' and `plan_json` defaults to '[]'. `parent_agent_id` is
/// optional; when `Some`, the parent must exist in the same project.
#[napi]
pub fn pm_create_agent(
    project_id: i32,
    objective: String,
    parent_agent_id: Option<i32>,
) -> Result<i32> {
    let project_id = valid_id(project_id, "project_id")?;
    let objective = required_text(objective, "objective", MAX_OBJECTIVE)?;
    let parent_agent_id = match parent_agent_id {
        Some(pid) => Some(valid_id(pid, "parent_agent_id")?),
        None => None,
    };
    with_db(|conn| {
        // Caller supplies only project_id; we resolve profile_id from the
        // project row. The shell-side agent will also pass profile_id
        // for double-check; we keep this signature lean for the common
        // case where the shell already validated ownership.
        let n: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM pm_projects WHERE id = ?1",
                params![project_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(codes::NOT_OWNED, "Project does not exist"));
        }
        if let Some(pid) = parent_agent_id {
            // Verify the parent exists in the SAME project (no cross-project
            // parenting). FK to pm_agents(id) is enforced by the schema.
            let n: i32 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pm_agents WHERE id = ?1 AND project_id = ?2",
                    params![pid, project_id],
                    |r| r.get(0),
                )
                .map_err(to_err)?;
            if n == 0 {
                return Err(coded(
                    codes::NOT_OWNED,
                    "Parent agent not found in this project",
                ));
            }
        }
        conn.execute(
            "INSERT INTO pm_agents (project_id, objective, parent_agent_id) VALUES (?1, ?2, ?3)",
            params![project_id, objective, parent_agent_id],
        )
        .map_err(to_err)?;
        Ok(conn.last_insert_rowid() as i32)
    })
}

#[napi]
pub fn pm_get_agent(profile_id: i32, agent_id: i32) -> Result<PmAgent> {
    let _ = valid_profile_id(profile_id)?;
    let agent_id = valid_id(agent_id, "agent_id")?;
    with_db(|conn| {
        // Verify the agent belongs to a project owned by the caller's
        // profile. The two-step scope is necessary because pm_agents
        // has no profile_id column of its own.
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
        let row = conn
            .query_row(
                "SELECT a.id, a.project_id, a.objective, a.state, a.plan_json,
                        a.tokens_in, a.tokens_out, a.finished_at, a.created_at, a.updated_at,
                        a.parent_agent_id
                 FROM pm_agents a
                 JOIN pm_projects p ON p.id = a.project_id
                 WHERE a.id = ?1 AND p.profile_id = ?2",
                params![agent_id, profile_id],
                |r| {
                    Ok(PmAgent {
                        id: r.get(0)?,
                        project_id: r.get(1)?,
                        objective: r.get(2)?,
                        state: r.get(3)?,
                        plan_json: r.get(4)?,
                        tokens_in: r.get(5)?,
                        tokens_out: r.get(6)?,
                        finished_at: r.get(7)?,
                        created_at: r.get(8)?,
                        updated_at: r.get(9)?,
                        parent_agent_id: r.get(10)?,
                    })
                },
            )
            .map_err(to_err)?;
        Ok(row)
    })
}

/// Update an agent's state, plan, and token counters in one call. Used
/// by the main-process agent loop at the end of every model/tool step.
#[napi]
pub fn pm_update_agent(
    profile_id: i32,
    agent_id: i32,
    state: String,
    plan_json: String,
    tokens_in: i32,
    tokens_out: i32,
) -> Result<()> {
    let profile_id = valid_profile_id(profile_id)?;
    let agent_id = valid_id(agent_id, "agent_id")?;
    let n = with_db(|conn| {
        let n = conn
            .execute(
                "UPDATE pm_agents
                 SET state = ?2, plan_json = ?3, tokens_in = ?4, tokens_out = ?5,
                     updated_at = datetime('now','localtime')
                 WHERE id = ?1
                   AND project_id IN (SELECT id FROM pm_projects WHERE profile_id = ?6)",
                params![agent_id, state, plan_json, tokens_in, tokens_out, profile_id],
            )
            .map_err(to_err)?;
        Ok(n)
    })?;
    if n == 0 {
        return Err(coded(codes::NOT_OWNED, "Agent not found in this profile"));
    }
    Ok(())
}

/// Mark an agent as finished. Sets state and finished_at atomically.
#[napi]
pub fn pm_finish_agent(profile_id: i32, agent_id: i32, state: String) -> Result<()> {
    let profile_id = valid_profile_id(profile_id)?;
    let agent_id = valid_id(agent_id, "agent_id")?;
    let n = with_db(|conn| {
        let n = conn
            .execute(
                "UPDATE pm_agents
                 SET state = ?2, finished_at = datetime('now','localtime'),
                     updated_at = datetime('now','localtime')
                 WHERE id = ?1
                   AND project_id IN (SELECT id FROM pm_projects WHERE profile_id = ?3)",
                params![agent_id, state, profile_id],
            )
            .map_err(to_err)?;
        Ok(n)
    })?;
    if n == 0 {
        return Err(coded(codes::NOT_OWNED, "Agent not found in this profile"));
    }
    Ok(())
}

#[napi]
pub fn pm_list_agents(profile_id: i32, project_id: i32) -> Result<Vec<PmAgent>> {
    let profile_id = valid_profile_id(profile_id)?;
    let project_id = valid_id(project_id, "project_id")?;
    with_db(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT a.id, a.project_id, a.objective, a.state, a.plan_json,
                        a.tokens_in, a.tokens_out, a.finished_at, a.created_at, a.updated_at,
                        a.parent_agent_id
                 FROM pm_agents a
                 JOIN pm_projects p ON p.id = a.project_id
                 WHERE a.project_id = ?1 AND p.profile_id = ?2
                 ORDER BY a.created_at DESC, a.id DESC",
            )
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![project_id, profile_id], |r| {
                Ok(PmAgent {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    objective: r.get(2)?,
                    state: r.get(3)?,
                    plan_json: r.get(4)?,
                    tokens_in: r.get(5)?,
                    tokens_out: r.get(6)?,
                    finished_at: r.get(7)?,
                    created_at: r.get(8)?,
                    updated_at: r.get(9)?,
                    parent_agent_id: r.get(10)?,
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

/// List all child agents of `parent_agent_id` (owned by `profile_id`).
/// Ownership is gated through the project chain (parent and children
/// must both belong to projects owned by the caller). Ordering is
/// newest-first by creation time, like `pm_list_agents`.
#[napi]
pub fn pm_get_children(profile_id: i32, parent_agent_id: i32) -> Result<Vec<PmAgent>> {
    let profile_id = valid_profile_id(profile_id)?;
    let parent_agent_id = valid_id(parent_agent_id, "parent_agent_id")?;
    with_db(|conn| {
        // Verify the parent belongs to the caller's profile.
        let n: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM pm_agents a
                 JOIN pm_projects p ON p.id = a.project_id
                 WHERE a.id = ?1 AND p.profile_id = ?2",
                params![parent_agent_id, profile_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "Parent agent not found in this profile",
            ));
        }
        let mut stmt = conn
            .prepare(
                "SELECT a.id, a.project_id, a.objective, a.state, a.plan_json,
                        a.tokens_in, a.tokens_out, a.finished_at, a.created_at, a.updated_at,
                        a.parent_agent_id
                 FROM pm_agents a
                 JOIN pm_projects p ON p.id = a.project_id
                 WHERE a.parent_agent_id = ?1 AND p.profile_id = ?2
                 ORDER BY a.created_at DESC, a.id DESC",
            )
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![parent_agent_id, profile_id], |r| {
                Ok(PmAgent {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    objective: r.get(2)?,
                    state: r.get(3)?,
                    plan_json: r.get(4)?,
                    tokens_in: r.get(5)?,
                    tokens_out: r.get(6)?,
                    finished_at: r.get(7)?,
                    created_at: r.get(8)?,
                    updated_at: r.get(9)?,
                    parent_agent_id: r.get(10)?,
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

/// Set (or clear) the parent_agent_id of `agent_id`. Ownership is
/// gated through the project chain: both the child and the parent
/// must belong to projects owned by `profile_id`. Pass `parent_agent_id
/// = 0` to clear the link (the column is then set to NULL).
#[napi]
pub fn pm_set_parent(profile_id: i32, agent_id: i32, parent_agent_id: i32) -> Result<()> {
    let profile_id = valid_profile_id(profile_id)?;
    let agent_id = valid_id(agent_id, "agent_id")?;
    let parent_agent_id = valid_id(parent_agent_id, "parent_agent_id")?;
    with_db(|conn| {
        // Verify the child belongs to the caller's profile.
        assert_agent_owned_by(conn, profile_id, agent_id)?;
        let new_parent: Option<i32> = if parent_agent_id == 0 {
            None
        } else {
            // Verify the proposed parent belongs to the SAME project as
            // the child (no cross-project parenting) and to the same
            // profile. The two-step check below mirrors the project's
            // ownership chain.
            let row: Option<(i32, i32, i32)> = conn
                .query_row(
                    "SELECT a.project_id, p.profile_id, p.id
                     FROM pm_agents a
                     JOIN pm_projects p ON p.id = a.project_id
                     WHERE a.id = ?1",
                    params![parent_agent_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(to_err)?;
            let (parent_project_id, parent_profile_id, _pid) = match row {
                Some(t) => t,
                None => {
                    return Err(coded(codes::NOT_OWNED, "Parent agent not found"));
                }
            };
            if parent_profile_id != profile_id {
                return Err(coded(codes::NOT_OWNED, "Parent agent not in this profile"));
            }
            // Cross-check that the child + parent share a project.
            let child_project_id: i32 = conn
                .query_row(
                    "SELECT project_id FROM pm_agents WHERE id = ?1",
                    params![agent_id],
                    |r| r.get(0),
                )
                .map_err(to_err)?;
            if child_project_id != parent_project_id {
                return Err(coded(
                    codes::NOT_OWNED,
                    "Parent agent must be in the same project",
                ));
            }
            // Reject self-parenting and longer parent/child cycles. Without
            // this guard a malicious renderer could create a cyclic agent
            // graph that breaks recursive traversal and cancellation.
            let would_cycle: i32 = conn
                .query_row(
                    "WITH RECURSIVE descendants(id) AS (
                         SELECT ?1
                         UNION
                         SELECT a.id
                         FROM pm_agents a
                         JOIN descendants d ON a.parent_agent_id = d.id
                     )
                     SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?2)",
                    params![agent_id, parent_agent_id],
                    |r| r.get(0),
                )
                .map_err(to_err)?;
            if would_cycle != 0 {
                return Err(coded(
                    codes::INVALID_INPUT,
                    "Parent link would create an agent cycle",
                ));
            }
            Some(parent_agent_id)
        };
        let n = conn
            .execute(
                "UPDATE pm_agents
                 SET parent_agent_id = ?2, updated_at = datetime('now','localtime')
                 WHERE id = ?1
                   AND project_id IN (SELECT id FROM pm_projects WHERE profile_id = ?3)",
                params![agent_id, new_parent, profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(codes::NOT_OWNED, "Agent not found in this profile"));
        }
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// pm_messages (transcript)
// ---------------------------------------------------------------------------

/// Append a message to an agent's transcript. `seq` is auto-computed as
/// the next available integer for the agent. `payload_json` is optional
/// (used by tool_call, tool_result, error, status).
#[napi]
pub fn pm_append_message(
    profile_id: i32,
    agent_id: i32,
    role: String,
    content: String,
    name: Option<String>,
    payload_json: Option<String>,
) -> Result<i32> {
    let profile_id = valid_profile_id(profile_id)?;
    let agent_id = valid_id(agent_id, "agent_id")?;
    let role = required_text(role, "role", 32)?;
    let content = text(Some(content), "content", MAX_MESSAGE_CONTENT)?.unwrap_or_default();
    with_immediate_transaction(|conn| {
        // Verify ownership: agent must belong to a project owned by the
        // caller's profile.
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
        // Append at next seq.
        let next_seq: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM pm_messages WHERE agent_id = ?1",
                params![agent_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        conn.execute(
            "INSERT INTO pm_messages (agent_id, seq, role, content, name, payload_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![agent_id, next_seq, role, content, name, payload_json],
        )
        .map_err(to_err)?;
        Ok(next_seq)
    })
}

/// Paginated message list for the session timeline panel. Returns the
/// `limit` newest messages where `id < before` (cursor-based pagination).
/// When `before` is null the newest `limit` messages are returned.
/// Ordered newest-first (seq DESC) so the UI can display a natural
/// scrollback without re-fetching the whole transcript.
#[napi]
pub fn pm_list_messages_paginated(
    profile_id: i32,
    agent_id: i32,
    limit: Option<i32>,
    before: Option<i32>,
) -> Result<Vec<PmMessage>> {
    let profile_id = valid_profile_id(profile_id)?;
    let agent_id = valid_id(agent_id, "agent_id")?;
    let raw_limit = limit.unwrap_or(50);
    let limit = if raw_limit < 1 {
        1
    } else if raw_limit > 200 {
        200
    } else {
        raw_limit
    };
    with_db(|conn| {
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
        // Collect each arm into a Vec<PmMessage> so the match returns a
        // single unified type. (The two closures have distinct types and
        // Rust cannot unify `MappedRows<closure_a>` with `MappedRows<closure_b>`.)
        // Each `?` propagates up to the enclosing `with_db` closure, which
        // returns `Result<Vec<PmMessage>, napi::Error>`.
        let rows: Vec<PmMessage> = match before {
            Some(bid) => {
                let bid = valid_id(bid, "before")?;
                let mut stmt = conn
                    .prepare(
                        "SELECT id, agent_id, seq, role, content, name, payload_json, created_at
                         FROM pm_messages
                         WHERE agent_id = ?1 AND id < ?2
                         ORDER BY seq DESC
                         LIMIT ?3",
                    )
                    .map_err(to_err)?;
                let mut v = Vec::new();
                for row in stmt
                    .query_map(params![agent_id, bid, limit], |r| {
                        Ok(PmMessage {
                            id: r.get(0)?,
                            agent_id: r.get(1)?,
                            seq: r.get(2)?,
                            role: r.get(3)?,
                            content: r.get(4)?,
                            name: r.get(5)?,
                            payload_json: r.get(6)?,
                            created_at: r.get(7)?,
                        })
                    })
                    .map_err(to_err)?
                {
                    v.push(row.map_err(to_err)?);
                }
                v
            }
            None => {
                let mut stmt = conn
                    .prepare(
                        "SELECT id, agent_id, seq, role, content, name, payload_json, created_at
                         FROM pm_messages
                         WHERE agent_id = ?1
                         ORDER BY seq DESC
                         LIMIT ?2",
                    )
                    .map_err(to_err)?;
                let mut v = Vec::new();
                for row in stmt
                    .query_map(params![agent_id, limit], |r| {
                        Ok(PmMessage {
                            id: r.get(0)?,
                            agent_id: r.get(1)?,
                            seq: r.get(2)?,
                            role: r.get(3)?,
                            content: r.get(4)?,
                            name: r.get(5)?,
                            payload_json: r.get(6)?,
                            created_at: r.get(7)?,
                        })
                    })
                    .map_err(to_err)?
                {
                    v.push(row.map_err(to_err)?);
                }
                v
            }
        };
        Ok(rows)
    })
}

#[napi]
pub fn pm_list_messages(profile_id: i32, agent_id: i32) -> Result<Vec<PmMessage>> {
    let profile_id = valid_profile_id(profile_id)?;
    let agent_id = valid_id(agent_id, "agent_id")?;
    with_db(|conn| {
        // Verify ownership first.
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
        let mut stmt = conn
            .prepare(
                "SELECT id, agent_id, seq, role, content, name, payload_json, created_at
                 FROM pm_messages WHERE agent_id = ?1 ORDER BY seq ASC",
            )
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![agent_id], |r| {
                Ok(PmMessage {
                    id: r.get(0)?,
                    agent_id: r.get(1)?,
                    seq: r.get(2)?,
                    role: r.get(3)?,
                    content: r.get(4)?,
                    name: r.get(5)?,
                    payload_json: r.get(6)?,
                    created_at: r.get(7)?,
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

/// Recent failed agent runs for a profile, newest-first. Returns the
/// same columns as `pm_list_recent_agent_runs` plus the last recorded
/// error/status message for each failed agent (from `pm_messages`
/// `role='status'` Ã¢â‚¬â€ that is where the agent loop records verification
/// failures, budget-exceeded, and fix-retry traces).
///
/// `since` is an optional ISO-8601 timestamp. When present, only agents
/// whose `finished_at` (or `updated_at` if not yet finished) is at or
/// after `since` are returned. `limit` is clamped to [1, 500].
///
/// A failed agent with no status message (e.g. `loop-error` from the
/// loop's outer catch, or `max-steps-exceeded` without a preceding
/// status row) is still returned with empty `error_message` /
/// `error_payload` Ã¢â‚¬â€ the UI can render a "(no detail)" placeholder.
#[napi(object)]
pub struct FailedAgentRun {
    pub id: i32,
    pub project_id: i32,
    pub objective: String,
    pub state: String,
    pub created_at: String,
    pub updated_at: String,
    pub finished_at: Option<String>,
    pub tokens_in: i32,
    pub tokens_out: i32,
    pub error_message: String,
    pub error_payload: String,
    pub error_name: Option<String>,
    pub error_ts: Option<String>,
}

#[napi]
pub fn pm_list_failed_agent_runs(
    profile_id: i32,
    since: Option<String>,
    limit: Option<i32>,
) -> Result<Vec<FailedAgentRun>> {
    let profile_id = valid_profile_id(profile_id)?;
    let since = since.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    let raw_limit = limit.unwrap_or(50);
    let limit = if raw_limit < 1 {
        1
    } else if raw_limit > 500 {
        500
    } else {
        raw_limit
    };
    with_db(|conn| {
        // The correlated subquery picks the newest status message per
        // agent. We restrict to role='status' because that is where the
        // agent loop persists verification failures / budget-exceeded /
        // fix-retry traces. Tool results are per-call and not useful as
        // a "run summary"; error-role rows are not written by the loop.
        let mut stmt = conn
            .prepare(
                "SELECT a.id, a.project_id, a.objective, a.state,
                        a.created_at, a.updated_at, a.finished_at,
                        a.tokens_in, a.tokens_out,
                        COALESCE(err.content, '') AS error_message,
                        COALESCE(err.payload_json, '') AS error_payload,
                        err.name AS error_name,
                        err.created_at AS error_ts
                 FROM pm_agents a
                 JOIN pm_projects p ON p.id = a.project_id
                 LEFT JOIN (
                     SELECT m1.id, m1.agent_id, m1.role, m1.content,
                            m1.name, m1.payload_json, m1.created_at
                     FROM pm_messages m1
                     WHERE m1.role = 'status'
                       AND m1.id = (
                           SELECT MAX(m2.id)
                           FROM pm_messages m2
                           WHERE m2.agent_id = m1.agent_id
                             AND m2.role = 'status'
                       )
                 ) err ON err.agent_id = a.id
                 WHERE p.profile_id = ?1
                   AND a.state = 'failed'
                   AND (?2 IS NULL
                        OR COALESCE(a.finished_at, a.updated_at) >= ?2)
                 ORDER BY COALESCE(a.finished_at, a.updated_at) DESC,
                          a.id DESC
                 LIMIT ?3",
            )
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![profile_id, since, limit], |r| {
                Ok(FailedAgentRun {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    objective: r.get(2)?,
                    state: r.get(3)?,
                    created_at: r.get(4)?,
                    updated_at: r.get(5)?,
                    finished_at: r.get(6)?,
                    tokens_in: r.get(7)?,
                    tokens_out: r.get(8)?,
                    error_message: r.get(9)?,
                    error_payload: r.get(10)?,
                    error_name: r.get(11)?,
                    error_ts: r.get(12)?,
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

// Tiny internal helper used by the agent loop to verify ownership in
// one shot. Not exposed to JS.
pub(crate) fn assert_agent_owned_by(
    conn: &Connection,
    profile_id: i32,
    agent_id: i32,
) -> Result<()> {
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

// ---------------------------------------------------------------------------
// subagent_runs telemetry
// ---------------------------------------------------------------------------
//
// Per-invocation log for sub-agent runs. The agent loop calls
// `pmInsertSubagentRun` at dispatch and `pmEndSubagentRun` when the
// child reaches a terminal state. The list endpoint powers a future
// "Sub-agent activity" panel in the UI.
//
// Schema lives in migrations/019_subagent_runs.sql. Profile ownership
// is enforced through the parent_agent_id chain (parent must belong to
// a project owned by the caller's profile). Telemetry rows survive
// their referent Ã¢â‚¬â€ there is no FK to pm_agents.

#[napi(object)]
pub struct SubagentRun {
    pub id: i32,
    pub parent_agent_id: i32,
    pub role: Option<String>,
    pub child_agent_id: Option<i32>,
    pub run_id: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub outcome: Option<String>,
    pub tokens_in: Option<i32>,
    pub tokens_out: Option<i32>,
    pub error: String,
}

const MAX_SUBAGENT_ROLE: usize = 64;
const MAX_SUBAGENT_RUN_ID: usize = 64;
const MAX_SUBAGENT_OUTCOME: usize = 32;
const MAX_SUBAGENT_ERROR: usize = 2_000;

/// Insert a new subagent_runs row at dispatch time. Returns the new id.
/// `parent_agent_id` must exist in pm_agents and belong to a project
/// owned by `profile_id` (ownership-gated). `role`, `child_agent_id`
/// and `run_id` are optional. The row is left with `ended_at`/`outcome`
/// NULL Ã¢â‚¬â€ the matching `pm_end_subagent_run` call closes it.
#[napi]
pub fn pm_insert_subagent_run(
    profile_id: i32,
    parent_agent_id: i32,
    role: Option<String>,
    child_agent_id: Option<i32>,
    run_id: Option<String>,
) -> Result<i32> {
    let profile_id = valid_profile_id(profile_id)?;
    let parent_agent_id = valid_id(parent_agent_id, "parent_agent_id")?;
    let role = text(role, "role", MAX_SUBAGENT_ROLE)?;
    let run_id = text(run_id, "run_id", MAX_SUBAGENT_RUN_ID)?;
    let child_agent_id = match child_agent_id {
        Some(id) => {
            let v = valid_id(id, "child_agent_id")?;
            Some(v)
        }
        None => None,
    };
    with_db(|conn| {
        assert_agent_owned_by(conn, profile_id, parent_agent_id)?;
        if let Some(child_id) = child_agent_id {
            let n: i32 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pm_agents child
                     JOIN pm_projects cp ON cp.id = child.project_id
                     JOIN pm_agents parent ON parent.project_id = child.project_id
                     JOIN pm_projects pp ON pp.id = parent.project_id
                     WHERE child.id = ?1 AND parent.id = ?2
                       AND cp.profile_id = ?3 AND pp.profile_id = ?3",
                    params![child_id, parent_agent_id, profile_id],
                    |r| r.get(0),
                )
                .map_err(to_err)?;
            if n == 0 {
                return Err(coded(codes::NOT_OWNED, "Child agent not found in the parent's project"));
            }
        }
        conn.execute(
            "INSERT INTO subagent_runs
                (parent_agent_id, role, child_agent_id, run_id)
             VALUES (?1, ?2, ?3, ?4)",
            params![parent_agent_id, role, child_agent_id, run_id],
        )
        .map_err(to_err)?;
        Ok(conn.last_insert_rowid() as i32)
    })
}

/// Close an open subagent_runs row. Sets `ended_at`, `outcome`,
/// `tokens_in`, `tokens_out`, and `error`. Refuses to update a row
/// that is already terminal (a defence against double-end races where
/// two paths each think they are the closer).
#[napi]
pub fn pm_end_subagent_run(
    profile_id: i32,
    id: i32,
    outcome: String,
    tokens_in: i32,
    tokens_out: i32,
    error: Option<String>,
) -> Result<()> {
    let profile_id = valid_profile_id(profile_id)?;
    let id = valid_id(id, "id")?;
    let outcome = required_text(outcome, "outcome", MAX_SUBAGENT_OUTCOME)?;
    let error = text(error, "error", MAX_SUBAGENT_ERROR)?.unwrap_or_default();
    with_db(|conn| {
        // Verify the row exists and the parent belongs to the caller's
        // profile. Ownership is gated through the parent_agent_id
        // chain Ã¢â‚¬â€ same pattern as pm_update_agent.
        let n: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM subagent_runs r
                 JOIN pm_agents a ON a.id = r.parent_agent_id
                 JOIN pm_projects p ON p.id = a.project_id
                 WHERE r.id = ?1 AND p.profile_id = ?2",
                params![id, profile_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "Sub-agent run not found in this profile",
            ));
        }
        // Refuse double-end. An already-terminal row is a bug.
        let already_ended: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM subagent_runs
                 WHERE id = ?1 AND ended_at IS NOT NULL",
                params![id],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        if already_ended > 0 {
            return Err(coded(codes::INVALID_INPUT, "Sub-agent run already ended"));
        }
        let n = conn
            .execute(
                "UPDATE subagent_runs
                 SET ended_at = datetime('now','localtime'),
                     outcome = ?2,
                     tokens_in = ?3,
                     tokens_out = ?4,
                     error = ?5
                 WHERE id = ?1",
                params![id, outcome, tokens_in, tokens_out, error],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(codes::NOT_OWNED, "Sub-agent run vanished"));
        }
        Ok(())
    })
}

/// List subagent_runs rows for `profile_id`. Ordered newest-first by
/// `started_at DESC, id DESC` (the same order the index supports).
/// `limit` is clamped to [1, 1000] so a UI bug can't pull the entire
/// table.
#[napi]
pub fn pm_list_subagent_runs(
    profile_id: i32,
    parent_agent_id: Option<i32>,
    limit: Option<i32>,
) -> Result<Vec<SubagentRun>> {
    let profile_id = valid_profile_id(profile_id)?;
    let parent_agent_id = match parent_agent_id {
        Some(id) => Some(valid_id(id, "parent_agent_id")?),
        None => None,
    };
    let raw_limit = limit.unwrap_or(200);
    let limit = if raw_limit < 1 {
        1
    } else if raw_limit > 1000 {
        1000
    } else {
        raw_limit
    };
    with_db(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT r.id, r.parent_agent_id, r.role, r.child_agent_id,
                        r.run_id, r.started_at, r.ended_at, r.outcome,
                        r.tokens_in, r.tokens_out, r.error
                 FROM subagent_runs r
                 JOIN pm_agents a ON a.id = r.parent_agent_id
                 JOIN pm_projects p ON p.id = a.project_id
                 WHERE p.profile_id = ?1
                   AND (?2 IS NULL OR r.parent_agent_id = ?2)
                 ORDER BY r.started_at DESC, r.id DESC
                 LIMIT ?3",
            )
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![profile_id, parent_agent_id, limit], |r| {
                Ok(SubagentRun {
                    id: r.get(0)?,
                    parent_agent_id: r.get(1)?,
                    role: r.get(2)?,
                    child_agent_id: r.get(3)?,
                    run_id: r.get(4)?,
                    started_at: r.get(5)?,
                    ended_at: r.get(6)?,
                    outcome: r.get(7)?,
                    tokens_in: r.get(8)?,
                    tokens_out: r.get(9)?,
                    error: r.get(10)?,
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

/// Get the default provider for a project. Returns the provider ID string
/// (e.g., "openai-compatible", "mock"), or null if not set (defaults to
/// "openai-compatible").
#[napi]
pub fn pm_get_default_provider(profile_id: i32, project_id: i32) -> Result<Option<String>> {
    let profile_id = valid_profile_id(profile_id)?;
    let project_id = valid_id(project_id, "project_id")?;
    with_db(|conn| {
        // Verify the project belongs to the caller's profile.
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
        // Get the config_json and parse out the defaultProvider field
        let config_json: String = conn
            .query_row(
                "SELECT config_json FROM pm_projects WHERE id = ?1",
                params![project_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        // Parse the JSON to extract defaultProvider
        let default_provider: Option<String> =
            serde_json::from_str(&config_json)
                .ok()
                .and_then(|map: serde_json::Value| {
                    map.get("defaultProvider")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                });
        Ok(default_provider)
    })
}

/// Set the default provider for a project.
/// provider_id should be one of: "openai-compatible", "mock"
#[napi]
pub fn pm_set_default_provider(
    profile_id: i32,
    project_id: i32,
    provider_id: String,
) -> Result<()> {
    let profile_id = valid_profile_id(profile_id)?;
    let project_id = valid_id(project_id, "project_id")?;
    // Validate provider_id
    let provider_id = provider_id.trim();
    if provider_id.is_empty()
        || (!provider_id.eq_ignore_ascii_case("openai-compatible")
            && !provider_id.eq_ignore_ascii_case("mock"))
    {
        return Err(coded(
            codes::INVALID_INPUT,
            "provider_id must be 'openai-compatible' or 'mock'",
        ));
    }
    with_db(|conn| {
        // Verify the project belongs to the caller's profile.
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
        // Get existing config_json, update defaultProvider field, write back
        let mut config_json: String = conn
            .query_row(
                "SELECT config_json FROM pm_projects WHERE id = ?1",
                params![project_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        // Parse, update, and serialize back
        let mut map: serde_json::Value =
            serde_json::from_str(&config_json).unwrap_or_else(|_| serde_json::json!({}));
        map["defaultProvider"] = serde_json::Value::String(provider_id.to_string());
        config_json = serde_json::to_string(&map)
            .map_err(|e| coded(codes::INTERNAL, format!("Failed to serialize JSON: {}", e)))?;
        conn.execute(
            "UPDATE pm_projects SET config_json = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
            params![config_json, project_id],
        )
        .map_err(to_err)?;
        Ok(())
    })
}

/// Recent parent-agent runs for a profile, newest-first across every
/// project the profile owns. Each `pm_agents` row is one agent run; this
/// gives the history panel a single bounded call instead of fan-out over
/// `pm_list_agents` per project. `limit` is clamped to [1, 1000].
#[napi(object)]
pub struct AgentRunSummary {
    pub id: i32,
    pub project_id: i32,
    pub objective: String,
    pub state: String,
    pub tokens_in: i32,
    pub tokens_out: i32,
    pub finished_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[napi]
pub fn pm_list_recent_agent_runs(
    profile_id: i32,
    limit: Option<i32>,
) -> Result<Vec<AgentRunSummary>> {
    let profile_id = valid_profile_id(profile_id)?;
    let raw_limit = limit.unwrap_or(50);
    let limit = if raw_limit < 1 {
        1
    } else if raw_limit > 1000 {
        1000
    } else {
        raw_limit
    };
    with_db(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT a.id, a.project_id, a.objective, a.state,
                        a.tokens_in, a.tokens_out, a.finished_at,
                        a.created_at, a.updated_at
                 FROM pm_agents a
                 JOIN pm_projects p ON p.id = a.project_id
                 WHERE p.profile_id = ?1
                 ORDER BY a.created_at DESC, a.id DESC
                 LIMIT ?2",
            )
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![profile_id, limit], |r| {
                Ok(AgentRunSummary {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    objective: r.get(2)?,
                    state: r.get(3)?,
                    tokens_in: r.get(4)?,
                    tokens_out: r.get(5)?,
                    finished_at: r.get(6)?,
                    created_at: r.get(7)?,
                    updated_at: r.get(8)?,
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

// ---------------------------------------------------------------------------
// pm_plan_templates (saved plans, reusable across runs)
// ---------------------------------------------------------------------------
//
// A user may save a finished (or partial) plan as a named template and
// re-load it later as the starter plan for a new agent run. Templates are
// scoped by profile_id so the renderer can never read another profile's
// saved plans. The NAPI surface mirrors pm_projects / pm_agents: validate
// at the boundary, gate ownership in the SQL, and return minimal DTOs.

// Per-template cap. The plan_json blob is the same shape as pm_agents.plan_json;
// we keep it at the agent-side limit (200 KB) so a saved plan stays portable.
const MAX_PLAN_TEMPLATE_JSON: usize = 200_000;
const MAX_PLAN_TEMPLATE_DESC: usize = 100_000;

#[napi(object)]
pub struct PmPlanTemplate {
    pub id: i32,
    pub profile_id: i32,
    pub name: String,
    pub description: String,
    pub plan_json: String,
    pub step_count: i32,
    pub created_at: String,
    pub updated_at: String,
}

/// Parse a plan JSON string into the canonical { steps, version } shape
/// and return the step count. Mirrors `parsePlan` in
/// `shell/src/services/agent/plan.js` so the on-disk shape is the same.
fn count_plan_steps(plan_json: &str) -> Result<i32> {
    let parsed: serde_json::Value = serde_json::from_str(plan_json).map_err(|e| {
        coded(
            codes::INVALID_INPUT,
            format!("plan_json is not valid JSON: {}", e),
        )
    })?;
    let steps = match parsed {
        serde_json::Value::Array(arr) => arr,
        serde_json::Value::Object(ref map) => match map.get("steps") {
            Some(serde_json::Value::Array(arr)) => arr.clone(),
            _ => {
                return Err(coded(
                    codes::INVALID_INPUT,
                    "plan_json must be an array or {steps:[]} object",
                ))
            }
        },
        _ => {
            return Err(coded(
                codes::INVALID_INPUT,
                "plan_json must be an array or {steps:[]} object",
            ))
        }
    };
    let n = steps.len() as i32;
    Ok(n)
}

/// Save (or overwrite) a plan template. Returns the row id. If a template
/// with the same `name` already exists for the profile, the row is updated
/// in place (description + plan_json + step_count + updated_at refreshed).
/// `name` must be non-empty and unique per profile; the SQL UNIQUE
/// constraint is the authoritative guard, but we also reject empty /
/// over-long names at the boundary so the renderer gets a clear message.
#[napi]
pub fn pm_save_plan_template(
    profile_id: i32,
    name: String,
    description: Option<String>,
    plan_json: String,
) -> Result<i32> {
    let profile_id = valid_profile_id(profile_id)?;
    let name = required_text(name, "name", MAX_NAME)?;
    let description = text(description, "description", MAX_PLAN_TEMPLATE_DESC)?.unwrap_or_default();
    let plan_json = text(Some(plan_json), "plan_json", MAX_PLAN_TEMPLATE_JSON)?
        .ok_or_else(|| coded(codes::INVALID_INPUT, "plan_json is required"))?;
    // Validate JSON shape and compute step_count for the denormalised column.
    let step_count = count_plan_steps(&plan_json)?;
    with_db(|conn| {
        // Verify the profile exists (mirrors pm_create_project's early check
        // so the FK error surfaces as a clear NOT_OWNED rather than a raw
        // SQLITE_CONSTRAINT_FOREIGNKEY message).
        let n: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM profiles WHERE id = ?1",
                params![profile_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(codes::NOT_OWNED, "Profile does not exist"));
        }
        // Upsert on (profile_id, name).
        conn.execute(
            "INSERT INTO pm_plan_templates (profile_id, name, description, plan_json, step_count)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(profile_id, name) DO UPDATE SET
                description = excluded.description,
                plan_json   = excluded.plan_json,
                step_count  = excluded.step_count,
                updated_at  = datetime('now','localtime')",
            params![profile_id, name, description, plan_json, step_count],
        )
        .map_err(to_err)?;
        // Resolve the id (could be either the freshly inserted row or the
        // updated existing one).
        let id: i32 = conn
            .query_row(
                "SELECT id FROM pm_plan_templates WHERE profile_id = ?1 AND name = ?2",
                params![profile_id, name],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        Ok(id)
    })
}

/// List plan templates for the given profile, newest-first. Returns one
/// row per saved template; step_count is the denormalised number of steps
/// at save time so the renderer can render the table without re-parsing.
#[napi]
pub fn pm_list_plan_templates(profile_id: i32) -> Result<Vec<PmPlanTemplate>> {
    let profile_id = valid_profile_id(profile_id)?;
    with_db(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT id, profile_id, name, description, plan_json, step_count,
                        created_at, updated_at
                 FROM pm_plan_templates
                 WHERE profile_id = ?1
                 ORDER BY updated_at DESC, id DESC",
            )
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![profile_id], |r| {
                Ok(PmPlanTemplate {
                    id: r.get(0)?,
                    profile_id: r.get(1)?,
                    name: r.get(2)?,
                    description: r.get(3)?,
                    plan_json: r.get(4)?,
                    step_count: r.get(5)?,
                    created_at: r.get(6)?,
                    updated_at: r.get(7)?,
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

/// Load a single plan template (the full row, including plan_json). The
/// renderer can either pass the row id (preferred) or the template name;
/// name-based lookup is offered as a convenience so the UI can route by
/// `name` without first listing the table. Both lookup paths enforce
/// profile ownership at the SQL boundary.
#[napi]
pub fn pm_load_plan_template(
    profile_id: i32,
    template_id: Option<i32>,
    name: Option<String>,
) -> Result<PmPlanTemplate> {
    let profile_id = valid_profile_id(profile_id)?;
    let template_id = match template_id {
        Some(id) => Some(valid_id(id, "template_id")?),
        None => None,
    };
    let name = text(name, "name", MAX_NAME)?;
    if template_id.is_none() && name.is_none() {
        return Err(coded(
            codes::INVALID_INPUT,
            "either template_id or name is required",
        ));
    }
    with_db(|conn| {
        // Resolve by id first if provided; fall back to (profile_id, name)
        // otherwise. Both branches gate on profile_id at the SQL boundary.
        if let Some(tid) = template_id {
            let row = conn
                .query_row(
                    "SELECT id, profile_id, name, description, plan_json, step_count,
                            created_at, updated_at
                     FROM pm_plan_templates
                     WHERE id = ?1 AND profile_id = ?2",
                    params![tid, profile_id],
                    |r| {
                        Ok(PmPlanTemplate {
                            id: r.get(0)?,
                            profile_id: r.get(1)?,
                            name: r.get(2)?,
                            description: r.get(3)?,
                            plan_json: r.get(4)?,
                            step_count: r.get(5)?,
                            created_at: r.get(6)?,
                            updated_at: r.get(7)?,
                        })
                    },
                )
                .map_err(to_err)?;
            return Ok(row);
        }
        if let Some(ref nm) = name {
            let row = conn
                .query_row(
                    "SELECT id, profile_id, name, description, plan_json, step_count,
                            created_at, updated_at
                     FROM pm_plan_templates
                     WHERE name = ?1 AND profile_id = ?2",
                    params![nm, profile_id],
                    |r| {
                        Ok(PmPlanTemplate {
                            id: r.get(0)?,
                            profile_id: r.get(1)?,
                            name: r.get(2)?,
                            description: r.get(3)?,
                            plan_json: r.get(4)?,
                            step_count: r.get(5)?,
                            created_at: r.get(6)?,
                            updated_at: r.get(7)?,
                        })
                    },
                )
                .map_err(to_err)?;
            return Ok(row);
        }
        Err(coded(
            codes::INVALID_INPUT,
            "either template_id or name is required",
        ))
    })
}

/// Delete a plan template. Enforces profile ownership at the SQL boundary
/// (the `AND profile_id = ?2` clause) so a user cannot delete another
/// profile's templates by guessing ids. Returns `NOT_OWNED` when no row
/// matched Ã¢â‚¬â€ i.e. the template does not exist in this profile Ã¢â‚¬â€ so the
/// UI can surface a clear message rather than a raw constraint error.
#[napi]
pub fn pm_delete_plan_template(profile_id: i32, template_id: i32) -> Result<()> {
    let profile_id = valid_profile_id(profile_id)?;
    let template_id = valid_id(template_id, "template_id")?;
    with_db(|conn| {
        let n = conn
            .execute(
                "DELETE FROM pm_plan_templates WHERE id = ?1 AND profile_id = ?2",
                params![template_id, profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "Plan template not found in this profile",
            ));
        }
        Ok(())
    })
}

#[cfg(test)]
mod concurrency_tests {
    use super::*;
    use crate::db::{init_db, with_db};
    use rusqlite::params;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn concurrent_message_appends_get_unique_sequences() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let db_path = std::env::temp_dir().join(format!("careerflow-pm-message-{stamp}.db"));
        init_db(db_path.to_string_lossy().into_owned()).expect("init db");

        let (profile_id, agent_id) = with_db(|conn| {
            conn.execute(
                "INSERT INTO profiles(name, slug) VALUES (?1, ?2)",
                params!["concurrency-test", format!("concurrency-{stamp}")],
            )
            .map_err(crate::db::to_err)?;
            let profile_id = conn.last_insert_rowid() as i32;
            conn.execute(
                "INSERT INTO pm_projects(profile_id, name, root_path) VALUES (?1, ?2, ?3)",
                params![profile_id, "project", db_path.to_string_lossy()],
            )
            .map_err(crate::db::to_err)?;
            let project_id = conn.last_insert_rowid() as i32;
            conn.execute(
                "INSERT INTO pm_agents(project_id, objective) VALUES (?1, ?2)",
                params![project_id, "concurrent append test"],
            )
            .map_err(crate::db::to_err)?;
            Ok((profile_id, conn.last_insert_rowid() as i32))
        })
        .expect("seed db");

        let barrier = Arc::new(Barrier::new(2));
        let mut handles = Vec::new();
        for content in ["first", "second"] {
            let barrier = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                barrier.wait();
                pm_append_message(
                    profile_id,
                    agent_id,
                    "assistant".to_string(),
                    content.to_string(),
                    None,
                    None,
                )
            }));
        }
        let mut seqs = handles
            .into_iter()
            .map(|h| h.join().expect("append thread panicked").expect("append failed"))
            .collect::<Vec<_>>();
        seqs.sort_unstable();
        assert_eq!(seqs, vec![1, 2]);

        with_db(|conn| {
            let count: i32 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pm_messages WHERE agent_id = ?1",
                    params![agent_id],
                    |r| r.get(0),
                )
                .map_err(crate::db::to_err)?;
            assert_eq!(count, 2);
            Ok(())
        })
        .expect("verify persisted messages");

        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
        let _ = std::fs::remove_file(db_path.with_extension("db-shm"));
    }
}
