# Progress Ledger v2 — Final Report

Simple English. Every number below was read from a run that actually
happened. Where something was not proven, it says so.

Builds and tests in this report ran on the user's laptop, except for
the items listed under "Work done on the Muse machine" at the end.
Nothing was pushed or published. The repo is
`D:\Muse_Workspace\projects\Progress_Ledger_v2`; commits are named in
each session section below.

## What was built, per phase

- Phase 0: investigation. CareerFlow (commit 568a00d) copied
  read-only (813 files, 13.88 MB, 0 failed). Verdict: GO WITH
  CHANGES. The untracked `project-intel/index.js` was protected
  byte-for-byte; a fresh clone cannot run without it.
- Phase 1: baseline. 442 packages, 27 vulnerabilities (1 low,
  5 moderate, 16 high, 5 critical). Shell 1390 pass, UI 72 files,
  cargo ok, core rebuilt. Lesson recorded: npm 11.19 gates install
  scripts, and Electron's `path.txt` must be the bare filename
  with no trailing newline.
- Phase 2: rename to Progress Ledger (338 files, 2378 replacements;
  runtime identity uses `-v2` suffixes). Donut/CDP fully removed.
  Inter latin and Cascadia Mono bundled offline. Build ID
  (git hash + ISO time) shown in the status bar. 7 B6 bugs fixed;
  2 carried to Phase 5 (Degree header overlap, sidebar highlight
  lag).
- Phase 3: embedded browser. TypeScript extraction island, research
  capture with main-attested provenance, research text with FTS5,
  LRU hibernation (live cap 5), tab restore, backup bundle now
  includes the research ledger and snapshots. Proof: page load
  298 ms, tab switch 41 ms, capture pixel-exact teal #1F7A8C.
- Phase 3B: multiple isolated browser profiles. Migrations 026
  (profile settings, Default row per workspace, live cap 5),
  027 (per-profile research sources), 028 (pending deletes).
  Options-object page creation, about:blank fix, pending-delete
  fix, and the rm-import crash fix (a callback API awaited
  without a callback killed main after window creation).
  Isolation groups runs 4 and 5: 54/54.
- V2-41 follow-up: startup pending-delete cleanup moved to after
  the main window is shown (30 s budget, result log). Diag18
  proxy and Diag19 startup cases green (22/22 and 16/16).
- Solo session A: 3B-6 close-out verified. No p3b/diag driver is
  tracked in the repo; isolation logic is proper tests.
- Solo session B: crash safety. A main-process crash handler
  (no Electron import, injected deps) logs uncaught exceptions
  to `<userData>/crash-logs/`, shows an error box and quits;
  unhandled rejections log and show a box without quitting.
  5 tests.
- Solo session C: async audit. All 40 files in shell/src/ipc
  plus browser services read. No new V2-40-class bug. A source
  check test (4 tests) now guards this.
- Solo session D, Phase 4: shared layout module, overlay flag
  fix, security and multitasking proofs. See Layout and
  Phase 4 proof below.
- Solo session E, performance: measured with the EF driver.
  See Performance below, including the honest off-screen
  page-open caveat.
- Solo session F, Phase 5: real-app browser proof, screenshot
  rounds, profile UI, targeted shots, desktop proof. See
  Screenshots below. The desktop screenshot is VERIFIED.
- Solo session G, finish: rename test, offline check,
  dependency audit, DESIGN check, accessibility, full suite,
  production build. See V2-47 in docs/DECISIONS.md.
- Solo session H: this report.

## Packages added

- Phase 3 only: typescript 5.9.3 (npm) and sha2 0.10 (cargo).
- Solo session A–H: NONE. `npm audit fix` in G updated existing
  versions in package-lock.json only; it added no package.

## Browser feature table

- Back / forward: in the browser bar and in the pane trail;
  covered by the navigation security specs (12 pass).
- Reload: browser bar reload, covered by the same specs.
- Address bar policy: only allowed URLs load. `file://` and
  internal schemes (including `progressledger-v2://`) are
  refused; the registry checks the URL before the live cap.
- Tabs: create, switch, move between panes without reload,
  restore after restart in their own profile.
- LRU hibernation: at the live cap, a background page sleeps
  and a new page is created; a popup is refused with
  `live-cap-reached` only when no background victim exists
  (all pages visible). Live cap default 5, per workspace,
  clamped 1 to 20.
