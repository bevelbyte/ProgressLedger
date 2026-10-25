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

## V2-21 — Phase 3 port shape: merge, not wholesale replacement
The task's goal paragraph says CareerFlow's browser code is removed and
the PL TypeScript browser is the browser. The Phase 3 inventory
(docs/BROWSER_MIGRATION.md) shows that would REGRESS safety: v2's
embedded browser already implements opaque page ids, a
profile-existence gate, a permission allow-list (deny-by-default with
both handlers + denial events), managed downloads, rectangle clamping,
a popup budget, a global navigation backstop and crash-state retention
— and PL's host lacks each of those (deny-all permissions, downloads
refused, no clamping, no budget, no backstop, single-profile-per-window
model that does not fit v2's multi-profile window). The task also
requires "never lose a safety feature silently" and a feature table
that v2's host already satisfies. Decision: the port MERGES PL's
missing capabilities (live extraction, tab-state persistence, LRU
hibernation, ledger delete/search, snapshots) into v2's host, and keeps
v2's host, policy, permissions, downloads, navigation and IPC. The
Donut browser — CareerFlow's OTHER browser system — was fully removed
in Phase 2, so no Donut path remains. The user may overrule this and
order a wholesale replacement; the comparison table is in
BROWSER_MIGRATION.md §3 for that judgement. Date: 2026-10-24.

## V2-22 — TypeScript island for the ported browser logic
The ported logic (extraction script, caps, validation, types) is
written in TypeScript at shell/src/browser-ts/extraction.ts and
compiled with tsc to a gitignored output dir, because the task
requires the ported browser to stay TypeScript and forbids rewriting
it to JavaScript. The existing v2 host stays JavaScript — it is not
PL code being converted, and rewriting a tested host for language
purity would violate the quality-first mandate. typescript becomes a
devDependency (checks in docs/DEPENDENCIES.md: needed, widely used,
MIT, no install scripts, no network calls, local-only output).
build:browser-ts runs via npm pre-hooks (predev, prestart,
pretest:shell) so no manual build step is ever forgotten; the packaged
build includes the compiled output. Date: 2026-10-24.

## V2-23 — Migration 025: research extension + tab state
The next migration is 025, not 024: migration 024 already defines
research_sources + research_captures. 025 adds content_file,
content_sha256, text_length, text_truncated columns on
research_sources; research_source_texts (source_id, text); FTS5
search_index (kind, profile_id, source_id, capture_id, title, body);
and browser_tabs (profile_id, browser_profile_id, position, url,
title, is_active, timestamps). Passage cap rises 8,000 → 20,000 to
match the PL cap the task keeps. Snapshots live under the app userData
vault/sources/ directory, owned by the shell (write + unlink), with
rows owned by the Rust core; delete returns the filename for the
shell to unlink after the transaction commits. In Phase 3,
browser_profile_id carries the workspace profile id (the partition
owner); Phase 3B repoints it at real browser-profile ids. Profile
export/import and the local-vault backup must be checked for snapshot
inclusion once snapshots exist, with a throwaway-data round-trip test.
Date: 2026-10-24.

