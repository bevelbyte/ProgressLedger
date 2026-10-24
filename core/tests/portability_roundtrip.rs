//! Whole-profile backup roundtrip tests (bundle format v2, schema v14).
//!
//! These call the real connection-level exporter/importer
//! (`portability::export_profile_conn` / `import_bundle_conn`) against a fully
//! migrated database seeded with a deliberately rich profile, then verify the
//! restored copy VALUE-for-VALUE (not just row counts), the ID remapping layer,
//! format-v1 backward compatibility, and that every failure mode leaves the
//! destination database byte-for-byte untouched.

use rusqlite::{Connection, OptionalExtension, Result};
use std::fs;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use progress_ledger_core::portability::{export_profile_conn, import_bundle_conn};

fn setup_test_db() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    let migrations_dir = std::path::Path::new("migrations");
    let mut files: Vec<_> = fs::read_dir(migrations_dir)
        .map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(
                Box::new(e) as Box<dyn std::error::Error + Send + Sync>
            )
        })?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |ext| ext == "sql"))
        .collect();
    files.sort_by_key(|e| e.path());
    for entry in files {
        let path = entry.path();
        let ver: i32 = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.split('_').next())
            .and_then(|s| s.parse().ok())
            .expect("migration filenames are NNN_description.sql");
        let sql = fs::read_to_string(&path).map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(
                Box::new(e) as Box<dyn std::error::Error + Send + Sync>
            )
        })?;
        let batch = format!("BEGIN;\n{sql}\nPRAGMA user_version = {ver};\nCOMMIT;");
        conn.execute_batch(&batch)?;
    }
    Ok(conn)
}

/// Convert napi-layer failures into the rusqlite error type this test uses.
fn to_sql<T>(r: napi::Result<T>) -> Result<T> {
    r.map_err(|e| {
        rusqlite::Error::ToSqlConversionFailure(
            Box::new(e) as Box<dyn std::error::Error + Send + Sync>
        )
    })
}

// Atomic (not `static mut`): these tests run on parallel threads and a plain
// mutable counter raced two tests onto the same temp bundle path, letting one
// overwrite the other's archive between write and read ("Invalid checksum").
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);
fn temp_bundle_path() -> PathBuf {
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "cf-roundtrip-{}-{}.cfprofile",
        std::process::id(),
        n
    ))
}

