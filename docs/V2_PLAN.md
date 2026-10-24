# Progress Ledger v2 — plan (DRAFT staging copy, 2026-10-24)

Status: DRAFT written on the Muse machine while waiting for the laptop helper
to run again. The laptop repo `D:\Muse_Workspace\projects\Progress_Ledger_v2`
will be canonical once created; this file will be copied there in Phase 0
and kept current from then on.

## Goal (user's words, shortened)
Progress Ledger v2 is a copy of CareerFlow with CareerFlow's exact look and
features, renamed "Progress Ledger". Its browser is the TypeScript browser
from the existing Progress Ledger project, upgraded to market standard with
MULTIPLE ISOLATED BROWSER PROFILES. CareerFlow's own browser code is REMOVED.
The Chromium engine (Electron) stays. The browser must really work, including
Capture page and Capture selection saved into the research ledger.
No new design. CareerFlow's design.

## Rules that bind this build
- Laptop only for builds, tests, app runs, screenshots. Muse machine: reading,
  writing docs and code only. Final report must say if anything ran elsewhere.
- All laptop runs go through temporary admin Task Scheduler tasks (user-set
  2026-10-24, supersedes helper.bat for this build): schtasks /RL HIGHEST
  /IT, SC ONCE, /Run immediately, launched minimized (start /min), deleted
  AFTER the work is verified, in a separate call from /Run. SSH: simple
  direct commands only, ONE connection joined with `&`, no PowerShell, no
  WMI, no `.cmd` over SSH. `if exist` checks LAST. Never ask to turn off
  Bitdefender or add exceptions for cmd/PowerShell.
- Every job: low priority, its own log file per phase (unique names),
  a done flag, survives a dropped SSH connection.
- Code may be written on the Muse machine and copied to the laptop with scp
  or tar. BEFORE every build, verify on the laptop that files match
  (hash list or git status). The laptop git repo counts. Commit there.
- Build ID (git short hash + build time) in the status bar. Before every run,
  end old Electron and Node processes for this project.
- NEVER modify, create or delete anything in CareerFlow or the original
  Progress_Ledger. Leave their branches alone.
- v2 has its OWN data folder, app name, app id and Electron userData path.
  It must never open CareerFlow, Progress Ledger, or installed-copy data.
  A test must prove this. Throwaway data in all tests and screenshots.
- Delete heavy scratch copies when no longer needed (cf-build, pl-test, repo
  clones). Keep REPORT.md and the helper.
- No risky imports: nothing from the GitHub design repos (no skills, hooks,
  plugins, scripts, markdown rules). DESIGN.md is written from CareerFlow's
  real tokens and screenshots (all 22 viewed 2026-10-24; notes in
  `~/workspace/v2-investigation/cf-screenshots-notes.md`).
- No new npm/cargo package unless ALL Section 2 checks pass; list each in
  DEPENDENCIES.md. Browser stays TypeScript. Profile/proxy use Electron APIs;
  any local test server/proxy is written by hand.
- allowScripts: explicit, minimal (electron expected), documented per entry.
  Never allow all.
- Fonts bundled locally (Inter + a mono font). No CDN. Nothing loads from
  the internet at runtime. Cloud-sync, WebDAV and updater OFF by default,
  no network call at startup — tested.

## Stop rules (user-set)
- Phase 1 baseline fails and cannot be fixed quickly → STOP, report with
  options (NO-GO).
- No working way to run jobs in the logged-in session → STOP, say what is
  needed. (At drafting time the helper loop was not picking up jobs; the
  user then set the Task Scheduler route instead — see DECISIONS.md V2-02.
  Test task V2Check1 proved it on 2026-10-24 22:25 IST.)
- Otherwise keep going. Do not stop for small problems.

## Phases (commit after each; tests, type checks, build green at each commit)
- Phase 0, protect and plan: project-intel copied out of any gitignored path,
  verified byte for byte; v2 created from CareerFlow source (no node_modules,
  target, ui\dist, .git, build output; left-out list recorded); new git repo;
  .gitignore fixed so project-intel is tracked; first commit "Import
  CareerFlow source" + CareerFlow commit; V2_PLAN.md, DECISIONS.md,
  DEPENDENCIES.md written.
- Phase 1, baseline: install, Rust core build, UI build, all tests (Rust,
  shell, UI, e2e smoke) with real numbers; run via helper; open EVERY view,
  record works / placeholder / broken with a screenshot each; record how
  CareerFlow's own browser behaves today (record only); solve the real-desktop
  screenshot method (dev output to a file, wait up to 120 s, confirm window
  by process AND title BEFORE keystrokes, test-mode env flag to bring the
  window forward, screenshot the app window itself, a real page visible in
  at least one shot; else write check-ui.bat for double-click and mark
  NOT VERIFIED).
