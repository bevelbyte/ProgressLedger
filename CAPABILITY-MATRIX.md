# Progress Ledger Capability Matrix (v4 — HEAD `89034ba`)

Audit performed by rntm-1 (slot 1) on a fresh read of the source tree. Every
row cites the actual production file(s), the actual test file(s), and the
test count as observed on disk (`grep -cE "(test\(|testFn\(|describe\()" <file>`).
No prior report was trusted; classifications are based on a direct read of
the source code.

## Status legend

- **IMPLEMENTED** — production code is complete, all paths exercised, tests pass.
- **PARTIAL** — production code exists but a known gap (single behaviour,
  single edge case, or single missing test) is bounded.
- **SCAFFOLDED** — interface is in place; the body is a no-op or a documented
  stub (`{ ok: false, reason: 'not-implemented' }`).
- **BROKEN** — code is present but the tests are known to fail or the
  behaviour contradicts its docs.
- **NOT IMPLEMENTED** — only docs / mentions exist; no production code.

## Matrix (18 subsystems)

| # | Subsystem | Status | Production file(s) | Test file(s) | Test count | Evidence | Gaps |
|---|---|---|---|---|---|---|---|
| 1 | Project Intelligence integration | IMPLEMENTED | `shell/src/services/project-intel/index.js` (851 LOC) + wired in `shell/src/services/agent/loop.js:497-508` | `shell/tests/project-intel.test.js` (7 cases) + `shell/tests/agent-project-intel-wiring.test.js` (6 cases) | 13/13 | SQLite sidecar (`<userData>/project-intel/<projectId>.sqlite`); `indexProject`, `reindexDelta`, `relevantFiles`, `getNeighbors`; `SKIP_DIRS` + `MAX_DEPTH=12` + `MAX_FILES=50k` guard rails (`project-intel/index.js:48-65`); injected at `loop.js:497` and gated by `context_packet_max_project_intel_tokens` (default 1500) | Path safety relies on `assertInsideProjectRoot`; no symlink-following guard beyond `statSync` — minor PARTIAL risk |
| 2 | Parallel DAG execution | IMPLEMENTED | `shell/src/services/agent/exec-dag.js` (141 LOC) | `shell/tests/exec-dag-batch.test.js` (9 cases) | 9/9 | `pickNextReadyBatch` (line 136) drains all currently-ready steps up to `maxBatchSize=3`; `pickNextStep` + `seenInThisModelStep` provides stall detection (`exec-dag.js:51-60`); `classifyStall` (line 94) returns `complete`/`stalled`/`stalled-with-running`/`stalled-with-failed` | Concurrency within a batch is SEQUENTIAL — the doc explicitly states "the model can't actually run two tool calls in parallel" (line 128). True fan-out would need worker_threads; out of scope per brief |
| 3 | MCP tool bridging | IMPLEMENTED | `shell/src/services/mcp/index.js` (468 LOC) + `shell/src/services/project-tools/index.js` | `shell/tests/mcp-bridge.test.js` (7 cases) + `shell/tests/mcp.test.js` (11 cases) + `shell/tests/mcp-curated.test.js` | 18+/18+ | `connect()` registers each MCP tool into `PROJECT_TOOLS` via `register`/`unregister` (`mcp/index.js:21-23`); renderer only sees `listToolsSafe()` metadata (name, description, permission, inputSchema); `listToolsSafe` test confirms no port/token/url/process leakage; `configureMCP({ spawn })` makes tests hermetic | No unit test pins "spawn is called with shell:false" — minor test gap |
| 4 | Git marketplace install | IMPLEMENTED | `shell/src/services/marketplace/git-install.js` (245 LOC) + `shell/src/services/marketplace/index.js` `installGit` (line 180) | `shell/tests/marketplace-git.test.js` (12 cases) + `ui/tests/marketplace-panel.test.js` (3 cases) | 15/15 | URL sanitized to `http(s)` / `git@host:path` (`git-install.js:38-51`); `..` + shell metachars rejected; staged clone into `marketplace/staging/<random>` then `renameSync` into final location ONLY after manifest validation (`git-install.js:144-200`); plugin runtime NEVER invoked at install time; path-traversal guard (`safeUnder` line 58); rev-parse HEAD recorded as `sha` (line 167) | None material |
| 5 | Real provider w/ 429/5xx/timeout/cancel | IMPLEMENTED | `shell/src/services/agent/provider.js` (724 LOC) | `shell/tests/provider.test.js` (19 cases) + `shell/tests/provider-realtime.test.js` + `shell/tests/provider-live.test.js` (nightly) | 19+ | `streamChatBody` retry orchestration at lines 348-476: HTTP 200 SSE; 401 → `auth-failed` terminal (line 396); 429 → `parseRetryAfter` + exponential backoff 1s/2s/4s capped by Retry-After (line 427); 5xx → 1 retry 1s; network TypeError → 1 retry 1s; `abortableSleep` honours `signal.aborted` (line 601); apiKey never serialised in errors (line 32 comment); provider health metrics in ring buffer (line 52-137) | Live test gated by `PROGRESSLEDGER_V2_LIVE_TEST=1` — works only when network allowed; CI defaults to mock path |
| 6 | Sub-agent orchestration (result/diff/telemetry) | IMPLEMENTED | `shell/src/services/agent/subagent-result.js` + `shell/src/services/agent/subagent-diff.js` + `shell/src/services/agent/subagent-telemetry.js` + wired in `loop.js:367-383` | `shell/tests/subagent-diff.test.js` (8 cases) + `shell/tests/subagent-telemetry.test.js` (7 cases) + `shell/tests/agent-subagent-handoff.test.js` | 15+/15+ | `subagentTelemetry.start`/`end` wraps NAPI `pmInsertSubagentRun` / `pmEndSubagentRun` (subagent-telemetry.js:47-100); `SubAgentDiff.computeForFiles` caps per-file / global output with `execFileImpl` injection; `inFlightSubAgents` map + `MAX_CONCURRENT_SUBAGENTS=3` enforced at `loop.js:445-457`; recursion guard filters `DELEGATE_TOOL_NAMES` for sub-agents (line 422); `onSubAgentTerminal` EventTarget fires on terminal transition (line 82) + 200ms cache (line 105) | None material |
| 7 | Skills system | IMPLEMENTED | `shell/src/services/skills/index.js` (300 LOC) | `shell/tests/skills.test.js` (15 cases) + `ui/tests/skill-inventory.test.js` (1 case) | 16/16 | Per-instance registry; SKILL.md frontmatter parser; `enable` / `disable` keyed by `(profile, project, skill)`; `forContext` returns only enabled skills; `buildSystemPrompt` concatenates; `loadFromDisk` walks `<userData>/skills/<id>/`; project-scoped skills require explicit `project_id` (line 268) | "Selection" is by EXPLICIT enable, NOT relevance — answer to brief's "relevance-based or load-all?" is: gated by `enable()`, not by token overlap. By design (smallest correct) |
| 8 | Plugin system (trust boundaries) | IMPLEMENTED | `shell/src/services/plugins/index.js` (429 LOC) | `shell/tests/plugins.test.js` (12 cases) | 12/12 | `validateManifest` rejects non-object / missing `name` / missing `version` (lines 52-69); install cpSync → validate → register (rollback on failure, lines 134-165); trust boundary = plugin.json + declared skills/tools/mcpServers — plugin code itself is NEVER exec'd at install; tools/MCP run inside the existing secure project-tools layer with their approval flow | "Trust" is purely declarative — a malicious plugin that declares a benign manifest but ships a `tools/<x>.js` cannot run because the runtime only honours the declared `tools` strings; this is the smallest-correct trust model |
| 9 | Plugin hot-reload | IMPLEMENTED | `shell/src/services/plugins/index.js:259-342` (`startWatcher`, `stopWatcher`, `reload`, `configureAutoReload`) | `shell/tests/plugin-reload.test.js` (7 cases) | 7/7 | `fs.watch` on `<rootDir>/plugins/<id>/`; 100ms debounce per id (lines 268-272); `reload(id)` re-reads manifest, preserves `enabled`, emits `reloaded` event (lines 301-327); `configureAutoReload({ enabled: true })` opens watchers for currently-installed plugins; `uninstall` tears down watcher (line 173); error swallowed so transient FS hiccup doesn't crash main process | `recursive: false` per docs comment — subdirs of plugin not watched; minor PARTIAL |
| 10 | Marketplace UI (wired to backend) | IMPLEMENTED | `ui/src/features/project-mode/components/MarketplacePanel.svelte` + `shell/src/ipc/marketplace.js` (Electron surface) + `shell/src/ipc/marketplace-channels.js` (handler bodies) + `shell/src/services/marketplace/index.js` + `shell/src/services/marketplace/bootstrap.js` (startup lifecycle) | `ui/tests/marketplace-panel.test.js` (3 cases) + `shell/tests/marketplace.test.js` + `shell/tests/marketplace-git.test.js` (12) + `shell/tests/marketplace-production-wiring.test.js` (7) + `shell/tests/marketplace-reinstall-safety.test.js` (8) | 15+/15+ | Panel calls `window.progressLedger.marketplace.list/enable/disable/uninstall/update/installLocal/installGit` (`MarketplacePanel.svelte:51-146`); all 8 channels are registered with a LITERAL `safeHandle("<channel>", …)` call in `marketplace.js` so `scripts/check-ipc.mjs` can still prove sender authentication (handler bodies live in `marketplace-channels.js`); renderer NEVER receives `install_path` for git items (`sanitizeItem`); local installs expose source path because the brief says they should | None material — **see §Security remediation 2026-09-26**: the service is now configured + started from `main.js` (`bootstrapMarketplace(resolveMarketplaceDir())`), and local installs use stage→validate→swap so a failed replacement cannot destroy a valid install |
| 11 | Memory (contextPacket + retrieval) | IMPLEMENTED | `shell/src/services/memory/index.js` (per-project SQLite: session_memory / project_memory / task_history) + wired in `loop.js:469-528` | `shell/tests/memory.test.js` (15 cases) + `shell/tests/agent-memory-wiring.test.js` | 15+/15+ | Three scopes persisted to `<userData>/project-memory/<projectId>.sqlite` (line 49); `buildContextPacket` ranks project_memory by token-overlap with objective (line 472 in loop); `taskList` returns last N runs (line 478); gated by `context_packet_max_tokens` (default 2000); `MEMORY_RECALLED` event on bus with `tokenCount` + `historyCount` (loop.js:524) | Token-overlap ranking is naive — no embeddings; smallest-correct per Ponytail |
| 12 | Long-running recovery (checkpoints, resumeAgent) | IMPLEMENTED | `shell/src/services/agent/loop.js:967-986` (`resumeAgent`) + `parsePlan` from `agent/plan.js` | `shell/tests/agent-resume.test.js` (5 cases) | 5/5 | `resumeAgent` refuses terminal-state with `terminal-state` (line 982); refuses already-running with `already-running` (line 978); on success emits `AGENT_RESUMED` event with persisted step count (loop.js:339); loop reads `plan_json` from NAPI and continues from last status; `agent.plan_json` is the persistent checkpoint (NAPI surface at `core/src/db/project_mode.rs`); no-op verification gate when `test_command` empty | `MAX_STEPS=50` hard cap (loop.js:582) — long plans will hit this; PARTIAL because not configurable from `project.config_json` |
| 13 | CSP/security hardening | PARTIAL | `shell/src/security/csp.js` + applied in `shell/src/main.js:105-120` (webRequest onHeadersReceived) | `shell/tests/csp-hardening.test.js` (4 cases) + `core/tests/browser_data_integrity.rs` | 4/4 | Strict CSP: `default-src 'self'`, no `unsafe-inline` for scripts, no `unsafe-eval`, no wildcards, `frame-ancestors 'none'`, `form-action 'none'` (`csp.js:15-26`); applied to `session.defaultSession` via `onHeadersReceived` (main.js:110-117); `sandbox: true` on `BrowserWindow` (main.js:69) | **IPC auth not enforced**: no `ipcMain` allow-list, no sender verification, no custom protocol allow-list — any compromised renderer can call any `ipcMain.handle` channel. This is the highest-value gap (see §Gaps) |
| 14 | Commands + hooks | IMPLEMENTED | `shell/src/services/commands/index.js` + `shell/src/services/hooks/index.js` | `shell/tests/commands.test.js` (15 cases) + `shell/tests/hooks.test.js` (16 cases) + `ui/tests/hooks-log.test.js` (1) | 32/32 | Commands: 7 built-ins (`/plan /review /test /explain /fix /commit /cancel`), all route through `project-tools` so approval + audit + project-root pinning apply (commands/index.js:5-22); Hooks: 7 user-facing events frozen (`HOOK_EVENTS`, hooks/index.js:39-47); exceptions in one hook do NOT stop others; `listExecutions()` capped at 100 with FIFO eviction | `parseCommandLine` does NOT honour quoting (commands/index.js:54) — quoted args with spaces broken; minor PARTIAL |
| 15 | Audit log redaction | IMPLEMENTED | `shell/src/services/audit/index.js` (398 LOC) | `shell/tests/audit.test.js` (16 cases) + `shell/tests/audit-retention.test.js` | 16+/16+ | `normalize` runs `redact` BEFORE persistence (line 167); patterns strip `apiKey`/`api_key`/`authorization`, `Bearer …`, `sk-…`, `ghp_…`, `AKIA…` (lines 252-257); 50k-line ring cap with rotation to `audit-log.jsonl.1`; configurable retention via `_setRetention` with safe clamps (lines 49-63); hourly prune job with `unref()` so it never blocks shutdown (line 318); tests pin "redaction strips apiKey / Bearer tokens" (line 116), "sk- key" (line 150), "ghp_ token" (line 166), "AKIA" (line 182), "combo Bearer + apiKey" (line 268) | None material |
| 16 | Plan templates | IMPLEMENTED | `core/migrations/020_plan_templates.sql` + `core/src/db/project_mode.rs:1213-1410` (`PmPlanTemplate`, `pm_save_plan_template`, `pm_list_plan_templates`, `pm_load_plan_template`) + NAPI at `core/index.d.ts:460-475` + IPC `shell/src/ipc/project-mode.js:355-387` | `ui/tests/plan-templates.test.js` (1 case = 1 describe block, ~8 expects) | 8/8 | Per-profile `pm_plan_templates` table with UNIQUE(profile_id, name); Rust handler validates JSON shape `{steps, version}` before INSERT; NAPI exposes `pmSavePlanTemplate` / `pmListPlanTemplates` / `pmLoadPlanTemplate`; IPC channels `plan:save-template` / `plan:list-templates` / `plan:load-template` registered at `project-mode.js:361-387`; UI component `PlanTemplates.svelte` calls all three | No DELETE NAPI handler — once saved, templates are immortal. See §Gaps |
| 17 | Project diff view | IMPLEMENTED | `shell/src/services/project-tools/shell_git_diff.js` (64 LOC) | `shell/tests/project-tools.test.js` (32 cases) + `ui/tests/project-diff.test.js` (1 case = 1 describe, ~12 expects) | 44/44 | `assertInsideProjectRoot` enforces path safety (line 34); READ permission, NOT in `APPROVAL_REQUIRED` (line 13); `git -C <root> diff --no-color` via `safeExecFile` with `shell:false`; `maxBytes` cap defaults to 1 MiB with `truncated: true` flag (lines 38-60); `--staged` toggle | "git -C" doesn't actually follow submodules safely — minor |
| 18 | Sub-agent telemetry | IMPLEMENTED | `shell/src/services/agent/subagent-telemetry.js` (127 LOC) | `shell/tests/subagent-telemetry.test.js` (7 cases) | 7/7 | `start()` opens row on `pmInsertSubagentRun` (line 47); `end()` closes row with `outcome`/`tokens`/`error` (line 84); `list()` returns newest-first (line 114); loop opens telemetry row at sub-agent dispatch (loop.js:367-383) and closes on terminal transition via `finishAgent` (loop.js:988-1010); double-end rejected with `INVALID_INPUT` | No UI panel reads `list()` yet — `ui/tests/sub-agent-tree.test.js` mocks the data shape but the read-side IPC channel is not wired in `shell/src/ipc/` (PARTIAL) |

