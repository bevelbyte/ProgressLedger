//! Project Tracker: Mini/Major Capstone Projects with task management.
//!
//! This module manages academic projects with hierarchical task lists for
//! tracking mini-projects, major capstone projects, and other academic work.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection};

use crate::db::{to_err, with_db};
use crate::errors::{coded, codes};
use crate::validate::{
    enum_value, profile_id as valid_profile_id, required_text, text, valid_id, MAX_CATEGORY,
    MAX_NAME, MAX_TAG, MAX_TEXT,
};

#[napi(object)]
pub struct Project {
    pub id: i32,
    pub profile_id: i32,
    pub name: String,
    pub project_type: String,
    pub status: String,
    pub deadline: Option<String>,
    pub description: Option<String>,
    pub created_at: String,
}

#[napi(object)]
pub struct ProjectTask {
    pub id: i32,
    pub project_id: i32,
    pub title: String,
    pub status: String,
    pub priority: String,
    pub due_date: Option<String>,
    pub notes: Option<String>,
    pub sort_order: i32,
    pub created_at: String,
}

#[napi]
pub fn add_project(
    profile_id: i32,
    name: String,
    project_type: String,
    deadline: Option<String>,
    description: Option<String>,
) -> Result<i32> {
    let profile_id = valid_profile_id(profile_id)?;
    let name = required_text(name, "name", MAX_NAME)?;
    let project_type = required_text(project_type, "project_type", MAX_CATEGORY)?;
    let deadline = text(deadline, "deadline", MAX_TAG)?;
    let description = text(description, "description", MAX_TEXT)?;
    with_db(|conn| {
        conn.execute(
            "INSERT INTO projects (profile_id, name, project_type, deadline, description) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![profile_id, name, project_type, deadline, description],
        )
        .map_err(to_err)?;
        Ok(conn.last_insert_rowid() as i32)
    })
}

#[napi]
pub fn get_projects(profile_id: i32) -> Result<Vec<Project>> {
    with_db(|conn| {
        let mut stmt = conn
            .prepare("SELECT id, profile_id, name, project_type, status, deadline, description, created_at FROM projects WHERE profile_id = ?1 ORDER BY created_at DESC")
            .map_err(to_err)?;

        let rows = stmt
            .query_map(params![profile_id], |row| {
                Ok(Project {
                    id: row.get(0)?,
                    profile_id: row.get(1)?,
                    name: row.get(2)?,
                    project_type: row.get(3)?,
                    status: row.get(4)?,
                    deadline: row.get(5)?,
                    description: row.get(6)?,
                    created_at: row.get(7)?,
                })
            })
            .map_err(to_err)?;

        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(to_err)?);
        }
        Ok(out)
    })
}

#[napi]
pub fn update_project(
    profile_id: i32,
    id: i32,
    name: String,
    status: String,
    deadline: Option<String>,
    description: Option<String>,
) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let row_id = valid_id(id, "id")?;
    let name = required_text(name, "name", MAX_NAME)?;
    let status = required_text(status, "status", MAX_CATEGORY)?;
    let deadline = text(deadline, "deadline", MAX_TAG)?;
    let description = text(description, "description", MAX_TEXT)?;
    with_db(|conn| {
        let n = conn
            .execute(
                "UPDATE projects SET name = ?1, status = ?2, deadline = ?3, description = ?4 WHERE id = ?5 AND profile_id = ?6",
                params![name, status, deadline, description, row_id, profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(codes::NOT_OWNED, "Project not found in this profile"));
        }
        Ok(())
    })
}

#[napi]
pub fn delete_project(profile_id: i32, id: i32) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let row_id = valid_id(id, "id")?;
    with_db(|conn| {
        let n = conn
            .execute(
                "DELETE FROM projects WHERE id = ?1 AND profile_id = ?2",
                params![row_id, profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(codes::NOT_OWNED, "Project not found in this profile"));
        }
        Ok(())
    })
}

#[napi]
pub fn add_project_task(
    profile_id: i32,
    project_id: i32,
    title: String,
    priority: Option<String>,
    due_date: Option<String>,
) -> Result<i32> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let project_id = valid_id(project_id, "project_id")?;
    let title = required_text(title, "title", MAX_NAME)?;
    let priority = match priority {
        Some(p) => enum_value(p, "priority", &["low", "medium", "high"])?,
        None => "medium".to_string(),
    };
    let due_date = text(due_date, "due_date", MAX_TAG)?;
    with_db(|conn| {
        assert_project_owned_by(conn, profile_id, project_id)?;
        conn.execute(
            "INSERT INTO project_tasks (project_id, title, priority, due_date) VALUES (?1, ?2, ?3, ?4)",
            params![project_id, title, priority, due_date],
        )
        .map_err(to_err)?;
        Ok(conn.last_insert_rowid() as i32)
    })
}