- Phase 2, rename and clean: every visible "CareerFlow" → "Progress Ledger"
  (title, app name, appId, product name, installer, careerflow:// protocol,
  scopes, database, profile and userData names, status bar, menus, empty
  states, docs); new simple SVG logo mark (not copied); leftover test labels
  removed; test that fails if "CareerFlow" appears in user-visible text;
  Donut removed completely (services, UI, CDP path; old tables decided in
  Phase 3B); fonts bundled; build ID added; Part B6 bugs fixed (overlapping
  Degree headers, clipped tabs and status bar, toast covering status bar,
  Flashcards empty-deck text, barely visible hover) plus any more seen.
- Phase 3, browser replacement: inventory (BROWSER_MIGRATION.md); feature
  table (CF had / PL has / v2 action) covering persistent session per
  profile, permission deny-by-default, managed downloads, live-page limit,
  rectangle validation, crash handling/recovery, navigation policy, address
  handling, new-window handling; port the PL TypeScript browser (host,
  policy + tests, tab state, page/selection extraction, overlay flag, bridge
  channels with sender validation, browser screen, tab bar, address bar +
  tests); fill gaps (permission denial, rectangle validation, downloads —
  see DECISIONS.md); data option (c): TS research service + Rust core store,
  new migration (page text, passages, HTML snapshot path + SHA-256, delete
  of rows/passages/FTS/snapshot file, FTS5 search, tab-state table for
  restart restore, lazy); PL caps kept (page text 200,000 + truncated flag,
  snapshot 10 MB else text-only, selection 20,000, URL/title from the page
  itself); capture ONLY on explicit click; browsing alone adds NOTHING;
  snapshots local; nothing sent anywhere without approval; wire browser view
  in Operator group + Research ledger screen (Ledger, Sources, Kept passages)
  with search and delete (confirm); old browser tab in saved workspaces
  opens cleanly as a new browser tab; remove old browser code, search-prove
  no references, re-run all tests/type checks; profile export/import and
  backup must include snapshot files (extend + round-trip test if not).
