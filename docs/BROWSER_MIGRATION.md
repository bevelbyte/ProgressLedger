# Browser migration inventory (Phase 3)

Read from the live trees on 2026-10-24. CareerFlow's embedded browser is
referred to as "v2" below (it is the code in the v2 repo); the Progress
Ledger browser is "PL".

## 1. What v2 already has (CareerFlow's embedded browser, kept)

All in `shell/src/services/browser/` + `shell/src/ipc/browser.js` +
`shell/src/ipc/research.js` + `shell/src/preload.cjs` (browser namespace)
+ `ui/src/features/browser/components/BrowserSurface.svelte`:

- **Host** (`host.js`): sole owner of `WebContentsView`s. Strictest web
  preferences in the app: no preload (pages get NO bridge at all),
  `sandbox: true`, `contextIsolation: true`, `nodeIntegration` off in
  all frames, `webSecurity: true`, `allowRunningInsecureContent:
  false`, `webviewTag: false`, `spellcheck: false`. Per-view gates
  installed before anything loads; a `web-contents-created` global
  backstop in `main.js` covers any view created without them.
- **Registry** (`registry.js`): opaque page ids (`bp-N`), live cap 4,
  profile id validated before it is ever built into a partition name,
  sanitized public page shape (display URLs stripped of credentials,
  token-ish query keys and fragments). No persistence, no LRU.
- **Navigation** (`navigation.js` + `policy.js`): one allowlist
  (`http:`/`https:`/`about:blank`) shared by the address bar, the IPC
  navigate path and all five guards (`will-navigate`, `will-redirect`,
  `will-frame-navigate`, `setWindowOpenHandler`, `will-attach-webview`).
  Address-bar input: absolute URL or bare host inferred as https
  (never http); credentials refused; anything else refused with a
  stated reason (no silent rewrite, no search fallback). Popups: the OS
  window is always denied; an http(s) popup inside a budget of 2 per
  page load becomes a new unfocused in-app page.
- **Permissions** (`permissions.js`): deny by default, decided in main
  on every request, both handlers installed. Only
  `clipboard-sanitized-write` and focused-only `fullscreen` are ever
  granted; denials are reported to the shell instead of vanishing.
- **Downloads** (`downloads.js` + policy download section): managed,
  inside the active workspace's `downloads` folder, never the OS
  folder, never auto-opened. Filenames sanitized (separators,
  traversal, control characters, Windows-illegal set, reserved device
  names, trailing dots/spaces), containment re-checked on the resolved
  path, collisions de-duplicated, max 3 concurrent. No directory means
  refusal, never a fallback.
- **Rectangle validation** (`policy.js` `clampRect`): the renderer's
  rectangle is clamped to the window content area, rounded, and refused
  when degenerate. Main decides, always.
- **Crash handling** (`host.js`): `render-process-gone` marks the page
  CRASHED with a reason and an event; `reload` revalidates the recorded
  URL through the same policy before loading. Navigation timeout
  (30 s default, bounded 100 ms–300 s) fails a stuck load honestly.
- **Overlay flag** (`host.js` `setOccluded` + IPC
  `browser:set-occluded`): any open overlay hides every page; the
  request-visible state is remembered so closing the overlay restores
  pages without re-asking. `BrowserSurface` already accepts an
  `occluded` prop and calls `setVisible(pageId, !occluded)`. Whether
  EVERY dialog, menu and palette feeds that prop is a Phase 4 check.
- **IPC** (`ipc/browser.js`, 11 channels, all through `safeHandle`
  sender validation): `create-page` (with a profile-existence gate
  against the Rust core before any partition is minted), `navigate`,
  `reload`, `close-page`, `state`, `downloads`, `cancel-download`,
  `set-bounds`, `set-visible`, `set-occluded`, plus the
  `browser:on-event` push channel. The renderer never names a
  partition, path, port, token or webContents.
- **Research IPC** (`ipc/research.js`, 5 channels):
  `list-sources`, `list-captures`, `save-source`, `capture`,
  `kept-count`. Every write attests page ownership in main
  (`host.researchPage`: the page id exists, belongs to the profile,
  and has an http(s) URL). LIMIT: `capture` takes renderer-supplied
  text (1–8000 chars) — there is no live page extraction, no page
  text storage, no snapshot, no delete, no search.
