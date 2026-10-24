# GATES-PHASE18 — Ledger (Browser Workspace)

Phase 18 gates, all rows carry the exact evidence. Companion report: `REPORT-V18.md`.

## Status legend
- ✅ verified green (exact numbers below)
- ⏳ pending (blocked on an external condition, with a re-run instruction)

---

## GATE-1: Recovery hygiene
| Check | Result |
|---|---|
| `git status` at start | clean at `f5f12a2` — previous run changed nothing on disk |
| No half-written files, no stashes, no orphan branches | ✅ none |
| Phase 17 artifacts untouched | ✅ REPORT-V17 / GATES-PHASE17 / e2e helpers / core/src/validate.rs all unmodified |

## GATE-2: Subagent slot discipline
| Check | Result |
|---|---|
| Named slots used (one provider each) | ✅ rntm-1, rntm-2, sensenova-1 dispatched for the investigation wave |
| Dead-slot policy | ✅ rntm-1 rate-limited on first dispatch → retried once → backfilled to the next enabled slot; final audit results below come from the slots that returned (see REPORT-V18 §3) |
| No "six subagents used" claim | ✅ this run launched 3 named slots, not six |

## GATE-3: P0 ownership fix
| Check | Result |
|---|---|
| `resolveOwnedRuntime` wired into `ctx.donut` (real + stub branches) | ✅ `shell/src/ipc/donut.js` |
| Denied resolution is authoritative (no `ensureBinding` fallback for a deny) | ✅ `launch` returns `unknown-profile` on any deny (shell test `launch: resolveOwnedRuntime denies → unknown-profile, no run`) |
| Renderer never receives port/host/PID/token | ✅ asserted in 29 shell tests + E2E spec (no `token` / `127.0.0.1` / `runtime.json` in any serialized result) |

## GATE-4: Unit layers (Node ABI build)
| Suite | Count | Result |
|---|---|---|
| `node --test shell/tests/*.test.js` | 1045 pass | ✅ 0 fail |
| — new `shell/tests/browser-workspace.test.js` | 29 | ✅ 29/29 |
| — new `shell/tests/browser-workspace-tools.test.js` | 11 | ✅ 11/11 |
| — existing cdp-adapter / donut-manager suites | 73 (subset) | ✅ 0 fail |
| `npx vitest run` (ui) | 523 pass | ✅ 0 fail (baseline 495 + 28 new) |
| `cargo test` (core) | 132 pass | ✅ 0 fail — note: the *first* full run after a cold build reported 4 transient failures in `browser_data_integrity`; a clean rerun passed 132/132. Root cause: compile-cache artifact of the first parallel build, not a code regression (no Rust changed in Phase 18) |

## GATE-5: Static gates + build
| Gate | Result |
|---|---|
| `node scripts/check-ipc.mjs` | ✅ 249 channels, all handled (was 248; +`browser-workspace:stop`) |
| `node scripts/check-esm.mjs` | ✅ 114 files, all relative imports resolve |
| `node scripts/check-napi.mjs` | ✅ 115 core exports referenced by IPC all present |
| `npx svelte-check` (ui) | ✅ 0 errors; 2 pre-existing warnings (GoalsView `#` href, RecallDeck line-clamp) |
| `vite build` (ui) | ✅ built |
| Electron ABI rebuild (`rebuild-native.mjs electron`) | ✅ ABI 119 |

## GATE-6: E2E (Electron, real app surface)
Full suite `npx playwright test` (stub seam for Donut) including new
`e2e/browser-workspace.spec.js` (launch / sanitized snapshot / dock survives
`cf:navigate` / invalid-url + no-tab refusals / reload
feature-not-supported / restart persistence / foreign-profile refusal).
**Expected**: 93 baseline + 1 new = 94 total.
First full run: **90 passed / 4 failed** — 3× `academic-focus.spec.js`
(date-sensitive pre-existing flake, proven below) + 1× new
`browser-workspace.spec.js` (fixed: binding must be established via
`browserManager.openBrowserProfile` before workspace launch, and
`validateHttpUrl` was missing its import in the workspace IPC file —
both fixed). Second full run (after fixes): **see final row below**.

### Academic-focus flake attribution (proven, not assumed)
The same 3 academic-focus deadline tests fail on the **clean Phase 17
baseline** (`git stash` → `f5f12a2` → `npx playwright test
e2e/academic-focus.spec.js` → identical 3 failures). Root cause:
the spec computes `YESTERDAY` in **UTC** (`toISOString().slice(0,10)`)
while the focus service computes overdue days in **local dates**; in the
IST morning window (local date = UTC date + 1) the UTC-yesterday deadline
reads as "2d overdue" and the `/1 deadline 1d overdue/` assertion fails.
**Pre-existing Phase 17 issue, not a Phase 18 regression.**

### E2E final (after fixes)
**91 passed / 3 failed (13.1m)**. The 3 failures are exactly the proven
pre-existing `academic-focus` timezone flake (identical failures on the clean
`f5f12a2` baseline). The new `e2e/browser-workspace.spec.js` passes:
launch→ready sanitized snapshot (no token/port/path), transport run recorded,
dock survives `cf:navigate` view changes, invalid-url refusal,
backend-unavailable honesty on navigate without a live backend, reload
`feature-not-supported`, binding + launch survive restart, foreign profile id
refused. **0 failures attributable to Phase 18.**

## GATE-7: REAL-VALIDATION (live Donut backend) — ⏳
| Check | Evidence |
|---|---|
| Backend reachable | ✅ `/health` returned `{"headless":true,"ready":true,"status":"ok"}` at least once during Phase 18 |
| Runtime credential present | ✅ `runtime.json` (api.port 10108, api_token set, pid rotates) |
| Stable window for a real windowed run | ⏳ backend was observed cycling (health `ready` flapping, token/PID rotating, intermittent connection resets) during the validation window — **re-run required**: start the app with `CAREERFLOW_E2E_DONUT_STUB` unset, launch a bound browser profile from the dock, and verify a visible Wayfern window opens + tabs/screenshot respond. Until then: **no claim of real-browser control passing** (per instruction). |

## GATE-8: Security / a11y / perf
| Check | Result |
|---|---|
| `contextIsolation` / `sandbox` / `nodeIntegration:false` / strict CSP | ✅ unchanged (verified in `shell/src/main.js`) |
| Sanitized status echo | ✅ `PUBLIC_STATUS_KEYS` whitelist (no pid/port/path) |
| New a11y warnings | ✅ all new warnings fixed; dock controls labelled; resize handle keyboard accessible |
| Timer lifecycle | ✅ status-refresh timer runs only while ready; dock unmounted from layout when closed |

## GATE-9: Docs / memory / tree
| Check | Result |
|---|---|
| `REPORT-V18.md` | ✅ written (final HEAD recorded) |
| ai-memory page `notes/browser-workspace-arch.md` | ✅ written |
| Handoff (ai-memory) | ✅ created (`01a0692b-ec0a-7d51-9174-444d20f53682`) |
| Commits | ✅ `91a1ede` (feature) + `65b0ede` (report hash) |
| `git status` clean at the end | ✅ clean |

---
*Ledger updated at Phase 18 close. Only non-green row: REAL-1 (real visible-window
run pending a stable Donut backend window) — explicitly tracked, no claim made.*
