# Browser Profile UX — Baseline audit (2026-10-26 evening IST)

Repo: `D:\Muse_Workspace\projects\Progress_Ledger_v2`, branch `main`,
HEAD `d6553a3` ("Items 11-12: feature gap report, screenshots list,
second-session report"). Working tree CLEAN at baseline (git status
empty). No commit, stage, push, reset, stash, or clean is authorized
for this task; all task changes stay uncommitted and are listed
separately in REPORT.md.

## Baseline test results (job V2PlayBase, /RL LIMITED /IT, minimized)

- UI suite (`npm run test:ui`, vitest run): 70 files, 861 tests, all pass.
- Shell suite (`npm run test:shell`, node --test): 1204 pass, 0 fail.
- No pre-existing failures. (Two `at startTests` vitest stack traces
  appear in the UI log but the suite exits 0 with 861 passed; they are
  not failures.)
- Task V2PlayBase deleted after use and verified gone by Query error.

## Complete flow traced (profile row -> visible page)

1. `BrowserProfiles.svelte` row actions call the browser store
   (`ui/src/shared/stores/browser.svelte.js`).
2. Store `openPage({profileId, url, browserProfileId})` calls the
   preload bridge `browser.createPage` with ONE options object
   `{profileId, url, restoreId, browserProfileId}`.
3. Preload (`shell/src/preload.cjs`) invokes `browser:create-page`.
4. Main (`shell/src/ipc/browser.js`, `browser:create-page`) validates
   exactly the four keys, strict types, workspace profile existence,
   and resolves the browser profile via `resolveProfile` (unknown or
   malformed id -> `unknown-browser-profile`; restore rows override
   the request). `createPageWithProfile` creates the host page, saves
   the `browser_tabs` row (persistent profiles only), and fails
   closed (tears the page down) if the row write fails.
5. Host (`shell/src/services/browser/host.js`) + registry own the
   WebContentsView in the resolved profile's partition.
6. Renderer workspace: `openPageTab(paneId, label, entity, {activate})`
   creates a `page` tab whose entity IS the page id; `PaneView`
   renders `BrowserSurface` with `pageId={entity}`; `setTabEntity`
   also records `browserTabId` (restore row id).
7. Precedents reused by this task: the surface switcher's
   "Open a new tab in this profile" (+) button (explicit id +
   `about:blank`); `App.svelte` research-reopen (capture pane/context
   BEFORE awaiting main, verify they still exist after, then
   switchContext + focusPane + openPageTab); `Modal.svelte` (dialog
   primitive) and `Menu.svelte` (click-anchored overflow menu).

## Findings (BF = baseline finding)

- BF-1 (BUG, in scope): `BrowserProfiles.svelte` calls `toast(...)`
  as a function in 4 places (delete success, live-cap save,
  duplicate success, clear success), but `toasts.svelte.js` exports
  `toast` as an OBJECT `{success, error, warning, info}`. The calls
  throw at runtime: success feedback never shows, and after a
  successful delete the confirm dialog stays open because
  `deleteTarget = null` runs after the throwing call.
- BF-2 (DEAD FEATURE, in scope): "Last used" always reads "Never".
  The Rust `touch_browser_profile` + NAPI `touchBrowserProfile`
  exist (with a Rust test) but main never calls them, so
  `last_used_at` is never written. The renderer projection is fine
  (napi camelCases `last_used_at` to `lastUsedAt`); only the call
  is missing.
- BF-3 (MISSING, core task): the manager has NO Play button. Rows
  offer "Use for new tabs" + inline Edit / Duplicate settings /
  Clear data / Delete. The new-profile `onSaved` handler switches
  the current profile AND opens a bare page tab (`openPageTab`
  with a null entity) that only adopts a page on later navigation
  — the misleading empty tab the mission targets. (The surface's
  own new-profile handler is different and correct: it opens a real
  page in the new profile in the same tab.)
- BF-4 (MISSING, core task): no context menu anywhere in `ui/src`
  (zero `contextmenu` uses). `Menu.svelte` is a click-anchored
  overflow menu, not a cursor-positioned context menu, so the row
  menu needs its own cursor-anchored variant following the same
  accessibility contract (role=menu/menuitem, arrows/Home/End,
  Escape returns focus, pointerdown-outside closes).
- BF-5 (MISSING, core task): no read-only profile information view;
  `BrowserProfileDialog.svelte` is edit-only. The sanitized profile
  model carries everything an info view needs except secrets (main
  strips password blob/plain before the renderer ever sees them).
- BF-6 (OK, verified): explicit profile ids already survive the
  whole create flow; main validation is authoritative; temp
  profiles get no tab row and are validated against the in-memory
  temp map + workspace match; unknown/deleted profiles are
  rejected with `unknown-browser-profile`.
- BF-7 (NOTE): `C:\Users\Asus\AGENTS.md` was read. It documents REA,
  a binary reverse-engineering toolchain (PE/ASAR/APK analysis).
  It is NOT applicable here: the v2 browser is source-available
  Electron code, and the Donut fork under `browser_lab` is
  out of scope (boundary: do not modify it). No browser_lab files
  were opened or changed.

## Checks that can run safely

- UI vitest suite, shell node tests, `check:ipc`, `check:esm`,
  `check:napi`, production build: all headless, safe.
- Real-app validation: off-screen E2E mode only (background, no
  visible window) while the user is browsing; visible-window runs
  are NOT used in this task.
- No external network needed: tests use mocks/local pages only.

## Implementation plan (smallest safe change set)

1. `shell/src/ipc/browser.js`: touch `last_used_at` after a
   successful persistent page creation (fresh + restore paths),
   guarded so a metadata failure never fails the page.
2. `ui/src/features/browser/components/BrowserProfiles.svelte`:
   Play button per row (explicit id, `about:blank`, busy state,
   honest failure, orphan cleanup on mid-flight delete/pane loss);
   row actions move into a cursor/button menu; new-profile flow
   stays in the manager with a toast instead of a bare tab +
   current-profile switch; `toast(...)` calls fixed to
   `toast.success/error`.
3. New `ui/src/features/browser/components/BrowserProfileInfo.svelte`:
   Modal-based read-only view, no password fields at all.
4. New `ui/tests/browser-profiles-play.test.js`: Play targeting,
   activation, failure honesty, busy/double-click, per-row
   targeting, menu targeting, info read-only + no secrets,
   confirm safeguards, temp restrictions.
5. Validate: focused tests, full UI + shell suites, checks,
   production build, off-screen E2E Play run, DB read-back of
   `last_used_at`.