- **Browser surface** (`BrowserSurface.svelte`): address bar, loading /
  insecure / crashed states, bounds reporting by `getBoundingClientRect`
  + `ResizeObserver`, a research ledger strip (sources, passages, keep
  a passage), and a "save this page" action. It renders the ACTIVE tab
  of a pane; leaving a pane hides the page without closing it.
- **Workspace page tabs** (`ui/src/shell/workspace/model.js`,
  `PaneView.svelte`, `view-registry.js`): a web page is an ordinary
  workspace tab, view `"page"`, entity = the opaque page id. The pane
  header's "New web page" action opens a bare page tab that adopts the
  page it navigates to, so one pane can hold several pages and a page
  can move between panes as a bounds change with no reload. The view
  is hidden from the rail by design — that is why Phase 1's UI walk
  did not find it, not because the trigger is missing. Phase 3
  verifies this path live.
- **Rust research** (`core/src/db/research.rs`, migration 024):
  `research_sources` (profile, canonical URL, title, domain) and
  `research_captures` (profile, source, page id, kind
  clip/highlight/extraction, text max 8000, deduped). Canonical URLs
  drop fragments and credential-like query keys and reject
  credentials outright.

## 2. What PL has that v2 lacks (the port)

From `src/main/browser/host.ts`, `policy.ts`, `research/service.ts`,
`src/main/store/research.ts`, `src/main/store/tabs.ts`,
`src/renderer/src/components/BrowserScreen.svelte` (+ its `TabBar`,
`AddressBar`, `StartPage` children, not copied — see §4):

- **Live extraction** (`host.ts` `extractActivePage`): main-side
  `executeJavaScript` reading `innerText`, the current selection and
  `outerHTML`; URL and title read from the webContents itself, never
  from page data. Caps: page text 200,000 chars with a visible
  truncated flag; snapshot 10 MB else text-only; selection 20,000
  chars; empty selection refused with "select some text first".
- **Tab-state persistence** (`store/tabs.ts`): `browser_tabs`
  (workspace, position, URL, title, active flag) restored lazily —
  views are runtime-only and rebuilt on activation; activating a
  crashed tab is the recovery path.
- **LRU hibernation** (`host.ts`): live-view cap 5; opening beyond it
  destroys the least-recently-used non-active view (the tab row
  survives and rebuilds on activation).
- **Ledger delete + search** (`research/service.ts`,
  `store/research.ts`): delete is complete — source row, text row,
  passages (by cascade) and every FTS index row in one transaction,
  then the snapshot file (with a filename-shape guard). Search is one
  FTS5 query across sources and passages with quoted-phrase terms,
  snippets, limit 50.
- **Snapshot files** (`research/service.ts`): `data/vault/sources/
  <id>.html` + SHA-256 on the row; a snapshot write failure degrades
  to text-only with a warning, never a failed capture.
- **Capture buttons** (`BrowserScreen.svelte`): Capture page and
  Capture selection on the address bar, enabled only for a live,
  non-crashed, non-loading page; a start page for blank/crashed tabs
  with a recover action.
- **Surface switching** (`host.ts` `setSurfaceVisible`): leaving the
  browser surface hides every page view; returning re-presents the
  active tab. (v2's per-tab `setVisible` covers the same case when
  the UI calls it on view switch — Phase 4 verifies.)

## 3. Feature table (CareerFlow had / PL has / v2 action)

