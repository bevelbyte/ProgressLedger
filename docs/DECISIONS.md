# Progress Ledger v2 — decisions (DRAFT staging copy, 2026-10-24)

Status: DRAFT written on the Muse machine while waiting for the laptop helper
to run again. Copied into the v2 repo in Phase 0; later decisions are added
there, in the same format: decision, short reason, date.

## V2-01 — v2 starts as a source-only copy of CareerFlow; project-intel is protected first
Reason: the report's condition 1 — `shell/src/services/project-intel/index.js`
is untracked and cannot be restored from git, so it is copied out of any
gitignored path and verified byte for byte BEFORE any copy. The copy leaves
out node_modules, target, ui\dist, .git and other build output; .gitignore
is fixed so project-intel is tracked in v2.
Date: 2026-10-24 (planned, Phase 0).

## V2-02 — laptop runs go through temporary admin Task Scheduler tasks, minimized; SSH is for simple reads and file copies
Reason: the user set this route on 2026-10-24 (no helper.bat needed):
Bitdefender ATD blocks SSH-launched WMI/PowerShell script chains, but a
scheduled task running as admin in the user's own logged-in session runs
cleanly, minimized (start /min) so it does not disturb him, and is deleted
after the work is verified. Simple direct SSH commands were proven
unblocked. This keeps every build, test and screenshot inside the one
route that works. Proven 2026-10-24 22:25 IST with test task V2Check1
(created, ran minimized, log + done verified, deleted, deletion verified).
Date: 2026-10-24.

## V2-03 — data option (c): TypeScript research service stores through CareerFlow's Rust core
Reason: the report's recommendation — one store, one backup, no profile-id
mapping, reusing the existing migration-024 research tables, `research:*`
IPC and main-attested pattern, extended with PL-style live extraction
(innerText/selection + HTML snapshot file + SHA-256), FTS search and delete.
Option (b) (small TS SQLite store beside Rust) is the fallback ONLY if the
Rust toolchain fails, and then the two-store backup contract is written first.
Option (a) (full Rust rewrite) is rejected: too much work for no user gain.
Date: 2026-10-24 (planned, Phase 3).

## V2-04 — downloads: build a minimal managed-download feature in TypeScript
Reason: CareerFlow had managed downloads and the feature table forbids
silently losing a safety/product feature. Minimal means: per-profile download
folder, save with progress and finished/failed state, never auto-open a file.
Fallback, recorded here in advance: if the minimal feature proves too big
inside Phase 3, downloads are turned OFF with an honest "not available"
state instead, and this decision is updated to say so. No silent loss either way.
Date: 2026-10-24 (planned, Phase 3).

## V2-05 — Donut's old tables (browser_profiles, browser_shortcuts): decision deferred to Phase 3B
Reason: the task allows reuse or replacement, decided in 3B. The right call
needs the actual table schemas in hand, which Phase 3B inventories first.
Recorded here so the question is not lost. Until 3B, Donut code is removed
in Phase 2 and no new code depends on those tables.
Date: 2026-10-24 (deferred).

## V2-06 — test-mode window switch is an environment flag only, never in production
Reason: Phase 1 needs screenshots of the app window itself on a real desktop,
but a production back door that forces the window forward would be a
behavior change the user did not ask for. An env flag keeps testing honest
and production clean.
Date: 2026-10-24 (planned, Phase 1).

## V2-07 — no new packages at Phase 0; every later addition must pass all Section 2 checks
Reason: the user's standing rule — if a feature can be written in a
reasonable amount of code, write it instead of adding a package. The
checks (needed, widely used and maintained, license allows use, no install
scripts, no network calls, bundled offline) are applied per package and
recorded in DEPENDENCIES.md.
Date: 2026-10-24.

## V2-08 — layout numbers are measured from CareerFlow in Phase 4, never copied from Progress Ledger
Reason: the user wants CareerFlow's look, and the two apps' geometry differs
(PL numbers are in its own layout.ts). Measuring the real v2 shell keeps
the browser rectangle math honest for this app.
Date: 2026-10-24 (planned, Phase 4).