- Capture page / capture selection: both land in the Research
  ledger. EF run 3: capture page sources=1, capture selection
  captures=1 with EFSELECT present.
- Research ledger: search (FTS5), delete, snapshot vault with
  SHA-256, per-profile sources since migration 027.
- Profiles: Default adopts the Phase 3 partition; new profiles
  get their own `persist:pl-browser-` partition; the manager
  shows Default plus created profiles; delete asks first and
  offers to delete ledger entries too.
- Temporary profiles: in-memory only, no DB row, no tab row;
  the browser bar shows an amber "Temporary" pill.
- Proxy: per-profile proxy setting, passwords stored as
  safeStorage-encrypted blobs, never shown to the renderer.
  Loopback bypass uses `<-loopback>` (plain bypass rules do
  not stop Chromium proxying loopback). A proxied page whose
  proxy setup fails is marked FAILED, never loads direct.
  A dead proxy fails closed (load-failed, no ledger row).
- Permissions: deny by default; only camera, microphone,
  geolocation, notifications, fullscreen and
  clipboard-sanitized-write are grantable. Covered by the
  permission guard in the navigation security specs.
- Popups: opened as unfocused tabs in the same profile, with
  a per-load budget of 2. Covered by the popup specs (8 pass).
- Fullscreen scoping: covered by navigation-security test 10
  ("fullscreen is scoped to the page that is on screen"),
  which passed in the final 24/24 run.
- Downloads: present in the browser code, but not separately
  re-proven in the solo session. Not claimed as proven here.

## Isolation table

Evidence: groups runs 4 and 5 (54/54 each, fresh app and
throwaway data dir per group) plus the Phase 4 isolation
specs (4 pass, including a restart test).

- G1 separation: cookie, localStorage, sessionStorage,
  IndexedDB and cache are separate per profile; the same
  profile reuses cache, another profile does not see it.
- G2 temp: temp tab rows 0, temp profile rows 0, only the
  boot partition present after a temp session.
- G3 delete: profile row gone while running and in the UI;
  folder pending while running; after quit, profile row 0,
  tab rows 0, ledger kept when the checkbox was unchecked;
  the pending folder is cleared at startup (not at quit,
  because Chromium holds a browsed partition until exit).
- G4 proxy-only: the proxied profile sees only the via-proxy
  page; the direct profile sees only the real page body.
- G5 dead proxy: page failed (load-failed), ledger rows 0.
- G6 forged names (`../evil`, `bp-../../evil`,
  `persist:evil`, `bp-;rm`, empty string): each rejected as
  `unknown-browser-profile`, page count unchanged, no evil
  partition directory created.
- Phase 4 isolation specs add: tab restore in its own profile
  after restart, and two contexts sharing one profile sharing
  one boundary.

## Performance numbers

- Phase 3 on-screen baseline: page load 298 ms, tab switch
  41 ms, 1 live page about 588 MB, about 5 pages about 968 MB,
  idle CPU about 0%.
- EF run 3 (solo session E, off-screen E2E window): tab switch
  852 ms (includes the driver's fixed 800 ms sleep; the
  switch itself was bp-2 to bp-1, a real switch). Resize
  followed the window (surface 1170x556 to 810x419 after
  resizing to 1024x640). Divider drag moved pane widths
  [591,591] to [710,471]. Memory at the split stage:
  totalWorkingSet 630,856 KB (about 616 MB) with 6 tab
  processes. Idle CPU about 0% (0 to 0.0066 over 5 s).
- Page-open caveat, stated plainly: EF page-open measured
  61,626 ms and 61,607 ms (run 2: 61,644 ms). That is the
  off-screen E2E window: the first navigation's page-id
  element takes about 60 s to appear while the window is
  off-screen and throttled. Do not quote 61.6 s as the app's
  page-open speed. The honest on-screen number is Phase 3's
  298 ms. Tab switch, resize and drag in the same EF run
  were fast, which fits a first-navigation throttle, not a
  slow browser.
- Engine guard: the shell suite's engine-guard test (fails on
  `<webview>` or BrowserView) passed in the D gate.

## Layout numbers

Measured live (job V2D4Measure, window 1386x779, device pixel
ratio 1.25). The numbers sum to the window height exactly.

- Titlebar 46, rail 216 wide, context strip 34, context
  header 52, pane header 34, pane body from y=166, status
  bar 26, operator dock about 31, split handle 4 px.