## V2-24 — How jobs run now: helper only, no scheduler, no elevation
(Ordered 2026-10-25, supersedes the 2026-10-24 scheduler route.)
- How a job starts: the user double-clicks
  `D:\Muse_Workspace\_shared\tools\agent-helper\helper.bat` in his
  normal logged-in session. The helper polls its `jobs\` folder every
  5 seconds and runs each job whose `<name>.ready` flag exists, via
  `call jobs\<name>.cmd > results\<name>.log 2>&1` inside its own
  window, then moves the script to `jobs\done\`, deletes the flag and
  writes `results\<name>.done`. `stop.txt` stops it within 5 seconds;
  closing its window stops it fully.
- Scheduled tasks: NONE of this project's tasks exist. Verified
  2026-10-25 ~01:50 IST: `schtasks /Query` for V2P3Ts4, V2P2Verify and
  V2P2Commit all return "The system cannot find the file specified",
  and the root task list contains no V2* entries. Every temporary
  admin scheduler task used for Phases 0-2 and Phase 3 chunks 1-2 was
  deleted and its deletion verified. That route is retired and will
  not be used again for this project.
- Which user: the helper runs as the normal user — the user's own
  interactive session (Session 1), the same user who double-clicked
  it. No administrator account, no service, no startup entry.
- Elevated: NOTHING. No /RL HIGHEST, no admin token, no UAC elevation.
  If a job ever needs something that requires elevation, it stops and
  asks instead of elevating.
- Bitdefender: no exception is asked for and none is needed — the
  helper is user-launched, the path Bitdefender never blocked. If a
  job is blocked, the job log and the exact detection are read, the
  cause (for example the command chain) is fixed, and the block is
  reported. A block is never worked around by elevating.
- Job windows: helper jobs run via `call` INSIDE the helper's window,
  so a plain `exit` in a job script would close the helper window
  itself, which is forbidden. Helper job scripts therefore end with
  `exit /b 0` (ends the job, returns to the helper loop). Any window
  a job opens with `start` is closed by that same job before it ends.
  The helper window itself is never closed by a job.
- Proof gating (condition 4 of the 2026-10-25 decision): Phase 3
  chunks 1-2 (the TypeScript extraction island + `host.extractPage`)
  were built before the proof instruction arrived. They are additive
  (no UI calls `extractPage` yet, loading behaviour unchanged) and
  fallback-compatible (the extraction script + caps are Progress
  Ledger's own logic, so they carry over if the fallback triggers).
  All further porting (migration, IPC, LRU, UI) is gated on the step-4
  browser proof passing.
Date: 2026-10-25.

## V2-25 — Back/forward added as a proof prerequisite (2026-10-25)
The step-4 proof requires back and forward to work, but no back/forward
path existed: no host method, no IPC channel, no surface button. Added
the smallest complete path: `host.goBack`/`goForward` (Chromium's own
per-page navigation history, refused with "no-history" when empty),
`host.navigationState` (canGoBack/canGoForward for the buttons), IPC
`browser:go-back`, `browser:go-forward`, `browser:navigation`, preload
entries, store functions, and Back/Forward buttons in BrowserSurface
(enabled only when history allows). This is not PL porting — it uses
Electron's own history API, which PL also uses — it is the browser
working as the proof demands. The pane-header "New web page" action
already opens the embedded browser, so no new "Browser" rail entry was
needed (condition 4a's fallback did not trigger).

## V2-26 — Engine guard test (2026-10-25)
`shell/tests/engine-guard.test.js` scans shipped code (shell/src +
ui/src, minus tests and the generated TS output, comments stripped)
and fails on any `<webview>` tag, `new BrowserView`, BrowserView
import, or `electron.BrowserView`, and fails if nothing imports
WebContentsView from electron. The surface already coalesces bounds
updates (rAF + timer fallback + identical-rect skip), so the step-5
resize measurement will show whether that is enough before any
hide-during-drag fix is added.

## V2-27 — Scheduler route reinstated, helper not used (2026-10-25)
The user corrected V2-24 in plain words: he runs as administrator, jobs
go through Task Scheduler and are deleted once done, and he will NOT
run the helper script. V2-24 (helper-only, no scheduler, no elevation)
is therefore SUPERSEDED. The route is the original 2026-10-24 pattern:
`schtasks /Create /TN <name> /TR "cmd /c start /min /low <job.cmd>"
/SC ONCE /ST 23:59 /RL HIGHEST /IT /F`, run immediately, verified,
then deleted in a separate call with deletion verified by Query.
Job scripts end with plain `exit` (their own window closes itself);
the helper's `exit /b` form does not apply to scheduler jobs. The
queued helper proof job (jobs/p3-proof.cmd + .ready) was removed from
the helper queue and re-submitted as scheduler task V2P3Proof, so no
stale helper job runs later.

## V2-28 — Browser proof outcome: browser PROVEN, desktop NOT VERIFIED (2026-10-25)
Proof run V2P3Proof2 (03:06-03:11 IST): 14 of 16 driver checks pass.
Proven: local test page loads (298 ms, title ZEBRAQUILT), link click,
second-page link, form typing + submit (server log confirms
/echo?text=hello+form), reload, back, forward, example.com
("Example Domain"), tab switch (41 ms), split + divider drag
(647 ms), 4-page memory, idle CPU ~0%, page capture. The two failures
are measurement bugs, not browser bugs: the tab-close selector guessed
a "Web page" label (page tabs show the page title), and the resize
check measured a background tab (only the active tab has a surface
sending bounds). Both are fixed in the driver for the Phase 5 repeat.
Desktop screenshot: it shows the user's own Brave window, not the app
— bringToFront + focus from a minimized job cannot overcome Windows'
foreground lock. Per condition 4h this is stated honestly: the
DESKTOP proof is NOT VERIFIED, check-ui.bat is written for the user
to double-click and see the app himself, and porting continues. The
Phase 5 repeat will front with restore + show + temporary
always-on-top (released after the screenshot). Performance numbers
for the final report: 1 page ~588 MB total working set, 5 pages
~968 MB (the close failure left example.com open, so the second
number is 5 pages, not 4); idle CPU ~0% on every process.

## V2-29 — LRU replaces refuse-past-cap; two old registry tests updated (2026-10-25)
Phase 3 gives the registry a live-view cap of 5 with LRU hibernation
instead of CareerFlow's refuse-past-cap: creating a page past the cap
sleeps the least-recently-used background page (record kept, view torn
down) and only refuses when every live page is visible. Two existing
shell tests encoded the old contract and failed after the change, as
expected: the public-shape test (toPublic gained the renderer-safe
`hibernated` flag) and the bounds test (a third background page no
longer refuses). Both were updated to the new contract, not weakened:
the shape test still forbids partition and profileId leakage, and the
bounds test now asserts the view bound (records kept, views bounded)
plus the all-visible refusal. Shell suite after the update: 1175 pass
/ 0 fail. Updating a test to a deliberately changed behaviour is not
weakening a control; the cap, the visible-page protection, and the
shape guard all still hold.

## V2-30 — SQLite snippet() dropped for Rust-computed snippets (2026-10-25)
Migration 025's search used FTS5 snippet() for result snippets. It
failed to parse in this build's bundled SQLite twice: first with a
Unicode ellipsis separator (`near "…": syntax error`), then with
plain ASCII dots (`near ".": syntax error` at the same argument),
while the identical query parses in Python's SQLite 3.45.1 and the
file bytes are clean ASCII (verified by od). Rather than chase a
build-specific parser quirk, search now runs a plain SELECT with
MATCH and computes snippets in Rust (window around the first term,
<b> markers for every term, ASCII-only marking because lowercasing
can shift byte offsets in other scripts). The UI's <b> marker
contract is unchanged, the round-trip test asserts a marked term,
and the migration verify passes end to end (v24 -> v25, backfill,
search, tab round-trip).

## V2-31 — Call contracts: no invented undefined arguments (2026-10-25)
The tab-restore wiring first passed `restoreBrowserTabId` (undefined)
through the store to the bridge and a null row id through onPageChange
on every create. Two UI tests failed on exactly that: they assert the
bridge is called with exactly (profileId, url) and the workspace is
told exactly the page id for a normal create. The fix is in the code,
not the tests: the store appends the restore id only when defined,
the preload omits the field when undefined, and the surface reports
the row id only when main actually returned one (a reportPage
helper). A normal create therefore still makes exactly the old calls;
a restore carries the extra data. The tests' contract stands.

## V2-32 — Backup bundle now includes the research ledger (2026-10-25)
The Phase 3 investigation found the .cfprofile bundle contained only
the manifest and PDF attachments: the research ledger (sources, texts,
captures), the snapshot files, and browser_tabs were silently dropped
on backup and restore. A backup that silently drops data violates the
quality-first data-integrity mandate, so the bundle was extended
instead of documenting the gap: the manifest gains a "research"
section (sources with texts and captures, plus FTS rows rebuilt on
import), and snapshot files travel as sources/<id>.html entries. The
shell passes its vault dir (userData/vault/sources) into the core
export/import functions, so no path is derived by guessing. Export is
fail-closed like attachments: a missing snapshot, an invalid snapshot
name, or a SHA-256 mismatch aborts the export. Import is graceful
where it should be: a snapshot whose bytes do not match its manifest
SHA is left out (its text survives) and counted in the result's
skipped_snapshots field; a filesystem write error still fails the
import. Snapshot filenames are re-issued to the new source id on
import, so no stale id is ever referenced. The SHA-256 check uses the
sha2 crate (see DEPENDENCIES.md); no other new dependency was
needed. Old bundles (no research key) still import exactly as before,
and bundles exported without a vault carry rows without file
references so they stay self-consistent.

## V2-33 — Phase 3B plan: reuse browser_profiles, default adopts the legacy partition (2026-10-25)
V2-05 (reuse-or-replace the 015/016 tables) is decided: REUSE
browser_profiles. Its columns are generic (workspace id, name,
position, enabled, timestamps) despite the Donut comments around it;
migration 026 adds the 3B settings (color, icon, notes, type,
is_default, proxy mode/host/port/user/encrypted password/bypass,
language, user-agent preset, WebRTC policy, permissions allow list,
GPC, DNT, third-party cookie blocking, clear-on-close, download
folder) plus a partial unique index for one default per workspace.
browser_shortcuts stays untouched as history (3B has no shortcuts).
Every workspace gains a Default browser profile row in 026, and the
Phase 3 browser_tabs rows (browser_profile_id = workspace id) are
repointed to that workspace's default. The default profile ADOPTS the
Phase 3 partition (persist:cf-browser-<workspace>) so existing
cookies survive; the cf-browser name is a Phase 3 artifact kept
deliberately, not a rename miss. New profiles get
persist:pl-browser-<workspace>-<browser id>; temporary profiles get
an in-memory partition (pl-temp-<uuid>, no persist: prefix) and no
database row. Partition names come only from validated internal ids,
never user text. Proxy passwords are encrypted by the shell with
safeStorage before reaching Rust (Rust stores an opaque blob); the
blob never reaches the renderer, never appears in logs or exports,
and a missing encryption capability refuses the password rather
than storing it plain. Per-profile language sets Accept-Language via
a per-session header override (navigator.language stays app-wide:
an Electron limit, documented, not worked around with a page
preload). Third-party cookie blocking is enforced per session via
webRequest header filtering, for the same reason (no Chromium pref
API in Electron). WebRTC defaults to no local-IP leak
(default_public_interface_only). User-agent presets are Chromium
variants only (no fake browsers, no free-text UA).

## V2-34 — Privilege rule: standard rights for every job (2026-10-25, user-ordered, supersedes the /RL HIGHEST part of V2-27)

The scheduler route itself stays (temporary tasks, created, run minimized, verified, deleted in a separate call, job scripts end with plain `exit`), but the privilege token changes. Every new task is created with `/RL LIMITED /IT`: the user's normal token, in the user's logged-in session. Never `/RL HIGHEST` for any job that starts the app, a test server, or a web page. Never raise the agent's own privileges. If a step seems to need administrator rights, stop and ask the user with the exact command and the reason.

Fallbacks, in this order, only if a limited task cannot be created or does not run: (a) the helper, which the user double-clicks once; (b) administrator rights ONLY for build, compile, and unit-test jobs that never start the app, a test server, or a web page, with whoami proof in the log. Anything else that seems to need admin rights is a stop-and-ask, not a fallback.

Every job log starts with the output of `whoami /groups | findstr /i "Mandatory"` plus the date and time. "Medium Mandatory Level" is normal. "High Mandatory Level" is elevated. Results from elevated runs are not final proof: the isolation test and the capture checks must be re-run without elevation, and that run is the proof. The final report states, for every job type, whether it ran elevated, with the log evidence.

Ending a job: `schtasks /End` first (note: a task whose command is `cmd /c start ...` shows Status Ready while its detached job still runs, so /End alone does not end the job). Then end only the processes that job started, identified specifically, never by image name: servers by the PID that owns their listening port (netstat), the app by its verified main-process PID (its child processes exit with it). Verify the app is gone, then delete the task in a separate call and verify the deletion by Query error.

## V2-35 — Run 10: what it proved, what it did not, and why it looked hung (2026-10-25)

Run 10 (task V2P3BIso10, created with /RL HIGHEST before the V2-34 correction) was ended by user order on 2026-10-25, replacing the earlier "let it finish". It did not finish on its own. Archive: `work\run10-archive\` (10 files, copy only: run 10 log up to temp, run 9 report, job script, old done/exit, final log, final report, final exit, and a consistent database snapshot made with the sqlite3 backup API, 532,480 bytes). `schtasks /End` reported success but the detached job kept running, as expected. Servers were killed by port-PIDs (8931 -> 34044, 8932 -> 33472). The app main process (PID 14260) was killed by PID; its four child electron processes exited with it and were "not found" on separate kill attempts, which confirms they were its children, not other projects' processes. App gone was verified (no electron tasks), and the task was deleted and verified gone by Query error.

Lesson, in the user's words: run 10 proved that the capture-handler fix works, and nothing about isolation. A and B both recorded capture-landed=true, and the live database held a real research source with extracted text, so the un-awaited extractPage bug from runs 8-9 is fixed. But that "landed" was misleading for isolation: the captures landed in the Default profile's source, not in A or B sources, because the driver navigated the existing Default page after creating each profile instead of opening a tab in the new profile. The save-source title flipped to "Already" because a /state source already existed, not because an A or B source was created. Run 10's final report (failed=1, driver-error at openBrowserPage for D) is a kill artifact, not a test failure: the error is `page.evaluate: Target page, context or browser has been closed` at clickWorkspaceTab (driver line 52) after the app was killed, and it is preserved as `p3b-iso-report-run10.json` for the record only.

Correction to the earlier "stuck before C" report: the log was buffered, not stuck. Node stdout redirected to a file does not flush every line promptly, so the log showed only up to the temp step for about 90 minutes while the driver was in fact progressing through the temp-to-C interval. After the kill, the flushed log showed profile-C-deleted-in-UI PASS (localId bp-8a2acadc-896b-4e25-bb2c-e34f5c6a10f1, row-remaining=0). Run 10 was therefore progressing slowly through that interval, not stuck before C, and had completed C's deletion by kill time. The exact slow step in that interval cannot be pinpointed from the evidence available: the log has no timestamps, C creation has no step-start record, and the app writes no log. Every Playwright wait in that interval is bounded (about 3.5 minutes total if every step hit its maximum), so the slow step must be an unbounded wait, a renderer evaluate or main-process IPC call made with no timeout set, or a main-process operation that took long. The fix is therefore not a guess at one line: timestamp every log line, record a step-start line before each profile step, bound every evaluate with a timeout race, and add the watchdog and hard limit below, so the next slow run names its step instead of hiding it in a buffer.

Time limits and watchdog, for every job from now on (user-ordered): hard limit 20 minutes for a proof run, 30 minutes for a build or test job. At the limit the job ends itself, ends the processes it started, and writes TIMED OUT and a done flag in its log. Watchdog: if the log gets no new line for 10 minutes, treat the job as hung, save a state report (which step, and a page capture if possible), end the job, and report it. Implementation for proof runs is inside the driver: record() timestamps every line and updates last-activity, an interval checks idle time and elapsed time, and on either limit it writes the state report and TIMED OUT, closes the app with a timeout, and exits with a distinct code; the job script then writes .done/.exit as usual. Build and test job scripts get the same self-limit through a Node watchdog wrapper, written with the next such job, not retroactively.

## V2-36 — Product fix: a created profile opens a tab at once; test fix: the driver asserts the profile, never trusts a title (2026-10-25, user-ordered)

Product fix (step 5): after a browser profile is created in the UI, the app opens a fresh tab in that profile and makes it active, so the user can use it right away. In the surface dialog (where a browser page already exists) the onSaved handler now opens a real page (about:blank) in the created profile with the same openPage + reportPage pattern as the switcher's "Open a new tab in this profile" button, so the pane tab immediately shows a fresh page in the new profile. In the manager dialog (where no browser surface exists) the onSaved handler for a new profile sets it current and opens a fresh Web page tab in the focused pane and activates it (openPageTab, activate: true); that tab is bare until the user navigates, and its first navigation opens in the new profile because new tabs open in the current profile. Edit mode opens no tab: editing settings creates nothing. Tabs already showed their profile color (PaneHeader .tab-profile-dot from page.browserProfile, and the surface address-bar dot); the fix makes the new profile's dot appear at once, because the new tab's page carries the new profile.

Test fix (step 6): the isolation driver no longer navigates the old page after creating a profile (the run 10 flaw). createBrowserProfileViaUI only creates and returns the local id; the caller then opens a tab IN that profile via the switcher's per-profile open button, waits for a page id, and asserts from app state (browser.state() pages, matched by the surface's page id) that the active tab's browserProfile.localId equals the profile under test. The assert runs inside capturePage (so every capture is preceded by it) and after every openTabInProfile (so every navigation and every cookie/storage check that follows is in the right profile). A mismatch throws PROFILE MISMATCH with the active and expected ids, failing loudly; a title flip to "Already" can no longer pass a capture in the wrong profile. Post-quit DB checks are grouped by browser_profile_id from the database (not by title), with two new explicit checks: profile-ids-in-db (A, B, D, F ids present as keys) and localstorage-separation (A text has ls=A, B does not). LocalStorage separation is now real: the test server gained /setls, which sets the probe in the loading profile's storage and goes to /state, so A captures both cookie=probe=A and ls=A while B captures neither. IndexedDB separation is NOT separately captured in ledger text (ledger text is page text only); it holds by partition construction (one persist partition per profile), and the final report must say so, not claim a captured IndexedDB check.

Driver hardening (steps 2-3, same change): every log line is timestamped and written synchronously to fd 1, so the job log can no longer hide progress in a buffer (the run 10 lesson); a STEP line is recorded before each profile step; every renderer evaluate is bounded by a 30-second timeout race (evaluate itself has no timeout, and an unbounded evaluate was the only unbounded wait left in the temp-to-C interval); a watchdog interval checks every 30 seconds and, if the log has no new line for 10 minutes or the run has exceeded its hard limit (20 minutes for a proof run, via P3B_HARD_LIMIT_MINUTES), writes a state report (step, profile, reason, last activity, results so far) plus a renderer screenshot if possible, writes TIMED OUT to the log and report, closes the app with a 10-second timeout, and exits with code 2 (the job script then writes TIMED OUT to the log and .done as usual). Exit codes: 0 pass, 1 test failure or driver error, 2 watchdog/hard-limit timeout.

## V2-37 — One options object for page creation (2026-10-25)

Iso11 proved the failure mode: store `openPage` passed arguments
positionally, so the browser profile id landed in the restore slot and
the page opened in the wrong profile. The fix removes the ambiguity at
every layer, not just at the call site:
- Store `ui/src/shared/stores/browser.svelte.js` `openPage` takes
  exactly one options object:
  `createPage({profileId, url, restoreId, browserProfileId})`.
- Preload `shell/src/preload.cjs` `createPage(options)` copies only
  defined fields among exactly those four.
- Main `shell/src/ipc/browser.js` validates at the trust boundary:
  plain non-array object; keys a subset of the four (unknown key
  returns `{ok:false, reason:"invalid-create-page"}`); `profileId`
  required integer; `url` required non-empty string; `restoreId`
  optional integer (explicit null invalid); `browserProfileId`
  optional string (shape checked by `resolveProfile`). Validation
  reads payload fields directly because `readString` coerces numbers
  to strings.
- Tests `ui/tests/browser-surface.test.js` gained two tests: one
  options object with a non-default profile in `browserProfileId`
  and no restore field; restore and profile in their own fields,
  never swapped.
No test was weakened to get here; the positional call was the bug,
not the test.

## V2-38 — about:blank, per-profile research sources, and the delete freeze evidence (2026-10-25)

Three separate findings, one entry because they were all found by
the same isolation runs:
- Iso12: Rust `valid_tab_url` rejected the exact string
  `"about:blank"`, so `save_browser_tab` threw before insert, main
  tore the page down and returned generic `tab-state-failed`. Fix:
  an `about:blank` special case in `core/src/db/research.rs`, plus
  `detail` propagation so a tab-state failure says why.
- Iso13: research uniqueness was `(profile_id, canonical_url)` only,
  so a second profile capturing the same URL overwrote the first
  profile's row and text. Migration 027 rebuilds
  `research_sources` (ids preserved, FTS valid) with two partial
  unique indexes (`WHERE browser_profile_id IS NOT NULL` /
  `IS NULL`). A plain table UNIQUE failed because SQLite treats
  NULLs as distinct (shell test expected 1, got 2). Migrations run
  it via `apply_with_fk_off` (FK OFF during rebuild, verified by
  `foreign_key_check`, FK ON restored on every path). New Rust test
  `same_url_in_two_browser_profiles_is_two_sources_with_two_texts`
  passes (research suite 29). Migration 027 was edited in place
  during this work only because it was an uncommitted 3B draft never
  applied to any real database; that is not a precedent for editing
  a shipped migration.
- Iso13-16 / Diag2-4 delete freeze, established and no further:
  the delete handler in main does NOT block (Diag3: whole delete in
  main ~92 ms, rm did not throw, DB row deleted; post-delete
  `listProfiles` answered in ~1 ms with the correct count), and
  after that refresh the renderer sends NO further IPC at all while
  renderer CDP becomes progressively unresponsive (backdrop poll
  ~18 s, then DOM count, screenshot and evaluate all time out at
  10-20 s) with zero console errors or pageerrors. CDP input clicks
  still worked after delete. The main-evaluate timeout is a
  consequence of the unresponsive main-window CDP channel, not main
  IPC blocking. The exact JS/native loop inside the renderer was
  NOT proven; code reading found no obvious infinite loop, and no
  specific loop, Rust/DB deadlock, or synchronous rm is recorded as
  proven. (The freeze itself was later explained by V2-40: main
  crashed in the pending-delete path, which killed the CDP channel
  with it. The Diag2-4 evidence above remains the accurate
  contemporaneous record of what was observed before the crash was
  identified.)
- Tab cleanup on profile delete (Iso15 orphans): Rust
  `delete_browser_profile` runs in `with_immediate_transaction`,
  first `DELETE FROM browser_tabs WHERE browser_profile_id=?1`,
  then the profile row. Proven live in Iso16 (no C tab rows) and by
  Rust test `browser_profile_delete_removes_its_tab_rows` (the other
  profile's tab row survives).
- Known gap, not silently fixed: `countKeptResearchPassages`
  (`shell/src/ipc/research.js`) sums kept passages across browser
  profiles for the same URL. UI count only; noted for the final
  report.

## V2-39 — Pending-delete fix for profile deletion (2026-10-25, user-ordered)

The user ordered the exact shape, and the code implements it, part
by part:
- Delete closes every live view of the profile first (awaiting
  each view's clear promise), then `session.clearStorageData()`
  (a failure here still aborts the delete, fail-closed), then
  best-effort `clearCache()`, `clearAuthCache()`,
  `clearHostResolverCache()`, `flushStorageData()` (each guarded by
  typeof + try/catch).
- For `persist:` partitions the name is validated
  (`^[A-Za-z0-9-]+$`) and the folder under `userData/Partitions/`
  is removed. If the folder cannot be removed while the app runs,
  the delete records a pending delete via
  `addPendingBrowserProfileDelete` (recording failure throws
  `pending-delete-record-failed`, fail-closed); `allowPending` is
  true only from the delete handler, never from clear-data on a
  profile that still exists. Delete order is unchanged: optional
  ledger delete, then clear, then `deleteBrowserProfile` LAST.
- Migration 028 adds `browser_profile_pending_deletes`
  (`local_id` PK, `partition_name`, `workspace_profile_id`,
  `created_at`). Rust adds the pending struct and
  add/list/remove functions; the pending-add validates the
  workspace id, the local id, and the partition name (non-empty,
  <=128 chars, ASCII alphanumerics + hyphens only), so a pending
  row can never name a path outside `Partitions/`. Startup
  cleanup runs at registration, before any page can be created in
  a deleted partition; quit cleanup runs on `before-quit`,
  synchronous, best effort, never blocking quit. A row is removed
  only after its folder is gone.
- Rust tests: `browser_profile_pending_deletes_round_trip`
  (including forged partition names `"../evil"` and
  `"pl-browser-1-bp-test-pending;rm"` rejected) and
  `browser_profile_delete_removes_its_tab_rows` (see V2-38).
- CamelCase field bug (Diag11): NAPI `#[napi(object)]` structs
  surface in JS as camelCase (`localId`, `partitionName`). The
  first cleanup version read `partition_name` / `local_id`, which
  are `undefined` in JS, so every pending entry was silently
  skipped. Fixed in both startup and quit cleanup to read
  `partitionName ?? partition_name`, with a comment saying why.