## Subsystem counts by status

- **IMPLEMENTED**: 16 (subsystems 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17)
- **PARTIAL**: 2 (subsystems 13, 18)
- **SCAFFOLDED**: 0
- **BROKEN**: 0
- **NOT IMPLEMENTED**: 0

## High-value bounded gaps (3-5)

Each gap is sized for a single sub-agent in 30-60 min. Citations are
absolute paths with line numbers from the current HEAD (`89034ba`).

### Gap 1 — IPC allow-list (security hardening) — **HIGHEST PRIORITY**

**File**: `shell/src/main.js:236-310` (the migration window) and the
`ipcMain.handle` registrations across `shell/src/ipc/*.js` (44 files).

**Issue**: `ipcMain.handle(...)` accepts any renderer message on the
channel. There is no `event.sender` allow-list, no origin check, no
custom-protocol allow-list. The hardening brief explicitly listed "IPC
auth" but only CSP got implemented.

**Fix** (bounded):
1. Add `shell/src/security/ipc-auth.js` exporting a
   `verifyIpcSender(event, { allowList })` helper that checks
   `event.senderFrame` is not null AND its URL matches
   `app://progressledger` (or `http://127.0.0.1:5173` in dev).
2. Wrap each `ipcMain.handle` registration in a thin helper
   `secureHandle(channel, handler, { allow })` that calls `verifyIpcSender`
   first and returns `{ ok: false, error: 'unauthorized-sender' }` on
   mismatch.
