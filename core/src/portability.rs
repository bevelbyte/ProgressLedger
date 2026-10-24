//! Portable profile bundles.
//!
//! Bundle = ZIP `.cfprofile` containing `manifest.json` (+ `attachments/*.pdf`
//! for PDF resources).
//!
//! FORMAT CONTRACT
//! ---------------
//! `manifest.format`  = "careerflow.profile" (all versions)
//! `manifest.version` = absent | 1 : LEGACY — academic tree + notes/PDFs ONLY
//!                      2         : COMPLETE whole-profile backup
//! Writer always emits version 2. Reader accepts 1 and 2 explicitly; anything
//! else is rejected before any DB write.
//!
//! Version 2 additionally covers, keyed for ID remapping (exported keys are
//! opaque ordinals meaningful only inside the bundle):
//!   grade_scales/grade_bands, semesters.status, subjects.code,
//!   courses (incl. marks/credits + structural subject key),
//!   deadlines (incl. completion), study sessions, flashcards incl. SM-2 state,
//!   mistakes, projects/project_tasks, lab_experiments, formulas,
//!   subject_links, focus_settings, career_goals/career_milestones incl.
//!   project/subject links.
//!
//! IMPORT SAFETY: the entire import runs in ONE transaction — any failure
//! rolls back every row, leaving the destination database untouched. PDF
//! attachment FILES are materialized only AFTER a successful commit (a crash
//! between commit and file-write is healed by startup orphan GC).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use napi::bindgen_prelude::*;
use napi::Task;
use napi_derive::napi;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use crate::db::{attach_root, to_err as toe, with_db};
use crate::errors::{coded, codes};

struct AtomicOutput {
    temp_path: PathBuf,
    committed: bool,
}

impl AtomicOutput {
    fn create(out_path: &Path) -> Result<(std::fs::File, Self)> {
        let parent = out_path.parent().unwrap_or_else(|| Path::new("."));
        let name = out_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("careerflow.cfprofile");
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let temp_path = parent.join(format!(".{name}.tmp-{}-{stamp}", std::process::id()));
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|e| {
                let msg = match e.kind() {
                    std::io::ErrorKind::PermissionDenied => {
                        "Permission denied while creating bundle file"
                    }
                    std::io::ErrorKind::NotFound => "Output path for bundle does not exist",
                    _ => "I/O error while creating bundle file",
                };
                coded(codes::IO_ERROR, msg)
            })?;
        Ok((
            file,
            Self {
                temp_path,
                committed: false,
            },
        ))
    }

    fn commit(mut self, out_path: &Path, file: std::fs::File) -> Result<()> {
        file.sync_all()
            .map_err(|_| coded(codes::IO_ERROR, "I/O error while flushing bundle file"))?;
        replace_file(&self.temp_path, out_path)
            .map_err(|_| coded(codes::IO_ERROR, "I/O error while replacing bundle file"))?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for AtomicOutput {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_file(&self.temp_path);
        }
    }
}

#[cfg(not(windows))]
fn replace_file(temp_path: &Path, out_path: &Path) -> std::io::Result<()> {
    std::fs::rename(temp_path, out_path)
}

#[cfg(windows)]
fn replace_file(temp_path: &Path, out_path: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let from: Vec<u16> = temp_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let to: Vec<u16> = out_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub const FORMAT_NAME: &str = "careerflow.profile";
const VERSION_V1: i64 = 1;
const FORMAT_VERSION_V2: i64 = 2;

/// Convert raw rusqlite failures into the coded napi envelope.
trait SqlOk<T> {
    fn sql(self) -> Result<T>;
}
impl<T> SqlOk<T> for std::result::Result<T, rusqlite::Error> {
    fn sql(self) -> Result<T> {
        self.map_err(toe)
    }
}

fn manifest_version(manifest: &Value) -> Result<i64> {
    if manifest.get("format").and_then(|v| v.as_str()) != Some(FORMAT_NAME) {
        return Err(coded(codes::INTERNAL, "Unrecognized bundle format"));
    }
    match manifest.get("version") {
        None | Some(Value::Null) => Ok(VERSION_V1),
        Some(Value::Number(n)) => {
            let v = n.as_i64().unwrap_or(-1);
            if v == VERSION_V1 || v == FORMAT_VERSION_V2 {
                Ok(v)
            } else {
                Err(coded(
                    codes::INTERNAL,
                    format!("Unsupported bundle format version: {v}"),
                ))
            }
        }
        _ => Err(coded(codes::INTERNAL, "Invalid bundle format version")),
    }
}

// ============================ EXPORT ============================

pub struct ExportTask {
    pub profile_id: i32,
    pub out_path: String,
}

impl Task for ExportTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        let root = attach_root().ok();
        with_db(|conn| {
            export_profile_conn(conn, self.profile_id, &self.out_path, root.as_deref())?;
            Ok(self.out_path.clone())
        })
    }

    fn resolve(&mut self, _env: napi::Env, output: String) -> Result<String> {
        Ok(output)
    }
}

