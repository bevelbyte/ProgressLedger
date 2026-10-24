#!/usr/bin/env node
/**
 * perf-probe — backend timing at realistic scale.
 *
 * Seeds a throwaway SQLite DB through the real NAPI CRUD surface, then times
 * the read paths the UI exercises. NOT part of the test gate: run manually via
 * `node scripts/perf-probe.mjs` when a performance question needs numbers.
 *
 * NOTE: measures backend (Rust→SQLite) only. Renderer paint/interaction cost
 * is intentionally out of scope here.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../core/index.js");

const dir = mkdtempSync(join(tmpdir(), "cf-perf-"));
const db = join(dir, "careerflow.db");
const t = (label, fn) => {
  const start = process.hrtime.bigint();
  const out = fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(`${ms.toFixed(1).padStart(9)} ms  ${label}`);
  return out;
};

try {
  t("initDb", () => core.initDb(db));

  // ---- seed ----
  const p = t("seed profile + grade scale", () => {
    const prof = core.addProfile("Perf", `perf-${Date.now()}`);
    core.setGradeScale(prof.id, [
      { minPercent: 80, gradePoint: 9, label: "A" },
      { minPercent: 40, gradePoint: 5, label: "P" },
      { minPercent: 0, gradePoint: 0, label: "F" },
    ]);
    return prof;
  });
  const pid = p.id;

  t("seed 10 tracks / 10 semesters / 10 milestones / 100 subjects", () => {
    for (let tr = 1; tr <= 2; tr++) {
      const trackId = core.addTrack(pid, `Track ${tr}`);
      for (let se = 1; se <= 5; se++) {
        const semesterId = core.addSemester(trackId, `Semester ${se}`);
        const msId = core.addMilestone(semesterId, "Subjects");
        for (let su = 1; su <= 10; su++) {
          core.addSubject(msId, `Subject ${tr}-${se}-${su}`, `C${tr}${se}${su}`);
        }
      }
    }
  });

  const subjects = [];
  for (const track of core.getAcademicTree(pid))
    for (const sem of track.semesters)
      for (const ms of sem.milestones)
        for (const subj of ms.subjects) subjects.push(subj);

  t(`seed 300 courses`, () => {
    for (const [i, s] of subjects.entries()) {
      core.addCourse(pid, `S${i % 10}`, `${s.name} graded`, 4,
        null, null, 50 + (i % 50), 100, false, s.id);
    }
  });

  const now = Date.now();
  const iso = (offsetDays) => new Date(now + offsetDays * 86400000).toISOString().slice(0, 10);
  const deadlineIds = t("seed 500 deadlines", () => {
    const ids = [];
    for (const [i, s] of subjects.entries()) {
      ids.push(core.addDeadline(s.id, iso((i % 30) - 5), i % 3 === 0 ? "exam" : "assignment", `D${i}`, ""));
    }
    // Mark every 6th completed to exercise the active-only filters.
    for (const [i, id] of ids.entries()) if (i % 6 === 0) core.setDeadlineCompletion(id, true);
    return ids;
  });
  console.log(`       (${deadlineIds.length} deadlines seeded)`);

  t("seed 600 study sessions", () => {
    for (const [i, s] of subjects.entries()) {
      core.addStudySession(s.id, 25 + (i % 40), null, null, "");
    }
  });

  t("seed 1500 flashcards (+300 reviews)", () => {
    for (const [i, s] of subjects.entries()) {
      const cardId = core.createCard(s.id, `Q${i}`, `A${i}`);
      if (i % 5 === 0) core.reviewCard(cardId, [3, 4, 5][i % 3]);
    }
  });

  t("seed 60 projects / 180 tasks", () => {
    for (let pr = 1; pr <= 60; pr++) {
      const projectId = core.addProject(pid, `Project ${pr}`, "mini", null, "");
      for (let ta = 1; ta <= 3; ta++) core.addProjectTask(projectId, `Task ${ta}`, "medium", null);
    }
  });

  // ---- measured reads ----
  console.log("--- reads ---");
  t("getDashboardStats", () => core.getDashboardStats(pid));
  t("getCourses(all)", () => core.getCourses(pid, null));
  t("getDeadlines", () => core.getDeadlines(pid));
  t("getDeadlinePaces", () => core.getDeadlinePaces(pid));
  t("getAllCards", () => core.getAllCards(pid));
  t("getReviewStats", () => core.getReviewStats(pid));
  t("getStudySessions(500)", () => core.getStudySessions(pid, 500));
  t("getStudySessionStats", () => core.getStudySessionStats(pid));
  t("getSubjectOverview(first)", () => core.getSubjectOverview(subjects[0].id));
  t("getSemesterOverview(first)", () => {
    const tree = core.getAcademicTree(pid);
    core.getSemesterOverview(tree[0].semesters[0].id);
  });
  t("getCareerGoals+milestones", () => {
    for (const g of core.getCareerGoals(pid)) core.getCareerMilestones(pid, g.id);
  });
  t("searchResources('subject')", () => core.searchResources(pid, "subject"));
} finally {
  // The native pool still holds the sqlite file open on Windows — best effort.
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