- Shared module: `shell/src/shared/layout.js` (plain JS,
  main side; the renderer measures its own surface box, so
  there is no second copy). Browser surface rect in EF run 3
  matched exactly: x=216, y=166, width 1170, height 556.
- Window minimum: `createWindow` enforces NO window minimum.
  The module records a USABLE floor of 1024x640 for tests
  and screenshots only.
- Overlay fix (real bug found in D): toasts, the global
  confirm dialog and both browser dialogs were not in App's
  `occluded` derived value, so a native page would have
  painted over them. Fixed through `onBrowserOverlayChange`
  (App to PaneView to BrowserSurface/BrowserProfiles), with
  a regression test. Main's `host.setOccluded` already
  existed.

## Phase 4 proof

32/32 Playwright specs green, no product code changed. Every
failure was pre-3B spec drift, fixed in the specs with the
assertions kept or strengthened (see V2-44):

- Navigation security 12, popups 8, profile isolation 4:
  24/24 in run 5.
- Workspace integration 5, arrange menu 3: 8/8 in run 8.
- Drift examples: the "Profiles" button selector matched the
  newer "Browser profiles" item first (substring match);
  positional `createPage` is refused since V2-37, so specs
  now use the options form; the scheme name is
  `progressledger-v2:`; the live cap default is 5, not 4;
  a forged id is refused as `invalid-create-page` before
  lookup; the popup-cap premise was false under LRU
  hibernation, so that test now sets the cap to 1 through
  the app's own bridge and asserts `live-cap-reached`.
- Multitasking covered: Arrange / Split / Immerse, tab move
  between panes without reload, overlay-hides-page
  screenshot test, tab restore in its own profile.

## Screenshots

Renderer screenshots never show the native page (black page
area: Playwright cannot composite a WebContentsView). Page
content is proven by capture-to-ledger, throwaway DB rows
and the desktop shot. All shots live in the task work
folder; the verified desktop shot is also saved locally as
desktop.png.

- Round 1 (EF driver): 01 dashboard, 02 browser page,
  03 two tabs, 04 resized 1024x640, 05 split one pane,
  06 split two profiles, 07 split after drag, 08 profile
  manager over the browser surface, 09/10 manager view.
  Viewed: 02 (two runs), 05, 06, 08. Problems found: none
  in layout, text or colour. Four observations recorded,
  not defects, not changed without the user: (a) the
  context header and rail follow the last rail navigation,
  not New-tab-menu tab creation; (b) the profile pill is
  workspace-wide ("profile for new tabs"), not per page,
  so both split panes showed the last-selected profile
  name; (c) the browser bar shows the URL twice (small
  static label plus editable input); (d) the Research
  ledger drawer was closed in the split shots.
- Round 2, targeted: 11 Degree empty state, 14 at
  1920x1080, 15 at 1024x640, 23 rail immediate, 24 rail
  settled. Degree: clean empty state, no header overlap
  seen. Sidebar highlight: after clicking the Labs pane
  tab, the immediate shot already showed Labs active and
  the settled shot agreed, so no lag seen. 1920x1080 and
  1024x640: clean.
- Round 3, profile UI: 16 new-profile dialog, 17 switcher,
  18 manager with Default plus two created profiles,
  19 temporary pill, 20 delete confirm, 21 proxy setting,
  22 final. The delete confirm shows the ledger checkbox
  ("Also delete 0 ledger entries...") and the danger
  Delete button; the driver pressed Cancel, so nothing
  was deleted for the shot. The proxy setting shows mode
  HTTP, host 127.0.0.1, port 8932, bypass `<-loopback>`.
  Driver fixes in this round (not product bugs): the
  switcher needs a page-bearing surface (the manager is a
  view and has no switcher), and the switcher menu toggles
  rather than closing on Escape.
- Desktop proof (V2-46, job V2Desktop4, 07:08 IST): VERIFIED.
  The real desktop screenshot (176,600 bytes) shows the
  v2 app window in front, with the real /state page
  (isolation state lines) rendered inside the pane
  rectangle, workspace "DESK" selected, status bar build
  37ed06e. This supersedes the V2-28 NOT VERIFIED verdict
  for the page-on-desktop claim. No check-ui.bat is needed.
  Driver fixes on the way there (not product bugs):
  select the workspace profile before creating a tab, and
  raise the app window with setAlwaysOnTop + focus +
  moveTop, because the v2 window opens behind the user's
  already-open maximized browser and Playwright
  bringToFront is page-level only. A diagnostic screenshot
  in that round contained the user's private desktop; it
  was deleted from both machines immediately after the
  diagnosis and is never attached or described.