## V2-09 — cloud-sync, WebDAV and updater are OFF by default and make no network call at startup
Reason: CareerFlow's Settings show a cloud-synced backup folder option; the
task requires it off by default and silent at startup. A test proves it
(startup with no network calls from those features).
Date: 2026-10-24 (planned, Phase 2/5).

## V2-10 — fonts are bundled as local files (Inter + a mono font); no CDN, nothing loads from the internet at runtime
Reason: offline use and the task's Section 2.5 rule. CareerFlow's font
delivery was NOT VERIFIED in the investigation, so v2 does not assume it —
it bundles and proves it.
Date: 2026-10-24 (planned, Phase 2).

## V2-11 — build ID (git short hash + build time) shown in the status bar
Reason: the user must be able to tell at a glance that a screenshot shows
v2 and not an old build (Section 4.4), and the laptop git repo is the
source of truth.
Date: 2026-10-24 (planned, Phase 2).

## V2-12 — v2 data isolation: own app name, app id and userData path; a test proves it never opens CareerFlow, Progress Ledger, or installed-copy data
Reason: the task's Section 1.8 rule. A copy of CareerFlow would otherwise
point at CareerFlow's data by default; the test makes the separation
provable instead of assumed.
Date: 2026-10-24 (planned, Phase 0/1).

## V2-13 — SF-2 fail-open fix in relevantFiles (baseline bug, fixed in Phase 1)
Reason: the baseline shell suite had exactly 1 failure in 1412
(project-intel-ownership SF-2): relevantFiles served the cache with no
caller root (its else-branch opened the DB directly), while getFileList,
getNeighbors, getStats and reindexDelta all fail closed through getDb.
Fix: relevantFiles now calls getDb unconditionally, like its siblings.
No test was changed. Targeted file 8/8, full shell 1390 pass / 0 fail.
The bug is pre-existing at CareerFlow HEAD (v2 source is byte-identical
to CareerFlow here), not caused by the copy. Fixing the source instead
of weakening the test keeps the security posture honest.
Date: 2026-10-24.

## V2-14 — allowScripts recorded by npm's own approve command; npm rebuild does not run these scripts
Reason: hand-editing package.json's allowScripts array did not satisfy
npm (rebuild still warned "not yet covered"). npm's approve rewrote it
to object form (electron@44.3.0 and better-sqlite3@13.0.3 set true) AND
updated package-lock.json (+30/-3). Even then `npm rebuild` exited 0
without producing binaries — it does not run these install scripts in
npm 11.19. Electron's binary was therefore provisioned by running its
approved install script directly (node node_modules/electron/install.js,
exit 0: dist/electron.exe 246,070,272 bytes, path.txt bare
"electron.exe"). better-sqlite3 needs no rebuild: its shipped prebuild
(prebuilds/win32-x64.node) loads under system Node and FTS5 works
(proven by load test). esbuild@0.21.5 is explicitly NOT allowed: the UI
build (vite 5.4.21, 4027 modules, 17.71s) proves its binary arrives via
@esbuild/win32-x64 without the postinstall.
Date: 2026-10-24.