/// A deliberately rich profile: 2 tracks / 3 semesters with statuses /
/// renamed subject / linked + legacy courses / custom grade scale / focus
/// settings / active+completed deadlines / session / non-default SM-2 card /
/// tagged mistake / note + pdf-meta resources / project + 2 tasks / lab /
/// formula / primary subject link / 2 career goals (one completed milestone,
/// project link, subject link).
fn seed_rich_profile(conn: &Connection) -> Result<i32> {
    conn.execute(
        "INSERT INTO profiles (name, slug) VALUES ('Rich Ada', 'rich-ada')",
        [],
    )?;
    let pid = conn.last_insert_rowid() as i32;

    conn.execute(
        "INSERT INTO tracks (profile_id, name) VALUES (?1, 'B.Tech')",
        [pid],
    )?;
    let t1 = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO tracks (profile_id, name) VALUES (?1, 'MSc')",
        [pid],
    )?;
    let _t2 = conn.last_insert_rowid() as i32;

    for (track, name, status) in [
        (t1, "Semester 1", "In Progress"),
        (t1, "Semester 2", "Upcoming"),
    ] {
        conn.execute(
            "INSERT INTO semesters (track_id, name, status) VALUES (?1, ?2, ?3)",
            rusqlite::params![track, name, status],
        )?;
    }

    conn.execute(
        "INSERT INTO milestones (semester_id, title) SELECT id, 'Subjects' FROM semesters WHERE track_id = ?1 AND name = 'Semester 1'",
        [t1],
    )?;
    let ms: i32 = conn.last_insert_rowid() as i32;

    // Subject whose course name diverges (post-rename world): structural link.
    conn.execute(
        "INSERT INTO subjects (milestone_id, name, code, status) VALUES (?1, 'Distributed Systems', 'CS301', 'in_progress')",
        [ms],
    )?;
    let sub_a = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO subjects (milestone_id, name, code, status) VALUES (?1, 'Legacy Course', 'XX1', 'pending')",
        [ms],
    )?;
    let sub_b = conn.last_insert_rowid() as i32;

    conn.execute(
        "INSERT INTO courses (profile_id, semester_label, course_name, credits, marks_obtained, max_marks, is_hypothetical, subject_id)
         VALUES (?1, 'Semester 1', 'Old Name That Was Renamed', 4, 88, 100, 0, ?2)",
        rusqlite::params![pid, sub_a],
    )?;
    conn.execute(
        "INSERT INTO courses (profile_id, semester_label, course_name, credits, marks_obtained, max_marks)
         VALUES (?1, 'Semester 1', 'Legacy Course', 3, 55, 100)",
        [pid],
    )?;

    // Grade scale + bands.
    conn.execute(
        "INSERT INTO grade_scales (profile_id, name) VALUES (?1, 'Custom 10pt')",
        [pid],
    )?;
    let scale = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO grade_bands (scale_id, min_percent, grade_point, label, sort_order) VALUES (?1, 80.0, 9.0, 'A+', 0)",
        [scale],
    )?;
    conn.execute(
        "INSERT INTO grade_bands (scale_id, min_percent, grade_point, label, sort_order) VALUES (?1, 40.0, 5.0, 'P', 1)",
        [scale],
    )?;

    // Focus settings.
    conn.execute(
        "INSERT INTO focus_settings (profile_id, is_enabled, blocked_domains) VALUES (?1, 1, '[\"x.com\"]')",
        [pid],
    )?;

    // Dependents on sub_a.
    conn.execute(
        "INSERT INTO session_states (subject_id, started_at, ended_at, duration_minutes, notes)
         VALUES (?1, '2026-08-20 10:00:00', '2026-08-20 10:30:00', 30, 'deep work')",
        [sub_a],
    )?;
    conn.execute(
        "INSERT INTO cards (subject_id, front, back, ease_factor, interval_days, repetitions, due_date, last_reviewed)
         VALUES (?1, 'Q', 'A', 2.7, 6, 3, '2030-01-01', '2026-08-20 10:00:00')",
        [sub_a],
    )?;
    conn.execute(
        "INSERT INTO mistakes (subject_id, question_text, mistake_type, correct_approach, tags)
         VALUES (?1, 'q', 'conceptual', 'a', '[\"off-by-one\"]')",
        [sub_a],
    )?;
    conn.execute(
        "INSERT INTO resources (subject_id, kind, title, content) VALUES (?1, 'note', 'Note A', 'body a')",
        [sub_a],
    )?;
    conn.execute(
        "INSERT INTO resources (subject_id, kind, title, content, rel_path, byte_size)
         VALUES (?1, 'pdf', 'Paper', '', NULL, 12345)",
        [sub_a],
    )?;
    conn.execute(
        "INSERT INTO deadlines (subject_id, deadline_date, category, title, notes) VALUES (?1, '2026-09-01', 'exam', 'Active Mid', '')",
        [sub_a],
    )?;
    conn.execute(
        "INSERT INTO deadlines (subject_id, deadline_date, category, title, completed_at) VALUES (?1, '2026-07-01', 'assignment', 'Done Quiz', '2026-07-02 09:00:00')",
        [sub_a],
    )?;
    conn.execute(
        "INSERT INTO lab_experiments (subject_id, experiment_no, title, record_submitted, viva_done, viva_score, notes)
         VALUES (?1, 3, 'Exp3', 1, 0, NULL, 'pending viva')",
        [sub_a],
    )?;
    conn.execute(
        "INSERT INTO formulas (subject_id, title, latex_content, category) VALUES (?1, 'Lamport', '\\\\clock', 'clocks')",
        [sub_a],
    )?;
    conn.execute(
        "INSERT INTO subject_links (subject_id, label, url, is_primary) VALUES (?1, 'Spec', 'https://example.com', 1)",
        [sub_a],
    )?;

    // Project + tasks.
    conn.execute(
        "INSERT INTO projects (profile_id, name, project_type, status, deadline, description)
         VALUES (?1, 'Capstone', 'major', 'in_progress', '2027-01-15', 'big')",
        [pid],
    )?;
    let proj = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO project_tasks (project_id, title, status, priority, due_date, notes, sort_order)
         VALUES (?1, 'Design', 'done', 'high', '2026-08-01', NULL, 0)",
        [proj],
    )?;
    conn.execute(
        "INSERT INTO project_tasks (project_id, title, status, priority, due_date, notes, sort_order)
         VALUES (?1, 'Build', 'todo', 'medium', NULL, 'start here', 1)",
        [proj],
    )?;

    // Career: two goals; milestones incl. completed one + both link kinds.
    conn.execute(
        "INSERT INTO career_goals (profile_id, title, target_role, domain, description, target_date, status, is_primary)
         VALUES (?1, 'Backend Engineer', 'Backend Engineer', 'Infra', 'go deep', '2027-06-01', 'active', 1)",
        [pid],
    )?;
    let goal1 = conn.last_insert_rowid() as i32;
    conn.execute(
        "INSERT INTO career_goals (profile_id, title, target_role, domain, description, target_date, status, is_primary)
         VALUES (?1, 'Researcher', NULL, 'Academia', NULL, NULL, 'paused', 0)",
        [pid],
    )?;
    let goal2 = conn.last_insert_rowid() as i32;

    conn.execute(
        "INSERT INTO career_milestones (goal_id, title, description, target_date, sort_order, completed_at, linked_project_id, linked_subject_id)
         VALUES (?1, 'Ship Capstone', 'v1', '2026-12-01', 0, NULL, ?2, ?3)",
        rusqlite::params![goal1, proj, sub_a],
    )?;
    conn.execute(
        "INSERT INTO career_milestones (goal_id, title, description, target_date, sort_order, completed_at)
         VALUES (?1, 'Read Papers', NULL, NULL, 1, '2026-05-05 12:00:00')",
        [goal2],
    )?;
    conn.execute(
        "INSERT INTO career_milestones (goal_id, title, description, target_date, sort_order, completed_at, linked_subject_id)
         VALUES (?1, 'Master DS', NULL, NULL, 2, NULL, ?2)",
        rusqlite::params![goal2, sub_b],
    )?;

    Ok(pid)
}

