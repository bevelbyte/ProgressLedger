//! Career Planning: a profile's career goals and the ordered milestones toward
//! each goal. The smallest persistent model for "where am I going?" — no task
//! engine, no job/company tables. Owns only career_goals + career_milestones;
//! it never persists other domains' data.

use crate::errors::{coded, codes};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, OptionalExtension};

use crate::db::{to_err, with_db, with_transaction};
use crate::validate::{
    profile_id as valid_profile_id, required_text, text, valid_id, MAX_NAME, MAX_TEXT,
};

#[napi(object)]
pub struct CareerGoal {
    pub id: i32,
    pub profile_id: i32,
    pub title: String,
    pub target_role: Option<String>,
    pub domain: Option<String>,
    pub description: Option<String>,
    pub target_date: Option<String>,
    pub status: String,
    pub is_primary: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[napi(object)]
pub struct CareerMilestone {
    pub id: i32,
    pub goal_id: i32,
    pub title: String,
    pub description: Option<String>,
    pub target_date: Option<String>,
    pub sort_order: i32,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub linked_project_id: Option<i32>,
    pub linked_project_name: Option<String>,
    pub linked_subject_id: Option<i32>,
    pub linked_subject_name: Option<String>,
}

fn valid_status(s: &str) -> bool {
    matches!(s, "active" | "achieved" | "paused")
}

// ---- Goals ----

/// Create a career goal. If `is_primary`, it becomes the profile's sole primary
/// goal (any previous primary is demoted) — one primary per profile.
#[napi]
pub fn add_career_goal(
    profile_id: i32,
    title: String,
    target_role: Option<String>,
    domain: Option<String>,
    description: Option<String>,
    target_date: Option<String>,
    is_primary: Option<bool>,
) -> Result<i32> {
    let profile_id = valid_profile_id(profile_id)?;
    let title = required_text(title, "title", MAX_NAME)?;
    let target_role = text(target_role, "target_role", MAX_NAME)?;
    let domain = text(domain, "domain", MAX_NAME)?;
    let description = text(description, "description", MAX_TEXT)?;
    let target_date = text(target_date, "target_date", MAX_TEXT)?;
    let primary = is_primary.unwrap_or(false);
    with_transaction(|conn| {
        if primary {
            conn.execute(
                "UPDATE career_goals SET is_primary = 0 WHERE profile_id = ?1",
                params![profile_id],
            )
            .map_err(to_err)?;
        }
        conn.execute(
            "INSERT INTO career_goals (profile_id, title, target_role, domain, description, target_date, is_primary)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![profile_id, title, target_role, domain, description, target_date, primary as i32],
        )
        .map_err(to_err)?;
        Ok(conn.last_insert_rowid() as i32)
    })
}

#[napi]
pub fn get_career_goals(profile_id: i32) -> Result<Vec<CareerGoal>> {
    with_db(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT id, profile_id, title, target_role, domain, description, target_date,
                        status, is_primary, created_at, updated_at
                 FROM career_goals WHERE profile_id = ?1
                 ORDER BY is_primary DESC, created_at ASC, id ASC",
            )
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![profile_id], |r| {
                Ok(CareerGoal {
                    id: r.get(0)?,
                    profile_id: r.get(1)?,
                    title: r.get(2)?,
                    target_role: r.get(3)?,
                    domain: r.get(4)?,
                    description: r.get(5)?,
                    target_date: r.get(6)?,
                    status: r.get(7)?,
                    is_primary: r.get::<_, i32>(8)? != 0,
                    created_at: r.get(9)?,
                    updated_at: r.get(10)?,
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
pub fn update_career_goal(
    profile_id: i32,
    id: i32,
    title: String,
    target_role: Option<String>,
    domain: Option<String>,
    description: Option<String>,
    target_date: Option<String>,
    status: String,
) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let row_id = valid_id(id, "id")?;
    let title = required_text(title, "title", MAX_NAME)?;
    let target_role = text(target_role, "target_role", MAX_NAME)?;
    let domain = text(domain, "domain", MAX_NAME)?;
    let description = text(description, "description", MAX_TEXT)?;
    let target_date = text(target_date, "target_date", MAX_TEXT)?;
    if !valid_status(&status) {
        return Err(crate::errors::coded(
            crate::errors::codes::DB_CONSTRAINT,
            "status must be active, achieved, or paused",
        ));
    }
    with_db(|conn| {
        let n = conn
            .execute(
                "UPDATE career_goals
             SET title = ?2, target_role = ?3, domain = ?4, description = ?5,
                 target_date = ?6, status = ?7, updated_at = datetime('now','localtime')
             WHERE id = ?1 AND profile_id = ?8",
                params![
                    row_id,
                    title,
                    target_role,
                    domain,
                    description,
                    target_date,
                    status,
                    profile_id
                ],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "Career goal not found in this profile",
            ));
        }
        Ok(())
    })
}

/// Make one goal the profile's primary; demote all others for that profile.
#[napi]
pub fn set_primary_career_goal(profile_id: i32, id: i32) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let row_id = valid_id(id, "id")?;
    with_transaction(|conn| {
        let owner: i32 = conn
            .query_row(
                "SELECT profile_id FROM career_goals WHERE id = ?1",
                params![row_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(to_err)?
            .ok_or_else(|| coded(codes::NOT_OWNED, "Career goal not found in this profile"))?;
        if owner != profile_id {
            return Err(coded(codes::NOT_OWNED, "Career goal not found in this profile"));
        }
        conn.execute(
            "UPDATE career_goals SET is_primary = 0 WHERE profile_id = ?1",
            params![profile_id],
        )
        .map_err(to_err)?;
        conn.execute(
            "UPDATE career_goals SET is_primary = 1, updated_at = datetime('now','localtime') WHERE id = ?1",
            params![row_id],
        )
        .map_err(to_err)?;
        Ok(())
    })
}

/// Delete a career goal. `profile_id` is the caller's profile; the function
/// refuses to delete rows owned by another profile.
#[napi]
pub fn delete_career_goal(profile_id: i32, id: i32) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let row_id = valid_id(id, "id")?;
    with_db(|conn| {
        let n = conn
            .execute(
                "DELETE FROM career_goals WHERE id = ?1 AND profile_id = ?2",
                params![row_id, profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "Career goal not found in this profile",
            ));
        }
        Ok(())
    })
}

// ---- Milestones ----

/// Append a milestone to a goal (sort_order = current max + 1). `profile_id`
/// is the caller's profile; the goal must belong to it.
#[napi]
pub fn add_career_milestone(
    profile_id: i32,
    goal_id: i32,
    title: String,
    description: Option<String>,
    target_date: Option<String>,
) -> Result<i32> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let goal_id = valid_id(goal_id, "goal_id")?;
    let title = required_text(title, "title", MAX_NAME)?;
    let description = text(description, "description", MAX_TEXT)?;
    let target_date = text(target_date, "target_date", MAX_TEXT)?;
    with_transaction(|conn| {
        // Verify the goal belongs to profile_id.
        let owner: i32 = conn
            .query_row(
                "SELECT profile_id FROM career_goals WHERE id = ?1",
                params![goal_id],
                |r| r.get(0),
            )
            .map_err(|_| coded(codes::NOT_OWNED, "Career goal not found in this profile"))?;
        if owner != profile_id {
            return Err(coded(
                codes::NOT_OWNED,
                "Career goal not found in this profile",
            ));
        }
        let next_order: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM career_milestones WHERE goal_id = ?1",
                params![goal_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        conn.execute(
            "INSERT INTO career_milestones (goal_id, title, description, target_date, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![goal_id, title, description, target_date, next_order],
        )
        .map_err(to_err)?;
        Ok(conn.last_insert_rowid() as i32)
    })
}

#[napi]
pub fn get_career_milestones(profile_id: i32, goal_id: i32) -> Result<Vec<CareerMilestone>> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let goal_id = valid_id(goal_id, "goal_id")?;
    with_db(|conn| {
        let owner: i32 = conn
            .query_row(
                "SELECT profile_id FROM career_goals WHERE id = ?1",
                params![goal_id],
                |r| r.get(0),
            )
            .map_err(|_| coded(codes::NOT_OWNED, "Career goal not found in this profile"))?;
        if owner != profile_id {
            return Err(coded(
                codes::NOT_OWNED,
                "Career goal not found in this profile",
            ));
        }
        let mut stmt = conn
            .prepare(
                "SELECT cm.id, cm.goal_id, cm.title, cm.description, cm.target_date, cm.sort_order,
                        cm.completed_at, cm.created_at, cm.linked_project_id, p.name,
                        cm.linked_subject_id, s.name
                 FROM career_milestones cm
                 LEFT JOIN projects p ON p.id = cm.linked_project_id
                 LEFT JOIN subjects s ON s.id = cm.linked_subject_id
                 WHERE cm.goal_id = ?1 AND cm.goal_id IN (SELECT id FROM career_goals WHERE profile_id = ?2)
                 ORDER BY cm.sort_order ASC, cm.id ASC",
            )
            .map_err(to_err)?;
        let rows = stmt
            .query_map(params![goal_id, profile_id], |r| {
                Ok(CareerMilestone {
                    id: r.get(0)?,
                    goal_id: r.get(1)?,
                    title: r.get(2)?,
                    description: r.get(3)?,
                    target_date: r.get(4)?,
                    sort_order: r.get(5)?,
                    completed_at: r.get(6)?,
                    created_at: r.get(7)?,
                    linked_project_id: r.get(8)?,
                    linked_project_name: r.get(9)?,
                    linked_subject_id: r.get(10)?,
                    linked_subject_name: r.get(11)?,
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
pub fn update_career_milestone(
    profile_id: i32,
    id: i32,
    title: String,
    description: Option<String>,
    target_date: Option<String>,
) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let row_id = valid_id(id, "id")?;
    let title = required_text(title, "title", MAX_NAME)?;
    let description = text(description, "description", MAX_TEXT)?;
    let target_date = text(target_date, "target_date", MAX_TEXT)?;
    with_db(|conn| {
        let n = conn
            .execute(
                "UPDATE career_milestones
             SET title = ?2, description = ?3, target_date = ?4
             WHERE id = ?1
               AND goal_id IN (SELECT id FROM career_goals WHERE profile_id = ?5)",
                params![row_id, title, description, target_date, profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "Career milestone not found in this profile",
            ));
        }
        Ok(())
    })
}

/// Mark a milestone complete (stamp completed_at with local datetime) or reopen
/// it (clear completed_at). Mirrors deadline completion semantics.
#[napi]
pub fn set_career_milestone_completion(profile_id: i32, id: i32, completed: bool) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let row_id = valid_id(id, "id")?;
    with_db(|conn| {
        let n = if completed {
            conn.execute(
                "UPDATE career_milestones SET completed_at = datetime('now','localtime')
                 WHERE id = ?1
                   AND goal_id IN (SELECT id FROM career_goals WHERE profile_id = ?2)",
                params![row_id, profile_id],
            )
            .map_err(to_err)?
        } else {
            conn.execute(
                "UPDATE career_milestones SET completed_at = NULL
                 WHERE id = ?1
                   AND goal_id IN (SELECT id FROM career_goals WHERE profile_id = ?2)",
                params![row_id, profile_id],
            )
            .map_err(to_err)?
        };
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "Career milestone not found in this profile",
            ));
        }
        Ok(())
    })
}

/// Persist an explicit ordering. `ordered_ids` lists milestone ids in the
/// desired order; each row's sort_order is set to its index. `profile_id` is
/// the caller's profile; the goal must belong to it, and every id in
/// `ordered_ids` must belong to the same goal (otherwise the goal_id check
/// would be meaningless).
#[napi]
pub fn reorder_career_milestones(
    profile_id: i32,
    goal_id: i32,
    ordered_ids: Vec<i32>,
) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let goal_id = valid_id(goal_id, "goal_id")?;
    with_transaction(|conn| {
        // Verify the goal belongs to profile_id.
        let owner: i32 = conn
            .query_row(
                "SELECT profile_id FROM career_goals WHERE id = ?1",
                params![goal_id],
                |r| r.get(0),
            )
            .map_err(|_| coded(codes::NOT_OWNED, "Career goal not found in this profile"))?;
        if owner != profile_id {
            return Err(coded(
                codes::NOT_OWNED,
                "Career goal not found in this profile",
            ));
        }
        // Defense-in-depth: every id in ordered_ids must belong to this goal.
        // The WHERE clause already does this per-row, but we also want a single
        // transactional check that the *full set* matches, so a partial reorder
        // can't slip through if one of the rows was just reassigned to a
        // different goal.
        let placeholders: Vec<String> = (0..ordered_ids.len())
            .map(|i| format!("?{}", i + 2))
            .collect();
        let sql = format!(
            "SELECT COUNT(*) FROM career_milestones WHERE goal_id = ?1 AND id IN ({})",
            placeholders.join(",")
        );
        let mut params_vec: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(1 + ordered_ids.len());
        params_vec.push(&goal_id);
        for m in &ordered_ids {
            params_vec.push(m);
        }
        let matched: i32 = conn
            .query_row(&sql, &params_vec[..], |r| r.get(0))
            .map_err(to_err)?;
        if matched as usize != ordered_ids.len() {
            return Err(coded(
                codes::NOT_OWNED,
                "Career milestone not found in this profile",
            ));
        }
        for (idx, mid) in ordered_ids.iter().enumerate() {
            conn.execute(
                "UPDATE career_milestones SET sort_order = ?2 WHERE id = ?1 AND goal_id = ?3",
                params![mid, idx as i32, goal_id],
            )
            .map_err(to_err)?;
        }
        Ok(())
    })
}