- Diag5 loopback finding: `session.setProxy` IS applied to page
  loads, but Chromium bypasses the proxy for loopback origins
  (127.0.0.1) regardless of the bypass rule (`<local>` default or
  a named bypass). A proxy-through test on a loopback origin can
  never pass; the group-4 test now loads `http://example.com`,
  which the proxy answers with the via-proxy page.
- Diag8 active-page finding: a persistent profile has two live
  pages (a background about:blank page, ready, plus the navigated
  page). Picking the first page in the profile returns the
  background page and hides a failure. Fail-closed holds for the
  active page: a dead-proxy navigation to example.com ends
  `failed` / `load-failed`, no ledger row lands. Group 5 now picks
  the navigated page (URL match, else a failed page, else last).
  The double-page observation itself is unexplained and is noted
  in the final report, not hidden.

## V2-40 — The rm import that crashed main, and the two test-design fixes (2026-10-25)

- Root cause, proven by Diag16 + a local reproduction:
  `shell/src/ipc/browser.js` imported `rm` from `node:fs` (the
  callback API) and awaited it without a callback. That call
  returns immediately without deleting, and rimraf then throws an
  uncaught `TypeError: callback is not a function`, which kills
  main right after window creation. Consequences, all observed:
  the pending folder was deleted by rimraf before the crash, the
  pending row was never removed (cleanup never resumed), the
  renderer CDP channel died with main (firstWindow timeouts,
  /json/list hanging for 5+ minutes on an accepted connection,
  app.close timeouts), and orphan renderer processes lingered.
  Fresh launches never hit it (empty pending list, so
  `removeDirWithRetry` is never called); every pre-seeded launch
  and every group-3 restart did (a pending row was present).
  This single wrong import explained the whole Diag5-16
  firstWindow block and the "delete freeze" of V2-38: main did
  not block on delete, it crashed in the delete's cleanup path.
  Fix: `rm` from `node:fs/promises`, nothing else. Scope check:
  every other `await rm` site in the shell imports from
  `fs/promises`; the sync sites use `rmSync`. Only browser.js
  was wrong, and it was 3B-only code (the delete fix itself).
  Verified by Diag17 (seeded launch, clean code): window in ~1 s,
  folder and pending row both gone at 1 s, clean close, 0
  electrons left. The retry window is now 10 s at startup
  (background, costs nothing user-visible) and 1 s on the delete
  path; with the correct rm the first check normally passes at
  once and the poll is a safety net, not the mechanism.
