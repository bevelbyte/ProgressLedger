# GATES-PHASE16 — Goal Mode Reliability Closure + Real Recovery Validation

Evidence classification:
- **LIVE** — against the real b.ai provider (env-gated)
- **REAL** — against the real production stack (Rust/NAPI + SQLite + real Electron app)
- **E2E** — against the real Electron app via Playwright
- **REAL-CORE** — real NAPI core + real SQLite, driven by the node:test harness
- **HARNESS** — blocked by an upstream test-runner issue (none remain from Phase 15)
- **ENV** — environment-skipped (no provider key)

---

## A. P1 — Deferred Goal UI tests (GATE 1)

| Gate | Description | Status | Evidence |
|---|---|---|---|
| A.1 | Root cause is test-mock architecture, not vitest upstream | PASS — REAL | Minimal reproduction: trivial component importing the runes store mounts fine; reading `goalsStore.goals` synchronously inside a mock during the component `$effect` crashes the worker; deferring past `await Promise.resolve()` does not. |
| A.2 | Svelte 5 runes track sync `$state` reads during effects | PASS — REAL | Reactive loop: effect reads store → `loadGoals` writes `state.goals` → effect re-fires → stack exhaustion → tinypool "Worker exited unexpectedly". |
| A.3 | Production is unaffected (IPC always async) | PASS — REAL | `window.careerflow.goals.list` is `ipcRenderer.invoke` — a promise; the store is never read synchronously inside an effect body in production. |
| A.4 | Fix is a test-mock change, no production behavior change | PASS — REAL | Mocks now defer store reads past `await Promise.resolve()`; store gained `__testSeed(goals, events)` + `__testSeedAgentSnapshot` (test-only). |
| A.5 | GoalsPanel 12 tests execute and pass | PASS — REAL | `npx vitest run tests/goals-panel.test.js` → 12/12. |
| A.6 | GoalDetailView 7 tests execute and pass | PASS — REAL | `npx vitest run tests/goal-detail.test.js` → 7/7. |
| A.7 | No blanket skips / no fake assertions | PASS — REAL | All assertions are real; `describe.skip`/`test.skip` absent; tests committed unchanged except mock-async + test-seed helper. |
| A.8 | Required coverage map | PASS — REAL | dashboard render, empty state, create, list, start, running, cancellation, completed, failed, detail, progress display, refresh/reconcile — all covered. |

---

## B. P2 — Real Electron validation (GATE 2)

| Gate | Description | Status | Evidence |
|---|---|---|---|
| B.1 | Electron boots with the production build | PASS — E2E | `npx electron .` stays alive; DB opens (schema 22); window loads `ui/dist/index.html`; `window.careerflow` present. |
| B.2 | Blocker #1: nested `export` in `project-mode.js` | PASS — REAL | `export function _seedApprovalQueueForTests` was inside `register()` (lines 89–592). acorn: `'export' may only appear at the top level` at line 490. Fixed by hoisting approval-queue state + helper to module scope. |
| B.3 | Blocker #2: missing `async` on `project:create-project` | PASS — REAL | `await` in a non-async arrow → SyntaxError. Fixed. |
| B.4 | Blocker #3: better-sqlite3 ABI mismatch | PASS — REAL | v13 (Node ≥22, ABI 137) segfaults under Electron 28's Node 18.18.2 (ABI 119). Pinned `^11.10.0` + `scripts/rebuild-native.mjs` for per-runtime rebuilds. |
| B.5 | Goal lifecycle through the real app | PASS — E2E | `e2e/goals-mode.spec.js`: create → start → linked agent → completed → timeline (created, agent_linked) → list shows completed. |
| B.6 | Cancel path through the real app | PASS — E2E | `e2e/goals-mode.spec.js`: start → cancel → `cancelled`, never `completed`. |
| B.7 | Goals reachable from real navigation | PASS — E2E | `e2e/goals-navigation.spec.js`: sidebar "Goals" → project picker → UI form creates a goal → appears in list. |
| B.8 | Pre-existing specs now run (latent bugs fixed) | PASS — E2E | `project-mode-lifecycle.spec.js` + `smoke.spec.js` pass after fixing: sandboxed renderer has no `process`; real NAPI returns plain ids; void returns; positional preload signatures. |
| B.9 | Remaining E2E failures classified honestly | PASS — REAL | 25 failures in academic-focus/focus-session/focus-lifecycle/deadline/career/backup specs are pre-existing latent test bugs (outdated IPC arg shapes), never runnable before this phase. Not Goal Mode regressions; tracked for Phase 17. |

---

## C. P3 — Actual process-restart recovery (GATE 3)