- Screenshot problems fixed, per round: round 1, none in
  the product (driver route and tab scoping fixed only);
  round 2, one driver premise fixed (the Study context
  has no Project pane tab, so the lag test used Labs);
  round 3, two driver premises fixed (switcher surface,
  switcher toggle); desktop round, two driver fixes above
  plus a silent flag-handshake failure replaced by a
  driver that takes its own screenshot and records the
  size or the error.

## NOT PORTING / NOT BUILT

- No fingerprint spoofing, no evasion, no Donut/CDP
  integration, no telemetry, no local AI hosting, no
  GitHub publishing or pushing, no cloud sync, no WebDAV,
  no updater calls at startup.
- Not ported from CareerFlow: the Donut browser manager
  and CDP layer, and any CareerFlow-only UI. The v2 browser
  is the embedded WebContentsView browser built in Phase 3.
- Not built in this run: a profile test button in the UI
  (testProxy exists in the store and bridge only; the
  proxy test in F ran through the app's own bridge and
  returned {ok:true, status:200} through the local proxy),
  and a per-page profile pill (the pill is workspace-wide).

## PARKED items

No PARKED.md file exists in the repo. This was checked by
directory listing and by git ls-files; the only PARKED
reference in the repo is the rule defining it in
docs/DECISIONS.md. Nothing was time-boxed out and parked
during the solo session. Items that are not finished are
listed in the next section, not hidden in a parked file.

## NOT FINISHED / NOT VERIFIED

- Lock-screen test: CANCELLED by the user (not a gap).
  The screen stays unlocked and the laptop stays on.
- `countKeptResearchPassages` sums kept passages across
  browser profiles for the same URL. UI count only; the
  underlying per-profile data is correct. Needs a Rust
  join to fix; deliberately skipped.
- Double live page per persistent profile: a background
  about:blank page plus the navigated page. Unexplained.
  State checks pick the navigated page, never the first.
- Quit-time pending-delete cleanup is best-effort only:
  a browsed partition folder is held until process exit,
  so quit removal normally fails and startup removal is
  the guarantee (proven by groups runs 3, 4 and 5).
- Degree header overlap: checked only on the empty state
  (clean). The with-data semester-header case was not
  reproduced with throwaway data and is not claimed
  closed beyond the empty state.
- Temporary-profile bridge check: `browser.state()` pages
  carry no `temporary` flag, so the bridge cross-check
  failed on shape only. Temp evidence is the amber
  "Temporary" pill screenshot plus the groups G2
  evaporation proof.
- EF page-open 61.6 s: off-screen throttle artifact, not
  the app's speed (see Performance). On-screen number
  remains Phase 3's 298 ms.
- Katex low vulnerability (GHSA-238p-pmpm-9mq7): fix needs
  `--force` and a breaking change to katex@0.19.1. Not
  applied; recorded in V2-47 as the safest option while
  the user is away.
- Text size exception: the `--text-micro: 10px` token in
  ui/src/app.css:142 remains and feeds meta labels across
  the app. All literal 10px font declarations in the
  browser components were raised to 11px. A strict "all
  text >= 11px" claim is therefore NOT made; the token
  is the documented exception (see V2-47).
- Screenshot observations (a) to (d) in Round 1 above:
  recorded, not fixed, not claimed as defects.
- Downloads: not separately re-proven in the solo session
  (see Browser feature table). Fullscreen scoping IS
  covered (navigation-security test 10, passed).
- The installed Progress Ledger app (separate product)
  still runs pre-redesign schema-7 code; its migration
  reaches it only through a future installer build, never
  by repeating the dev-to-installed cutover. Out of scope
  for v2, noted so it is not mistaken for a v2 gap.

## Job privilege evidence

Every scheduler job in this build ran at standard rights:
`/RL LIMITED /IT`, in the user's session, started minimized.
Every job log starts with a whoami Mandatory line, and
every log in this build shows "Medium Mandatory Level".
No v2 job ran elevated, and no v2 job raised privileges.

