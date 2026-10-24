# CareerFlow Production Audit Summary — Phase 20A

Baseline: `400aa46 feat(agent): complete Phase 19 authorization and verification`
Audit started: 2026-09-09
Repository: `D:\10_Dev_Workspace\Projects\laboratory\CareerFlow`

## Evidence collected

- Git baseline is Phase 19 commit `400aa46`; no Phase 20 source changes were made during the audit.
- Existing Understand Anything graph: 1,492 nodes / 1,593 edges / 10 layers, but its metadata is from commit `d93b84a` (2026-09-01), so it is treated as historical architecture evidence, not current truth.
- `npm run check:ipc`: PASS, 249 channels; 3 intentional/legacy registered-but-not-preload-invoked warnings: `mcp:list-curated`, `plugin:list-files`, `plugin:read-source`.
- `npm run check:napi`: PASS, 115 referenced core functions exported.
- `npm run check:esm`: PASS, 116 relative shell imports resolve.
- `npm run test:core`: PASS (existing Rust suite), with substantial pre-existing dead-code/compiler warnings.
- `npx playwright test e2e/smoke.spec.js`: PASS, 1/1.
- `npm test`: NOT GREEN in this host environment. Ten shell `file-reservations` tests fail before exercising behavior because `better-sqlite3` is compiled for NODE_MODULE_VERSION 119 while host Node 24.13.1 requires 137. This is a native-toolchain reproducibility problem, not a demonstrated reservation logic failure. Electron E2E smoke still runs successfully against the Electron-compatible native addon.

## Critical/high findings

### SEC-HIGH-01 — IPC sender authentication is implemented but not enforced globally

`ipc-auth.js` and `safe-handle.js` exist, and `main.js` re-exports `safeHandle`, but repository-wide registration still contains raw `ipcMain.handle(...)` calls (253 occurrences across IPC modules). The code comment explicitly says channels are still using raw handles. This defeats the intended Phase 19 sender-origin boundary. Electron's current security guidance explicitly recommends validating the sender of all IPC messages. Evidence: `shell/src/security/ipc-auth.js`, `shell/src/security/safe-handle.js`, `shell/src/main.js`, and raw registrations under `shell/src/ipc/`.

Impact: a compromised/foreign renderer frame that can reach the IPC machinery can invoke privileged main-process capabilities without the intended origin gate. Profile ownership checks reduce data-crossing risk but do not replace renderer-origin authentication.

Disposition: MUST FIX before production sign-off. Add centralized enforcement or migrate every handler to the safe wrapper; cover null/foreign iframe/external-origin/main-window cases and static parity so raw privileged handles cannot regress.

### SEC-HIGH-02 — Migration IPC trusts renderer-supplied filesystem destination

`migration:start` accepts `targetPath` directly from the migration renderer and calls `mkdirSync(targetPath, { recursive: true })`, copies data there, writes `workspace.json`, switches the active workspace, and renames the legacy DB. `migration:select-dir` is also an IPC handler. The migration window currently has no explicit sender validation. The selected path is legitimate user input, but the privileged operation should be bound to the intended migration window and validated as a filesystem path under the supported workspace policy.

Disposition: MUST FIX with sender binding plus path policy and regression tests. Do not constrain legitimate user-selected workspace locations without confirming the product contract.

### SEC-HIGH-03 — Electron runtime is severely stale for the production target

Current repository dependency is Electron `^28.0.0`, installed `28.3.3`. As of 2026-09-09, stable Electron is `44.3.0`; Electron's official security guidance says to keep Electron up to date. Electron 44 includes Chromium 152 and Node 24.20. Electron 28 is therefore a major security/maintenance liability and also blocks the modern `WebContentsView` architecture needed for a true embedded browser. Upgrade must be treated as a controlled compatibility phase, not a blind dependency bump.

Disposition: HIGH. Upgrade to current stable 44.x (or the latest stable verified at implementation time), then run full regression/E2E/native rebuild gates.

### PROD-HIGH-01 — Browser Workspace is not an embedded browser viewport

Phase 18's current UI renders a screenshot/data-URL preview and drives a separate Donut/Wayfern runtime through REST/CDP. The source explicitly labels the preview as a screenshot and Phase 18's gate records the real visible-window validation as pending. The user-facing browser therefore does not yet satisfy the requested "real browser viewport inside CareerFlow" target.