#[napi]
pub fn get_project_tasks(profile_id: i32, project_id: i32) -> Result<Vec<ProjectTask>> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let project_id = valid_id(project_id, "project_id")?;
    with_db(|conn| {
        assert_project_owned_by(conn, profile_id, project_id)?;
        let mut stmt = conn
            .prepare("SELECT id, project_id, title, status, priority, due_date, notes, sort_order, created_at FROM project_tasks WHERE project_id = ?1 ORDER BY sort_order ASC, created_at ASC")
            .map_err(to_err)?;

        let rows = stmt
            .query_map(params![project_id], |row| {
                Ok(ProjectTask {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    title: row.get(2)?,
                    status: row.get(3)?,
                    priority: row.get(4)?,
                    due_date: row.get(5)?,
                    notes: row.get(6)?,
                    sort_order: row.get(7)?,
                    created_at: row.get(8)?,
                })
            })
            .map_err(to_err)?;

        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(to_err)?);
        }
        Ok(out)
    })
}

#[napi]
pub fn update_project_task(
    profile_id: i32,
    id: i32,
    title: String,
    status: String,
    priority: String,
    due_date: Option<String>,
    notes: Option<String>,
) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let row_id = valid_id(id, "id")?;
    let title = required_text(title, "title", MAX_NAME)?;
    let status = enum_value(status, "status", &["open", "in_progress", "done"])?;
    let priority = enum_value(priority, "priority", &["low", "medium", "high"])?;
    let due_date = text(due_date, "due_date", MAX_TAG)?;
    let notes = text(notes, "notes", MAX_TEXT)?;
    with_db(|conn| {
        // Resolve the task's project_id and verify the project belongs to
        // the caller's profile. A renderer that supplies another profile's
        // task id is rejected with NOT_OWNED.
        let project_id: i32 = conn
            .query_row(
                "SELECT project_id FROM project_tasks WHERE id = ?1",
                params![row_id],
                |r| r.get(0),
            )
            .map_err(to_err)?;
        assert_project_owned_by(conn, profile_id, project_id)?;
        let n = conn
            .execute(
                "UPDATE project_tasks SET title = ?1, status = ?2, priority = ?3, due_date = ?4, notes = ?5 WHERE id = ?6 AND project_id = ?7",
                params![title, status, priority, due_date, notes, row_id, project_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "Project task not found in this profile",
            ));
        }
        Ok(())
    })
}

#[napi]
pub fn delete_project_task(profile_id: i32, id: i32) -> Result<()> {
    let profile_id = valid_id(profile_id, "profile_id")?;
    let row_id = valid_id(id, "id")?;
    with_db(|conn| {
        let n = conn
            .execute(
                "DELETE FROM project_tasks WHERE id = ?1 AND project_id IN (SELECT id FROM projects WHERE profile_id = ?2)",
                params![row_id, profile_id],
            )
            .map_err(to_err)?;
        if n == 0 {
            return Err(coded(
                codes::NOT_OWNED,
                "Project task not found in this profile",
            ));
        }
        Ok(())
    })
}

/// Helper: confirm a project exists and belongs to `profile_id`.
fn assert_project_owned_by(conn: &Connection, profile_id: i32, project_id: i32) -> Result<()> {
    let n: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM projects WHERE id = ?1 AND profile_id = ?2",
            params![project_id, profile_id],
            |r| r.get(0),
        )
        .map_err(to_err)?;
    if n == 0 {
        return Err(coded(
            codes::NOT_OWNED,
            "Project does not belong to this profile",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{add_profile, init_db};
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn project_task_listing_requires_project_ownership() {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "cf-project-task-scope-{}-{}-{}",
            std::process::id(),
            n,
            nonce
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let db = dir.join("careerflow.sqlite");
        init_db(db.to_string_lossy().to_string()).expect("init db");

        let owner = add_profile("Owner".into(), format!("owner-{}", n))
            .expect("owner")
            .id;
        let foreign = add_profile("Foreign".into(), format!("foreign-{}", n))
            .expect("foreign")
            .id;
        let project = add_project(owner, "Private project".into(), "mini".into(), None, None)
            .expect("project");
        add_project_task(owner, project, "Private task".into(), None, None).expect("task");

        assert_eq!(
            get_project_tasks(owner, project)
                .expect("owner listing")
                .len(),
            1
        );
        let error = match get_project_tasks(foreign, project) {
            Ok(_) => panic!("foreign listing must be rejected"),
            Err(error) => error,
        };
        assert!(
            error.to_string().contains("not owned") || error.to_string().contains("NOT_OWNED"),
            "unexpected ownership error: {error}"
        );
    }
}