Solo-session jobs (all /RL LIMITED /IT, Medium):
V2A6Gate, V2BCGate, V2BCGate2, V2BCGate3, V2D4Measure,
V2D4Gate, V2D4Proof, V2D4Proof2, V2D4Proof3, V2D4Proof4,
V2D4Proof5, V2D4Proof6, V2D4Proof7, V2D4Proof8, V2EF, V2EF2,
V2EF3, V2Targeted, V2Targeted2, V2ProfileUI, V2ProfileUI2,
V2ProfileUI3, V2ProfileUI4, V2Desktop, V2Desktop2,
V2Desktop3, V2Desktop4, V2GChecks, V2GFix, V2GFinal.
Each was deleted after its result was verified, except
V2GFinal, which is deleted at close-out below.

At close-out, a final schtasks sweep for V2* tasks is
recorded here: run at close-out: no V2* scheduled task remained (each deletion verified by a Query error, including V2GFinal). No Electron, node or cmd windows
from jobs were left running: the gate job ended with its own `exit`, its .done flag and exit files present, and no job window was left open; the job task itself was deleted.

The user confirmed on 2026-10-26 that agent jobs may run
as administrator when a job actually needs it. That
permission was NOT used for v2: every v2 job above ran
limited, including build and test jobs.

## Work done on the Muse machine (not the laptop)

Reading and writing docs and code, local PNG and colour
math including the WCAG contrast computations, local
Python sqlite3 reproductions and proofs, local `node
--check` syntax checks, a local curl smoke test of the EF
test server, and local `node --test` runs of the new
crash, async-guard and layout tests against audit copies
and fake trees. All builds, full test suites and app runs
were on the laptop.

## Decisions register

docs/DECISIONS.md holds V2-33 through V2-47. V2-47 is the
G record. Earlier decisions that still govern: V2-21
(Phase 3 merge and its 10 conditions), V2-34 (privilege
rule), V2-37 (options-object page creation), V2-39
(pending-delete fix), V2-40 (rm-import root cause),
V2-42 (solo-session rules), V2-43 (Phase 4 layout and
overlay), V2-44 (Phase 4 proof spec drift), V2-45 (EF
driver lessons), V2-46 (desktop proof).

## Second solo session (2026-10-26, from 13:22 IST, items 1-12, background-only from 14:11 IST)

Twelve items in a fixed order, worked alone while the user was away.
From 14:11 IST everything ran in the background only: no visible app
window, no desktop screenshot, all jobs minimized at low priority.
Every job ran /RL LIMITED /IT with the whoami Mandatory line at the
top of its log; every job log showed "Medium Mandatory Level"; no job
ran elevated; every task was deleted after use and verified gone by
Query error. Jobs used in this session: 15 (V2DistDir, V2Degree,
V2Degree2, V2MinWin, V2TextSize, V2DlPages, V2ProfKept, V2CargoKept,
V2Cargo2, V2DeskFinal, V2DeskFinal2, V2Gap, V2Final, V2Gap2, V2Repack).

1. Way to open the app: packaged build via npm run dist:dir; Desktop
   launcher `C:\Users\Asus\Desktop\Progress Ledger v2.bat` (a .bat was
   chosen over a .lnk for safety/transparency); it starts the packaged
   exe as the normal user, builds only if the exe is missing, sets no
   test flags. README_RUN.md documents run, data folder
   %APPDATA%\progress-ledger-v2, reset, and window-not-appearing steps.
2. Degree screen with real data (1 degree, 4 semesters, 16 subjects,
   CGPA 8.77) at 1024x640, 1386x779, 1920x1080 plus a toast shot: no
   header overlap, no clipping, toast above the status bar. No fix.
3. Minimum window size 1024x640 from the shared layout module, with a
   test that fails if the module and main ever differ (mutation-proven).
4. No text below 11px: --text-micro 10px to 11px, both 8.5px captions
   to 11px, two risky em rules fixed, source guard test added; live
   minimum computed font size exactly 11px; live clamp 1027x642.
5. Downloads proven to the managed workspace downloads folder in
   persistent and temp profiles, correct content, absent from OS
   Downloads, never auto-opened; temp downloads persist as workspace
   files by design.
6. No phantom second live page: state, debug snapshot and webContents
   agreed 1:1:1 per tab at every step; the earlier double was two tabs,
   one left blank (cost ~65-80 MB per stray tab, capped by LRU).