| Feature | v2 had | PL has | v2 action |
|---|---|---|---|
| Persistent session per profile (validated profile id) | Yes (partition from validated integer id, profile-existence gate) | Yes (partition from validated string id, single profile per window) | Keep v2's; Phase 3B rebuilds partition naming for browser profiles |
| Permission requests deny-by-default | Yes (allow-list: clipboard-write + focused fullscreen, both handlers, denial events) | Deny-all via request handler only | Keep v2's (finer, already deny-by-default); do NOT port deny-all |
| Managed downloads | Yes (workspace dir, sanitized names, containment, no auto-open, no fallback) | Refused with an honest notice | Keep v2's — V2-04 already satisfied; do NOT port refusal |
| Live-page limit | 4, no eviction | 5, LRU hibernate | Port LRU hibernate; raise cap to 5 |
| Rectangle validation | Yes (`clampRect`) | No (viewport bounds used as given) | Keep v2's |
| Crash handling / recovery | CRASHED state + policy-checked reload | Crashed set + rebuild on activation | Keep v2's; tab persistence adds PL-style rebuild |
| Navigation policy | http(s)/about:blank allowlist, 5 guards + global backstop, credential refusal | allow/external/mailto/block, will-navigate/will-redirect guards | Keep v2's (stricter); no mailto-external change |
| Address handling | Bare host → https, credentials refused, other input refused with a reason | Bare domain → https, local → http, other input → DuckDuckGo search | Keep v2's; do NOT port the search fallback (it sends typed text to a third party without an explicit act) |
| New-window handling | OS window always denied; in-app page within budget 2/load | New in-app tab, or external for mailto | Keep v2's |
| Page / selection extraction | No (capture text comes from the renderer) | Yes, main-side, caps + truncated flag | Port (TS island + host method + research IPC) |
| Tab state persistence / restore | No (live-only registry) | Yes (SQLite tabs, lazy restore) | Port via migration 025 `browser_tabs` |
| Capture page / capture selection | Save-source + keep-passage (manual text) | Capture page + capture selection (live) | Add live capture channels; keep manual keep-passage (an old feature) |
| Ledger search | No | FTS5 across sources + passages | Port via migration 025 `search_index` |
| Ledger delete | No | Complete (rows + index + file) | Port (Rust delete + shell file unlink) |
| Snapshot file + SHA-256 | No | Yes (`vault/sources/<id>.html`) | Port (shell-owned files under userData `vault/sources/`) |
| Overlay flag | Yes in host (`setOccluded`); UI wiring unverified | Yes (`setOverlayHidden` + surface switching) | Keep v2's flag; Phase 4 wires + verifies every overlay |
| Bridge channels with sender validation | Yes (`safeHandle` + preload bridge, 11 browser + 5 research channels) | PL's own preload bridge | Keep v2's; extend with the new research channels |
| Browser screen / tab bar / address bar | Yes (BrowserSurface + workspace page tabs + pane-header trigger) | Yes (BrowserScreen + TabBar + AddressBar + StartPage) | Keep v2's screen; add capture buttons + search/delete UI to its ledger strip; do NOT port PL's screen components (different shell, different style) |
| Profile export / import + backup incl. snapshots | Export = Rust `exportProfile` (DB rows); backup = local-vault bundle (DB-derived); neither includes files today | Snapshots under the data dir, included in PL's whole-data backup | Check both paths once snapshots exist; extend + round-trip test on throwaway data if either drops the files |
| Old saved workspaces with an old browser tab | Page tabs carry the opaque id; a dead id shows an honest re-open state | Tabs restore from rows | Restored tabs open as new browser tabs (lazy view creation); a tab whose page is gone re-opens at its stored URL |

## 4. NOT PORTING (from PL)

- PL's screen components (`TabBar`, `AddressBar`, `StartPage`):
  v2's shell, workspace tabs and style are different; porting the
  components would fight the shell instead of using it. Their
  behaviors (capture buttons, blank/crashed start state, recover)
  are ported into `BrowserSurface`.
- PL's `deny-all` permission handler, DuckDuckGo search fallback,
  downloads-refused notice, and unclamped viewport bounds: each is
  weaker than, or in tension with, what v2 already has (§3).
- PL's extras, per the task: what-if CGPA planner, AI
  preview-and-approve flow, whole-data backup, resources vault.

## 5. Port plan (in order)

1. **TS island + build step** (V2-22): `shell/src/browser-ts/
   extraction.ts` (extraction script, caps, validation, types)
   compiled by `tsc` to a gitignored output dir; `build:browser-ts`
   wired as `predev`, `prestart` (packaged runs use the built output)
   and `pretest:shell`; `typescript` added as a devDependency with
   its six checks recorded in `docs/DEPENDENCIES.md`.
2. **Host extraction**: `host.extractPage(pageId, wantSelection)` —
   registry record supplies URL/title (main truth), the compiled TS
   script supplies text/selection/HTML, caps applied in TS.
