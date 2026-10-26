# Feature gap report — CareerFlow / Progress Ledger plans vs Progress Ledger v2

Read-only report. Nothing in it was built. Summaries are in the author's
own words; paths are given so every claim can be checked at the source.
No private text is copied here.

How the search ran: a whole-D: filename search timed out at its 30-minute
limit with zero name matches in the portion it covered, so a narrower
search followed (job V2Gap2, standard rights, minimized, low priority):
a recursive listing of the CareerFlow tree and of the Progress Ledger
tree, filtered to file names containing careerflow, roadmap, plan,
spec, vision, todo, architecture or old_ideas, with .md / .txt / .docx
/ .pdf extensions, skipping node_modules, target, .git, dist and build
output, and skipping other projects' folders. Result: 61 documents,
all Markdown. Dates below are file dates on disk; for the CareerFlow
tree every file is dated 2026-10-18, which is the clone date, not the
date each document was written — versions below come from the
documents' own content (report numbers V5–V18, gate phases 10–18,
capability matrix v4, changelog v1–v3).

## Part 1 — Documents found

CareerFlow root: `D:\10_Dev_Workspace\Projects\laboratory\CareerFlow\`
(CF below). Progress Ledger root: `D:\Muse_Workspace\projects\Progress_Ledger\`
(PL below).

### CF root (2026-10-18)

- `CF\README.md` — Product overview: local-first student workspace, stack, layout, rules, what changed from CareerFlow-Opus.
- `CF\CHANGELOG.md` — Changelog: v1 foundation, v2 core engine, v3 Project Mode, unreleased additions.
- `CF\CAPABILITY-MATRIX.md` (v4, HEAD 89034ba) — Audit of 18 Project Mode subsystems with test counts, 5 bounded gaps, security remediation, reachability caveats.

### CF .agents (2026-10-18)

- `CF\.agents\LOCKS.md` — Agent working rules about locks (process, not product features).
- `CF\.agents\SKILLS-IN-USE.md` — Which agent skills are in use (process).
- `CF\.agents\STANDING-RULES.md` — Standing agent rules (process).
- `CF\.agents\sub-agent-registry.md` — Sub-agent registry notes (process).

### CF .unlazy (2026-10-18)

- `CF\.unlazy\phase19\PLAN.md` — Plan for phase 19 (planning record).
- `CF\.unlazy\phase19\GATES.md` — Gates for phase 19 (planning record).
- `CF\.unlazy\production\PLAN.md` — Production plan (planning record).
- `CF\.unlazy\production\GATES.md` — Production gates (planning record).
- `CF\.unlazy\production\audit-summary.md` — Production audit summary.

### CF docs (2026-10-18)

- `CF\docs\DESIGN-ATLAS.md` — The live design system: six planes, Desk, Runs console, Research console, shell geometry, contracts.
- `CF\docs\DESIGN.md` (v1.0, archived 2026-09-21) — The superseded Meridian design system; explicitly not a source of truth.
- `CF\docs\PROJECT-MODE-GUIDE.md` — User guide to all 16 Project Mode panels.
- `CF\docs\REDESIGN-COMPARISON.md` — Manual comparison guide: current main vs frozen v1 baseline vs visual references.
- `CF\docs\REDESIGN-V1-REPORT.md` — Redesign v1 delivery report.
- `CF\docs\VERSION-MANAGEMENT.md` — Version snapshots and restore rules.
- `CF\docs\CDP-AUTH-BOUNDARY.md` — Auth boundary for the Donut/CDP browser integration.
- `CF\docs\CI-DEV-RUNBOOK.md` — Test matrix and CI flow (process, not product features).

### CF docs\audits (2026-10-18)

- `CF\docs\audits\AUDIT-V12.md` — Full audit, version 12.
- `CF\docs\audits\CF-SEQUENTIAL-DISCREPANCY.md` — A sequential-consistency discrepancy note.
- `CF\docs\audits\PERF-AUDIT-V6.md` — Performance audit, version 6.
- `CF\docs\audits\TEST-AUDIT-V6.md` — Test audit, version 6.

### CF docs\gates (2026-10-18)

- `CF\docs\gates\GATES.md` — Master gate list.
- `CF\docs\gates\GATES-master.md`, `GATES-master2.md`, `GATES-manager.md` — Master/manager gate variants.
- `CF\docs\gates\GATES-PHASE10.md` … `GATES-PHASE18.md` (9 files) — Per-phase gate records, phases 10–18.
- `CF\docs\gates\GATES-project-mode-v2.md` — Project Mode v2 gates.
- `CF\docs\gates\GATES-zcode-platform.md` — Platform gate record.

### CF docs\official-donut (2026-10-18)

- `CF\docs\official-donut\README.md` — Donut browser integration notes.

### CF docs\reports (2026-10-18)

- `CF\docs\reports\REPORT.md` — Latest unversioned report.
- `CF\docs\reports\REPORT-V5.md` … `REPORT-V18.md` (V5–V18 except as listed: V5, V6, V7, V8, V9, V10, V11, V12, V13, V14, V15, V16, V17, V18) — Versioned delivery reports.
- `CF\docs\reports\V3-FINAL-SUMMARY.md` — Final summary for v3 (Project Mode).
- `CF\docs\reports\FINAL-AUTONOMOUS-REPORT-20261016.md` — Autonomous-run final report, 2026-10-16.
- `CF\docs\reports\MISSION-EXECUTION-RECORD-20261016.md` — Mission execution record, 2026-10-16.

### PL (Progress Ledger, the original product)

- `PL\DESIGN.md` (2026-10-23) — Design guide for the redesigned shell (branch redesign-shell, decisions D-017–D-020): tokens, layout numbers, screens, shortcuts.
- `PL\REDESIGN_REPORT.md` (2026-10-24) — Redesign delivery report: phases built, honest unfinished list, confirmed feature checklist.
- `PL\docs\ARCHITECTURE.md` (2026-10-23) — Architecture baseline and increment roadmap 0–7 (foundation through AI assistance).

## Part 2 — Every planned feature vs v2

Status key: done = present and wired in v2; partial = present but with a
known bound gap; missing = planned but absent; unclear = the documents
do not settle it or it was not individually re-verified. Evidence is
from the v2 tree at this session (git grep over shell / ui / core, and
this session's own verified runs), not from the documents' claims.

### Academic core (CF README layout; PL ARCHITECTURE increments 4–6)

| Feature | Document + version | Status | Evidence in v2 code |
|---|---|---|---|
| Subjects, semesters, deadlines, study sessions | CF README; PL ARCHITECTURE inc. 5 | done | `shell/src/ipc/{courses,deadlines,sessions}.js`, `ui/src/features/{subjects,semester,study-sessions,deadlines}` |
| CGPA with actual/planned separation | PL DESIGN screens; PL ARCHITECTURE inc. 5 | done | Single-math CGPA in v2; item 2 verified CGPA 8.77 with real data |
| What-if planning | PL DESIGN (Academics what-if panel) | partial | What-if logic exists in `ui/src/features/subjects/components/SubjectDetail.svelte` only; no dedicated Academics what-if panel |
| Flashcards with SM-2 engine | CF README (SM-2); CF core layout | done | `ui/src/features/recall-deck`, `shell/src/ipc/cards.js`, Rust SM-2 inherited |
| Mistakes, formula board, labs | CF README layout | done | `ui/src/features/{mistakes,formula-board,labs}`, matching IPC files |
| Projects as link spaces (never copies) | PL ARCHITECTURE inc. 6 | done | `ui/src/features/projects`, `shell/src/ipc/projects.js`; links model kept |
| Resources vault, PDF text extraction, unified search | PL ARCHITECTURE inc. 4 | done | `shell/src/ipc/resources.js`, vault + search inherited |
| Notes, goals, courses, subject links, career | CF README layout | done | Matching IPC files and UI features in v2 |
| Portability (.cfprofile export/import/inspect) | CF README data locations | done | `core/src/portability.rs` present in v2 |
| Whole-data backup create/validate/restore | PL DESIGN (Data & Backups); PL REDESIGN_REPORT checklist | done | Backup bundle incl. research ledger + snapshots (v2 decision D-015); `shell/src/ipc/backups.js` |
| Sync / WebDAV / updater | CF services layout (sync-runner, webdav) | partial | Services exist (`shell/src/services/{sync-runner,webdav}.js`, `shell/src/ipc/{sync,cloud,updates}.js`) but are OFF by default and never start on their own (v2 decision V2-09) |
| Version snapshots + restore (version manager) | CF docs/VERSION-MANAGEMENT.md; CF REDESIGN-COMPARISON (versions/v1) | done | `scripts/version-manager.mjs` + `scripts/test-version-manager.mjs` present in v2 |

### Browser and research (CF Atlas; PL ARCHITECTURE inc. 2–3)

| Feature | Document + version | Status | Evidence in v2 code |
|---|---|---|---|
| Integrated browser: tabs, per-profile partitions, navigation policy, hibernation, session restore | PL ARCHITECTURE inc. 2; CF Atlas (Research console + dockable pane) | done | Phase 3/3B in v2; this session re-verified tabs, profiles, restore, LRU |
| Research capture with provenance (page + selection), ledger search/delete | PL ARCHITECTURE inc. 3 | done | `shell/src/ipc/research.js`; item 9 proved page + selection landing in the ledger |
| Research ledger "Attach file" flow | PL DESIGN (Research ledger screen) | missing | No "Attach file" control in v2 UI (grep clean); the resource vault stores files separately but there is no ledger attach flow |
| Donut / CDP browser integration (manager + CDP control plane) | CF docs/CDP-AUTH-BOUNDARY.md; CF docs/official-donut/README.md | missing | Deliberately excluded by decision (2026-10-23): integrated browser only; Donut/CDP fully removed in v2 Phase 2 |
| Focus Curtain browser integration | CF README ("removed browser-integration leftovers") | missing | Removed in CareerFlow itself before v2; not a v2 gap, recorded for completeness |
| Graph view | CF REDESIGN-COMPARISON (v1 reference shots: Desk/Graph/Reader) | unclear | v1 reference surface only; the Atlas plane list (Today/Spaces/Plan/Library/Operator/System) does not name it, and v2 has no graph view |
| Reader view | CF REDESIGN-COMPARISON (v1 reference shots) | unclear | Same as Graph: v1 reference only, no Atlas listing, no v2 view |

### Project Mode agent layer (CF CHANGELOG v3; CF CAPABILITY-MATRIX v4; CF PROJECT-MODE-GUIDE)

| Feature | Document + version | Status | Evidence in v2 code |
|---|---|---|---|
| Agent loop, parallel DAG execution, resume | CF CAPABILITY-MATRIX rows 2, 12; CHANGELOG v3 | done | `shell/src/services/agent/loop.js`; `project:start-agent` / `project:resume-agent` wired in `shell/src/ipc/project-mode.js` |
| Sub-agent orchestration + run telemetry (write side) | CF CAPABILITY-MATRIX rows 6, 18 | done | Telemetry start/end/list in service; loop dispatches sub-agents |
| Sub-agent telemetry read side (UI list) | CF CAPABILITY-MATRIX Gap 3 | missing | No `subagent:list` channel in `shell/src/ipc`, preload, or UI (grep clean); the service `list()` exists but nothing reads it |
| Skills system (registry, enable/disable, prompt build) | CF CAPABILITY-MATRIX row 7 | done | `shell/src/services/skills`, `shell/src/ipc/skills-plugins-mcp.js` |
| Plugin system + hot-reload (recursive) | CF CAPABILITY-MATRIX rows 8, 9; Gap 5 | done | `shell/src/services/plugins/index.js` uses recursive watch with a Linux fallback (Gap 5 fixed in v2) |
| Marketplace: local + git install, enable/disable/uninstall | CF CAPABILITY-MATRIX rows 4, 10 | done | `shell/src/services/marketplace/*`; `bootstrapMarketplace` called from `shell/src/main.js` |
| MCP curated server catalogue | CF CAPABILITY-MATRIX row 3; CHANGELOG (MCP list) | done | `shell/src/services/mcp/curated.js`; catalogue served per profile/project |
| MCP tool execution (connect + callTool, spawning servers) | CF CAPABILITY-MATRIX reachability caveat 3b | missing | Deliberately unwired: `shell/src/services/mcp/startup.js` states `MCP.connect()` has no production caller, because connecting spawns network processes with no agreed lifecycle |
| Memory viewer + context packet | CF CAPABILITY-MATRIX row 11; PROJECT-MODE-GUIDE | done | `shell/src/services/memory`, `shell/src/ipc/memory.js`, memory UI inherited |
| Commands (built-ins) + hooks log UI | CF CAPABILITY-MATRIX row 14 | partial | Commands wired; hooks UI exists but `Hooks.emit()` has zero production call sites in v2 (`shell/src/services/hooks/index.js` comment), so the log is dormant by design pending two product decisions (event mapping ambiguity) |
| Plan templates save/load | CF CAPABILITY-MATRIX row 16; CHANGELOG | done | Rust + IPC + UI present |
| Plan template delete | CF CAPABILITY-MATRIX Gap 2 | done | `pm_delete_plan_template` in `core/src/db/project_mode.rs`, `plan:delete-template` IPC + preload + UI button (Gap 2 fixed in v2) |
| Provider health panel, token budget panel, default provider picker, keybindings help, session timeline/export, agent run history, approval queue, shell history, recent errors, onboarding tour | CF PROJECT-MODE-GUIDE (all panels); CF CHANGELOG (unreleased) | done | All corresponding components present in `ui/src/features/project-mode/components/` (TokenBudgetPanel, ProviderHealth, DefaultProviderPicker, KeybindingsHelp, ProjectWorkspace) and approval flow in the Operator console |
| Audit log + redaction + retention config | CF CAPABILITY-MATRIX row 15; PROJECT-MODE-GUIDE (audit retention) | partial | Log + redaction + retention service present; per-profile retention is not representable in the single-file store (stated in the matrix itself), so retention stays process-global |
| IPC sender allow-list + safeHandle | CF CAPABILITY-MATRIX Gap 1 + correction | done | `check:ipc` passes in v2; raw `ipcMain.handle` confined to migration handlers |
| Strict CSP + sandbox | CF CAPABILITY-MATRIX row 13 | done | Inherited; v2 Phase 4 proof covered navigation security |
| Project intelligence (relevant files, restart recovery) | CF CAPABILITY-MATRIX row 1; remediation P-1 | done | `shell/src/services/project-intel`, `shell/src/ipc/project-intel.js`; v2 Phase 0 protected the module byte-for-byte |
| Project diff view | CF CAPABILITY-MATRIX row 17 | done | `shell/src/ipc/diff.js`, diff UI inherited |
| MAX_STEPS configurable per project | CF CAPABILITY-MATRIX Gap 4 | done | `shell/src/services/agent/loop.js` reads `profile_config.max_steps`, default 50 (Gap 4 fixed in v2) |
| OS directory picker for project roots | CF CAPABILITY-MATRIX deliberate non-change (SF-1) | missing | Stated as a UX follow-up in the matrix, never built; canonicalization + breadth confirmation is the implemented control instead |

### Design system (CF Atlas; PL DESIGN)

| Feature | Document + version | Status | Evidence in v2 code |
|---|---|---|---|
| Atlas shell: six planes, Desk agenda-first, Runs console, Research console, two-pane settings | CF docs/DESIGN-ATLAS.md; CF docs/DESIGN.md (archived Meridian) | done | v2 shell follows Atlas (rail, Desk, Operator console, browser panes); Meridian is superseded, not a gap |
| Amber single accent, bundled fonts/icons, no CDN, 11px minimum text, shared layout numbers | PL DESIGN tokens + layout numbers; CF Atlas §3 | done | v2 tokens in `ui/src/app.css`; this session set the 1024x640 floor from the shared layout module (item 3) and the 11px floor (item 4) |
| Progress Ledger shell specifics: 1024x680 minimum, browser chrome 38/49px, sidebar 216/48px | PL DESIGN layout numbers | done (different) | v2 uses Atlas numbers instead (1024x640 floor, Atlas chrome); a deliberate difference between the two products, not a missing feature |
| Workspace tabs + split restore after restart | PL DESIGN (multi-tasking) | partial | Browser tab restore done (browser_tabs rows); UI workspace-tab restore after restart not individually re-verified in v2 |
| Command palette (Ctrl K) incl. capture/search/backup actions | PL DESIGN (multi-tasking) | done | `ui/src/features/command-palette` in v2 |
| AI Assistance screen: provider settings, preview-and-approve, draft audit, saved outputs | PL DESIGN (AI Assistance); PL ARCHITECTURE inc. 7 | partial | The approval flow itself exists (agent approval queue, fail-closed previews in the Operator flow), but there is no dedicated AI Assistance screen with provider settings + draft audit in v2; the Operator console is the equivalent surface |
| Projects "Ask AI for a briefing" | PL DESIGN (Projects screen) | unclear | No briefing control found in v2 projects UI; the agent loop could serve it, but no such feature was verified |

## Part 3 — The 10 most valuable missing features, in build order

Ordered by value per effort: finish what is already half-built first,
then the small user-visible gaps, then the large unlocks.

1. **Sub-agent telemetry read side** — small. Wire the existing service `list()` behind a `subagent:list` channel + preload + tree UI. Completes a feature whose write side already exists and is tested.
2. **Research ledger "Attach file"** — small. A ledger button that attaches a vault file as a source (reuse the existing save-source path). Closes the one ledger flow the Progress Ledger design specifies that v2 lacks.
3. **Projects "Ask AI for a briefing"** — small. A project action that runs the existing agent loop with the project's linked sources as context and saves the output as a draft. Reuses the loop, approval, and draft machinery.
4. **Academics what-if panel** — small. Promote the what-if logic already in SubjectDetail into a dedicated Academics panel (actual vs planned CGPA under changed grades).
5. **AI Assistance screen** — medium. A single screen for provider settings, new requests, preview-and-approve, drafts with audit, and saved outputs, sitting on top of the existing agent loop instead of the Operator console's run-centric view.
6. **Hooks wiring** — large. First the two product decisions the matrix names (which loop events map to the 7 hook events; what `verification.completed` means), then wire `Hooks.emit()` at the loop's real event points so plugins' hooks actually fire and the log stops being dormant.
7. **MCP tool execution** — large. Decide the curated auto-connect policy and lifecycle (which servers, when they start/stop, what approvals gate them), then wire `MCP.connect()` / `callTool()` behind it. Unlocks real MCP tools for the agent; deliberately not a small job because it spawns network processes.
8. **Per-profile audit retention** — medium. Either a second scoped store or scoped pruning of the single-file log, so the guide's per-profile retention setting becomes real instead of process-global.
9. **Reader view** — medium. A reading surface for captured pages and vault files (the v1 Reader reference), reusing extraction + ledger content.
10. **Graph view** — large. A subject/knowledge graph over the academic store (the v1 Graph reference). Listed last: it is the biggest build with the least evidence of demand in the later documents, which never mention it again after the v1 comparison.

Deliberately NOT in the top 10: Donut/CDP browser (excluded by decision, not a gap), Focus Curtain (removed upstream), Meridian design (superseded by Atlas), OS directory picker (small UX nicety, low value against the list above).

## Part 4 — What could not be found or could not be decided

- **Whole-D: coverage is partial.** The first search (whole D:, low priority) hit its 30-minute limit and was killed, with zero name matches in the portion it covered. The narrower search covered the CareerFlow tree and the Progress Ledger tree completely, plus top-level listings of the other D: roots. A CareerFlow planning document sitting in an unrelated D: folder (outside those two trees) would not have been found.
- **old_ideas folders.** The CareerFlow recovery audit mentions `old_ideas/01–06` doc/prototype folders and Repomix snapshots as historical sources, but no `old_ideas` directory exists inside the CareerFlow tree searched, and no file with that name matched. Its current location, if it still exists, was not found.
- **versions/v1 snapshot and Frontend-Lab v1 shots.** `REDESIGN-COMPARISON.md` cites `CareerFlow\versions\v1` (restorable snapshot) and a sibling `CareerFlow-Frontend-Lab\v1\shots` as comparison references. Neither path exists on disk now (both directory listings return not found), so the v1 baseline itself could not be inspected — only the comparison document describing it.
- **File dates are clone dates.** Every CareerFlow file is dated 2026-10-18 (the fresh-clone date). Authorship dates were taken from document content (report/gate numbers, changelog versions) where present; undated process notes (.agents, .unlazy) cannot be ordered precisely.
- **No .docx or .pdf planning documents were found.** All 61 matches are Markdown. If a plan exists as a Word or PDF file under a name that does not contain the searched words, it was not found.
- **Graph and Reader views: unclear, not decided.** They appear only as v1 visual references in the comparison guide. Whether Atlas intentionally dropped them or simply did not list them cannot be decided from the documents read.
- **Projects AI briefing: unclear.** No briefing control was found in v2, but the agent loop could plausibly serve it through an existing path that was not exercised in this session.
- **UI workspace-tab restore after restart: unclear.** Browser tab restore is proven in v2; whether open UI workspace tabs (and the split) survive a restart exactly as the Progress Ledger design specifies was not individually re-verified.
- **Inherited Project Mode panels: code present, wiring sampled, not exhaustively re-verified.** Panels were confirmed present in the v2 tree; only the known-dormant ones (hooks emit, MCP connect, telemetry read) were individually proven. A panel whose wiring silently broke in the rename would read as done here.
- **Nothing personal was opened.** Files outside the two project trees (including personal-looking text files noticed in passing in other folders) were not opened, and no text from any document is quoted at length here.
