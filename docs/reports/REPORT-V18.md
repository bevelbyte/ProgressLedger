# REPORT-V18 — Real Persistent Browser Workspace (Donut) + Agent Browser Control

Phase 18 of the CareerFlow autonomous program. **Recovery-first run**: the previous
Phase 18 attempt had been stopped mid-flight; this run recovered the git state,
verified nothing had been committed or half-written, audited the actual subagent
configuration, and only then delegated and parallelized.

- HEAD before Phase 18: `f5f12a2` (Phase 17, E2E closed, 93/0)
- HEAD after Phase 18: `91a1ede` — `feat(browser): Phase 18 — persistent real Donut browser workspace + agent browser control`
- Working tree: clean (see GATES-PHASE18 ledger)

---

## 1. RECOVER — what the previous run had actually done

`git status` / `git log` showed a **clean tree at `f5f12a2`** — the previous run
had changed nothing on disk; all of its "work" existed only in its context. So
this run did not need to revert or salvage: it started from the Phase 17
baseline and re-executed Phase 18 from scratch, with one exception — the
recovery also **confirmed the P0 wiring gap** that the earlier audits had
identified (`ctx.donut.resolveOwnedRuntime` was never set in `shell/src/ipc/donut.js`,
so every renderer `cdp:*` call returned `foreign-runtime` in production).

## 2. UNDERSTAND — subagent configuration

The six-slot worker pool is real and ordered (`~/.zcode/AGENTS.md`): rntm-1,
rntm-2, sensenova-1, sensenova-2, opencode, openrouter — one provider each.
This run dispatched **3 named slots** (rntm-1, rntm-2, sensenova-1) for the
parallel investigation wave; see §3. Slot notes: see GATES-PHASE18 (one slot
was rate-limited and backfilled; final reports below are from the slots that
actually returned).

## 3. PARALLEL INVESTIGATION — the three audits (dispatched concurrently)

| Slot | Audit | Key findings |
|------|-------|--------------|
| rntm-1 | Donut backend capabilities | Backend is headless-only, but `/v1/profiles/{id}/run` accepts `{headless: bool}`; `headless:false` makes Wayfern open a **real visible OS window** sized to the fingerprint. Tab/URL endpoints exist on the REST API; per-profile ephemeral CDP ports. |
| rntm-2 | CareerFlow browser UI/IPC surface | Existing Browser Manager (lifecycle/CRUD) + `cdp-adapter.js` restricted adapter; renderer NEVER receives port/host/PID/token; **`resolveOwnedRuntime` gap confirmed** — `cdp:*` channels were wired in preload but denied everything in production. |
| sensenova-1 | Testing surface | Shell `node:test` suite, UI `vitest` (495 baseline), E2E Playwright (93 baseline), static gates `check:ipc` / `check:esm` / `check:napi`; E2E stub seam `CAREERFLOW_E2E_DONUT_STUB=1` exists in `ipc/donut.js`. |