## V2-15 — Phase 1 screenshots via a Playwright driver, not SendKeys
Reason: the driver launches the app the e2e way (static ui/dist,
CAREERFLOW_E2E=1), verifies the window handle, and screenshots the app
window per view — more reliable than focus-dependent keystrokes, and it
satisfies the task's method (window verified, test-mode flag only,
app-window shots). Navigation model learned: the top tab row switches
workspace; the second tab row selects the view; a sidebar click alone
only switches workspace and leaves the last-active tab in front (this
misled pass 1 into duplicate shots). Sidebar collapse exists ("Collapse
navigation" button, collapses to an icon rail). The Ctrl+K palette is a
search palette, not a command runner for browser commands.
Date: 2026-10-24.

## V2-16 — CareerFlow browser baseline record (Phase 1, record only)
Reason: the Operator "Browser" tab is the Donut manager (external).
Without Donut running it shows "No managed browser profiles yet" with
New browser profile / + Profile / Launch / Open / Refresh; Launch adds
Open/Refresh but opens no page, shows no address bar and no Capture
button. Palette search for "browser" returns no matches. "+" creates a
Scratch workspace tab, not a browser tab. The embedded browser
(WebContentsView host.js) opening path was NOT found through UI
navigation in 4 passes; Phase 3 finds it from code (host.js,
BrowserSurface, workspace model). NO Phase 1 shot shows a real web page
— recorded as NOT VERIFIED, not claimed.
Date: 2026-10-24.

## V2-17 — Rename map (Phase 2)
Visible product name "Progress Ledger" everywhere. Runtime identity carries
a "-v2" suffix wherever a collision with the live Progress Ledger install
is possible (safety-critical, not cosmetic): npm root name
progress-ledger, scopes @progress-ledger/core|shell|ui, Rust crate
progress_ledger_core (node file progress_ledger_core.win32-x64-msvc.node),
Electron appId app.progressledger.v2, installer productName/shortcutName/
uninstallDisplayName "Progress Ledger v2" (the one place the visible name
is not exactly "Progress Ledger", so NSIS cannot overwrite the live
install dir; the user may overrule), userData dir progress-ledger-v2, DB
file progress-ledger-v2.db, protocol progressledger-v2://, preload bridge
window.progressLedger, env PROGRESSLEDGER_V2_*, localStorage keys
progressledger_v2_*. Docs scoping: README.md + CAPABILITY-MATRIX.md
renamed (living product docs); docs/** historical reports/gates,
.agents/**, .unlazy/** left as CareerFlow history (renaming them would
falsify the record). "cf" abbreviations (CSS classes like cf-kbd,
cf:open-page event) left as-is — not user-visible. Rename ran as an
ordered plain-string script: 338 files, 2378 replacements; post-rename
git grep -i careerflow over shell/ui/core/e2e/scripts/config is clean.
Two real bugs the rename exposed and fixed: preload exposed
"progressledger" (lowercase) while the UI calls window.progressLedger,
and main.js registered the bare "progressledger" protocol instead of
"progressledger-v2". main.js userData now sets progress-ledger-v2 for
normal runs, preserving the E2E/migration-test env override.
Date: 2026-10-24.

## V2-18 — Donut/CDP removal (Phase 2)
Removed entirely: Donut services (donut, donut-manager, donut-mapping,
donut-open, donut-transport, donut-credential), browser-workspace +
browser-workspace-tools services, cdp-session + cdp-adapter, IPC
donut/cdp/browser-manager/browser-workspace, BrowserManagerPanel +
QuickActionsPanel + features/browser + features/browser-workspace +
features/quick-actions + browser-workspace store, core browser_manager
module + windows_host + native module + its tests, 17 shell Donut/CDP
tests, 6 e2e Donut specs, 6 Donut scripts, docs/CDP-AUTH-BOUNDARY.md,
docs/official-donut, scripts/phase7-classify.mjs (its subject is gone),
and the Operator "browser" view from the registry, ALLOWED_VIEWS,
PROFILE_GATED, PaneView and the shell-contracts allowlist (its only
content was the Donut panel; Phase 3 re-adds a browser view wired to
the new TypeScript browser). Kept and rewired: a new shell/src/ipc/
system.js with system:open-external (http/https only) for SubjectLinks.
Portability: the Donut browser-profile export + import sections of
core/src/portability.rs are deleted (export manifest field included);
the 015/016 browser_profiles/browser_shortcuts tables STAY as schema
history (reuse-or-replace is Phase 3B decision V2-05); old bundles'
browserProfiles sections are silently ignored on import, not an error.
The agent browser_* refusal registry is deleted ENTIRELY: with no
browser tools registered, an unknown-tool response (tool-not-found from
the agent loop) is the honest behaviour, not a refusal message pointing
at deleted features. The browser-transport-boundary guard is rewritten
to assert absence (no Playwright import, no cdp-session.js, no
connectOverCDP anywhere) instead of asserting the transport exists in
one module. Lesson: git rm refuses files with unstaged modifications
without -f (the first delete job silently deleted nothing); the
force-delete used git rm -q -f --ignore-unmatch, scoped to the named
list only. Two cleanup-script bugs found by their logs: a save() that
compared mutated text to itself (wrote nothing) and an import-section
search that found an earlier Ok(ImportOutcome block instead of the one
after the section. Deleted test files: browser-product-loop (read the
deleted handler), research-console (rendered the deleted panel),
browser-workspace (deleted store); adapted: agent-loop, browser-tools-
approval (Donut cases removed, general approval tests kept),
audit-production-wiring + first-run (comments only),
project-intel-ui-wiring (regex used the pre-rename lowercase bridge
name; escaped-dot form is why the rename script missed it).
Date: 2026-10-24.

## V2-19 — Phase 2 product fixes: fonts, build ID, logo, B6
Fonts bundled, nothing fetched at runtime: Inter Variable latin
(normal + italic) copied from @fontsource-variable/inter as installed
in the Progress Ledger repo (OFL-1.1) — latin only, because the UI is
English and other scripts fall back to the system stack; Cascadia Mono
Regular copied from C:\Windows\Fonts (OFL-1.1) after confirming it is
present there (JetBrains Mono is not installed, so it was not
downloaded). The mono stack now lists the bundled Cascadia Mono first.
These are asset files, not new packages: no npm/cargo package was added
in Phase 2. Build ID: ui/vite.config.js defines __BUILD_ID__ as "<git
short hash> <ISO build time>" (fallback "dev"); StatusBar shows it in
the right group (mono micro, ellipsis, full string on hover via
title); the component guards with typeof so vitest renders "dev".
Logo: an original SVG mark (ui/src/assets/logo.svg) — an amber ledger
plate with three entry lines, drawn for v2, not copied — replaces the
CSS-diamond brand-mark in TitleBar. B6 fixes applied: Flashcards empty
deck now says "No cards yet" (not "All caught up!"); Labs empty state
says "No labs yet"; Formula Board shows "No subject selected" when no
subject is chosen (the old chain had no final else, so the area was
blank); the toast stack now sits above the 26px status bar
(bottom: calc(var(--shell-status-h) + 16px)) instead of covering it;
the status-bar right group never shrinks below its content
(flex-shrink: 0); the hover wash is raised from 0.032 to 0.05 (still
below the 0.06 selected wash); the pane tab strip scrolls the active
tab into view so it cannot sit half-clipped at the edge (the "Goal"
tab in the screenshots). Two B6 items are NOT fixed blind and are
carried into Phase 5 round 1 with explicit reproduction steps: the
Degree/semester header overlap + Semester 7 row clip (no faulty rule
found statically in CgpaPlanner/SubjectList) and the sidebar highlight
lag after a tab switch (the rail is prop-driven and every store path
from tab click to focus looks synchronous; reproduce live before
touching navigation state).
Date: 2026-10-24.

## V2-20 — Rename repair: plain-string rules break identifiers
The rename script's plain-string rules broke identifiers in two shapes,
found only when vitest collection failed on 5 UI files (the app build
passed because it never parses test-only modules): "CareerFlow" ->
"Progress Ledger" (with a space) inside identifiers (makeCareerflow ->
makeProgress Ledger, a parse error) and "careerflow" ->
"progressledger-v2" (with a hyphen) in identifier positions
(window.careerflow -> window.progressledger-v2, and the object key
`careerflow:` -> `progressledger-v2:`). The repair script joins the
space inside identifiers (ProgressLedger) and uses the camelCase bridge
name (progressLedger) in identifier positions, repo-wide across
js/cjs/mjs/svelte/rs/ts (excluding node_modules/dist/target/out), and
deliberately leaves the protocol string "progressledger-v2://" alone
(the key rule skips a colon followed by //). Lesson for any future
bulk rename: never apply a display-name rule (with a space) or a
hyphenated-name rule to identifier positions; scan for the broken
shapes across the whole tree, not just the files a failing test names
(the same breakage could sit in e2e specs no unit run parses).
Date: 2026-10-24.