| Gate | Description | Status | Evidence |
|---|---|---|---|
| C.1 | Persisted state survives a real hard crash | PASS — E2E | SIGKILL mid-run (`verifying` held by 30s `test_command`); relaunch against same `userDataDir`; goal/agent/run-state rows readable. |
| C.2 | Recovery sweep discovers the candidate | PASS — E2E | `goal:recovery-sweep` after restart returns the run-state row. |
| C.3 | No duplicate agent after restart | PASS — E2E | `sweep.resumable.length <= 1`; `pmListAgents` shows exactly one row (P5.1). |
| C.4 | Goal never faked as completed by the crash | PASS — E2E | Asserted goal ∈ {running, verifying, failed, cancelled}; the verification gate could not have passed (process died before the 30s command finished). |
| C.5 | Recovery is idempotent across restarts | PASS — E2E | Second sweep returns the same `resumable.length`. |
| C.6 | Crash before execution begins | PASS — REAL-CORE | Goal in `created`/`starting` with no run-state row: sweep is a no-op (P5.6/P7.8). |
| C.7 | Crash during verification | PASS — E2E | Covered by C.1–C.5 (agent held in `verifying` at kill time). |
| C.8 | Crash after agent terminal but before goal reconciliation | PASS — REAL-CORE | `terminal-cleanup` classification + goal reconciled to agent's terminal state (P5.3, P6.4). |

---

## D. P4 — Resume semantics (GATE 4)

| Gate | Description | Status | Evidence |
|---|---|---|---|
| D.1 | resumeAgent refuses terminal agents | PASS — REAL-CORE | P4.1 (`terminal-state`) + P4.3 (`cancelled`). |
| D.2 | resumeAgent refuses already-running agents | PASS — REAL-CORE | P4.2 (never a duplicate run). |
| D.3 | goal:resume IPC calls resumeAgent, not a new engine | PASS — REAL-CORE | P4.4; the IPC delegates to the existing `resumeAgent`. |
| D.4 | Resume uses the existing agent loop | PASS — REAL | `resumeAgent` → `startAgent({ isResume: true })` — no second engine. |
| D.5 | Completed steps are not replayed | PASS — REAL | The loop parses persisted `plan_json`; `pickNextReadyBatch` only selects pending steps. |
| D.6 | UI is truthful: Resume button only for `safe-resume` rows | PASS — REAL | `GoalsView.svelte` renders Resume for `safe-resume`, Open otherwise. |
| D.7 | Cancellation respected (no resurrection) | PASS — REAL-CORE | P9.2/P9.3; cancelled goal cannot be transitioned to completed. |

---

## E. P5 — Duplicate-execution safety (GATE 5)

| Gate | Description | Status | Evidence |
|---|---|---|---|
| E.1 | Two concurrent sweeps do not double-process | PASS — REAL-CORE | P5.1: goal completed exactly once; one agent row. |
| E.2 | Recovery + manual resume race → one owner | PASS — REAL-CORE | P5.2: `startAgent` either wins or refuses `already-running`. |
| E.3 | Stale run-state + terminal agent → cleanup, no resurrection | PASS — REAL-CORE | P5.3: `terminal-cleanup`; goal failed. |
| E.4 | Cancellation after restart never resurrected | PASS — REAL-CORE | P5.4. |
| E.5 | run-state without agent → safe | PASS — REAL-CORE | P5.5: sweep ok; row never `safe-resume`. |
| E.6 | agent without run-state → no phantom row | PASS — REAL-CORE | P5.6. |
| E.7 | Parent goal with children during recovery | PASS — REAL-CORE | Child rows are independent `pm_agents` rows; sweep reconciles by linked agent only; no child duplication (covered by E.1 + P7 matrix). |

---

## F. P6 — Recovery state machine (GATE 6)

| Gate | Description | Status | Evidence |
|---|---|---|---|
| F.1 | safe-resume requires phase == agent state | PASS — REAL-CORE | P6.1 (and idempotent across two sweeps). |
| F.2 | requires-user on phase mismatch | PASS — REAL-CORE | P6.2. |
| F.3 | stale rows reported separately | PASS — REAL-CORE | P6.3: in `stale[]`, never in `resumable`. |
| F.4 | terminal-cleanup idempotent | PASS — REAL-CORE | P6.4. |

---

## G. P7 — Goal ↔ Agent reconciliation matrix (GATE 7)

All PASS — REAL-CORE (`goals-reliability.test.js` P7.1–P7.9):