**Decision** (from the audits + the user's product intent): build the workspace
as **real Donut control** — no fake browser, no fake screenshot, no invented
endpoints. Where Donut has no capability (reload), return the honest
`feature-not-supported` reason and degrade the UI.

## 4. IMPLEMENTATION — what was built

### 4.1 P0 fix — ownership gate wired (1 line changed in `shell/src/ipc/donut.js`)
`ctx.donut.resolveOwnedRuntime(localId)` now resolves the opaque `profileLocalId`
to the machine-local Donut UUID through the durable binding store. Every
renderer-facing `cdp:*` / `browser-workspace:*` call depends on it; without it
the renderer could never drive a real browser.

### 4.2 Browser workspace service + IPC + preload (`shell/`)
- `shell/src/services/browser-workspace.js` — pure ops factory
  `createWorkspaceOps({ donut, core, adapter, rec, transport, now, emit, setStatusTimer })`.
  Ops: `snapshot` / `launch` / `stop` / `navigate` / `newTab` / `closeTab` /
  `activateTab` / `reload` (honest `feature-not-supported`) / `screenshot` /
  `subscribe`. Every result passes through `buildSnapshot(state)` — a fixed,
  sanitized shape (`state, backend, profileLocalId, tabs, activeTabId,
  lastError, openedAt, updatedAt`) with **no port, no token, no PID, no path**.
- `shell/src/ipc/browser-workspace.js` — 10 channels (`state`, `launch`,
  `stop`, `navigate`, `new-tab`, `close-tab`, `activate-tab`, `reload`,
  `screenshot`, `subscribe`) + push events (`browser-workspace:on-event`,
  kind-based: `launched`, `navigated`, `new-tab`, `close-tab`, …).
- `shell/src/preload.cjs` — `browserWorkspace` namespace + `onEvent` with
  unsubscribe. Renderer only ever supplies `{ profileLocalId, tabId?, url? }`.
- Launch semantics: `launch(localId, cfProfileId)` → ownership gate →
  `provider.ensureStarted()` → transport `POST /v1/profiles/{id}/run
  { headless: false }` → visible Wayfern window.

### 4.3 Dock UI (`ui/`)
- `ui/src/shared/stores/browser-workspace.svelte.js` — module-scoped store;
  open/width/activeProfileLocalId persist in localStorage; auto-launch on
  open; event-driven reconciliation (push events re-sync from the snapshot).
- `ui/src/features/browser-workspace/components/BrowserWorkspaceDock.svelte` —
  dock with launch/stop, tabs, address bar (validated navigation), screenshot
  button, honest "not running" state, width presets + drag/keyboard resize
  (`ResizeHandle.svelte`, `role="slider"`).
- `ui/src/App.svelte` — dock is a **sibling of the view switch**: navigating
  between views does not recreate it (verified in E2E via `cf:navigate`).

### 4.4 Agent browser-control tools (`shell/src/services/browser-workspace-tools.js`)
Eight tools registered into the project-tools **dynamic** registry (the agent
loop sees them via `listTools()`):
`browser_get_state`, `browser_launch`, `browser_stop`, `browser_navigate`,
`browser_new_tab`, `browser_close_tab`, `browser_activate_tab`,
`browser_screenshot`.
- Profile resolution: explicit `profileLocalId` → per-agent active profile
  (set by `browser_launch`) → the workspace's current profile.
- `browser_launch` always passes the agent's own CF profile id — the binding
  store enforces ownership; a tool cannot launch a profile the agent doesn't own.
- Every mutation emits the same workspace events the dock renders — the agent's
  actions are **user-visible activity** (no chain-of-thought).
- Known limitation (documented): the renderer-facing `project:invoke-tool`
  IPC path resolves only static tools; dynamic browser tools are reachable by
  the agent loop (main process), not by a renderer invocation.

## 5. TESTING — exact results

| Layer | Command | Result |
|-------|---------|--------|
| Shell unit | `node --test shell/tests/*.test.js` (Node ABI) | **1045 pass / 0 fail** (incl. new `browser-workspace.test.js` 29/29, `browser-workspace-tools.test.js` 11/11) |
| UI unit | `npx vitest run` (ui) | **523 pass / 0 fail** (was 495; +28 browser-workspace store tests) |
| Rust core | `cargo test` (core) | **132 pass / 0 fail** (first-run compile-cache artifact produced 4 transient failures; clean on rerun — see GATES-PHASE18) |
| Static gates | `check:ipc` / `check:esm` / `check:napi` | OK (249 channels all handled; 114 files resolve; 115 napi exports) |
| UI build | `vite build` | OK |
| E2E (Electron) | `npx playwright test` (Electron ABI) | **91 passed / 3 failed** — the 3 failures are the proven pre-existing `academic-focus` timezone flake (identical failures on the clean `f5f12a2` baseline; spec computes `YESTERDAY` in UTC while the focus service computes overdue in local dates, so during the IST morning window the UTC-yesterday deadline reads "2d overdue"). **0 failures attributable to Phase 18.** New `browser-workspace.spec.js` passes (see below). |

### New E2E spec — what it proves (real IPC surface, stub backend seam)
`e2e/browser-workspace.spec.js`:
launch → ready sanitized snapshot (no token/port/path in any result);
transport run recorded against the resolved Donut profile; dock survives
`cf:navigate` view changes (persistence requirement); invalid URLs refused at
the gate (`invalid-url`); navigate without a live backend reports the honest
`backend-unavailable`; reload → `feature-not-supported`; the durable binding +
launch survive a full app restart; an unbound (foreign) profile id is refused
with `unknown-profile`.

## 6. REAL VALIDATION — real Donut backend

Attempted against the live Donut backend (port 10108). The backend was
observed **cycling** during validation (health flapping `ready:true/false`,
API token + PID rotating, intermittent connection resets), which is a Donut
backend stability condition, not a CareerFlow one. The `/health` endpoint
returned `{"headless":true,"ready":true,"status":"ok"}` in a stable window;
profile listing was attempted and could not complete while the backend was
mid-cycle. **Claim boundary**: windowed (visible) browser control is proven at
the unit/contract layer (real IPC shapes, real REST payload `{headless:false}`,
real binding store); a full visible-window run against the live backend must
be re-attempted when the Donut backend is stable (see GATES-PHASE18, item
REAL-1). No claim of "real-browser test passed" is made in this report.

## 7. SECURITY / ACCESSIBILITY / PERFORMANCE

- Renderer boundary: `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`, strict CSP — **unchanged**; the new surface adds
  no renderer-visible secrets (verified by tests: no token/port/127.0.0.1 in
  any result, including error paths).
- `sanitizeStatus` whitelist (`PUBLIC_STATUS_KEYS`) covers the backend echo —
  no pid/port/path.
- Accessibility: dock has labelled controls, `role="tablist"/"tab"`,
  `aria-selected`, `aria-live` status, keyboard-resizable handle
  (`role="slider"` with Arrow/Home/End keys). All new svelte-check warnings
  fixed (0 errors; remaining 2 warnings are pre-existing in GoalsView /
  RecallDeck).
- Performance: status-refresh timer (2s) runs only while the workspace is
  ready; dock is removed from the layout when closed; screenshot data URLs are
  captured on demand (button/agent tool), never polled.

## 8. KNOWN LIMITATIONS (honest)

1. Donut has no reload endpoint → reload is `feature-not-supported` (by design).
2. Tab-list snapshots have no `loading` field — the dock's spinner is
   optimistic and clears on the next authoritative refresh.
3. Renderer cannot invoke dynamic (browser) tools through `project:invoke-tool`;
   the agent loop can (main-process path).
4. Real-backend validation is pending a stable Donut window (REAL-1).
5. Screenshot data URLs are returned inline (bounded); no streaming.