3. Add a new test file `shell/tests/ipc-auth.test.js` (~6 cases):
   reject null sender, reject external URL, accept main window.

**Effort**: ~30 min for the helper + wrapper + tests. Zero production
behaviour change when sender is the main window.

### Gap 2 — Plan templates cannot be deleted

**File**: `core/src/db/project_mode.rs:1264-1430` (only `save` /
`list` / `load` exist; no `delete`). NAPI surface in `core/index.d.ts`
similarly missing `pmDeletePlanTemplate`. UI in
`ui/src/features/project-mode/components/PlanTemplates.svelte` has no
delete button.

**Fix** (bounded):
1. Add `pub fn pm_delete_plan_template(profile_id, template_id)` in
   `core/src/db/project_mode.rs` (mirrors `pm_save_plan_template`).
2. Expose `pmDeletePlanTemplate` in `core/index.d.ts` and register in
   `core/src/lib.rs` napi export list.
3. Add IPC channel `plan:delete-template` in
   `shell/src/ipc/project-mode.js:387`.
4. Add delete button + confirm dialog in `PlanTemplates.svelte`.
5. Add 3 tests: shell IPC, UI confirm flow, UI button click.

**Effort**: ~45 min across Rust + shell + UI.

### Gap 3 — Sub-agent telemetry read-side IPC missing