Disposition: ARCHITECTURE FIRST. Do not patch the screenshot UI into pretending it is embedded. Investigate WebContentsView/BaseWindow, Donut/Wayfern process ownership and whether a Donut-controlled Chromium WebContents can be adopted. If adoption is impossible, document the limitation and select a supported architecture rather than using fragile native HWND hacks without proof.

### PROD-HIGH-02 — Career Planning UI exists but is not reachable from the main navigation

`ui/src/features/career` contains a fully actionable `CareerPlan.svelte` and service, and E2E tests exercise career IPC/flows, but `ui/src/App.svelte` does not import/render `CareerPlan` and has no `career` navigation view. This makes a planned product capability effectively undiscoverable through the normal UI.

Disposition: MUST FIX. Wire CareerPlan into the main application navigation and add a real Electron UI E2E test that reaches it through normal user navigation, not only direct preload calls.

## Medium findings

### PROD-MED-01 — Browser navigation controls are non-functional placeholders

Browser Workspace renders Back/Forward buttons but the store keeps `canGoBack` and `canGoForward` false and there are no corresponding IPC operations. Reload deliberately returns `feature-not-supported` because Donut lacks the endpoint. These controls must either be implemented after the browser architecture decision or not presented as actionable controls.

### PROD-MED-02 — Plugin watcher is non-recursive

`fsWatch(d, { recursive: false }, fire)` remains in `shell/src/services/plugins/index.js`. This can miss changes below plugin root directories. The current project has nested skill/plugin content, so watcher semantics should be made deterministic and platform-aware.

### PROD-MED-03 — Native dependency/toolchain contract is not reproducible

Host Node 24.13.1 causes `npm test` to fail because the checked-installed `better-sqlite3` binary targets ABI 119. The repo already has `scripts/rebuild-native.mjs`, but the normal test workflow does not automatically ensure the native module is built for the active host. Production development/CI instructions need a deterministic Node/Electron/native-rebuild contract. Electron 44 also changes the bundled Node version and therefore must be included in the compatibility matrix.

### PROD-MED-04 — CareerPlan project-link navigation appears semantically wrong

`CareerPlan.svelte`'s `openProject(projectId)` calls `onOpenSubject(projectId)`, while `App.svelte`'s `openSubject` treats its argument as a subject ID and navigates to Subjects. This can route a project ID into a subject workflow. Fix with explicit project navigation/selection semantics and an E2E regression test.

### PROD-MED-05 — Browser workspace is not a persistence/recovery model

Workspace state is primarily in renderer/module state and live backend/CDP state. Phase 18 documents backend cycling and real visible-window validation as pending. A production browser experience needs explicit persisted tab/session metadata, rebind/recover semantics, and crash/restart tests once the target architecture is selected.

## Low / cleanup findings

- Rust compiler reports many unused/dead-code warnings, largely because native exports are consumed through NAPI rather than ordinary Rust call sites. These should be reduced where practical, but not at the cost of deleting valid NAPI surface.
- `check:ipc` has three registered-but-uninvoked channels. They are documented as intentional read-only/plugin surfaces in tests/source, so they should be classified rather than blindly removed.
- Existing accessibility warnings in older views should be tracked during the UI pass; do not claim zero warnings until `npm run build`/Svelte checks are re-run after all work.

## Architecture direction

1. Security boundary closure first: IPC sender enforcement + migration window binding/path policy.
2. Toolchain/runtime modernization: Electron 44.x + native rebuild + CI/test contract.
3. Product discoverability/core-flow closure: Career Planning UI and any other orphaned features found by feature inventory.
4. Agent/Goal/Project lifecycle deep verification and fixes.
5. Browser architecture decision using current Electron `WebContentsView`/`BaseWindow` capabilities and Donut/Wayfern constraints; no embedded-browser implementation before this decision.
6. Browser implementation, if technically viable, with real Electron E2E, profile isolation, navigation, tabs, resize, persistence and crash recovery.
7. Full release hardening: performance, docs, security re-review, production build/dist, full E2E and clean Git.

## Worker status

The requested independent worker set was attempted (architecture, core, agent, UI, browser, and security). The worker backend failed to start/return reliably in this environment, including retries; no worker result is being represented as completed evidence. The main agent therefore performed and recorded the audit directly rather than pretending worker findings existed.

## External architecture evidence

Electron's official current documentation confirms `WebContentsView` is the supported replacement for deprecated `BrowserView`, is main-process controlled, and can adopt a `WebContents`. Current stable Electron is 44.3.0 as of 2026-09-08. Electron's security checklist explicitly includes validating all IPC senders and keeping Electron current. These external facts are architecture/security inputs, not repository claims.