fn q<T: rusqlite::types::FromSql>(conn: &Connection, sql: &str, pid: i32) -> Result<T> {
    conn.query_row(sql, [pid], |r| r.get(0))
}

#[test]
fn full_roundtrip_preserves_every_domain_and_relationship() -> Result<()> {
    let conn = setup_test_db()?;
    let pid = seed_rich_profile(&conn)?;

    let out_path = temp_bundle_path();
    let manifest = to_sql(export_profile_conn(
        &conn,
        pid,
        out_path.to_str().unwrap(),
        None,
        None,))?;

    // Completeness contract: every profile-owned domain appears in the bundle.
    assert_eq!(manifest["version"], 2);
    for section in [
        "gradeScale",
        "focusSettings",
        "tracks",
        "projects",
        "career",
    ] {
        assert!(manifest.get(section).is_some(), "missing section {section}");
    }
    let subj0 = &manifest["tracks"][0]["semesters"][0]["milestones"][0]["subjects"][0];
    for key in [
        "resources",
        "deadlines",
        "sessions",
        "cards",
        "mistakes",
        "labs",
        "formulas",
        "links",
    ] {
        assert!(subj0.get(key).is_some(), "subject missing {key}");
    }
    assert!(manifest["tracks"][0]["semesters"][0]
        .get("courses")
        .is_some());
    assert_eq!(
        manifest["tracks"][0]["semesters"][0]["status"],
        "In Progress"
    );

    // WIPE the profile (cascade destroys everything under it).
    conn.execute("DELETE FROM profiles WHERE id = ?1", [pid])?;
    let left: i64 = conn.query_row("SELECT COUNT(*) FROM subjects", [], |r| r.get::<_, i64>(0))?;
    assert_eq!(left, 0);

    // IMPORT.
    let restored = to_sql(import_bundle_conn(&conn, out_path.to_str().unwrap(), None, None))?;
    let new_pid = restored.profile_id;
    assert_eq!(restored.slug, "rich-ada"); // slug freed by the wipe

    // ---- identity/structure ----
    assert_eq!(
        q::<i64>(
            &conn,
            "SELECT COUNT(*) FROM profiles WHERE id = ?1",
            new_pid
        )?,
        1
    );
    assert_eq!(
        q::<String>(
            &conn,
            "SELECT name FROM tracks WHERE profile_id = ?1 ORDER BY id LIMIT 1",
            new_pid
        )?,
        "B.Tech"
    );
    assert_eq!(
        q::<i64>(
            &conn,
            "SELECT COUNT(*) FROM tracks WHERE profile_id = ?1",
            new_pid
        )?,
        2
    );
    // Semester statuses persisted (incl. non-default values).
    let statuses: String = conn.query_row(
        "SELECT GROUP_CONCAT(status) FROM semesters WHERE track_id =
           (SELECT id FROM tracks WHERE profile_id = ?1 ORDER BY id LIMIT 1)",
        [new_pid],
        |r| r.get(0),
    )?;
    assert_eq!(statuses, "In Progress,Upcoming");

    // Subjects: names/codes/statuses, and exactly one of each legacy pair.
    assert_eq!(q::<i64>(&conn, "SELECT COUNT(*) FROM subjects s JOIN milestones m ON m.id=s.milestone_id JOIN semesters se ON se.id=m.semester_id JOIN tracks t ON t.id=se.track_id WHERE t.profile_id=?1 AND s.name='Distributed Systems'", new_pid)?, 1);

    // Courses: structural link remapped to the NEW subject id; grades intact.
    let course: (f64, f64, Option<f64>, Option<i32>) = conn.query_row(
        "SELECT credits, max_marks, marks_obtained, subject_id FROM courses
         WHERE profile_id = ?1 AND course_name = 'Old Name That Was Renamed'",
        [new_pid],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    let linked_subject: i32 = course.3.expect("course must be structurally linked");
    let linked_name: String = conn.query_row(
        "SELECT s.name FROM subjects s WHERE s.id = ?1",
        [linked_subject],
        |r| r.get(0),
    )?;
    assert_eq!(linked_name, "Distributed Systems");
    assert!((course.0 - 4.0).abs() < f64::EPSILON);
    assert_eq!(course.2, Some(88.0));

    // Legacy NULL-linked row survives as NULL (never guessed).
    let null_link: Option<i32> = conn.query_row(
        "SELECT subject_id FROM courses WHERE profile_id = ?1 AND course_name = 'Legacy Course'",
        [new_pid],
        |r| r.get(0),
    )?;
    assert_eq!(null_link, None);

    // Deadlines incl. completion state.
    let (total, completed): (i64, i64) = conn.query_row(
        "SELECT COUNT(*),
           SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END)
         FROM deadlines d JOIN subjects s ON s.id=d.subject_id
           JOIN milestones m ON m.id=s.milestone_id
           JOIN semesters se ON se.id=m.semester_id
           JOIN tracks t ON t.id=se.track_id
         WHERE t.profile_id = ?1",
        [new_pid],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!((total, completed), (2, 1));

    // Study session value preserved.
    let mins: i64 = conn.query_row(
        "SELECT SUM(duration_minutes) FROM session_states ss
           JOIN subjects s ON s.id=ss.subject_id
           JOIN milestones m ON m.id=s.milestone_id
           JOIN semesters se ON se.id=m.semester_id
           JOIN tracks t ON t.id=se.track_id
         WHERE t.profile_id=?1",
        [new_pid],
        |r| r.get::<_, i64>(0),
    )?;
    assert_eq!(mins, 30);

    // SM-2 scheduling fields are exact.
    let card: (f64, i64, i64, String, String) = conn.query_row(
        "SELECT c.ease_factor, c.interval_days, c.repetitions, c.due_date, c.last_reviewed
         FROM cards c JOIN subjects s ON s.id=c.subject_id
           JOIN milestones m ON m.id=s.milestone_id
           JOIN semesters se ON se.id=m.semester_id
           JOIN tracks t ON t.id=se.track_id
         WHERE t.profile_id=?1",
        [new_pid],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;
    assert!((card.0 - 2.7).abs() < 1e-9);
    assert_eq!((card.1, card.2), (6, 3));
    assert_eq!(
        (card.3.as_str(), card.4.as_str()),
        ("2030-01-01", "2026-08-20 10:00:00")
    );

    // Mistake tags JSON preserved.
    let tags: String = conn.query_row(
        "SELECT m.tags FROM mistakes m JOIN subjects s ON s.id=m.subject_id
           JOIN milestones mm ON mm.id=s.milestone_id
           JOIN semesters se ON se.id=mm.semester_id
           JOIN tracks t ON t.id=se.track_id
         WHERE t.profile_id=?1",
        [new_pid],
        |r| r.get::<_, String>(0),
    )?;
    assert_eq!(tags, "[\"off-by-one\"]");

    // Resources: note content + pdf metadata row.
    let (notes, pdfs): (i64, i64) = conn.query_row(
        "SELECT SUM(kind='note'), SUM(kind='pdf') FROM resources r
           JOIN subjects s ON s.id=r.subject_id
           JOIN milestones m ON m.id=s.milestone_id
           JOIN semesters se ON se.id=m.semester_id
           JOIN tracks t ON t.id=se.track_id
         WHERE t.profile_id=?1",
        [new_pid],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!((notes, pdfs), (1, 1));
    assert_eq!(restored.resource_count, 2);

    // Projects/tasks.
    let (pname, task_done, task_todo): (String, i64, i64) = conn.query_row(
        "SELECT p.name,
           SUM(CASE WHEN pt.status='done' THEN 1 ELSE 0 END),
           SUM(CASE WHEN pt.status='todo' THEN 1 ELSE 0 END)
         FROM projects p LEFT JOIN project_tasks pt ON pt.project_id=p.id
         WHERE p.profile_id=?1 GROUP BY p.id",
        [new_pid],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    assert_eq!(pname, "Capstone");
    assert_eq!(task_done, 1);
    assert_eq!(task_todo, 1);

    // Labs/formulas/links counts + primary flag.
    for table in ["lab_experiments", "formulas", "subject_links"] {
        assert_eq!(
            q::<i64>(&conn,
                &format!("SELECT COUNT(*) FROM {table} x JOIN subjects s ON s.id=x.subject_id JOIN milestones m ON m.id=s.milestone_id JOIN semesters se ON se.id=m.semester_id JOIN tracks t ON t.id=se.track_id WHERE t.profile_id=?1"),
                new_pid)?,
            1,
            "{table}"
        );
    }
    let primary: i64 = conn.query_row(
        "SELECT COUNT(*) FROM subject_links x JOIN subjects s ON s.id=x.subject_id
           JOIN milestones m ON m.id=s.milestone_id
           JOIN semesters se ON se.id=m.semester_id
           JOIN tracks t ON t.id=se.track_id
         WHERE t.profile_id=?1 AND x.is_primary=1",
        [new_pid],
        |r| r.get::<_, i64>(0),
    )?;
    assert_eq!(primary, 1);

    // Grade scale + bands.
    let band_n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM grade_bands b JOIN grade_scales s ON s.id=b.scale_id WHERE s.profile_id=?1",
        [new_pid], |r| r.get::<_, i64>(0))?;
    assert_eq!(band_n, 2);

    // Focus settings.
    let enabled: i64 = conn.query_row(
        "SELECT is_enabled FROM focus_settings WHERE profile_id=?1",
        [new_pid],
        |r| r.get::<_, i64>(0),
    )?;
    assert_eq!(enabled, 1);

    // Career goals/milestones + BOTH link kinds resolve to imported rows.
    let goal_n: i64 = q::<i64>(
        &conn,
        "SELECT COUNT(*) FROM career_goals WHERE profile_id=?1",
        new_pid,
    )?;
    assert_eq!(goal_n, 2);
    let ms_stats: (i64, i64, i64) = conn.query_row(
        "SELECT COUNT(*),
           SUM(CASE WHEN cm.completed_at IS NOT NULL THEN 1 ELSE 0 END),
           SUM(CASE WHEN cm.linked_project_id IS NOT NULL THEN 1 ELSE 0 END)
         FROM career_milestones cm JOIN career_goals g ON g.id=cm.goal_id
         WHERE g.profile_id=?1",
        [new_pid],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    assert_eq!(ms_stats, (3, 1, 1));
    let career_subject_link: Option<String> = conn.query_row(
        "SELECT s.name FROM career_milestones cm
           JOIN subjects s ON s.id=cm.linked_subject_id
           JOIN career_goals g ON g.id=cm.goal_id
         WHERE g.profile_id=?1 AND cm.title='Ship Capstone'",
        [new_pid],
        |r| r.get::<_, Option<String>>(0),
    )?;
    assert_eq!(career_subject_link.as_deref(), Some("Distributed Systems"));

    let _ = fs::remove_file(&out_path);
    Ok(())
}

#[test]
fn format_v1_bundle_imports_academic_tree_and_resources_only() -> Result<()> {
    use serde_json::json;
    let conn = setup_test_db()?;
    let before_profiles: i64 =
        conn.query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get::<_, i64>(0))?;

    let manifest = json!({
        "format": "progressledger.profile",
        "profile": { "name": "Old Export", "slug": "old-export" },
        "tracks": [{
            "name": "BA",
            "semesters": [{
                "name": "Semester 1",
                "milestones": [{
                    "title": "Subjects",
                    "subjects": [{
                        "name": "History", "status": "done",
                        "resources": [
                            { "kind": "note", "title": "N", "content": "c" },
                            { "kind": "pdf", "title": "P", "content": "", "attachment": "attachments/9.pdf" }
                        ]
                    }]
                }]
            }]
        }]
    });

    let out_path = temp_bundle_path();
    let file = fs::File::create(&out_path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    zip.start_file("manifest.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(serde_json::to_string_pretty(&manifest).unwrap().as_bytes())
        .unwrap();
    zip.start_file(
        "attachments/9.pdf",
        zip::write::SimpleFileOptions::default(),
    )
    .unwrap();
    zip.write_all(b"%PDF-fake").unwrap();
    zip.finish().unwrap();

    let res = to_sql(import_bundle_conn(&conn, out_path.to_str().unwrap(), None, None))?;
    assert_eq!(res.slug, "old-export");
    assert_eq!(res.resource_count, 2);

    // Academic tree + resources exist...
    assert_eq!(
        q::<i64>(
            &conn,
            "SELECT COUNT(*) FROM subjects s JOIN milestones m ON m.id=s.milestone_id
             JOIN semesters se ON se.id=m.semester_id JOIN tracks t ON t.id=se.track_id
             WHERE t.profile_id=?1 AND s.name='History'",
            res.profile_id
        )?,
        1
    );
    // ...and nothing else — precisely the documented v1 limitation.
    assert_eq!(
        q::<i64>(
            &conn,
            "SELECT COUNT(*) FROM courses WHERE profile_id=?1",
            res.profile_id
        )?,
        0
    );
    assert_eq!(
        q::<i64>(
            &conn,
            "SELECT COUNT(*) FROM career_goals WHERE profile_id=?1",
            res.profile_id
        )?,
        0
    );
    assert_eq!(
        before_profiles + 1,
        conn.query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get::<_, i64>(0))?
    );

    let _ = fs::remove_file(&out_path);
    Ok(())
}

#[test]
fn unknown_version_is_rejected_without_touching_db() -> Result<()> {
    use serde_json::json;
    let conn = setup_test_db()?;
    let before: i64 =
        conn.query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get::<_, i64>(0))?;

    let manifest = json!({
        "format": "progressledger.profile", "version": 99,
        "profile": { "name": "X", "slug": "x" }, "tracks": []
    });
    let out_path = temp_bundle_path();
    let file = fs::File::create(&out_path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    zip.start_file("manifest.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(serde_json::to_string(&manifest).unwrap().as_bytes())
        .unwrap();
    zip.finish().unwrap();

    assert!(import_bundle_conn(&conn, out_path.to_str().unwrap(), None, None).is_err());
    assert_eq!(
        before,
        conn.query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get::<_, i64>(0))?
    );
    let _ = fs::remove_file(&out_path);
    Ok(())
}

#[test]
fn corrupt_and_truncated_archives_leave_db_unchanged() -> Result<()> {
    let conn = setup_test_db()?;
    let before: i64 =
        conn.query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get::<_, i64>(0))?;

    // Corrupt (not a zip at all).
    let bad = temp_bundle_path();
    fs::write(&bad, b"this is not a zip file").unwrap();
    assert!(import_bundle_conn(&conn, bad.to_str().unwrap(), None, None).is_err());

    // Truncated valid zip.
    let good = temp_bundle_path();
    let manifest = serde_json::json!({
        "format": "progressledger.profile", "version": 2,
        "profile": {"name":"T","slug":"t"}, "tracks": []
    });
    let file = fs::File::create(&good).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    zip.start_file("manifest.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(serde_json::to_string(&manifest).unwrap().as_bytes())
        .unwrap();
    zip.finish().unwrap();
    let bytes = fs::read(&good).unwrap();
    let truncated = temp_bundle_path();
    fs::write(&truncated, &bytes[..bytes.len() / 2]).unwrap();
    assert!(import_bundle_conn(&conn, truncated.to_str().unwrap(), None, None).is_err());

    // Invalid manifest JSON inside a valid zip.
    let invalid = temp_bundle_path();
    let file = fs::File::create(&invalid).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    zip.start_file("manifest.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(b"{ not json ").unwrap();
    zip.finish().unwrap();
    assert!(import_bundle_conn(&conn, invalid.to_str().unwrap(), None, None).is_err());

    assert_eq!(
        before,
        conn.query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get::<_, i64>(0))?
    );
    for f in [&bad, &good, &truncated, &invalid] {
        let _ = fs::remove_file(f);
    }
    Ok(())
}

#[test]
fn malformed_relationship_rolls_back_entire_import() -> Result<()> {
    use serde_json::json;
    let conn = setup_test_db()?;
    let before: i64 =
        conn.query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get::<_, i64>(0))?;

    // Course references a subject key that does not exist in the bundle.
    let manifest = json!({
        "format": "progressledger.profile", "version": 2,
        "profile": { "name": "Bad Ref", "slug": "bad-ref" },
        "tracks": [{
            "name": "T",
            "semesters": [{
                "name": "Semester 1", "status": "Upcoming",
                "milestones": [{ "title": "M", "subjects": [
                    { "k": 1, "name": "S", "status": "pending",
                      "resources": [], "deadlines": [], "sessions": [], "cards": [],
                      "mistakes": [], "labs": [], "formulas": [], "links": [] }
                ]}],
                "courses": [ { "subjectKey": 999, "name": "Orphan", "credits": 3 } ]
            }]
        }],
        "projects": [], "career": { "goals": [] }
    });
    let out_path = temp_bundle_path();
    let file = fs::File::create(&out_path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    zip.start_file("manifest.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(serde_json::to_string(&manifest).unwrap().as_bytes())
        .unwrap();
    zip.finish().unwrap();

    assert!(import_bundle_conn(&conn, out_path.to_str().unwrap(), None, None).is_err());
    // ROLLBACK: no profile, no subjects, no courses survived the failed import.
    assert_eq!(
        before,
        conn.query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get::<_, i64>(0))?
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM subjects", [], |r| r.get::<_, i64>(0))?,
        0
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM courses", [], |r| r.get::<_, i64>(0))?,
        0
    );
    let _ = fs::remove_file(&out_path);
    Ok(())
}

#[test]
fn attachment_materialization_failure_rolls_back_database_and_files() -> std::result::Result<(), Box<dyn std::error::Error>> {
    use serde_json::json;

    let conn = setup_test_db()?;
    let root = std::env::temp_dir().join(format!(
        "cf-import-attachments-{}-{}",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&root)?;

    // A fresh test DB assigns profile/subject/resource ids starting at 1.
    // Pre-create the exact destination for the imported attachment. The
    // importer must reject the collision BEFORE COMMIT; the old implementation
    // committed first and silently left the resource without its file.
    fs::create_dir_all(root.join("1"))?;
    fs::write(root.join("1").join("1.pdf"), b"pre-existing")?;

    let manifest = json!({
        "format": "progressledger.profile",
        "version": 2,
        "profile": { "name": "Attachment Failure", "slug": "attachment-failure" },
        "tracks": [{
            "name": "T",
            "semesters": [{
                "name": "Semester 1",
                "status": "Upcoming",
                "milestones": [{ "title": "M", "subjects": [{
                    "k": 1,
                    "name": "S",
                    "status": "pending",
                    "resources": [{
                        "kind": "pdf",
                        "title": "Paper",
                        "content": "",
                        "attachment": "attachments/1.pdf"
                    }],
                    "deadlines": [], "sessions": [], "cards": [], "mistakes": [],
                    "labs": [], "formulas": [], "links": []
                }]}],
                "courses": []
            }]
        }],
        "projects": [],
        "career": { "goals": [] }
    });

    let bundle = temp_bundle_path();
    let file = fs::File::create(&bundle)?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default();
    zip.start_file("manifest.json", opts)?;
    zip.write_all(serde_json::to_string(&manifest)?.as_bytes())?;
    zip.start_file("attachments/1.pdf", opts)?;
    zip.write_all(b"pdf-bytes")?;
    zip.finish()?;

    let before_profiles: i64 = conn.query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get(0))?;
    let result = import_bundle_conn(&conn, bundle.to_str().unwrap(), Some(&root), None);
    assert!(result.is_err(), "attachment collision must fail the import");
    assert_eq!(
        before_profiles,
        conn.query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get::<_, i64>(0))?
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM resources", [], |r| r.get::<_, i64>(0))?,
        0i64
    );
    assert_eq!(fs::read(root.join("1").join("1.pdf"))?, b"pre-existing");

    let _ = fs::remove_file(&bundle);
    let _ = fs::remove_dir_all(&root);
    Ok(())
}

#[test]
fn missing_referenced_attachment_rolls_back_database() -> Result<()> {
    use serde_json::json;

    let conn = setup_test_db()?;
    let manifest = json!({
        "format": "progressledger.profile",
        "version": 2,
        "profile": { "name": "Missing Attachment", "slug": "missing-attachment" },
        "tracks": [{
            "name": "T",
            "semesters": [{
                "name": "Semester 1", "status": "Upcoming",
                "milestones": [{ "title": "M", "subjects": [{
                    "k": 1, "name": "S", "status": "pending",
                    "resources": [{
                        "kind": "pdf", "title": "Paper", "content": "",
                        "attachment": "attachments/missing.pdf"
                    }],
                    "deadlines": [], "sessions": [], "cards": [], "mistakes": [],
                    "labs": [], "formulas": [], "links": []
                }]}],
                "courses": []
            }]
        }],
        "projects": [], "career": { "goals": [] }
    });
    let bundle = temp_bundle_path();
    let file = fs::File::create(&bundle).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    zip.start_file("manifest.json", zip::write::SimpleFileOptions::default()).unwrap();
    zip.write_all(serde_json::to_string(&manifest).unwrap().as_bytes()).unwrap();
    zip.finish().unwrap();

    assert!(import_bundle_conn(&conn, bundle.to_str().unwrap(), None, None).is_err());
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get::<_, i64>(0))?, 0);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM resources", [], |r| r.get::<_, i64>(0))?, 0);
    let _ = fs::remove_file(&bundle);
    Ok(())
}

#[test]
fn repeated_import_suffixes_slug_and_preserves_every_copy() -> Result<()> {
    use serde_json::json;
    let conn = setup_test_db()?;

    let manifest = json!({
        "format": "progressledger.profile", "version": 2,
        "profile": { "name": "Twin", "slug": "twin" },
        "tracks": [{
            "name": "T",
            "semesters": [{ "name": "Semester 1", "status": "Upcoming",
                "milestones": [{ "title": "M", "subjects": [
                    { "k": 1, "name": "S", "status": "pending",
                      "resources": [], "deadlines": [], "sessions": [], "cards": [],
                      "mistakes": [], "labs": [], "formulas": [], "links": [] }
                ]}],
                "courses": [ { "subjectKey": 1, "name": "S", "credits": 3 } ]
            }]
        }],
        "projects": [], "career": { "goals": [] }
    });
    let out_path = temp_bundle_path();
    let file = fs::File::create(&out_path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    zip.start_file("manifest.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(serde_json::to_string(&manifest).unwrap().as_bytes())
        .unwrap();
    zip.finish().unwrap();

    let slugs: Vec<String> = vec![
        to_sql(import_bundle_conn(&conn, out_path.to_str().unwrap(), None, None))?.slug,
        to_sql(import_bundle_conn(&conn, out_path.to_str().unwrap(), None, None))?.slug,
        to_sql(import_bundle_conn(&conn, out_path.to_str().unwrap(), None, None))?.slug,
    ];
    assert_eq!(slugs, vec!["twin", "twin-2", "twin-3"]);

    // Every copy keeps its own structural course link (no cross-profile bleed).
    for slug in &slugs {
        let linked: i64 = conn.query_row(
            "SELECT COUNT(*) FROM courses c
               JOIN subjects s ON s.id = c.subject_id
             WHERE c.profile_id = (SELECT id FROM profiles WHERE slug = ?1)",
            [slug],
            |r| r.get(0),
        )?;
        assert_eq!(linked, 1, "{slug} keeps its own linked course");
    }
    let _ = fs::remove_file(&out_path);
    Ok(())
}