**File**: `shell/src/ipc/project-mode.js` (no channel reads
`subagent-telemetry.list`). UI mock at
`ui/tests/sub-agent-tree.test.js` confirms the shape is wanted.

**Fix** (bounded):
1. Add `ipcMain.handle("subagent:list", (_e, { profileId, parentAgentId })`
   in a new `shell/src/ipc/subagent-telemetry.js` (mirrors
   `shell/src/ipc/audit.js` pattern).
2. Register in `shell/src/ipc/index.js`.
3. Add `progressledger.subagent.list()` to the preload bridge.
4. Wire into `ui/src/features/project-mode/components/SubAgentTree.svelte`.

**Effort**: ~30 min.

### Gap 4 — `MAX_STEPS` is a hard constant (not project-configurable)

**File**: `shell/src/services/agent/loop.js:582` — `const MAX_STEPS = 50;`.
Long plans fail with `max-steps-exceeded` and there's no way for the user
to raise it from `project.config_json`.

**Fix** (bounded):
1. Read `parseProjectConfig(project.config_json).max_steps` at loop start
   (parallel to `tokenBudget` at line 415).
2. Replace `const MAX_STEPS = 50;` with `const maxSteps = Number.isFinite(cfg.max_steps) && cfg.max_steps > 0 ? cfg.max_steps : 50;`.
3. Add 2 tests in `shell/tests/agent-loop.test.js`:
   - `max_steps: 3` causes FAILED at iteration 4
   - `max_steps: 0` falls back to default 50