7. Profile screens: Test proxy button in the edit dialog (live
   "Proxy test OK (HTTP 200)"), browser bar shows dot + profile name,
   title span no longer duplicates the URL, delete confirm carries
   the exact new leftover-files sentence.
8. Kept count is per browser profile (live 2 vs 1, old code 3 for
   both), new Rust test 1/1; temp bridge check fixed by creating a
   tab after selecting Temporary; validator now accepts temp- ids
   (V2-53), which fixed temp-page research capture.
9. Real desktop proof on the final build: status-bar build aaf781e
   equals newest commit aaf781e, real /state page, Capture page +
   Capture selection in the ledger (2 sources, 2 passages), temp kept
   count live = 1, shot cropped to the app window, full-desktop image
   deleted at once.
10. Cleanup: only the three approved paths deleted (cf-build 2,053
    files / 488,962,652 B; pl-test/node_modules 19,377 files /
    707,241,273 B; pl-test/throwaway-data 3 files / 465,376 B;
    total ~1,196,669,301 B freed). REPORT.md and everything else kept.
11. Feature gap report (docs/FEATURE_GAP.md, read-only, nothing
    built): 61 documents from the CareerFlow and Progress Ledger
    trees; most planned features are done in v2 by inheritance;
    missing are sub-agent telemetry read IPC, ledger Attach file, MCP
    tool execution (deliberately unwired), hooks emit wiring
    (dormant by design), OS directory picker; see the report for the
    full table and the top 10 in build order.
12. Final checks (this section): docs/SCREENSHOTS.md lists 34
    screenshots in 8 sets; final gate (job V2Final) npm test exit 0
    (shell 1204 pass / 0 fail, UI 70 files / 861 tests, cargo suites
    ok) and npm run build exit 0; everything committed, then the app
    re-packaged from the final commit (job V2Repack, dist:dir exit 0);
    git status clean after packaging; packaged build ID verified
    against the final commit hash from the built output without
    opening any window; Desktop launcher verified by properties only
    (not launched); no scheduler tasks or job windows left running.

Production audit note: still 1 low only (katex, breaking fix
deliberately not applied, see V2-47). No new packages were added in
this session. No PARKED.md was needed: no problem hit the 30-minute
limit except the whole-D: gap search, which was narrowed and
completed rather than parked.

## Audit + continue session (2026-10-27, branch v2-continue)

Worked alone under the user's rules: standard rights only
(/RL LIMITED /IT, whoami Mandatory line at the top of every job log,
every log showed "Medium Mandatory Level", no job elevated), nothing
in front of the user (all jobs minimized, all app runs off-screen,
no desktop screenshots), no touching the user's running app or Brave
browser, no push, no remotes, no reading or resetting real app data.
Every scheduler task used here was deleted after use and verified
gone by Query error (V2Audit1, V2Audit2, V2Shot9 leftover, V2Mgr1,
V2Mgr2, V2Chat1, V2Chat2, V2Chat3, V2Guard1, V2Site1, V2Site2, V2Site3,
V2Gate1). The user's part-session loss (ChatGPT changes) was already
captured on arrival: HEAD was 2e87673 "Snapshot" on v2-continue, so
no new snapshot commit was needed.

1. Stage 1 audit (docs/CHANGES_SINCE_D6553A3.md, commit aefb61f):
   29 files changed since d6553a3 — GOOD 13, NEUTRAL 16, RISKY 0,
   BROKEN 0, UNKNOWN 3 (three pre-existing non-V2 scheduled tasks
   left running, removal commands documented). No security setting
   changed, no dependency changed, no schema change. Tests on the
   snapshot: shell 1204/0, UI 71 files / 875 tests, cargo 122/0,
   build exit 0.
2. Stage 1B cleanup: no reverts required — nothing weakened
   security, added an unvetted network call or package, or broke
   the build.
3. Stage 2.1 profile manager (commit 43804a8): search box, sort by
   name, Open (play) per row, double-click to open, right-click
   menu (Open, Open details, Set as current — renamed from "Use
   for new tabs", Rename (F2), Duplicate settings, Copy ID, Clear
   data, Delete with the existing confirm wording), tabbed details
   side panel (Overview with ID + copy button, data size, and
   clear-data-on-close; Network with proxy + Test proxy; Start
   pages one per line), start pages opened on Play (first URL
   focused, up to 10 total). New migration 029 (start_pages) and a
   partition-size measurer (symlinks never followed, capped).
   Verified: UI 71 files / 884 tests, core 124, shell green, build
   exit 0, manager/play/split E2E specs green. Two test-only fixes
   were needed on the way (a duplicated Rust test module and three
   jsdom tests using a non-existent fireEvent.update); no product
   code was weakened for any test.
