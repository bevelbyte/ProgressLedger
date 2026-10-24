# GATES-PHASE17 — Full Electron E2E Closure + Production Regression

Evidence classification (project convention):
- **LIVE** — against the real b.ai provider (env-gated)
- **REAL** — against the real production stack (Rust/NAPI + SQLite + real Electron app)
- **E2E** — against the real Electron app via Playwright
- **REAL-CORE** — real NAPI core + real SQLite, driven by the node:test harness
- **ENV** — environment-skipped (no provider key / external dependency unavailable)

---

## A. P1 — Baseline from real Electron (GATE 1)

| Gate | Description | Status | Evidence |
|---|---|---|---|
| A.1 | Full E2E suite runs against the real Electron app | PASS — E2E | `npx playwright test` completed (19.4 min) |
| A.2 | Baseline recorded before any fix | PASS — E2E | 47 passed / 46 failed / 1 non-test error (run1) |
| A.3 | Every failure captured with error context | PASS — E2E | `test-results/*/error-context.md` per failure |

---

## B. P2 — Failure classification (GATE 2)

| Gate | Description | Status | Evidence |
|---|---|---|---|
| B.1 | Every original failure classified TEST SPEC / APP / ENV / INTENTIONAL | PASS — REAL | See REPORT-V17 §2; scratch ledger in `C:\Users\Asus\.zcode\tmp\phase17-classification.md` |
| B.2 | No failure hidden with a skip | PASS — REAL | No `test.skip`/`describe.skip`/`test.fixme` introduced |
| B.3 | No assertion weakened to obtain green | PASS — REAL | All existing assertions preserved; only shapes/contracts corrected |

---

## C. P3 — Application defects fixed (GATE 3)

| Gate | Description | Status | Evidence |
|---|---|---|---|
| C.1 | Focus session save passes profileId (arg-shift defect) | PASS — REAL | `focus.service.js` + `FocusSession.svelte`; UI regression tests 45/45 |
| C.2 | Mistakes tags accept empty (optional field defect) | PASS — REAL | `core/src/validate.rs` `bounded_text`; `core/src/db/mistakes.rs`; core rebuild green |
| C.3 | Browser Manager add-form Cancel not disabled while open | PASS — REAL | `BrowserManagerPanel.svelte` `disabled={busy}`; quick-actions-browser E2E green |
| C.4 | Donut launcher spawn does not wedge on Electron exit | PASS — REAL | `donut.js` `defaultSpawnLauncher`; 33 donut unit tests pass; phase9 restart E2E green |

---

## D. P4 — Test-spec contract fixes (GATE 4)

| Gate | Description | Status | Evidence |
|---|---|---|---|
| D.1 | Stale IPC shapes corrected to preload contract (14 spec files) | PASS — E2E | academic-focus, backup-restore, career-planning, career-subject-link, deadline-completion, focus-session (seed), journey-learning-projects, semester-progress, semester-status, study-sessions, subject-rename, subject-workspace, today + quick-actions-browser |
| D.2 | Donut real-browser specs use shared cleanup (preflight + teardown) | PASS — E2E | `e2e/helpers/donut-cleanup.mjs` wired into phase5-9 |
| D.3 | real-donut-e2e uses reload+activation after IPC profile creation | PASS — E2E | PHASE 1-8 all green |
| D.4 | No test-only production behavior beyond `__test*` helpers | PASS — REAL | audit |

---

## E. P5 — Full E2E green (GATE 5)

| Gate | Description | Status | Evidence |
|---|---|---|---|
| E.1 | Complete Electron E2E suite: 0 failures | PASS — E2E | **93 passed / 0 failed** — reproduced twice (run8 with spawn experiment, run9 final with reverted spawn) |
| E.2 | Goal Mode E2E remains green | PASS — E2E | goals-mode ×2, goals-navigation ×1, goals-restart ×1 |
| E.3 | Project Mode E2E remains green | PASS — E2E | project-mode-lifecycle ×1 |
| E.4 | No environmental blockers left unresolved | PASS — REAL | all real-Donut tests green; evidence chain in REPORT-V17 §16 |

---

## F. P6 — Regression layers (GATE 6)

| Gate | Description | Status | Evidence |
|---|---|---|---|
| F.1 | Shell tests green | PASS — REAL-CORE | **1027 / 1005 pass / 0 fail / 22 env-skips** |
| F.2 | UI tests green | PASS — REAL | **495 / 495** (incl. 2 new focus regression tests) |
| F.3 | Rust tests green | PASS — REAL | **132 pass / 0 fail** |
| F.4 | IPC parity ≥ 239 | PASS — REAL | `check:ipc` — 239 channels, all handled |
| F.5 | NAPI parity ≥ 115 | PASS — REAL | `check:napi` — 115 exports OK |
| F.6 | ESM parity ≥ 111 | PASS — REAL | `check:esm` — 111 files OK |
| F.7 | Production build green | PASS — REAL | `npm run build:core` + `build:ui` green |
| F.8 | Native dual-ABI workflow reproducible | PASS — REAL | `rebuild-native.mjs node` → shell 1027; `... electron` → E2E 93/0; both directions verified |

---

## G. P7 — Security regression (GATE 7)

| Gate | Description | Status | Evidence |
|---|---|---|---|
| G.1 | contextIsolation / nodeIntegration=false / preload whitelist intact | PASS — REAL | `main.js` both window configs verified |
| G.2 | CSP untouched | PASS — REAL | no CSP edits |
| G.3 | No provider secrets in renderer/test output/logs/git | PASS — REAL | git diff secret scan clean |
| G.4 | Project/profile isolation intact | PASS — REAL | NAPI ownership checks unchanged; mistakes/courses changes validation-only |

---

## H. P8 — Code quality (GATE 8)

| Gate | Description | Status | Evidence |
|---|---|---|---|
| H.1 | No debug logging / temporary artifacts committed | PASS — REAL | audit of all diffs; scratch files outside repo; zz-* debug specs removed |
| H.2 | No skipped tests, dead code, or bypass TODOs | PASS — REAL | audit |
| H.3 | Working tree clean after commit | PASS — REAL | `git status` clean; commits `1bc8302` + `3085bac` |

---

## Summary (final)

| Category | Passed | Harness | Env |
|---|---|---|---|
| A. Baseline | 3 | 0 | 0 |
| B. Classification | 3 | 0 | 0 |
| C. App defects | 3 | 0 | 0 |
| D. Spec contracts | 4 | 0 | 0 |
| E. Full E2E | 4 | 0 | 0 |
| F. Regression | 8 | 0 | 0 |
| G. Security | 4 | 0 | 0 |
| H. Quality | 3 | 0 | 0 |
| **Total** | **32** | **0** | **0** |