/// Delete a career milestone. `profile_id` is the caller's profile; the
/// function refuses to delete rows whose owning goal belongs to another
/// profile. Resolves the milestone's goal -> profile before acting.
#[napi]
pub fn delete_career_milestone(profile_id: i32, id: i32) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let row_id = valid_id(id, "id")?;
    with_db(|conn| {
        let n = conn
            .execute(
                "DELETE FROM career_milestones
                 WHERE id = ?1
                   AND goal_id IN (SELECT id FROM career_goals WHERE profile_id = ?2)",
                params![row_id, profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "Career milestone not found in this profile",
            ));
        }
        Ok(())
    })
}

/// Set or clear a career milestone's linked project. Validates project ownership:
/// the project must belong to the same profile as the milestone's goal. When
/// `project_id` is None, clears the link. Cross-profile ownership is enforced
/// defensively at the domain layer even though the FK is now active on pooled
/// connections (belt-and-braces: we never want a code path to silently corrupt
/// due to a future PRAGMA misconfiguration). `profile_id` is the caller's
/// profile; the milestone's owning goal must match.
#[napi]
pub fn set_career_milestone_project(
    profile_id: i32,
    milestone_id: i32,
    project_id: Option<i32>,
) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let milestone_id = valid_id(milestone_id, "milestone_id")?;
    let project_id = match project_id {
        Some(pid) => Some(valid_id(pid, "project_id")?),
        None => None,
    };
    with_transaction(|conn| {
        // Get the milestone's goal and its profile.
        let owner_profile: i32 = conn
            .query_row(
                "SELECT cg.profile_id
                 FROM career_milestones cm
                 JOIN career_goals cg ON cg.id = cm.goal_id
                 WHERE cm.id = ?1",
                params![milestone_id],
                |r| r.get(0),
            )
            .map_err(|e| coded(codes::NOT_OWNED, format!("Milestone not found: {}", e)))?;
        if owner_profile != profile_id {
            return Err(coded(
                codes::NOT_OWNED,
                "Career milestone not found in this profile",
            ));
        }

        if let Some(pid) = project_id {
            // Verify the project exists and belongs to the SAME profile.
            let project_profile: i32 = conn
                .query_row(
                    "SELECT profile_id FROM projects WHERE id = ?1",
                    params![pid],
                    |r| r.get(0),
                )
                .map_err(|_| coded(codes::DB_CONSTRAINT, format!("Project {} not found", pid)))?;
            if project_profile != profile_id {
                return Err(coded(
                    codes::DB_CONSTRAINT,
                    "Project belongs to a different profile",
                ));
            }
            // Defense-in-depth: belt-and-braces filter that the milestone's
            // owning goal belongs to this profile, even though the pre-flight
            // ownership resolution above already proved it.
            let n = conn
                .execute(
                    "UPDATE career_milestones SET linked_project_id = ?1
                     WHERE id = ?2
                       AND goal_id IN (SELECT id FROM career_goals WHERE profile_id = ?3)",
                    params![pid, milestone_id, profile_id],
                )
                .map_err(to_err)?;
            if n == 0 {
                return Err(coded(
                    codes::NOT_OWNED,
                    "Career milestone not found in this profile",
                ));
            }
        } else {
            // Same defense-in-depth filter on the clear path.
            let n = conn
                .execute(
                    "UPDATE career_milestones SET linked_project_id = NULL
                     WHERE id = ?1
                       AND goal_id IN (SELECT id FROM career_goals WHERE profile_id = ?2)",
                    params![milestone_id, profile_id],
                )
                .map_err(to_err)?;
            if n == 0 {
                return Err(coded(
                    codes::NOT_OWNED,
                    "Career milestone not found in this profile",
                ));
            }
        }
        Ok(())
    })
}