| Combination | Outcome |
|---|---|
| running + completed | goal → completed |
| running + failed | goal → failed + reason |
| running + cancelled | goal → cancelled |
| completed + failed (mutated) | stays completed (terminal wins) |
| failed + completed (mutated) | stays failed |
| cancelled + completed (mutated) | stays cancelled |
| created + terminal agent | created or completed; no invented failure |
| starting, no linked agent | goal → failed, `no-agent-created` |
| cross-profile sweep | cannot touch the goal |

---

## H. P8 — Truthful progress (GATE 8)

PASS — REAL (`ui/tests/goals-progress.test.js`, 20 tests):

- 0-step plan → total 0, not 100%, percentReliable false
- 1-step plan → 0/100
- partial plan → exact percent
- all steps done but agent verifying → phase `verifying` (NOT a finished goal)
- verification complete → `completed` + 100%
- failed step → percent counts done only, failed visible
- cancelled → truthful percent (50%), not fake 100
- child delegation reflected via parent plan

Never invented: percent derived only from `pm_agents.state` + `plan_json`.

---

## I. P9 — Completion contract (GATE 9)

PASS — REAL-CORE + REAL:

| Scenario | Outcome |
|---|---|
| Model says "done" while agent running | goal NOT completed (Phase 15 ADVERSARIAL-1) |
| Agent completed but verification failed | code_change goal NOT completed (ADVERSARIAL-2) |
| Verification passes but agent failed | NOT completed (ADVERSARIAL-3) |
| Agent cancelled | goal cancelled |
| Goal already completed | cannot be reverted (P7.4) |
| Goal cancelled | stale completion cannot resurrect (P9.2) |
| Duplicate completion | idempotent; `completed_at` preserved (P9.1) |
| Crash between agent completion and goal completion | reconciliation produces correct final state (P7.1) |

---

## J. P10 — Security (GATE 10)

PASS — REAL-CORE (`goals-security.test.js`, 12 tests) + static:

- Cross-profile goal read / transition / agent-link / recovery rejected
- Negative ids rejected; zero ids → NOT_OWNED
- Malformed goal state / run-state phase / state / recovery rejected
- Run-state rows profile-isolated
- Goal rows + events never contain provider secrets
- Oversized objectives rejected
- `check:ipc` 239 channels OK; `check:napi` 115 OK; `check:esm` 111 OK; CSP untouched

---

## K. P11 — Regression (GATE 11)

| Suite | Result |
|---|---|
| Shell | **1027 / 1005 pass / 0 fail / 22 env-skips** (Phase 15: 989/967) |
| UI | **493 / 493** (Phase 15: 486) |
| Rust | **132 / 0 fail** (unchanged) |
| Static IPC / NAPI / ESM | 239 / 115 / 111, all OK |
| Production build | green |

Zero regressions in any Phase 11–15 test or build.

---

## L. P12 — Live provider acceptance (GATE 12)

- **ENV** — `CAREERFLOW_PROVIDER_KEY` not set. `shell/tests/goals-live.test.js` (Phase 14) is env-skipped (3 of the 22 skips). No live success claimed. The live test file is ready and requires only the env var.

---

## M. P14 — Code quality (GATE 13)

- Debug logging removed from `goals-recovery.test.js` and recovery.js
- Temp files removed; `.gitignore` updated (`build/`, native binary, target/)
- `scripts/rebuild-native.mjs` added (documented dual-ABI workflow)
- No test-only production behavior (only `__test*` named helpers)
- No hidden/deleted/skipped tests (the 12+7 component tests now run)
- E2E harness unblocked; remaining failures classified honestly

---

## Summary

| Category | Passed | Harness | Env |
|---|---|---|---|
| A. P1 Goal UI tests | 8 | 0 | 0 |
| B. P2 Real Electron | 9 | 0 | 0 |
| C. P3 Restart recovery | 8 | 0 | 0 |
| D. P4 Resume | 7 | 0 | 0 |
| E. P5 Duplicate safety | 7 | 0 | 0 |
| F. P6 Recovery machine | 4 | 0 | 0 |
| G. P7 Reconciliation | 9 | 0 | 0 |
| H. P8 Progress | 1 | 0 | 0 |
| I. P9 Completion | 8 | 0 | 0 |
| J. P10 Security | 1 | 0 | 0 |
| K. P11 Regression | 1 | 0 | 0 |
| L. P12 Live | 0 | 0 | 1 |
| M. P14 Quality | 1 | 0 | 0 |
| **Total** | **64** | **0** | **1** |

**No remaining harness blockers. Goal Mode is validated through the real Electron app, survives a real process restart, resumes truthfully, cannot duplicate agents, reconciles every goal/agent mismatch deterministically, derives progress from persisted state, and completes only on real execution + verification.**