# Browser Profile UX — Final report (2026-10-26 evening IST)

Task: Browser Profile Manager UX + embedded-browser launch workflow,
Progress Ledger v2, autonomous session. Branch `main`, base HEAD
`d6553a3`. NOTHING was committed, staged, pushed, reset, stashed,
or cleaned (per task §13). All changes below are uncommitted
working-tree changes, listed separately from the clean baseline.
All jobs ran minimized, low priority, `/RL LIMITED /IT`, with the
whoami Mandatory line first, and each task was deleted after use
and verified gone. No visible app window was ever opened (the user
was browsing); real-app validation used the off-screen E2E mode
only. No other project was touched; no backup or git remote was
created.

## What was built

- Play button on every profile row (persistent + temporary).
  Clicking it creates a real embedded page via the existing browser
  store with the clicked row's explicit `browserProfileId` and
  `about:blank` (the surface switcher's established blank-page
  convention), then opens a workspace tab carrying the returned
  page id in the pane focused at click time, activates it, focuses
  the pane, and records the restore row id when main returns one.
  The global current profile is never consulted and never changed
  by Play.
- Failure honesty: a refused create opens no tab and shows the
  reason in the manager notice; a page orphaned by a vanished pane
  or a profile deleted mid-flight is closed again (only that page);
  component unmount mid-flight tears the page down; per-row busy
  state ("Opening…", disabled) ignores repeat clicks.
- Row redesign: Play (primary) + ⋯ menu button; the redundant
  Color column is gone (the dot carries identity); secondary
  actions moved into a profile-specific menu opened by the ⋯
  button or by right-clicking the row (cursor-anchored,
  role=menu/menuitem, arrows/Home/End, Escape returns focus,
  pointerdown-outside closes). Menu items capture the profile at
  open time, so a current-profile change mid-menu cannot retarget
  them.
- Menu actions: Profile information, Use for new tabs (unchanged
  semantics: sets the default for ordinary new tabs), Edit settings
  (existing editor), Duplicate settings (existing workflow),
  Clear browsing data (now a confirm dialog, replacing the
  two-click button), Delete profile (existing confirm dialog).
  Temporary rows offer only information + use-for-new-tabs, as
  before.
- Read-only information view (`BrowserProfileInfo.svelte`, built on
  the `Modal` primitive): name, color, type, default, notes, proxy
  mode/host/port/username/bypass, privacy toggles, permissions,
  language, user-agent preset, WebRTC policy, download dir,
  created, last used. NO password field of any kind is rendered.