- Quit cleanup is best-effort, startup cleanup is the guarantee:
  a browsed partition's folder is held by its Chromium session
  until process exit, and `before-quit` runs before session
  teardown, so `rmSync` at quit cannot remove it on Windows.
  Groups run 4 records this honestly as
  `cleared-at-quit=false cleared-at-startup=true`. The security
  property does not depend on quit removal: the profile row and
  tab rows are gone at delete time, a deleted id can never open
  its partition again (resolveProfile rejects it), and a new
  profile sees no old data (group 3, DB-evidenced). The pending
  folder between quit and next start is unreachable through the
  app, and startup removal deletes it before any page can use it.
- Example heading test fix (run 3 to run 4): the real Example
  Domain page's extracted text starts with its body paragraph
  ("This domain is for use in documentation examples..."), not
  its `<h1>`. Checking the heading in the text was a test-design
  error; the group-4 direct check now uses the body paragraph
  (title "Example Domain" in the source row corroborates it).
  Product behaviour was correct in run 3; the test was wrong.
- Main-process integration test (user order, rule 7): there is no
  committed shell test that imports `shell/src/ipc/browser.js`,
  because it imports `electron` directly and cannot load under
  plain `node --test`, and no fake Electron shim was invented to
  pretend otherwise. Committed coverage is the Rust pending/tab
  tests plus the shell/UI browser tests. The app-level
  main-process proof, needing no UI interaction, is Diag17
  (seed via the real core, startup cleanup, window existence,
  clean close) plus groups run 4. The drivers are temporary and
  are deleted before the 3B commit; their results are recorded
  here, in PROGRESS.md, and in V2_REPORT.md.