/// Set or clear a career milestone's linked subject. Validates ownership: the
/// subject must belong to the same profile as the milestone's goal (resolved
/// through subjects -> milestones -> semesters -> tracks). When `subject_id`
/// is None, clears the link. Cross-profile ownership is enforced defensively
/// at the domain layer; see `set_career_milestone_project` for the rationale.
/// `profile_id` is the caller's profile; the milestone's owning goal must match.
#[napi]
pub fn set_career_milestone_subject(
    profile_id: i32,
    milestone_id: i32,
    subject_id: Option<i32>,
) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let milestone_id = valid_id(milestone_id, "milestone_id")?;
    let subject_id = match subject_id {
        Some(sid) => Some(valid_id(sid, "subject_id")?),
        None => None,
    };
    with_transaction(|conn| {
        // Get the milestone's goal and its profile.
        let owner_profile: i32 = conn
            .query_row(
                "SELECT cg.profile_id
                 FROM career_milestones cm
                 JOIN career_goals cg ON cg.id = cm.goal_id
                 WHERE cm.id = ?1",
                params![milestone_id],
                |r| r.get(0),
            )
            .map_err(|e| coded(codes::NOT_OWNED, format!("Milestone not found: {}", e)))?;
        if owner_profile != profile_id {
            return Err(coded(
                codes::NOT_OWNED,
                "Career milestone not found in this profile",
            ));
        }

        if let Some(sid) = subject_id {
            // Verify the subject exists and belongs to the SAME profile.
            let subject_profile: i32 = conn
                .query_row(
                    "SELECT t.profile_id
                     FROM subjects s
                     JOIN milestones m ON m.id = s.milestone_id
                     JOIN semesters se ON se.id = m.semester_id
                     JOIN tracks t ON t.id = se.track_id
                     WHERE s.id = ?1",
                    params![sid],
                    |r| r.get(0),
                )
                .map_err(|_| coded(codes::DB_CONSTRAINT, format!("Subject {} not found", sid)))?;
            if subject_profile != profile_id {
                return Err(coded(
                    codes::DB_CONSTRAINT,
                    "Subject belongs to a different profile",
                ));
            }
            // Defense-in-depth: belt-and-braces filter that the milestone's
            // owning goal belongs to this profile, even though the pre-flight
            // ownership resolution above already proved it.
            let n = conn
                .execute(
                    "UPDATE career_milestones SET linked_subject_id = ?1
                     WHERE id = ?2
                       AND goal_id IN (SELECT id FROM career_goals WHERE profile_id = ?3)",
                    params![sid, milestone_id, profile_id],
                )
                .map_err(to_err)?;
            if n == 0 {
                return Err(coded(
                    codes::NOT_OWNED,
                    "Career milestone not found in this profile",
                ));
            }
        } else {
            // Same defense-in-depth filter on the clear path.
            let n = conn
                .execute(
                    "UPDATE career_milestones SET linked_subject_id = NULL
                     WHERE id = ?1
                       AND goal_id IN (SELECT id FROM career_goals WHERE profile_id = ?2)",
                    params![milestone_id, profile_id],
                )
                .map_err(to_err)?;
            if n == 0 {
                return Err(coded(
                    codes::NOT_OWNED,
                    "Career milestone not found in this profile",
                ));
            }
        }
        Ok(())
    })
}