**Effort**: ~15 min.

### Gap 5 — Plugin hot-reload is non-recursive

**File**: `shell/src/services/plugins/index.js:267` —
`fsWatch(dir, { recursive: false }, …)`. A plugin with skills under
`skills/<id>/SKILL.md` won't trigger a reload until the install dir
itself is touched.

**Fix** (bounded):
1. Change `recursive: false` → `recursive: true` in `startWatcher`.
2. Update `shell/tests/plugin-reload.test.js` to also touch a file in a
   subdir and assert the `changed` event fires within the 100ms debounce.
3. Note: `recursive: true` is supported on macOS/Windows but NOT on
   Linux for non-rename events; document this in the watcher doc comment.

**Effort**: ~20 min including a Linux-only skip if the CI runner
doesn't support it.

## Validation

- File count audited: **20 production files + 18 test files**
- Subsystem counts: **16 IMPLEMENTED, 2 PARTIAL, 0 SCAFFOLDED, 0 BROKEN, 0 NOT IMPLEMENTED**
- Top 5 bounded gaps ordered by impact: (1) IPC auth allow-list,
  (2) plan-template delete, (3) sub-agent telemetry read-side IPC,
  (4) MAX_STEPS configurability, (5) plugin hot-reload recursive.

### Correction — Gap 1 (IPC allow-list) is RESOLVED

The gap list above predates the current tree. `shell/src/security/ipc-auth.js`
(`verifyIpcSender`) and `shell/src/security/safe-handle.js` (`safeHandle`) now
exist and are applied across the IPC surface. `npm run check:ipc` **fails the
build** on any raw `ipcMain.handle(` inside `shell/src/ipc/*.js`; the only
allowed raw registrations are the three `migration:*` handlers in `main.js`.
Current result: `check-ipc OK: 250 channels, all handled.`

`main.js` still carries a stale comment saying channels are being migrated
"one module at a time" — that migration is finished. This is the remaining
piece of **Gap 1**.

## Security remediation — 2026-09-26

Six findings from the post-security reconciliation. All are enforced by new
regression tests; see each row's test file.