- Phase 3B, multiple isolated browser profiles: own persistent partition per
  browser profile (cookies, localStorage, sessionStorage, IndexedDB, cache,
  service workers, permissions, downloads separate); partition names built
  only from validated internal ids, never user text; several profiles at
  once, in different tabs and split panes; temporary profiles = in-memory
  partition, nothing on disk after close; per-profile settings in Rust core
  (new migration): name, color, icon, notes, created, last used, type,
  proxy (none/HTTP/HTTPS/SOCKS5, host, port, optional user/pass encrypted
  via safeStorage or existing vault — never plain text, never in logs,
  never in exports; per-partition; proxy failure FAILS CLOSED, no direct
  fallback; Test proxy button uses a user-entered address, contacts nothing
  unless clicked), language, user agent (normal Chromium UA minus Electron
  and app tokens, stable per profile, optional fixed preset), WebRTC
  no-local-IP-leak policy with proxy-consistent traffic, permissions
  deny-by-default + per-profile allow list, GPC/DNT on/off, third-party
  cookie blocking on/off, clear-on-close on/off, download folder per
  profile; UI in CareerFlow style (toolbar switcher with color dot + name,
  New browser profile dialog, manager view replacing old browser manager,
  row menu Edit / Duplicate settings (not data) / Clear data / Delete with
  a confirm dialog stating cookies and data will be deleted, new tabs in
  current profile, "Open in profile..." menu, profile color on tabs and
  address bar, temporary clearly marked, two profiles side by side in
  Split/Arrange, plain-words help text: "Profiles keep your data separate.
  They do not hide that you use this browser."); DELETE means delete
  (partition storage cleared, files removed, then settings); ledger link
  (each capture records browser profile id + name at capture time, shown
  as a chip; deleting a profile does NOT delete ledger entries unless the
  confirm checkbox "Also delete N ledger entries captured from this
  profile" is ticked, default off); live-page limit across all profiles,
  configurable, LRU hibernate as PL does; isolation tests with a small
  local 127.0.0.1 test server (cookie, localStorage, sessionStorage,
  IndexedDB, cache, per-profile proxy, failed-proxy no-fallback, temporary
  leaves no files, delete removes disk data, partition names unforgeable
  from UI, pages never get the app bridge).
- Phase 4, layout and security: measure CareerFlow's real layout numbers
  (sidebar, rail, top bar, tab strip, pane headers, status bar, browser
  bars, minimum window, split limits) — NOT Progress Ledger's numbers —
  in ONE shared module used by main and UI, with bounds tests (sidebar
  open/closed, split on/off, resize, minimum size); web view must never
  cover sidebar, top bars, status bar, dialogs, menus, toasts, command
  palette (hide it while any overlay is open; wire every dialog, menu and
  the palette into the overlay flag); in a split, a browser view fills ONE
  pane only; security tests (no bridge/Node to pages, contextIsolation on,
  nodeIntegration off, sandbox on, strict CSP for app UI, permissions
  denied by default, no file:// or internal-scheme navigation from pages,
  new windows open as in-app tabs in the same profile); multitasking
  (workspace tabs, Arrange, Split, Immerse with browser + several profiles;
  tab switching keeps scroll, form input, live pages; tabs restore after
  restart in their own profiles).
- Phase 5, verification and report: real-app screenshot rounds (at least 3,
  max 6; every view empty + with sample data, sidebar open/collapsed,
  hover + keyboard focus, dialog, confirm dialog, toast, command palette,
  workspace tabs, Arrange + Split, browser with a REAL page in layout and
  in a split, Capture page + Capture selection with result in ledger,
  search + delete in ledger, restart with restored tabs, minimum window,
  1920x1080; profiles: manager empty + several profiles, New profile
  dialog, switcher open, delete confirm, two profiles side by side in a
  split showing DIFFERENT logged-in state on a local test page, temporary
  marked, proxy setting + test result); compare with CareerFlow shots
  (same structure, colors, spacing, polish, nothing worse); fix, reshoot,
  repeat; also run it the way the user runs it and screenshot that, to
  prove it shows v2 and not an old build; accessibility (contrast 4.5:1,
  visible focus ring, aria labels on icon-only buttons, text >= 11px,
  prefers-reduced-motion); never claim the browser works on a real desktop
  unless a real screenshot shows a real page in the right place. Final:
  all tests, type checks, production build with real numbers; confirm every
  old CareerFlow feature still works plus browser, capture, search, delete,
  profile export/import, browser profile features; commit everything;
  V2_REPORT.md + same text in reply.

## NOT-PORTING list (from Progress Ledger — do not build in v2)
- What-if CGPA planner
- AI preview-and-approve flow
- Whole-data backup
- Resources vault

## Phase 0 record (done 2026-10-24, laptop time)
- CareerFlow source: HEAD 568a00d76e8a385d01e8659c8c47ab9ccf6e0768, working
  tree with 3 modified files at import (core/index.d.ts, core/index.js,
  package-lock.json) — copied as-is.
- project-intel protected FIRST: copied to
  `D:\Muse_Workspace\_scratch\v2-investigation\project-intel-backup\index.js`,
  `fc /b` = no differences, both 15,664 bytes. Original untouched.
- Copy: robocopy, 813 files / 13.88 MB, 0 failed, in ~2 s. Left out and why:
  .git, node_modules, target, dist, build, release, logs, test-results,
  Temp, artifacts, shots, versions, .ua, and *.log / *.sqlite / *.db /
  *.exe / .DS_Store files (build, run or runtime output, all gitignored in
  CareerFlow). The prebuilt core .node WAS copied (gitignored, on disk
  only) and is rebuilt in Phase 1. ui\dist was absent, so nothing to leave
  out there.
- Commits on branch main: 1c4ada8 "Import CareerFlow source" (813 files);
  e1d0111 "Fix .gitignore and untrack ignored files"; 85d58fb "Restore
  tracked CareerFlow agent-note files omitted in error". Tracked total
  after Phase 0: 812 = CareerFlow's 811 + project-intel. The .node stays on
  disk, ignored.
- Two mistakes, both fixed and verified in Phase 0 (honest record): (1) the
  first .gitignore fix used two output redirects on one line, which emptied
  the file and let 10 ignored files into the import commit — fixed by
  restoring the full rule set in e1d0111; (2) that fix then deleted 9
  tracked agent-note files (.agents + .unlazy) believing they were
  ignored-only — the file-list audit proved they are tracked, so they
  were restored in 85d58fb. Lesson: never combine `>` and `>>` on one
  .cmd line; always audit tracked-file counts after an import.
- Docs in this commit: V2_PLAN.md, DECISIONS.md, DEPENDENCIES.md,
  PROGRESS.md (this file's siblings).

## NOT-BUILT list (on purpose)
- No fingerprint spoofing (canvas, WebGL, audio, fonts, hardware values,
  faked timezone or location) and no attempts to evade bot detection.
- Do not claim the browser is "undetectable" or "anonymous".
- If true anti-detect browsing is needed later, a separate optional
  external-tool integration is the way, not this code.

## Phase 1 record (done 2026-10-24, laptop time; all runs via scheduler tasks, each deleted + deletion verified)
- Install: `npm install` added 442 packages, audited 446, in 43s;
  27 vulnerabilities (1 low, 5 moderate, 16 high, 5 critical). npm's own
  summary printed, but the job's later lines never ran: a bare `npm`
  call inside a .cmd transfers control to npm.cmd and never returns.
  Lesson: always `call npm` / `call npx` in .cmd files (corebuild and
  uibuild were already written that way; the install job was not).
- allowScripts saga (see DECISIONS.md V2-14): hand-edited array form did
  not satisfy npm; `npm install-scripts approve` rewrote it to object
  form + updated package-lock.json; `npm rebuild` then exited 0 while
  doing nothing; Electron's binary came from running its approved
  install.js directly (dist/electron.exe 246,070,272 bytes, path.txt
  bare "electron.exe"); better-sqlite3 prebuild verified by load test
  (SQLITE_OK + FTS5 MATCH). esbuild left unapproved with proof.
- Log-lock race, proven twice (allowscripts job + VsDevCmd repro): rapid
  successive `>>` appends to the same log file fail silently when a
  watcher briefly locks the fresh file, while a later write to a
  different file (the .done flag) still succeeds — a job can look
  finished with a truncated log. Rule now in AGENTS.md: one log file per
  step, exit codes to their own one-write files, grouped outputs via a
  parenthesized block with a single redirect, .done flag as completion
  signal, never trust .done alone — read the step logs.
- Rust core: VsDevCmd + delete prebuilt + `npm install -w @careerflow/core`
  + `npm run build -w @careerflow/core`, exit 0, output
  careerflow_core.win32-x64-msvc.node 6,270,976 bytes (same size as the
  investigation's clean build).
- UI: `npm run build -w @careerflow/ui`, exit 0, vite 5.4.21, 4027 modules
  transformed, built in 17.71s, ui/dist/index.html 725 bytes.
- Tests, full `npm test` rerun after the fix: checks check:ipc,
  check:napi, check:esm, check:cdp-boundary all pass; shell 1412 tests:
  1390 pass, 0 fail, 22 skipped; UI vitest 72 files passed; cargo tests
  all ok (incl. study_session_focus 14/14, subject_identity 7/7);
  e2e smoke passed (6.7s: profile + degree + subject + Subjects sync);
  e2e startup passed (2.1s: main boots, Rust core responds).
- The one baseline failure (fixed, see DECISIONS.md V2-13): shell SF-2
  relevantFiles served the cache with no caller root (fail-open). Fixed
  in v2's copy only (original CareerFlow untouched); no test changed.
  Stale-flag lesson from the rerun: reusing a job's .done/.exit filenames
  makes a fresh run unreadable until it overwrites them — use fresh
  filenames per run or delete stale flags first.
- App run (Playwright driver, 4 passes, shots in task work/shots*):
  pass 1 empty sweep (38 shots, all 17 nav labels clicked) but profile
  creation failed (tried on the wrong view) and sidebar clicks alone
  proved to switch workspace only; pass 2 with profile (24 shots) proved
  profile creation + auto-transition to Subjects + sidebar collapse to
  an icon rail + Ctrl+K palette, but Study views still duplicated
  (workspace-tab matcher caught sidebar "Study Sessions" at y=480);
  pass 3 with the top-row-band fix (15 shots) proved degree + subject
  creation and 8 distinct Study views + Research ledger reached via its
  sidebar button (x=8, y=778, below the visible sidebar area);
  pass 4 (5 shots) proved the palette is search-only ("browser" = no
  matches), "+" creates a Scratch workspace, and the Donut-manager
  "Launch" adds Open/Refresh without opening a page. NO shot shows a
  real web page: NOT VERIFIED (see DECISIONS.md V2-16).
- Tunnel outage mid-Phase 1: repeated "Connection closed by UNKNOWN port
  65535" while the PC and Tailscale were proven up (user's tailscale
  status screenshot: tuf-a15 100.112.116.73, muse active via relay nyc)
  and the laptop jobs kept running unaffected. Self-recovered, same as
  the 2026-10-23 outages. Lesson: on CONNECT rejection, suspect the
  tunnel path before the PC.
- Residue: every app/e2e run created %APPDATA%\careerflow (test data
  only; CareerFlow has no installed app). Deleted before each driver
  pass and at close-out; Progress Ledger's own data folder was never
  touched. Temporary driver scripts (e2e/p1-shots*.mjs) are deleted
  before the Phase 1 commit and are never committed.