- Redundant launch step removed (manager only): creating a profile
  now stays in the manager with a success toast ("Press Play to
  open it.") instead of switching the current profile and opening
  a bare tab that showed nothing until navigation. The surface's
  own new-profile flow (opens a real page in the same tab) is
  untouched, as is the surface switcher's per-profile open button.
- Last-used fixed: main now calls the existing NAPI
  `touchBrowserProfile` after every successful persistent page
  creation (fresh + restore paths), guarded so a metadata failure
  never fails the page. Temporary profiles are skipped (no row).
- Pre-existing bug fixed in scope: the manager called `toast(...)`
  as a function in 4 places although `toast` is an object; success
  feedback never showed and a successful delete left its dialog
  open. All four now use `toast.success`.

## Files changed (task-created only)

- M `shell/src/ipc/browser.js` (+11 lines: touch helper + 2 calls).
- M `ui/src/features/browser/components/BrowserProfiles.svelte`
  (Play, menu, clear dialog, toast fixes, new-profile flow).
- NEW `ui/src/features/browser/components/BrowserProfileInfo.svelte`.
- NEW `ui/tests/browser-profiles-play.test.js` (14 tests).
- NEW `e2e/browser-profile-play.spec.js` (2 real-app tests).
- NEW `docs/browser-profile-ux/` (BASELINE.md, REPORT.md, job logs;
  evidence only, no product code).

## Checks (all on the laptop, /RL LIMITED /IT, minimized jobs)

- Baseline (before changes): UI 70 files / 861 tests pass; shell
  1204 pass / 0 fail. No pre-existing failures.
- Focused (after changes): new UI tests 14/14 + browser-surface
  22/22 = 36 pass.
- Full gate: checks ipc/napi/esm pass; UI suite pass (71 files
  incl. the new one); cargo pass; production build pass.
- Shell suite first run: 1203 pass / 1 fail — the overlay-guard
  source test, because the rewritten effect call no longer
  contained the literal `onBrowserOverlayChange(dialog`. The
  behavior was correct (broader, not narrower); the fix reformats
  the call to one line and the guard passes (OVERLAY 0, Play UI
  14/14 re-verified). Full shell re-run after the fix: 1204 pass
  / 0 fail (SHELL2 0).
- Security review: no change to URL validation, partition
  derivation, IPC allow-list, permission policy, or navigation
  rules; Play passes only an opaque localId main re-validates;
  unknown/deleted profiles are still refused; no new packages;
  no secrets reach the renderer (info view renders none; main
  still strips password blob/plain).
- Text-size floor: new styles use 11–13 px font sizes only; the
  10 px profile dot is a box size, as before (guard checks
  font-size only) — full UI suite green covers it.
- `git diff --check` clean; `git status` shows only the files
  listed above. `test-results/` is gitignored (Playwright
  failure artifacts from the two failed E2E runs were left in
  place on the laptop, not in the repo).

## Real-app validation (off-screen E2E, no visible window)

- Run 1: FAILED at profile creation via the manager UI — dialog
  showed `unknown-profile`. Root cause (spec bug, not product):
  the E2E boot state has no active workspace profile (status bar
  "workspace: none"), so the manager's profileId was invalid.
- Run 2: FAILED at profile selection — no `button.profile-main`
  card exists in a fresh dir. Root cause (spec bug, not product):
  a fresh dir has no workspace profile at all; the isolation
  spec's card pattern only works after creating one via the
  bridge. Fix: the spec now creates a workspace profile via the
  bridge, reloads, then selects it through its card (the isolation
  spec's own pattern). No product code changed for either failure.
- Run 3: PASS — 2 passed (Play test 5.0 s, menu/info test 3.6 s).
  Proven in the running app: Play-B opens a page tab showing
  profile "Play-B" while the switcher still reads "New tabs open
  in Play-A"; B's page writes a probe cookie/localStorage value
  that A's Play-created page cannot see, while the snapshot shows
  two distinct partitions; both played profiles' Last-used cells
  leave "Never"; a synchronous double Play click adds exactly one
  page; right-click menu, read-only info (zero inputs), Escape
  close, and delete-cancel all behave.

## Definition-of-done status

- Play launches an embedded page in the explicitly chosen profile:
  PASS (jsdom + real app).
- Tab carries the real page id; tab activated: PASS (jsdom +
  real app).
- Current profile cannot override Play: PASS (jsdom + real app).
- Failure states honest/recoverable: PASS (jsdom); a refused
  create has no UI trigger in the real app without deleting
  mid-flight, so that leg is NOT RUN in E2E (covered at the
  boundary instead) — not claimed as real-app verified.
- Duplicate launches handled: PASS (jsdom + real app).
- Primary-action hierarchy, context menu, read-only info,
  existing safeguards, temp restrictions: PASS (jsdom + real app).
- Redundant launch steps removed/justified: DONE (manager bare
  tab removed; surface flow justified and kept; Use-for-new-tabs
  kept with distinct semantics).
- Focused tests: 14 new, all pass. Regression/security: see
  checks above. Diff contains no unrelated changes: verified.
- NOT RUN: visible-window manual check (deliberately avoided
  while the user browses; off-screen E2E is the validation used).
- Remaining note: the two failed E2E runs' `test-results/`
  artifacts remain on the laptop (gitignored, harmless); the
  passing run overwrote `.last-run.json`.