3. **Migration 025** (V2-23): columns on `research_sources`
   (`content_file`, `content_sha256`, `text_length`,
   `text_truncated`); `research_source_texts`; FTS5 `search_index`
   (kind, profile_id, source_id, capture_id, title, body); 
...[truncated 2542 chars]
## 6. Progress (2026-10-24, steps 1–2 done)
- TS island built: `shell/src/browser-ts/extraction.ts` (script, caps,
  types) + `shell/tsconfig.browser.json` (NodeNext ESM, strict) +
  `build:browser-ts` wired via `predev`, `predev:shell`, `pretest`,
  `pretest:shell` and first in `build`; output gitignored (the
  repo-wide `dist/` pattern covers it, verified by `git
  check-ignore`); packaged automatically (`shell/**/*` in
  electron-builder.yml). typescript 5.9.3 added (checks above).
- `host.extractPage` added (URL/title from the registry record, caps
  from the TS module). Unit test covers the TS module (5 tests; shell
  suite now 1170 pass / 0 fail). The host method itself has no unit
  test: host.js imports Electron, which plain Node cannot provide, and
  the repo has no host unit tests for the same reason — it is covered
  by the real-Electron extraction spec in verification (step 8).
  Two fixable mistakes on the way: a missing comma after the new
  object method, and a one-level-short import path
  (`../browser-ts/...` from `services/browser/` resolves under
  `services/`; the correct path is `../../browser-ts/...`).

## 7. Job-running method (2026-10-25, binding)
All Phase 3 proof, build, test and screenshot jobs run through the
user-launched helper in the normal session (V2-24). No Task Scheduler
tasks, no administrator rights, no elevation. Helper job scripts end
with `exit /b 0` (plain `exit` would close the helper window, since
jobs run via `call` inside it).

## 8. Proof job queued (2026-10-25, helper only)
- Back/forward (V2-25) + engine guard (V2-26) are in the tree,
  uncommitted, with the TS island. The proof job `p3-proof` is queued
  in the helper (`jobs/p3-proof.cmd` + `.ready`): gates first
  (build:browser-ts, check:ipc/napi/esm, test:shell, build:ui,
  test:ui — a failed gate skips the proof), then the local test
  server (127.0.0.1:18931, no packages), the Playwright proof driver
  (real app, real page, link, form, reload, back, forward, new tab,
  example.com, tab switch, close, 1-page and 4-page memory, idle CPU,
  resize follow, divider drag best-effort, webContents capture, window
  fronted for the desktop screenshot), then the desktop screenshot
  (PowerShell, in-session) and the pure-Node color check of the
  #1F7A8C box in both images. Outputs: `work/shots-p3/` (PROOF.json,
  COLORCHECK.json, proof-capture.png, proof-desktop.png).
- The helper was NOT running when the job was queued, so the job waits
  for the user to double-click helper.bat. Three older jobs
  (cleanup1, helper_test, mycampus_phone) are queued ahead of it and
  were left alone.

## 9. Proof run 1 stopped at a gate — my test bug, not the browser
- Task V2P3Proof ran 2026-10-25 ~03:01-03:02 IST and stopped after
  test:shell: 1170 pass / 1 fail. The single failure was the new
  engine-guard test itself: it computed the repo root one level up
  from shell/tests (landing on shell/ instead of the repo root) and
  tried to scan shell/shell/src, which does not exist. Fixed (two
  levels up) and re-submitted as V2P3Proof2; V2P3Proof was deleted
  after verification, per the scheduler rule. The browser code,
  back/forward, and extraction tests all passed in that run.

## As-built additions (2026-10-25, after this plan was written)
- Live cap is 5 with LRU hibernation (V2-29): past-cap creates sleep
  the least-recently-used background page; the visible page is never
  evicted; all-visible creation still refuses.
- Tab restore uses the browser_tabs row id carried on the workspace
  tab (exact, no order guessing). is_active is NOT tracked in Phase 3
  (restore activates the first tab); per-tab active state is Phase 3B.
- Search snippets are computed in Rust, not by SQLite snippet():
  the bundled SQLite rejects snippet()'s ellipsis argument in both
  Unicode and ASCII forms (V2-30).
- The backup bundle includes the research ledger and snapshot files
  (V2-32): manifest "research" section, sources/<id>.html entries,
  SHA-256 verified with sha2, export fail-closed, import graceful.