4. Stage 2.2 ChatGPT "Unable to connect" (verdict C — session /
   network, not an app bug, not a site refusal): chatgpt.com loads
   in the app's Default, brand-new, and temporary profiles (~2 s,
   correct title, default settings). In a bare Electron window
   (same Electron 44.9.3, default settings), the page loads
   (document 200, HTTP/2, cookies set, no service workers) and an
   anonymous message receives a real assistant reply. The only
   failed requests were 13 aborted analytics beacons; no console
   errors, no page errors, no WebSocket use. The user's logged-in
   send failure was not reproduced in any test arm, and the user's
   own logged-in profile was never touched, so a logged-in-only
   app-view issue cannot be fully excluded — but there is no
   evidence for it. One early bare-window launch timed out at
   180 s; the smoke test and the rerun both launched it in under a
   second (transient harness issue).
5. Stage 2.3 site table (docs/SITE_COMPAT.md): example.com, Wikipedia,
   GitHub work; Google search partly (Google serves its /sorry
   unusual-traffic check, trigger not isolated); YouTube works
   (video plays, audio decodes; Electron codec limits noted);
   PDF fails (bytes arrive as application/pdf but the viewer never
   renders — zero viewer elements after 30 s, page capture times
   out); download works (file lands in the profile's download
   folder); local login form works; camera/microphone denied with
   NotAllowedError. The first PDF probe used a dead public URL, so
   the valid test used a locally served minimal PDF.
6. Stage 2.4 deferred ideas (docs/FUTURE.md): cookie import/export,
   profile transfer, per-profile logs, request viewer, password
   protection of profile data — each with its risk note. Fingerprint
   settings, sync, launch hook, 2FA codes, extensions, VPN/DNS, and
   a debugging endpoint were not built, by decision.
7. Stage 2.5 Proof workspace: the real app data contains
   spec-created workspace profiles ("Browser Phase Two", created by
   e2e/browser-workspace-integration.spec.js:120, proves test runs
   reached real data). Mechanism: main ignored Chromium's
   --user-data-dir for app.getPath("userData"), so any driver that
   launched the app without PROGRESSLEDGER_V2_E2E_USER_DATA fell
   through to %APPDATA%\progress-ledger-v2. The exact driver that
   created "Proof 1792878075719" was not identified (no current
   driver uses that name; it may come from the lost ChatGPT
   session) — real data was never read to check, per the rules.
   Guard added (shell/src/main.js + shell/src/e2e-data-guard.js):
   test mode refuses to start, with exit code 1 and a REFUSING
   message, when the resolved data path equals the real folder or
   sits inside it — including test mode with no override at all.
   Guard unit tests 5/5, shell 1212/0, guard E2E spec green (the
   first version failed only because Playwright reports the
   refusal as a launch error; the spec now accepts that shape).
   README_RUN.md gained safe in-app delete steps for the Proof
   workspace; nothing in real data was deleted or reset.
8. Final gate (job V2Gate1, on commit 477d0a1): npm run test exit 0
   (shell 1212 pass / 0 fail, UI 71 files / 884 tests passed,
   cargo 124 passed), npm run build exit 0, manager/play/split/
   guard E2E specs exit 0. The diagnostic specs (chatgpt, site,
   pdf) are skipped in a normal suite run unless their bare-driver
   env var is set, so a full suite run stays green.
9. Packaging runs from the report commit (this commit): the UI
   build bakes the commit's short hash into the status-bar build
   ID, so the packaged build ID equals this commit. Folder,
   shortcut target, and old-folder size are in the session's final
   message, not here, because the folder name carries this
   commit's hash.

No PARKED.md was needed in this session: no problem hit the
30-minute limit. Not verified: the PDF viewer in a visible window
(prohibited by the task rules — all probes ran off-screen); the
logged-in ChatGPT send in the app view (would need the user's own
logged-in profile, which was never touched); the exact driver that
created "Proof 1792878075719" (see item 7).