/// Serialize `profile_id` completely and write a format-v2 bundle.
/// Returns the manifest (also embedded in the zip).
pub fn export_profile_conn(
    conn: &Connection,
    profile_id: i32,
    out_path: &str,
    root: Option<&Path>,
) -> Result<Value> {
    let (name, slug): (String, String) = conn
        .query_row(
            "SELECT name, slug FROM profiles WHERE id = ?1",
            params![profile_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| coded(codes::DB_ERROR, format!("Profile {profile_id} not found")))?;

    // Grade scale (0 or 1 per profile).
    let grade_scale: Value = {
        let scale: Option<(i32, String)> = conn
            .query_row(
                "SELECT id, name FROM grade_scales WHERE profile_id = ?1",
                params![profile_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(toe)?;
        match scale {
            None => Value::Null,
            Some((scale_id, sname)) => {
                let mut stmt = conn
                    .prepare(
                        "SELECT min_percent, grade_point, label, sort_order
                     FROM grade_bands WHERE scale_id = ?1 ORDER BY sort_order, id",
                    )
                    .sql()?;
                let bands: Vec<Value> = stmt
                    .query_map(params![scale_id], |r| {
                        Ok(json!({
                            "minPercent": r.get::<_, f64>(0)?,
                            "gradePoint": r.get::<_, f64>(1)?,
                            "label": r.get::<_, String>(2)?,
                            "sortOrder": r.get::<_, i32>(3)?,
                        }))
                    })
                    .map_err(toe)?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(toe)?;
                json!({ "name": sname, "bands": bands })
            }
        }
    };

    // Focus settings (0 or 1 per profile).
    let focus: Value = conn
        .query_row(
            "SELECT is_enabled, blocked_domains FROM focus_settings WHERE profile_id = ?1",
            params![profile_id],
            |r| {
                Ok(json!({
                    "isEnabled": r.get::<_, i32>(0)? != 0,
                    "blockedDomains": r.get::<_, String>(1)?,
                }))
            },
        )
        .optional()
        .map_err(toe)?
        .unwrap_or(Value::Null);

    // Academic tree with everything hanging off subjects; courses hang off
    // semesters because legacy rows may have NULL subject_id.
    let mut pdfs: Vec<(i32, String)> = Vec::new();
    let mut tracks_json: Vec<Value> = Vec::new();
    let mut tstmt = conn
        .prepare("SELECT id, name FROM tracks WHERE profile_id = ?1 ORDER BY id")
        .sql()?;
    let tracks: Vec<(i32, String)> = tstmt
        .query_map(params![profile_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(toe)?
        .collect::<rusqlite::Result<_>>()
        .map_err(toe)?;
    drop(tstmt);

    let mut next_key: i64 = 1;
    let mut subj_key_of: HashMap<i32, i64> = HashMap::new(); // old subject id -> export key

    for (tid, tname) in tracks {
        let mut sems_json: Vec<Value> = Vec::new();
        let mut sstmt = conn
            .prepare("SELECT id, name, status FROM semesters WHERE track_id = ?1 ORDER BY id")
            .sql()?;
        let sems: Vec<(i32, String, String)> = sstmt
            .query_map(params![tid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(toe)?
            .collect::<rusqlite::Result<_>>()
            .map_err(toe)?;
        drop(sstmt);

        for (sid, sname, sstatus) in sems {
            let mut ms_json: Vec<Value> = Vec::new();
            let mut mstmt = conn
                .prepare("SELECT id, title FROM milestones WHERE semester_id = ?1 ORDER BY id")
                .sql()?;
            let mss: Vec<(i32, String)> = mstmt
                .query_map(params![sid], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(toe)?
                .collect::<rusqlite::Result<_>>()
                .map_err(toe)?;
            drop(mstmt);

            for (mid, mtitle) in mss {
                let mut subj_json: Vec<Value> = Vec::new();
                let mut sjstmt = conn.prepare(
                    "SELECT id, name, code, status FROM subjects WHERE milestone_id = ?1 ORDER BY id",
                                ).sql()?;
                let subs: Vec<(i32, String, Option<String>, String)> = sjstmt
                    .query_map(params![mid], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                    })
                    .map_err(toe)?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(toe)?;
                drop(sjstmt);

                for (subid, subname, subcode, status) in subs {
                    let key = next_key;
                    next_key += 1;
                    subj_key_of.insert(subid, key);

                    // Resources (notes inline, PDFs referenced as attachments).
                    let mut res_json: Vec<Value> = Vec::new();
                    let mut rstmt = conn.prepare(
                        "SELECT id, kind, title, content, rel_path, orig_path, byte_size, created_at
                         FROM resources WHERE subject_id = ?1 ORDER BY id",
                                        ).sql()?;
                    let rows: Vec<(
                        i32,
                        String,
                        String,
                        String,
                        Option<String>,
                        Option<String>,
                        Option<i64>,
                        String,
                    )> = rstmt
                        .query_map(params![subid], |r| {
                            Ok((
                                r.get(0)?,
                                r.get(1)?,
                                r.get(2)?,
                                r.get(3)?,
                                r.get(4)?,
                                r.get(5)?,
                                r.get(6)?,
                                r.get(7)?,
                            ))
                        })
                        .map_err(toe)?
                        .collect::<rusqlite::Result<_>>()
                        .map_err(toe)?;
                    drop(rstmt);

                    for (rid, kind, title, content, rel, orig, bsize, created_at) in rows {
                        let mut attachment = Value::Null;
                        if kind == "pdf" {
                            if let (Some(rel), Some(root)) = (&rel, root) {
                                let abs = root.join(rel);
                                if abs.exists() {
                                    let entry = format!("attachments/{rid}.pdf");
                                    pdfs.push((rid, abs.to_string_lossy().to_string()));
                                    attachment = json!(entry);
                                }
                            }
                        }
                        res_json.push(json!({
                            "kind": kind, "title": title, "content": content,
                            "origPath": orig, "attachment": attachment,
                            "byteSize": bsize, "createdAt": created_at
                        }));
                    }

                    let arr = |sql: &str| -> Result<Vec<Value>> {
                        let mut st = conn.prepare(sql).sql()?;
                        let cols: Vec<String> =
                            st.column_names().into_iter().map(String::from).collect();
                        let mut rows_out: Vec<Value> = Vec::new();
                        let mut rows_iter = st.query(params![subid]).sql()?;
                        while let Some(row) = rows_iter.next().map_err(toe)? {
                            let mut o = serde_json::Map::new();
                            for (i, c) in cols.iter().enumerate() {
                                let val = match row.get_ref(i).map_err(toe)? {
                                    rusqlite::types::ValueRef::Null => Value::Null,
                                    rusqlite::types::ValueRef::Integer(v) => json!(v),
                                    rusqlite::types::ValueRef::Real(v) => json!(v),
                                    rusqlite::types::ValueRef::Text(t) => {
                                        Value::String(String::from_utf8_lossy(t).into_owned())
                                    }
                                    rusqlite::types::ValueRef::Blob(b) => json!(b.len()),
                                };
                                o.insert(c.clone(), val);
                            }
                            rows_out.push(Value::Object(o));
                        }
                        Ok(rows_out)
                    };
                    let deadlines = arr(
                        "SELECT deadline_date AS date, category, title, notes, completed_at AS completedAt
                         FROM deadlines WHERE subject_id = ?1 ORDER BY id",
                    )?;
                    let sessions = arr("SELECT started_at AS startedAt, ended_at AS endedAt,
                                duration_minutes AS durationMinutes, notes
                         FROM session_states WHERE subject_id = ?1 ORDER BY id")?;
                    let cards = arr("SELECT front, back, ease_factor AS easeFactor,
                                interval_days AS intervalDays, repetitions,
                                due_date AS dueDate, last_reviewed AS lastReviewed
                         FROM cards WHERE subject_id = ?1 ORDER BY id")?;
                    let mistakes = arr(
                        "SELECT question_text AS questionText, mistake_type AS mistakeType,
                                correct_approach AS correctApproach, tags
                         FROM mistakes WHERE subject_id = ?1 ORDER BY id",
                    )?;
                    let labs = arr("SELECT experiment_no AS experimentNo, title,
                                record_submitted AS recordSubmitted, viva_done AS vivaDone,
                                viva_score AS vivaScore, notes
                         FROM lab_experiments WHERE subject_id = ?1 ORDER BY id")?;
                    let formulas = arr("SELECT title, latex_content AS latexContent, category
                         FROM formulas WHERE subject_id = ?1 ORDER BY id")?;
                    let links = arr("SELECT label, url, is_primary AS isPrimary
                         FROM subject_links WHERE subject_id = ?1 ORDER BY id")?;

                    subj_json.push(json!({
                        "k": key, "name": subname, "code": subcode, "status": status,
                        "resources": res_json, "deadlines": deadlines,
                        "sessions": sessions, "cards": cards, "mistakes": mistakes,
                        "labs": labs, "formulas": formulas, "links": links,
                    }));
                }
                ms_json.push(json!({ "title": mtitle, "subjects": subj_json }));
            }
            // Courses for this semester — collected AFTER the subject walk so
            // structural subjectKey remapping is available. Legacy rows with
            // NULL subject_id stay unlinked.
            let mut cstmt = conn
                .prepare(
                    "SELECT id, subject_id, course_name, credits, marks_obtained, max_marks,
                        is_hypothetical
                 FROM courses
                 WHERE profile_id = ?1 AND semester_label = ?2 ORDER BY id",
                )
                .sql()?;
            let courses: Vec<(i32, Option<i32>, String, f64, Option<f64>, Option<f64>, i32)> =
                cstmt
                    .query_map(params![profile_id, sname], |r| {
                        Ok((
                            r.get::<_, i32>(0)?,
                            r.get::<_, Option<i32>>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, f64>(3)?,
                            r.get::<_, Option<f64>>(4)?,
                            r.get::<_, Option<f64>>(5)?,
                            r.get::<_, i32>(6)?,
                        ))
                    })
                    .map_err(toe)?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(toe)?;
            drop(cstmt);
            let courses_json: Vec<Value> = courses
                .iter()
                .map(|(_cid, sub_opt, cname, credits, mo, mm, hyp)| {
                    json!({
                        "subjectKey": sub_opt.and_then(|s| subj_key_of.get(&s).copied()),
                        "name": cname,
                        "credits": credits,
                        "marksObtained": mo,
                        "maxMarks": mm,
                        "isHypothetical": *hyp != 0,
                    })
                })
                .collect();

            sems_json.push(json!({
                "name": sname, "status": sstatus, "milestones": ms_json,
                "courses": courses_json,
            }));
        }
        tracks_json.push(json!({ "name": tname, "semesters": sems_json }));
    }

    // Projects + tasks (flat, keyed).
    let mut proj_json: Vec<Value> = Vec::new();
    {
        let mut pstmt = conn
            .prepare(
                "SELECT id, name, project_type, status, deadline, description
             FROM projects WHERE profile_id = ?1 ORDER BY id",
            )
            .sql()?;
        let projs: Vec<(i32, String, String, String, Option<String>, Option<String>)> = pstmt
            .query_map(params![profile_id], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })
            .map_err(toe)?
            .collect::<rusqlite::Result<_>>()
            .map_err(toe)?;
        drop(pstmt);
        for (pid, pname, ptype, pstatus, pdeadline, pdesc) in projs {
            let key = next_key;
            next_key += 1;
            let mut tstmt = conn
                .prepare(
                    "SELECT title, status, priority, due_date, notes, sort_order
                 FROM project_tasks WHERE project_id = ?1 ORDER BY sort_order, id",
                )
                .sql()?;
            let tasks: Vec<Value> = tstmt
                .query_map(params![pid], |r| {
                    Ok(json!({
                        "title": r.get::<_, String>(0)?,
                        "status": r.get::<_, String>(1)?,
                        "priority": r.get::<_, String>(2)?,
                        "dueDate": r.get::<_, Option<String>>(3)?,
                        "notes": r.get::<_, Option<String>>(4)?,
                        "sortOrder": r.get::<_, i32>(5)?,
                    }))
                })
                .map_err(toe)?
                .collect::<rusqlite::Result<_>>()
                .map_err(toe)?;
            drop(tstmt);
            proj_json.push(json!({
                "pk": key, "name": pname, "projectType": ptype, "status": pstatus,
                "deadline": pdeadline, "description": pdesc, "tasks": tasks,
            }));
        }
    }

    // Career goals + milestones (references remapped through keys).
    // Projects were keyed during the same next_key sequence as subjects:
    // rebuild old-project-id -> export-key deterministically first.
    let mut project_key_of: HashMap<i32, i64> = HashMap::new();
    {
        let mut pstmt = conn
            .prepare("SELECT id FROM projects WHERE profile_id = ?1 ORDER BY id")
            .sql()?;
        let ids: Vec<i32> = pstmt
            .query_map(params![profile_id], |r| r.get(0))
            .map_err(toe)?
            .collect::<rusqlite::Result<_>>()
            .map_err(toe)?;
        drop(pstmt);
        let base = subj_key_of.len() as i64;
        for (i, pid) in ids.iter().enumerate() {
            project_key_of.insert(*pid, base + 1 + i as i64);
        }
    }

    let mut goals_json: Vec<Value> = Vec::new();
    {
        let mut gstmt = conn.prepare(
            "SELECT id, title, target_role, domain, description, target_date, status, is_primary
             FROM career_goals WHERE profile_id = ?1 ORDER BY id",
        )
        .sql()?;
        let goals: Vec<(
            i32,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            String,
            bool,
        )> = gstmt
            .query_map(params![profile_id], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get::<_, i32>(7)? != 0,
                ))
            })
            .map_err(toe)?
            .collect::<rusqlite::Result<_>>()
            .map_err(toe)?;
        drop(gstmt);
        for (gid, gtitle, role, domain, gdesc, gdate, gstatus, primary) in goals {
            let mut mstmt = conn
                .prepare(
                    "SELECT title, description, target_date, sort_order, completed_at,
                        linked_project_id, linked_subject_id
                 FROM career_milestones WHERE goal_id = ?1 ORDER BY sort_order, id",
                )
                .sql()?;
            let miles: Vec<(
                String,
                Option<String>,
                Option<String>,
                i32,
                Option<String>,
                Option<i32>,
                Option<i32>,
            )> = mstmt
                .query_map(params![gid], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                    ))
                })
                .map_err(toe)?
                .collect::<rusqlite::Result<_>>()
                .map_err(toe)?;
            drop(mstmt);
            let miles_json: Vec<Value> = miles
                .into_iter()
                .map(|(t, d, td, so, done, lp, ls)| {
                    json!({
                        "title": t, "description": d, "targetDate": td,
                        "sortOrder": so, "completedAt": done,
                        "projectKey": lp.as_ref().and_then(|p| project_key_of.get(p).copied()),
                        "subjectKey": ls.and_then(|s| subj_key_of.get(&s).copied()),
                    })
                })
                .collect();
            goals_json.push(json!({
                "title": gtitle, "targetRole": role, "domain": domain,
                "description": gdesc, "targetDate": gdate, "status": gstatus,
                "isPrimary": primary, "milestones": miles_json,
            }));
        }
    }
    // ---- browser manager (schema v15+) ----
    // Metadata + shortcuts are portable user content. The machine-local Donut
    // profile binding lives in workspace JSON and is deliberately NOT exported.
    let mut browsers_json: Vec<Value> = Vec::new();
    {
        let mut bp_stmt = conn
            .prepare(
                "SELECT local_id, display_name, position, enabled, created_at, last_used_at
                 FROM browser_profiles
                 WHERE cf_profile_id = ?1
                 ORDER BY position ASC, created_at ASC",
            )
            .map_err(toe)?;
        let mut bp_rows: Vec<(String, String, i32, i32, String, Option<String>)> = Vec::new();
        for row in bp_stmt
            .query_map(params![profile_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i32>(2)?,
                    row.get::<_, i32>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            })
            .map_err(toe)?
        {
            bp_rows.push(row.map_err(toe)?);
        }
        drop(bp_stmt);
        for (local_id, display_name, position, enabled, created_at, last_used_at) in bp_rows {
            let mut sc_stmt = conn
                .prepare(
                    "SELECT label, url, position, created_at, pinned FROM browser_shortcuts
                     WHERE browser_profile_id = ?1
                     ORDER BY position ASC, created_at ASC",
                )
                .map_err(toe)?;
            let mut shortcuts: Vec<Value> = Vec::new();
            for row in sc_stmt
                .query_map(params![local_id], |row| {
                    Ok(json!({
                        "label": row.get::<_, String>(0)?,
                        "url": row.get::<_, String>(1)?,
                        "position": row.get::<_, i32>(2)?,
                        "createdAt": row.get::<_, String>(3)?,
                        "pinned": row.get::<_, i32>(4)? != 0,
                    }))
                })
                .map_err(toe)?
            {
                shortcuts.push(row.map_err(toe)?);
            }
            drop(sc_stmt);
            browsers_json.push(json!({
                "displayName": display_name,
                "position": position,
                "enabled": enabled != 0,
                "createdAt": created_at,
                "lastUsedAt": last_used_at,
                "shortcuts": shortcuts,
            }));
        }
    }
    let manifest = json!({
        "format": FORMAT_NAME,
        "version": FORMAT_VERSION_V2,
        "exportedAt": now_iso(conn),
        "profile": { "name": name, "slug": slug },
        "gradeScale": grade_scale,
        "focusSettings": focus,
        "tracks": tracks_json,
        "projects": proj_json,
        "career": { "goals": goals_json },
        "browserProfiles": browsers_json,
    });

    // Stage the complete archive beside the destination. The existing backup
    // remains untouched until the zip is finalized and durably flushed.
    let out_path = Path::new(out_path);
    let (file, atomic) = AtomicOutput::create(out_path)?;
    let mut zip = ZipWriter::new(file);
    let opts: SimpleFileOptions = SimpleFileOptions::default();
    zip.start_file("manifest.json", opts)
        .map_err(|_| coded(codes::IO_ERROR, "Backup file is corrupted"))?;
    zip.write_all(
        serde_json::to_string_pretty(&manifest)
            .map_err(|_| coded(codes::IO_ERROR, "I/O error"))?
            .as_bytes(),
    )
    .map_err(|e| {
        let msg = match e.kind() {
            std::io::ErrorKind::PermissionDenied => "Permission denied while writing manifest",
            _ => "I/O error while writing manifest",
        };
        coded(codes::IO_ERROR, msg)
    })?;
    for (_rid, abs) in &pdfs {
        let entry_name = abs.rsplit('/').next().unwrap_or("attachment.pdf");
        let entry_name = format!("attachments/{entry_name}");
        zip.start_file(entry_name.as_str(), opts)
            .map_err(|_| coded(codes::IO_ERROR, "Backup file is corrupted"))?;
        let bytes = std::fs::read(abs).map_err(|e| {
            let msg = match e.kind() {
                std::io::ErrorKind::NotFound => "Backup attachment is missing",
                std::io::ErrorKind::PermissionDenied => {
                    "Permission denied while reading attachment"
                }
                _ => "I/O error while reading attachment",
            };
            coded(codes::IO_ERROR, msg)
        })?;
        zip.write_all(&bytes).map_err(|e| {
            let msg = match e.kind() {
                std::io::ErrorKind::PermissionDenied => {
                    "Permission denied while writing attachment"
                }
                _ => "I/O error while writing attachment",
            };
            coded(codes::IO_ERROR, msg)
        })?;
    }
    let file = zip
        .finish()
        .map_err(|_| coded(codes::IO_ERROR, "Backup file is corrupted"))?;
    atomic.commit(out_path, file)?;

    Ok(manifest)
}

// ============================ IMPORT ============================

#[napi(object)]
pub struct ImportResult {
    pub profile_id: i32,
    pub name: String,
    pub slug: String,
    pub resource_count: i32,
}

#[napi(object)]
pub struct BundleInfo {
    pub name: String,
    pub slug: String,
    pub exported_at: Option<String>,
    pub resource_count: i32,
}

fn count_resources_in_manifest(manifest: &Value) -> i32 {
    let mut count = 0i32;
    for track in manifest["tracks"].as_array().into_iter().flatten() {
        for sem in track["semesters"].as_array().into_iter().flatten() {
            for ms in sem["milestones"].as_array().into_iter().flatten() {
                for subj in ms["subjects"].as_array().into_iter().flatten() {
                    count += subj["resources"]
                        .as_array()
                        .map(|r| r.len() as i32)
                        .unwrap_or(0);
                }
            }
        }
    }
    count
}

fn read_bundle(bundle_path: &str) -> Result<(Value, HashMap<String, Vec<u8>>)> {
    let file = std::fs::File::open(bundle_path).map_err(|e| {
        let msg = match e.kind() {
            std::io::ErrorKind::NotFound => "Bundle file not found",
            std::io::ErrorKind::PermissionDenied => "Permission denied while opening bundle",
            _ => "I/O error while opening bundle",
        };
        coded(codes::IO_ERROR, msg)
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| {
        coded(
            codes::INTERNAL,
            "Not a valid bundle: corrupt or truncated archive",
        )
    })?;
    let mut manifest_str = String::new();
    let mut attachments: HashMap<String, Vec<u8>> = HashMap::new();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|_| coded(codes::INTERNAL, "Backup file is corrupted"))?;
        let name = entry.name().to_string();
        if name == "manifest.json" {
            entry
                .read_to_string(&mut manifest_str)
                .map_err(|_| coded(codes::INTERNAL, "Backup file is corrupted"))?;
        } else if name.starts_with("attachments/") {
            let mut buf = Vec::new();
            entry
                .read_to_end(&mut buf)
                .map_err(|_| coded(codes::INTERNAL, "Backup file is corrupted"))?;
            attachments.insert(name, buf);
        }
    }
    if manifest_str.is_empty() {
        return Err(coded(codes::INTERNAL, "Bundle is missing manifest.json"));
    }
    let manifest: Value = serde_json::from_str(&manifest_str)
        .map_err(|_| coded(codes::INTERNAL, "Invalid manifest JSON"))?;
    // Version gate BEFORE touching the database.
    manifest_version(&manifest)?;
    Ok((manifest, attachments))
}

#[napi]
pub fn inspect_profile_bundle(bundle_path: String) -> Result<BundleInfo> {
    let (manifest, _) = read_bundle(&bundle_path)?;
    Ok(BundleInfo {
        name: manifest["profile"]["name"]
            .as_str()
            .unwrap_or("Imported Profile")
            .to_string(),
        slug: manifest["profile"]["slug"]
            .as_str()
            .unwrap_or("imported")
            .to_string(),
        exported_at: manifest["exportedAt"].as_str().map(|s| s.to_string()),
        resource_count: count_resources_in_manifest(&manifest),
    })
}

/// Resolve slug collisions: slug, slug-2, slug-3, ...
fn resolve_slug(conn: &Connection, base_slug: &str) -> Result<String> {
    let mut slug = base_slug.to_string();
    let mut n = 2;
    loop {
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM profiles WHERE slug = ?1",
                params![slug],
                |_| Ok(()),
            )
            .optional()
            .map_err(toe)?
            .is_some();
        if !exists {
            break;
        }
        slug = format!("{base_slug}-{n}");
        n += 1;
    }
    Ok(slug)
}

struct PendingAttachment {
    resource_id: i32,
    rel_path: String,
    bytes: Vec<u8>,
}

pub struct ImportTask {
    pub bundle_path: String,
}

impl Task for ImportTask {
    type Output = ImportResult;
    type JsValue = ImportResult;

    fn compute(&mut self) -> Result<ImportResult> {
        let root = attach_root()?;
        with_db(|conn| import_bundle_conn(conn, &self.bundle_path, Some(root.as_path())))
    }

    fn resolve(&mut self, _env: napi::Env, output: ImportResult) -> Result<ImportResult> {
        Ok(output)
    }
}

/// Import a bundle transactionally. Accepts format v1 (legacy subset) and
/// format v2 (complete). Any failure rolls back every row.
pub fn import_bundle_conn(
    conn: &Connection,
    bundle_path: &str,
    root: Option<&Path>,
) -> Result<ImportResult> {
    let (manifest, attachments) = read_bundle(bundle_path)?;
    let version = manifest_version(&manifest)?;

    let tx = conn.unchecked_transaction().map_err(toe)?;
    let outcome = match version {
        VERSION_V1 => import_v1(&tx, &manifest, &attachments, root),
        FORMAT_VERSION_V2 => import_v2(&tx, &manifest, &attachments, root),
        other => Err(coded(
            codes::INTERNAL,
            format!("Unsupported bundle format version: {other}"),
        )),
    };
    let result = outcome?; // early-return on Err drops `tx` => ROLLBACK

    // Materialize attachment files BEFORE committing the DB transaction. This
    // makes filesystem failure transactional from the caller's perspective:
    // an import cannot commit resource rows that point at files we failed to
    // create. If the process crashes after the file move but before COMMIT,
    // startup orphan-GC removes the unreferenced file. If COMMIT succeeds, the
    // files already exist and the resource rows are durable in the same commit.
    let mut materialized = Vec::new();
    if let Some(root) = root {
        for p in &result.pending {
            let profile_id = p.rel_path.split('/').next().unwrap_or("").parse::<i32>().map_err(|_| {
                coded(codes::IO_ERROR, "Invalid attachment profile directory")
            })?;
            let _dir = crate::db::ensure_attachment_profile_dir(root, profile_id).map_err(|e| {
                for path in materialized.drain(..) { let _ = std::fs::remove_file(path); }
                e
            })?;
            let full = root.join(&p.rel_path);
            if full.exists() {
                for path in materialized.drain(..) { let _ = std::fs::remove_file(path); }
                return Err(coded(codes::IO_ERROR, "Attachment destination already exists"));
            }
            if std::fs::write(&full, &p.bytes).is_err() {
                for path in materialized.drain(..) { let _ = std::fs::remove_file(path); }
                return Err(coded(codes::IO_ERROR, "I/O error while writing attachment"));
            }
            materialized.push(full);
            if let Err(e) = tx.execute(
                "UPDATE resources SET rel_path = ?2, byte_size = ?3 WHERE id = ?1",
                rusqlite::params![p.resource_id, p.rel_path, p.bytes.len() as i64],
            ) {
                for path in materialized.drain(..) { let _ = std::fs::remove_file(path); }
                return Err(toe(e));
            }
        }
    }

    if let Err(e) = tx.commit() {
        for path in materialized { let _ = std::fs::remove_file(path); }
        return Err(toe(e));
    }
    Ok(result.result)
}

#[cfg(test)]
mod atomic_output_tests {
    use super::AtomicOutput;
    use std::io::Write;

    #[test]
    fn failed_staged_export_does_not_replace_existing_backup() {
        let dir = std::env::temp_dir().join(format!(
            "careerflow-atomic-export-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("backup.cfprofile");
        let original = b"known-valid-backup";
        std::fs::write(&out, original).unwrap();

        {
            let (mut file, _atomic) = AtomicOutput::create(&out).unwrap();
            file.write_all(b"truncated-new-backup").unwrap();
            // Simulate an export/write failure before commit. Dropping the
            // staging guard removes the partial sibling and leaves `out`
            // untouched.
        }

        assert_eq!(std::fs::read(&out).unwrap(), original);
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name())
            .collect();
        assert_eq!(
            leftovers,
            vec![std::ffi::OsString::from("backup.cfprofile")]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

struct ImportOutcome {
    result: ImportResult,
    pending: Vec<PendingAttachment>,
}

fn base_profile_fields(manifest: &Value) -> (String, String) {
    (
        manifest["profile"]["name"]
            .as_str()
            .unwrap_or("Imported Profile")
            .to_string(),
        manifest["profile"]["slug"]
            .as_str()
            .unwrap_or("imported")
            .to_string(),
    )
}

/// Read a JSON value that may have been exported as bool OR as 0/1 integer
/// (the generic row serializer emits INTEGERs as JSON numbers).
fn truthy(v: &Value) -> bool {
    v.as_bool()
        .unwrap_or_else(|| v.as_i64().map(|n| n != 0).unwrap_or(false))
}

// ------------------------- format v1 (LEGACY) -------------------------

fn import_v1(
    conn: &Connection,
    manifest: &Value,
    attachments: &HashMap<String, Vec<u8>>,
    _root: Option<&Path>,
) -> Result<ImportOutcome> {
    let (base_name, base_slug) = base_profile_fields(manifest);
    let final_slug = resolve_slug(conn, &base_slug)?;
    let display_name = if final_slug == base_slug {
        base_name.clone()
    } else {
        format!("{base_name} (imported)")
    };
    conn.execute(
        "INSERT INTO profiles (name, slug) VALUES (?1, ?2)",
        params![display_name, final_slug],
    )
    .map_err(toe)?;
    let new_pid = conn.last_insert_rowid() as i32;

    let mut resource_count = 0i32;
    let mut pending: Vec<PendingAttachment> = Vec::new();

    for track in manifest["tracks"].as_array().cloned().unwrap_or_default() {
        let tname = track["name"].as_str().unwrap_or("Track");
        conn.execute(
            "INSERT INTO tracks (profile_id, name) VALUES (?1, ?2)",
            params![new_pid, tname],
        )
        .map_err(toe)?;
        let tid = conn.last_insert_rowid() as i32;

        for sem in track["semesters"].as_array().cloned().unwrap_or_default() {
            let sname = sem["name"].as_str().unwrap_or("Semester");
            conn.execute(
                "INSERT INTO semesters (track_id, name) VALUES (?1, ?2)",
                params![tid, sname],
            )
            .map_err(toe)?;
            let sid = conn.last_insert_rowid() as i32;

            for ms in sem["milestones"].as_array().cloned().unwrap_or_default() {
                let mtitle = ms["title"].as_str().unwrap_or("Milestone");
                conn.execute(
                    "INSERT INTO milestones (semester_id, title) VALUES (?1, ?2)",
                    params![sid, mtitle],
                )
                .map_err(toe)?;
                let mid = conn.last_insert_rowid() as i32;

                for subj in ms["subjects"].as_array().cloned().unwrap_or_default() {
                    let subname = subj["name"].as_str().unwrap_or("Subject");
                    let status = subj["status"].as_str().unwrap_or("pending");
                    conn.execute(
                        "INSERT INTO subjects (milestone_id, name, status) VALUES (?1, ?2, ?3)",
                        params![mid, subname, status],
                    )
                    .map_err(toe)?;
                    let subid = conn.last_insert_rowid() as i32;

                    for res in subj["resources"].as_array().cloned().unwrap_or_default() {
                        let kind = res["kind"].as_str().unwrap_or("note");
                        let title = res["title"].as_str().unwrap_or("Untitled");
                        let content = res["content"].as_str().unwrap_or("");
                        let orig = res["origPath"].as_str();
                        let attach_entry = res["attachment"].as_str().map(String::from);

                        conn.execute(
                            "INSERT INTO resources (subject_id, kind, title, file_path, content, orig_path)
                             VALUES (?1, ?2, ?3, NULL, ?4, ?5)",
                            params![subid, kind, title, content, orig],
                        )
                        .map_err(toe)?;
                        let rid = conn.last_insert_rowid() as i32;
                        if let Some(p) = pending_attachment(
                            attachments,
                            rid,
                            new_pid,
                            kind,
                            attach_entry,
                        )? {
                            pending.push(p);
                        }
                        resource_count += 1;
                    }
                }
            }
        }
    }
    Ok(ImportOutcome {
        result: ImportResult {
            profile_id: new_pid,
            name: display_name,
            slug: final_slug,
            resource_count,
        },
        pending,
    })
}

// ------------------------- format v2 (COMPLETE) -------------------------

fn opt_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(String::from)
}
fn opt_f64(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.as_f64())
}
fn opt_i64(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|x| x.as_i64())
}
fn str_or<'a>(v: &'a Value, key: &str, default: &'a str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or(default)
        .to_string()
}

fn pending_attachment(
    attachments: &HashMap<String, Vec<u8>>,
    resource_id: i32,
    profile_id: i32,
    kind: &str,
    attachment: Option<String>,
) -> Result<Option<PendingAttachment>> {
    if kind != "pdf" || attachment.is_none() {
        return Ok(None);
    }
    let entry = attachment.unwrap();
    let bytes = attachments.get(&entry).ok_or_else(|| {
        coded(codes::INTERNAL, "Malformed bundle: referenced PDF attachment is missing")
    })?;
    Ok(Some(PendingAttachment {
        resource_id,
        rel_path: format!("{profile_id}/{resource_id}.pdf"),
        bytes: bytes.clone(),
    }))
}

fn import_v2(
    conn: &Connection,
    manifest: &Value,
    attachments: &HashMap<String, Vec<u8>>,
    _root: Option<&Path>,
) -> Result<ImportOutcome> {
    let (base_name, base_slug) = base_profile_fields(manifest);
    let final_slug = resolve_slug(conn, &base_slug)?;
    let display_name = if final_slug == base_slug {
        base_name.clone()
    } else {
        format!("{base_name} (imported)")
    };
    conn.execute(
        "INSERT INTO profiles (name, slug) VALUES (?1, ?2)",
        params![display_name, final_slug],
    )
    .map_err(toe)?;
    let new_pid = conn.last_insert_rowid() as i32;

    let mut pending: Vec<PendingAttachment> = Vec::new();
    let mut resource_count = 0i32;

    // ---- grade scale ----
    if !manifest["gradeScale"].is_null() {
        let gs = &manifest["gradeScale"];
        conn.execute(
            "INSERT INTO grade_scales (profile_id, name) VALUES (?1, ?2)",
            params![new_pid, str_or(gs, "name", "Default")],
        )
        .map_err(toe)?;
        let scale_id = conn.last_insert_rowid() as i32;
        for (i, b) in gs["bands"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .enumerate()
        {
            conn.execute(
                "INSERT INTO grade_bands (scale_id, min_percent, grade_point, label, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    scale_id,
                    b["minPercent"].as_f64().unwrap_or(0.0),
                    b["gradePoint"].as_f64().unwrap_or(0.0),
                    str_or(b, "label", ""),
                    b["sortOrder"]
                        .as_i64()
                        .map(|v| v as i32)
                        .unwrap_or(i as i32)
                ],
            )
            .map_err(toe)?;
        }
    }

    // ---- focus settings ----
    if let Some(f) = manifest.get("focusSettings").filter(|v| !v.is_null()) {
        conn.execute(
            "INSERT INTO focus_settings (profile_id, is_enabled, blocked_domains)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(profile_id) DO UPDATE SET is_enabled = excluded.is_enabled,
                                                   blocked_domains = excluded.blocked_domains",
            rusqlite::params![
                new_pid,
                f["isEnabled"].as_bool().unwrap_or(false) as i32,
                str_or(f, "blockedDomains", "")
            ],
        )
        .map_err(toe)?;
    }

    // ---- academic tree ----
    let mut subject_key_to_id: HashMap<i64, i32> = HashMap::new();

    for track in manifest["tracks"].as_array().cloned().unwrap_or_default() {
        conn.execute(
            "INSERT INTO tracks (profile_id, name) VALUES (?1, ?2)",
            params![new_pid, str_or(&track, "name", "Track")],
        )
        .map_err(toe)?;
        let tid = conn.last_insert_rowid() as i32;

        for sem in track["semesters"].as_array().cloned().unwrap_or_default() {
            let sname = str_or(&sem, "name", "Semester");
            conn.execute(
                "INSERT INTO semesters (track_id, name, status) VALUES (?1, ?2, ?3)",
                params![tid, sname, str_or(&sem, "status", "Upcoming")],
            )
            .map_err(toe)?;
            let sid = conn.last_insert_rowid() as i32;

            for ms in sem["milestones"].as_array().cloned().unwrap_or_default() {
                conn.execute(
                    "INSERT INTO milestones (semester_id, title) VALUES (?1, ?2)",
                    params![sid, str_or(&ms, "title", "Milestone")],
                )
                .map_err(toe)?;
                let mid = conn.last_insert_rowid() as i32;

                for subj in ms["subjects"].as_array().cloned().unwrap_or_default() {
                    conn.execute(
                        "INSERT INTO subjects (milestone_id, name, code, status) VALUES (?1, ?2, ?3, ?4)",
                        rusqlite::params![
                            mid,
                            str_or(&subj, "name", "Subject"),
                            opt_str(&subj, "code"),
                            str_or(&subj, "status", "pending")
                        ],
                    )
                    .map_err(toe)?;
                    let subid = conn.last_insert_rowid() as i32;
                    if let Some(k) = opt_i64(&subj, "k") {
                        subject_key_to_id.insert(k, subid);
                    }

                    // deadlines
                    for d in subj["deadlines"].as_array().cloned().unwrap_or_default() {
                        conn.execute(
                            "INSERT INTO deadlines (subject_id, deadline_date, category, title, notes, completed_at)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                            rusqlite::params![
                                subid,
                                str_or(&d, "date", ""),
                                str_or(&d, "category", "exam"),
                                str_or(&d, "title", "Deadline"),
                                opt_str(&d, "notes"),
                                opt_str(&d, "completedAt")
                            ],
                        )
                        .map_err(toe)?;
                    }

                    // sessions
                    for s in subj["sessions"].as_array().cloned().unwrap_or_default() {
                        conn.execute(
                            "INSERT INTO session_states (subject_id, started_at, ended_at, duration_minutes, notes)
                             VALUES (?1, ?2, ?3, ?4, ?5)",
                            rusqlite::params![
                                subid,
                                str_or(&s, "startedAt", "now"),
                                opt_str(&s, "endedAt"),
                                s["durationMinutes"].as_i64().unwrap_or(0) as i32,
                                str_or(&s, "notes", "")
                            ],
                        )
                        .map_err(toe)?;
                    }

                    // flashcards (SM-2 state preserved verbatim)
                    for c in subj["cards"].as_array().cloned().unwrap_or_default() {
                        conn.execute(
                            "INSERT INTO cards (subject_id, front, back, ease_factor, interval_days, repetitions, due_date, last_reviewed)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                            rusqlite::params![
                                subid,
                                str_or(&c, "front", ""),
                                str_or(&c, "back", ""),
                                c["easeFactor"].as_f64().unwrap_or(2.5),
                                c["intervalDays"].as_i64().unwrap_or(0) as i32,
                                c["repetitions"].as_i64().unwrap_or(0) as i32,
                                str_or(&c, "dueDate", "1970-01-01"),
                                opt_str(&c, "lastReviewed")
                            ],
                        )
                        .map_err(toe)?;
                    }

                    // mistakes
                    for m in subj["mistakes"].as_array().cloned().unwrap_or_default() {
                        conn.execute(
                            "INSERT INTO mistakes (subject_id, question_text, mistake_type, correct_approach, tags)
                             VALUES (?1, ?2, ?3, ?4, ?5)",
                            rusqlite::params![
                                subid,
                                str_or(&m, "questionText", ""),
                                str_or(&m, "mistakeType", "conceptual"),
                                str_or(&m, "correctApproach", ""),
                                str_or(&m, "tags", "[]")
                            ],
                        )
                        .map_err(toe)?;
                    }

                    // labs
                    for l in subj["labs"].as_array().cloned().unwrap_or_default() {
                        conn.execute(
                            "INSERT INTO lab_experiments (subject_id, experiment_no, title, record_submitted, viva_done, viva_score, notes)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                            rusqlite::params![
                                subid,
                                l["experimentNo"].as_i64().unwrap_or(1) as i32,
                                str_or(&l, "title", "Experiment"),
                                truthy(&l["recordSubmitted"]) as i32,
                                truthy(&l["vivaDone"]) as i32,
                                opt_str(&l, "vivaScore"),
                                opt_str(&l, "notes")
                            ],
                        )
                        .map_err(toe)?;
                    }

                    // formulas
                    for fm in subj["formulas"].as_array().cloned().unwrap_or_default() {
                        conn.execute(
                            "INSERT INTO formulas (subject_id, title, latex_content, category)
                             VALUES (?1, ?2, ?3, ?4)",
                            rusqlite::params![
                                subid,
                                str_or(&fm, "title", "Formula"),
                                str_or(&fm, "latexContent", ""),
                                opt_str(&fm, "category")
                            ],
                        )
                        .map_err(toe)?;
                    }

                    // subject links
                    for sl in subj["links"].as_array().cloned().unwrap_or_default() {
                        conn.execute(
                            "INSERT INTO subject_links (subject_id, label, url, is_primary)
                             VALUES (?1, ?2, ?3, ?4)",
                            rusqlite::params![
                                subid,
                                str_or(&sl, "label", "Link"),
                                str_or(&sl, "url", "#"),
                                truthy(&sl["isPrimary"]) as i32
                            ],
                        )
                        .map_err(toe)?;
                    }

                    // resources (identical shape to v1)
                    for res in subj["resources"].as_array().cloned().unwrap_or_default() {
                        let kind = str_or(&res, "kind", "note");
                        let title = str_or(&res, "title", "Untitled");
                        let content = str_or(&res, "content", "");
                        let orig = opt_str(&res, "origPath");
                        let attach_entry = opt_str(&res, "attachment");

                        conn.execute(
                            "INSERT INTO resources (subject_id, kind, title, file_path, content, orig_path, created_at)
                             VALUES (?1, ?2, ?3, NULL, ?4, ?5, COALESCE(?6, CURRENT_TIMESTAMP))",
                            rusqlite::params![subid, kind, title, content, orig, opt_str(&res, "createdAt")],
                        )
                        .map_err(toe)?;
                        let rid = conn.last_insert_rowid() as i32;
                        if let Some(p) = pending_attachment(
                            attachments,
                            rid,
                            new_pid,
                            &kind,
                            attach_entry,
                        )? {
                            pending.push(p);
                        }
                        resource_count += 1;
                    }
                }
            }

            // Courses for this semester (structural subjectKey remap; NULL stays NULL).
            for c in sem["courses"].as_array().cloned().unwrap_or_default() {
                let sk = opt_i64(&c, "subjectKey");
                let subject_id = match sk {
                    None => None,
                    Some(k) => match subject_key_to_id.get(&k) {
                        Some(id) => Some(*id),
                        None => {
                            return Err(coded(
                                codes::INTERNAL,
                                format!(
                                    "Malformed bundle: course references unknown subject key {k}"
                                ),
                            ))
                        }
                    },
                };
                conn.execute(
                    "INSERT INTO courses (profile_id, semester_label, course_name, credits, marks_obtained, max_marks, is_hypothetical, subject_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    rusqlite::params![
                        new_pid,
                        sname,
                        str_or(&c, "name", "Course"),
                        c["credits"].as_f64().unwrap_or(0.0),
                        opt_f64(&c, "marksObtained"),
                        opt_f64(&c, "maxMarks"),
                        c["isHypothetical"].as_bool().unwrap_or(false) as i32,
                        subject_id
                    ],
                )
                .map_err(toe)?;
            }
        }
    }

    // ---- projects + tasks ----
    let mut project_key_to_id: HashMap<i64, i32> = HashMap::new();
    for p in manifest["projects"].as_array().cloned().unwrap_or_default() {
        conn.execute(
            "INSERT INTO projects (profile_id, name, project_type, status, deadline, description)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                new_pid,
                str_or(&p, "name", "Project"),
                str_or(&p, "projectType", "other"),
                str_or(&p, "status", "planning"),
                opt_str(&p, "deadline"),
                opt_str(&p, "description")
            ],
        )
        .map_err(toe)?;
        let prid = conn.last_insert_rowid() as i32;
        if let Some(k) = opt_i64(&p, "pk") {
            project_key_to_id.insert(k, prid);
        }
        for t in p["tasks"].as_array().cloned().unwrap_or_default() {
            conn.execute(
                "INSERT INTO project_tasks (project_id, title, status, priority, due_date, notes, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    prid,
                    str_or(&t, "title", "Task"),
                    str_or(&t, "status", "todo"),
                    str_or(&t, "priority", "medium"),
                    opt_str(&t, "dueDate"),
                    opt_str(&t, "notes"),
                    t["sortOrder"].as_i64().map(|v| v as i32).unwrap_or(0)
                ],
            )
            .map_err(toe)?;
        }
    }

    // ---- career goals + milestones (remap goal/project/subject references) ----
    for g in manifest["career"]["goals"]
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        conn.execute(
            "INSERT INTO career_goals (profile_id, title, target_role, domain, description, target_date, status, is_primary)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                new_pid,
                str_or(&g, "title", "Goal"),
                opt_str(&g, "targetRole"),
                opt_str(&g, "domain"),
                opt_str(&g, "description"),
                opt_str(&g, "targetDate"),
                str_or(&g, "status", "active"),
                g["isPrimary"].as_bool().unwrap_or(false) as i32
            ],
        )
        .map_err(toe)?;
        let gid = conn.last_insert_rowid() as i32;

        for m in g["milestones"].as_array().cloned().unwrap_or_default() {
            let project_ref = opt_i64(&m, "projectKey");
            let subject_ref = opt_i64(&m, "subjectKey");

            let linked_project_id = match project_ref {
                None => None,
                Some(k) => match project_key_to_id.get(&k) {
                    Some(id) => Some(*id),
                    None => {
                        return Err(coded(
                            codes::INTERNAL,
                            format!(
                            "Malformed bundle: career milestone references unknown project key {k}"
                        ),
                        ))
                    }
                },
            };
            let linked_subject_id = match subject_ref {
                None => None,
                Some(k) => match subject_key_to_id.get(&k) {
                    Some(id) => Some(*id),
                    None => {
                        return Err(coded(
                            codes::INTERNAL,
                            format!(
                            "Malformed bundle: career milestone references unknown subject key {k}"
                        ),
                        ))
                    }
                },
            };

            conn.execute(
                "INSERT INTO career_milestones (goal_id, title, description, target_date, sort_order, completed_at, linked_project_id, linked_subject_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    gid,
                    str_or(&m, "title", "Milestone"),
                    opt_str(&m, "description"),
                    opt_str(&m, "targetDate"),
                    m["sortOrder"].as_i64().map(|v| v as i32).unwrap_or(0),
                    opt_str(&m, "completedAt"),
                    linked_project_id,
                    linked_subject_id
                ],
            )
            .map_err(toe)?;
        }
    }

    // ---- relationship validation (still inside the transaction) ----
    // Any dangling reference means the remap was wrong: abort the whole import.
    let pid = new_pid;
    let no_dangling: i64 = conn
        .query_row(
            "SELECT
           (SELECT COUNT(*) FROM courses c LEFT JOIN subjects s ON s.id = c.subject_id
             WHERE c.profile_id = ?1 AND c.subject_id IS NOT NULL AND s.id IS NULL)
         + (SELECT COUNT(*) FROM career_milestones cm
             LEFT JOIN projects p ON p.id = cm.linked_project_id
             JOIN career_goals cg ON cg.id = cm.goal_id
             WHERE cg.profile_id = ?1 AND cm.linked_project_id IS NOT NULL AND p.id IS NULL)
         + (SELECT COUNT(*) FROM career_milestones cm
             LEFT JOIN subjects s ON s.id = cm.linked_subject_id
             JOIN career_goals cg ON cg.id = cm.goal_id
             WHERE cg.profile_id = ?1 AND cm.linked_subject_id IS NOT NULL AND s.id IS NULL)",
            [pid],
            |r| r.get(0),
        )
        .map_err(toe)?;
    if no_dangling != 0 {
        return Err(coded(
            codes::INTERNAL,
            format!("Import produced {no_dangling} dangling references — rolled back"),
        ));
    }

    // ---- browser manager (schema v15+): metadata + shortcuts are portable;
    // ---- the machine-local Donut binding is NOT (fresh ids, unmapped).
    for (idx, b) in manifest["browserProfiles"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        let new_local = format!("imp-{}-{}", new_pid, idx + 1);
        conn.execute(
            "INSERT INTO browser_profiles
               (local_id, cf_profile_id, display_name, position, enabled, created_at, last_used_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                new_local,
                new_pid,
                str_or(b, "displayName", "Browser"),
                b["position"]
                    .as_i64()
                    .map(|v| v as i32)
                    .unwrap_or(idx as i32 + 1),
                b["enabled"].as_bool().unwrap_or(true) as i32,
                str_or(b, "createdAt", ""),
                str_or(b, "lastUsedAt", ""),
            ],
        )
        .map_err(toe)?;
        for (si, sc) in b["shortcuts"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .enumerate()
        {
            conn.execute(
                "INSERT INTO browser_shortcuts
                   (browser_profile_id, label, url, position, created_at, pinned)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    new_local,
                    str_or(sc, "label", ""),
                    str_or(sc, "url", ""),
                    sc["position"]
                        .as_i64()
                        .map(|v| v as i32)
                        .unwrap_or(si as i32 + 1),
                    str_or(sc, "createdAt", ""),
                    if sc["pinned"].as_bool().unwrap_or(false) {
                        1i32
                    } else {
                        0i32
                    },
                ],
            )
            .map_err(toe)?;
        }
    }

    Ok(ImportOutcome {
        result: ImportResult {
            profile_id: new_pid,
            name: display_name,
            slug: final_slug,
            resource_count,
        },
        pending,
    })
}

// Helper: SQLite's own UTC timestamp, so exports are consistent with stored rows.
fn now_iso(conn: &rusqlite::Connection) -> String {
    conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now')", [], |r| {
        r.get::<_, String>(0)
    })
    .unwrap_or_default()
}

/// Export a profile and everything under it to a portable `.cfprofile` bundle.
#[napi]
pub fn export_profile(profile_id: i32, out_path: String) -> AsyncTask<ExportTask> {
    AsyncTask::new(ExportTask {
        profile_id,
        out_path,
    })
}

/// Import a `.cfprofile` bundle, recreating the profile + all data. Slug
/// collisions are auto-resolved by suffixing.
#[napi]
pub fn import_profile(bundle_path: String) -> AsyncTask<ImportTask> {
    AsyncTask::new(ImportTask { bundle_path })
}