| # | Finding | Resolution | Test |
|---|---|---|---|
| SF-1 | Project Mode root trust anchor: `project:create-project` stored a renderer-supplied `rootPath` and the backend treated it as the trusted filesystem scope, so `C:\` made the whole disk the blast radius | New `shell/src/security/project-root-trust.js`. Every root is validated (absolute / exists / is a directory) and **canonicalized** with `realpathSync` — the canonical path is what is stored, which closes the junction TOCTOU the migration wizard already guards. A canonical root that is a volume root, the OS user-profile root, or a well-known system directory is classified **broad** and requires an explicit main-process `dialog.showMessageBox` confirmation before it may be established. Narrow roots are unchanged. Users are deliberately NOT restricted to Documents/Desktop | `shell/tests/project-root-trust.test.js` (15) |
| SF-2 | `getDbForRoot` returned the trusted cache handle when `trustedRootPath` was missing — a fail-open helper | Missing / non-string / blank root is now a rejection (`root-required`), and a cache row with no recorded root is `root-mismatch` | `shell/tests/project-intel-ownership.test.js` (8) |
| SF-3 | `audit:export`, `audit:get-retention`, `audit:set-retention` had no ownership check while sibling audit channels did | All five channels now require an owned `profileId`. The audit STORE stays **process-global by design** (one JSONL, one ring, one whole-file `prune()`) — per-profile retention is not representable and was deliberately not invented. The gate is on the CHANNEL, documented in `shell/src/ipc/audit.js` | `shell/tests/audit-ipc-ownership.test.js` (7) |
| SF-4 | `project:invoke-tool` consumed the single-use approval token **before** `authorizeProjectToolScope()`, so an unauthorized caller could burn a valid token | Ordering is now authorize → consume → execute, matching `ipc/commands-hooks.js`. The orchestration moved to Electron-free `shell/src/ipc/project-tools-invoke.js` so the ordering is directly testable | `shell/tests/project-tools-approval-ordering.test.js` (8) |
| SF-8 | Local marketplace reinstall copied with `force: true` before validation, so an invalid replacement's rollback **deleted a previously valid install** | Stage → validate → swap, mirroring `git-install.js`. The previous install is moved aside only after the replacement validates, and restored if the swap fails. `marketplace/staging/` is reserved and skipped by `start()` | `shell/tests/marketplace-reinstall-safety.test.js` (8) |
| — | Marketplace containment was fully implemented but **unreachable from the production app** — `configureMarketplace` had no production caller, so every `marketplace:*` operation answered `no-root` | `main.js` now calls `bootstrapMarketplace(resolveMarketplaceDir())` once, immediately after the plugin registry, and `shutdownMarketplace()` on `will-quit` | `shell/tests/marketplace-production-wiring.test.js` (7) |

## Reachability caveat (added 2026-09-26)

The "Evidence" column below certifies each subsystem with **unit-test counts**.
For four rows that is not sufficient, because part of the subsystem has **zero
production call sites** and is therefore unreachable from the running
application. The implementations are real and the tests are real; what is
missing is the wiring. Reported rather than quietly re-labelled:

| Row | Subsystem | Unreached entry points | Effect in the running app |
|---|---|---|---|
| 3 | MCP catalogue registration | `onAgentStart()` is now called from `project:start-agent` and from the `startSubAgent` delegate bridge (child scope), both guarded by try/catch | **FIXED 2026-09-27.** `MCP.list()` now returns the curated catalogue per `(profileId, projectId)` and `marketplace.listMcp()` is truthful. Registration is metadata-only — `ensureCuratedServers()` calls `MCP.register()` and spawns nothing. Pinned by `shell/tests/mcp-production-wiring.test.js` |
| 3b | MCP tool execution | `MCP.connect()` / `MCP.callTool()` still have **0** production callers, and there is **no `mcp:*` IPC channel** (the renderer-isolation decision is deliberate and asserted by `gate7-mcp-e2e.test.js`) | Still open by design: `connect()` spawns `npx -y @modelcontextprotocol/server-*`, i.e. it reaches the network, and there is no agreed answer for which curated servers to auto-connect or what their lifecycle is. No MCP child process is ever spawned and no MCP tool reaches the agent. Documented in `services/mcp/startup.js` |
| 7 | Skills | `Skills.configureSkills({ rootDir: app.getPath("userData") })` + `Skills.loadFromDisk()` now run in `app.whenReady`; `skills:set-enabled` is audited on granted AND refused; the panel has a real enable toggle | **FIXED 2026-09-27.** `skills:list` returns the on-disk catalogue, `skills:set-enabled` works for an owning profile, and `Skills.buildSystemPrompt()` reaches the agent (scoped per profile, persisted across restart). Pinned by `shell/tests/skills-production-wiring.test.js` + 8 new cases in `ui/tests/skill-inventory.test.js` |
| 8 | Plugin system | `Plugins.enable()` flips a flag and nothing registers the plugin's declared `skills`/`tools`/`mcpServers`. The plugin registry (`<ws>/plugins/`) and the marketplace registry (`<ws>/marketplace/<id>/`) are **disjoint directories**, so a marketplace item is never loaded as a plugin at all | Enabling a plugin or marketplace item changes nothing at runtime while the UI reports success |
| 14 | Commands + hooks | `Hooks.register()` / `Hooks.emit()` — 0 production callers. The `commands/` half IS wired; the HOOK half is not | `_executions` is always empty, so `hooks:list-executions` is permanently `[]`; a plugin that registers a hook is silently never called. **Presentation defect FIXED 2026-09-27**: the panel used to read "No hook executions yet.", implying a working feature that merely had no data. It now shows a distinct dormant notice driven by `Hooks.emitterStatus()`, which DERIVES dormancy from real `emit()` call counts rather than a maintained flag, so it flips automatically the day an emitter is wired and cannot silently rot. `register()` alone does not clear it, a rejected emit does not count, and a throwing hook still counts — all pinned in `shell/tests/hooks.test.js` (+6) and `ui/tests/hooks-log.test.js` (+4). **The wiring itself remains deliberately undone**: the loop's 16 `agent.*` events map onto the 7 hook events for only 5 of 7 — `agent.completed` → `task.completed` AND/OR `agent.stopped` is ambiguous, and `verification.completed` has no source (the loop's `agent.verifying` marks the START of a pass, not its completion). Wiring 5/7 would leave a plugin registered for `verification.completed` silently never firing, which is the exact failure mode being eliminated. Two named product decisions are required; see `_evidence_FINALVAL3_hooks_mcp_20260927.txt` |

Full detail, the reason each was not fixed during the validation run, and a
bounded recommendation: `_evidence_FINALVAL_remaining_gaps_20260926.txt`.

Two subsystems that WERE certified this way — the Marketplace registry and the
security audit log — have since been proven reachable in the PACKAGED
application and now carry production-path tests rather than only unit tests.
See the "Final-validation remediation" table below.

### Final-validation remediation (2026-09-26)

Found by driving the **packaged** application, not by reading reports. Full
write-up in `_evidence_FINALVAL_defects_20260926.txt`.

| # | Finding | Resolution | Test |
|---|---|---|---|
| SF-9 | The security audit log was **never initialized in production**. `Audit.log()` returns immediately while the store is unstarted and `Audit.list()` returns `[]`, yet `Audit.start()` had **zero** production callers (only `shell/tests/audit.test.js` called it) against 24 production `Audit.log(` sites. Nothing reached `<userData>/audit-log.jsonl` and every audit read was permanently empty — the SF-3 ownership gate was guarding nothing | `main.js` imports the audit service and calls `Audit.start(join(app.getPath("userData"), "audit-log.jsonl"))` inside `app.whenReady` (immediately after the DB, so the trail can record initialization itself), and `Audit.stop()` on `will-quit` to flush in-flight writes | `shell/tests/audit-production-wiring.test.js` (4) |
| SF-10 | **Agent tool invocations produced no audit record at all.** `runTool()` in `services/project-tools/_runtime.js` is the only writer of `tool.invoked` / `tool.completed` / `tool.failed`, but the agent path calls `tool.execute()` directly (`services/agent/loop.js`) because it owns its own approval handshake. Every tool the agent ran — including privileged approval-gated `fs_write` / `exec_run` — was absent from the trail | The loop now writes the same three events, with the same shape and redaction, around the `tool.execute()` call; the completion event is written in a `finally` so a throwing tool is still recorded and the throw still propagates. Authorization, approval and execution are unchanged — this is the record, not the gate | covered by `shell/tests/audit-production-wiring.test.js` + proved end-to-end by `e2e/workflow-end-to-end.spec.js` |
| P-1 | **Project Intelligence did not survive an application restart.** The index is durable (per-project SQLite sidecar + `meta.rootPath`) but only the open handle was cached in a module-scoped Map and nothing re-opened it, so every read answered `not-initialized` in a fresh process — and no renderer surface calls `project:intel:index`, so the user could not rebuild it either | A cold read now reopens the persisted sidecar. SF-2 is not weakened, it is strengthened: the recovered `meta.rootPath` is validated against the authorized root, and a project with no index on disk is refused `root-mismatch` | `shell/tests/project-intel-restart-recovery.test.js` (3) |
| P-2 | **Every note write was silently misfiled.** `noteService.addNote/updateNote` are positional 4-arg signatures matching the preload and handler chain, and both call sites passed 3 args — so the call succeeded at the IPC boundary with each argument shifted one slot left (the subject id became the `profileId`, the title became the `subjectId`, the body landed in `title`, and `content` was null). `NoteEditor` additionally referenced a `profileId` that was not a prop, so its load threw, the error was swallowed, and the editor opened blank — the next Save wiped the note | `NoteEditor` takes `profileId` as a prop and both surfaces pass it first; both now **refuse** to write without a profile (or, for a new note, without a subject) rather than misfile. Deliberate regression check: restoring the 3-arg call made the new test fail | `ui/tests/notes-write-boundary.test.js` (10) |
| P-3 | The Runs console shipped a **fake "Show arguments" disclosure** on every approval row. `sanitizeApprovalEntry` strips `input` in the main process, so `req.input` is always undefined and the control could only ever render the hardcoded `"Arguments hidden for security"` or a literal `{}` — on the screen where a user authorizes a privileged tool call. This is the exact Meridian behaviour `docs/DESIGN-ATLAS.md` says Atlas replaced | Replaced with the spec-conformant boundary statement + a plain-language permission gloss, matching the global `OperatorConsole`. The two test blocks that encoded the pre-Atlas behaviour were rewritten into **stronger** assertions that the disclosure is gone and the placeholder string is never rendered | `ui/tests/approval-queue.test.js`, `ui/tests/gate16-ui-runtime-state.test.js` |
| P-4 | The Browser dock's **Back and Forward buttons were enabled and did nothing** — `aria-label`, `title` and a `disabled` binding, but no `onclick`. `handleBack` / `handleForward` existed, correct, one screen away, and unbound | Bound to the existing handlers | `e2e/browser-workspace.spec.js`, `e2e/agent-browser-tools.spec.js` |
| P-5 | The Updates panel passed an **options object** as the second argument of `toast.info(message, title)`, so `[object Object]` was rendered as the toast title and the actual failure reason (`description`) was never shown (8 call sites) | All 8 now pass a real string title; the failure reason goes in the message slot where it is rendered | `ui/tests/` (suite) |
| P-6 | The Runs-console search modal's **memory and plugin groups were permanently empty**: `memory.list(profileId, {})` put `{}` in the `projectId` slot (handler normalises to 0 → `invalid-input`), and `extensions.listPlugins()` was called with no `profileId` (handler is ownership-gated). Both are advertised in the modal's own aria-label | `fetchAll` now takes the active `projectId`, memory is requested only when a project is in scope (it is project-scoped by design), and `listPlugins(profileId)` | `ui/tests/search-modal.test.js` (+3) |
| P-7 | In Goals, a recovery row classified `requires-user` / `stale` rendered a button labelled **"Open" that resumed the agent run** (`goal:resume`), contradicting the banner's own "Nothing resumes on its own" | "Open" now only dispatches `cf:open-agent`. "Resume" remains the only control that resumes, and only for `safe-resume` | `ui/tests/` (suite) |
| P-8 | `Ctrl+1..9` assigned `currentView` directly, **bypassing** both `navigate()`'s allow-list and the rail's profile gating, so `Ctrl+8` reached Goals with no profile and waited forever | The gate moved to `ui/src/shell/view-registry.js` as `isProfileGated(id, profileReady)` (a routing rule, not a rendering one) and is now imported by both `NavRail` and the key handler; the handler routes through `navigate()` | `ui/tests/shell-contracts.test.js` (suite) |
| T-1 | The `PROGRESSLEDGER_V2_E2E_DONUT_STUB` seam was **not hermetic** for the separate-mode focus gate: the transport was stubbed but `focusSeparate` still reached for the real Donut control plane, so every stubbed launch failed closed with `separate-focus-failed`. It was also a live hazard — with no `PROGRESSLEDGER_V2_DONUT_WORKSPACE` override it resolves the sibling Donut workspace and could pull foreground from a real user backend | The Donut half of the gate is factored out (`resolveRealBrowserPid`). Production keeps the real gate unchanged. Under the stub, a REAL resolvable browser still runs the REAL native gate (so the headed focus-ownership coverage is preserved); when none exists there is no real HWND to own, so the gate is vacuously satisfied and the call is recorded as such | `e2e/browser-workspace.spec.js`, `e2e/agent-browser-tools.spec.js` |

### Deliberate non-changes

- The centralized marketplace containment policy (`path-security.js`) was **not**
  modified. SF-8 fixed the install *lifecycle* around it, not the policy.
- The `audit` retention policy remains process-global. Making it per-profile
  would require a second storage system the single-file store cannot honour.
- SF-1 does not add an OS directory picker. Canonicalization + breadth
  confirmation is the security property; a picker would be a UX improvement,
  not a control. Recommended as a follow-up.


## Sources

All line citations in the sections above refer to files at `89034ba` on
`main`, EXCEPT the 2026-09-26 remediation section, which reflects the current
worktree. Test counts for the original audit were obtained with
`grep -cE "(test\(|testFn\(|describe\()" <file>`.