## V2-41 — Startup cleanup runs only after the window is shown (2026-10-26, user-ordered follow-up to 3B)

- The pending-delete cleanup used to start at IPC registration,
  before the main window existed. It was already async (void), so
  it never awaited the window, but it still ran before first
  paint and its failure mode (the V2-40 crash) had killed main
  before the window could be trusted. The user ordered it moved:
  `register()` now only stores the cleanup on
  `ctx.runPendingDeleteCleanup`; main calls it once, after
  `createWindow()`, guarded by a typeof check. It is safe to run
  late: `resolveProfile` rejects deleted ids, so no page can be
  created in a deleted partition before cleanup runs.
- The pass has a 30 second budget (checked before each entry;
  one entry can run at most 10 s past it) and logs its result:
  `[pending-delete-cleanup] done: entries=... removed=...
  kept=... skipped=... budgetExceeded=... elapsedMs=...`. A row
  left when the budget runs out waits for the next start.
- Regression test (committed):
  `shell/tests/browser-startup-cleanup.test.js` — a source-order
  test in the engine-guard precedent (the IPC module imports
  Electron, so it cannot load under plain node --test, and no
  fake shim was invented): cleanup exposed on ctx, no
  registration-time run, 30 s budget + result log, main calls it
  after `createWindow()`. Gate job V2P3BV41Gate (LIMITED,
  Medium): test exit 0, shell pass 1184 (1181 + 3 new), UI 70
  files / 861 tests, cargo all suites ok.
