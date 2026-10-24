-- Migration 006: Add performance indexes for dashboard and common queries
-- This migration adds indexes to optimize frequently executed queries
-- Note: Some indexes for deadlines, cards, mistakes, subject_links are already
-- created in migration 003, so we only add NEW indexes here.

-- Indexes for academic hierarchy queries (dashboard stats, tree fetching)
CREATE INDEX IF NOT EXISTS idx_tracks_profile ON tracks(profile_id);
CREATE INDEX IF NOT EXISTS idx_semesters_track ON semesters(track_id);
CREATE INDEX IF NOT EXISTS idx_milestones_semester ON milestones(semester_id);
CREATE INDEX IF NOT EXISTS idx_subjects_milestone ON subjects(milestone_id);
CREATE INDEX IF NOT EXISTS idx_subjects_status ON subjects(status);

-- Indexes for resource queries (dashboard recent activity, subject resources)
CREATE INDEX IF NOT EXISTS idx_resources_subject ON resources(subject_id);
CREATE INDEX IF NOT EXISTS idx_resources_kind ON resources(kind);
CREATE INDEX IF NOT EXISTS idx_resources_created ON resources(created_at DESC);

-- Indexes for deadline queries (category filter)
CREATE INDEX IF NOT EXISTS idx_deadlines_category ON deadlines(category);

-- Indexes for card queries (last_reviewed for streak calculation)
CREATE INDEX IF NOT EXISTS idx_cards_last_reviewed ON cards(last_reviewed);

-- Indexes for mistake queries (time-based filtering)
CREATE INDEX IF NOT EXISTS idx_mistakes_created ON mistakes(created_at DESC);

-- Indexes for course queries (CGPA/SGPA calculations)
CREATE INDEX IF NOT EXISTS idx_courses_profile ON courses(profile_id);
CREATE INDEX IF NOT EXISTS idx_courses_semester ON courses(semester_label);
CREATE INDEX IF NOT EXISTS idx_courses_grade_points ON courses(grade_points);

-- Indexes for project queries
CREATE INDEX IF NOT EXISTS idx_projects_profile ON projects(profile_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_project_tasks_status ON project_tasks(status);
CREATE INDEX IF NOT EXISTS idx_project_tasks_priority ON project_tasks(priority);

-- Indexes for lab experiments
CREATE INDEX IF NOT EXISTS idx_lab_experiments_subject ON lab_experiments(subject_id);
CREATE INDEX IF NOT EXISTS idx_lab_experiments_no ON lab_experiments(experiment_no);

-- Indexes for formulas
CREATE INDEX IF NOT EXISTS idx_formulas_subject ON formulas(subject_id);
CREATE INDEX IF NOT EXISTS idx_formulas_category ON formulas(category);

-- Indexes for subject links (primary link lookup)
CREATE INDEX IF NOT EXISTS idx_subject_links_primary ON subject_links(is_primary);

-- Covering indexes for dashboard stats (optimized tree queries)
CREATE INDEX IF NOT EXISTS idx_subjects_full_tree ON subjects(milestone_id, status);
CREATE INDEX IF NOT EXISTS idx_milestones_full_tree ON milestones(semester_id);
CREATE INDEX IF NOT EXISTS idx_semesters_full_tree ON semesters(track_id);

-- Covering index for resource FTS search
CREATE INDEX IF NOT EXISTS idx_resources_fts_content ON resources(subject_id, kind, created_at DESC);
