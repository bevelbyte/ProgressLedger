# Gates: Master task — CareerFlow product completion + architecture hardening

OWNS: core/src/**/*.rs, shell/src/**/*.js, shell/src/preload.cjs, ui/src/**/*.svelte, ui/src/**/*.js

Scope: Apply P0/P1 fixes from the Phase 0/1/3/4/7/8 audits, keep the build + every test green, produce a final report.

## Phase 0 fixes (committed)
- [x] 15925bc: pool connection init closure (PRAGMA foreign_keys=ON)
- [x] 0f12795: migration BrowserWindow sandbox:true
- [x] 0a12d10: open-file now takes resourceId, not path
- [x] 5d6c5a7: NAPI input validation module + scope courses.rs
- [x] eb1dc9e: scope career.rs delete_career_goal + delete_career_milestone
- [x] a1e204e: scope cards.rs (create/review/update/delete)
- [x] 75e53c5: stop leaking SQLite error details to renderer

## In progress
- [ ] P1-scope: mistakes.rs (Rust done, IPC + renderer in progress)
- [ ] P1-scope: deadlines.rs (Rust done, IPC + renderer in progress)
- [ ] P1-scope: projects.rs + subject_links.rs (sub-agent in progress)
- [ ] P1-scope: formulas.rs + lab_tracker.rs + study_sessions.rs + resources.rs + focus.rs

## Test gates (must stay green on every meaningful change)
- [ ] G-CORE: 115+ core tests pass
  CHECK: cd /d/10_Dev_Workspace/Projects/laboratory/CareerFlow/core && cargo test 2>&1 | grep -E "test result:" | awk '{ok+=$4; fail+=$6} END {print "passed="ok" failed="fail}'
  EXPECT: passed=115+ failed=0
- [ ] G-PARITY: 3 OKs
  CHECK: cd /d/10_Dev_Workspace/Projects/laboratory/CareerFlow && npm run check:ipc 2>&1 | tail -1 && npm run check:napi 2>&1 | tail -1 && npm run check:esm 2>&1 | tail -1
  EXPECT: 3 OKs
- [ ] G-UI: 207 vitest
  CHECK: cd /d/10_Dev_Workspace/Projects/laboratory/CareerFlow && npm run test:ui 2>&1 | tail -3
  EXPECT: 207 passed
- [ ] G-SHELL: 90/90
  CHECK: cd /d/10_Dev_Workspace/Projects/laboratory/CareerFlow && npm run test:shell 2>&1 | tail -3
  EXPECT: 90 pass
- [ ] G-FULL: full `npm test` exits 0
  CHECK: cd /d/10_Dev_Workspace/Projects/laboratory/CareerFlow && npm test 2>&1 | tail -3
  EXPECT: exit 0

## Final report
- [ ] G-REPORT: synthesize the master-task final report (Phase 12 deliverable)
  CHECK: cat REPORT.md
  EXPECT: file exists, contains all 13 phases