- Live proof (Diag19, temporary timestamped main-process file
  log, reverted after the run — no diagLog line remains in
  main.js or ipc/browser.js, verified by findstr): four cases,
  every window under 30 s (seeded no-pending 933 ms, seeded
  with-pending 839 ms, app-made first 892 ms / relaunch 770 ms,
  real-flow first 934 ms / restart 818 ms). Case B's log reads,
  in order: WHENREADY_START, DB_INIT_DONE, REGISTER_DONE,
  WINDOW_SHOWN 20:23:55.694, CLEANUP_START 55.716 (22 ms after
  the window), CLEANUP_END 56.297 removed=1. Real flow: delete
  returned pendingDelete=true while running; after quit +
  restart, pending rows = 0 and only the default profile row
  remains. Honest limit: in the real-flow case the folder was
  already gone when the restart check ran, so that case alone
  does not distinguish quit cleanup from startup cleanup — the
  seeded-with-pending case does (its folder survived until the
  startup pass removed it).
- Diag18 (items 4+5, 22/22): proxy bypass `"<-loopback>"`
  removes Chromium's loopback exception — a local /state page
  through the proxied profile returns the via-proxy page, while
  the same proxy without the rule loads direct (isolation
  state) and a profile without a proxy loads direct; example.com
  stays a second proof (via-proxy vs real body). Dead proxy
  with `"<-loopback>"` on a local URL: page failed /
  load-failed, server hit count unchanged (1 to 1), ledger rows
  0; the control (same dead proxy, no rule) loads direct and
  raises the hit count (0 to 1), proving the rule is what
  changed the behaviour. The bypass value passes through to
  `session.setProxy` unchanged (default `"<local>"`).
- Item 3 audit, renderer freeze: the store does NOT keep
  pointing at a deleted profile — `deleteBrowserProfile` refreshes
  via `loadProfiles`, which resets current to the stored choice
  if it still exists, else the default, else the first; a stored
  choice for a deleted id is ignored (the localStorage key
  lingers but is never followed). No effect depends on the
  browser profile id: the surface's `loadProfiles` effect keys
  on the workspace profile id, and the research effect keys on
  workspace profile / page / URL. No looping effect was found.
  A debugger-protocol pause of the frozen renderer was NOT run,
  because the freeze no longer reproduces (groups run 4: the
  post-delete bridge check passes immediately, and every later
  step stays responsive) — pausing a healthy renderer cannot
  produce the frozen stack. PROVEN: main crashed in the delete
  cleanup path (V2-40) and the CDP channel died with it; the
  store resets current; no effect loops on delete. INFERRED
  ONLY, never recorded as proven: whatever renderer-side loop
  (if any) the dead channel looked like from the outside.
