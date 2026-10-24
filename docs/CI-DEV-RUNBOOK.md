# CI / Dev Runbook

How to develop CareerFlow locally, what the test matrix covers, and what the
nightly CI lane does. Companion to the top-level `README.md`.

## Quick start

```bash
npm install && npm test
```

`npm install` builds the workspace graph + Electron; `npm test` runs the three
static guards plus the shell test-suite, UI tests, and `cargo test`. The nightly
live-LLM smoke is **not** included in `npm test` (see below).

## Test matrix

| Suite | Command | What it covers | Cost |
|---|---|---|---|
| Static guards | `npm run check:ipc` / `check:napi` / `check:esm` / `check:cdp-boundary` | IPC contract parity, NAPI export surface, ES-module imports, CDP auth boundary | seconds, no network |
| Shell | `npm run test:shell` | Electron-main unit tests (donut, skills, plugins, mcp, commands, hooks, …) | seconds, no network |
| UI | `npm run test:ui` | Vitest suite in `@careerflow/ui` | seconds, no network |
| Core | `npm run test:core` | `cargo test --manifest-path core/Cargo.toml` | seconds, native only |
| Nightly (live LLM) | `npm run test:nightly` | Real OpenAI-compatible HTTP call — **skipped unless** `CAREERFLOW_LIVE_TEST=1` + a stored credential exist | minutes, needs secret |
| E2E | `npm run test:e2e` | Playwright smoke; requires `ui/dist` to be built first | minutes, needs built UI |
| E2E (batched) | `npm run test:e2e:batched` | The same specs in bounded batches, with Electron/Playwright processes reclaimed between batches. **Prefer this on a machine that is also running a desktop browser** — see Troubleshooting 9 | minutes, needs built UI |

The aggregate `npm test` is:

```bash
npm run check:ipc && npm run check:napi && npm run check:esm && \
npm run check:cdp-boundary && npm run test:shell && npm run test:ui && npm run test:core
```

`npm test` does **not** run Playwright, does **not** package, and does **not**
run the live-provider bucket. A green `npm test` is necessary, not sufficient —
see the E2E and packaging notes in Troubleshooting below.

## Per-suite commands

```bash
# Static contract guards (fail fast, no deps beyond Node 20)
npm run check:ipc    # every preload.cjs invoke() has an ipcMain.handle
npm run check:napi   # every core.<fn>() call references an exported NAPI function
npm run check:esm    # every relative import resolves to a real named export

# Test suites
npm run test:shell   # node --test shell/tests/*.test.js
npm run test:ui      # vitest in @careerflow/ui
npm run test:core    # cargo test in core/

# Nightly live smoke — only when a real key is available
npm run test:nightly # CAREERFLOW_LIVE_TEST=1 node --test shell/tests/provider-live.test.js

# E2E (needs the UI built first)
npm run build:ui && npm run test:e2e

# Build
npm run build        # core (cargo) + ui (vite)
npm run dev          # vite + electron concurrently
npm run dist         # full electron-builder artifact
```

## CI flow (nightly lane)

File: `.github/workflows/nightly.yml` (`nightly-live-llm` job).

- **When:** 06:00 UTC every day (cron `0 6 * * *`), plus manual run via the
  Actions tab (`workflow_dispatch`).
- **What it does:**
  1. Checks out, sets up Node 20 + a stable Rust toolchain.
  2. Caches `~/.cargo` + `core/target` keyed on `core/Cargo.lock`.
  3. `npm ci`, then `npm run build` (core + UI).
  4. Writes a synthetic `userData/pm-secrets.json` containing the secret.
  5. Runs `npm run test:nightly` with `CAREERFLOW_LIVE_TEST=1` and the
     synthetic userData dir.
  6. Uploads the raw test output as an artifact (14-day retention).
  7. Removes the synthetic userData dir at the end (always).
- **Secrets required:** `LIVE_LLM_KEY` — a real, read-only / pay-as-you-go
  OpenAI-compatible API key. The test uses ~1 prompt / ~100 tokens.
  Optional env overrides: `OPENAI_BASE_URL`, `OPENAI_MODEL` (defaults:
  `https://api.openai.com/v1`, `gpt-4o-mini`).
- **If the secret is missing:** the job emits a `::warning::` and skips the
  test step rather than failing the run.

## Common failure modes

1. **`check:ipc` — "N channel(s) invoked in preload.cjs have NO ipcMain handler"**
   A new channel was added to the preload without wiring the main-process
   handler. Add the `ipcMain.handle` in the matching `shell/src/ipc/*.js`
   registrar (and a test in `shell/tests/`).
2. **`check:napi` — "handlers call NAPI functions that are not exported"**
   The shell references a `core.<fn>()` that is not in `core/index.d.ts`.
   Add the export to the Rust crate (`napi` macro) and regenerate the typings,
   or remove the call. Never edit `core/index.d.ts` by hand.
3. **`check:esm` — "imports { X } from "./y.js", but that module does not export it"**
   A named import does not exist on the target module. Fix the import or add
   the export. This catches crashes that would otherwise only fire at
   Electron startup.
4. **`audit retention race`** (test flake in `shell/tests/audit-retention.test.js`)
   When a test run leaves a half-written audit row, the next run can collide on
   the retention window. Run `git stash` (or clean the workspace) and re-run
   `npm run test:shell`; the file-reservations in the workspace usually hold
   the stale lock.
5. **`provider-live` is skipped / `CAREERFLOW_LIVE_TEST` is not set to 1**
   Expected behavior — the live smoke is intentionally absent from `npm test`
   so a dev machine without a key never fails. To run it manually, set the env
   var and supply a `pm-secrets.json` with a non-empty `apiKey` in your
   userData dir. It never logs the key or endpoint host.
6. **`npm run test:e2e` fails with "page not found"**
   Playwright needs a built UI. Run `npm run build:ui` first (or `npm run dev`
   leaves a usable `ui/dist`).

7. **`npm run test:e2e` fails with `packaged exe missing`**
   Three specs drive the REAL packaged binary rather than the dev tree, because
   the packaged app takes a different renderer path (`careerflow://` instead of
   `file:`), a different `userData` resolution, and the real `app.whenReady`
   ordering — none of which a dev-server run exercises:

   | Spec | Proves |
   |---|---|
   | `e2e/packaged-smoke.spec.js` | packaged boot, native core load from `app.asar.unpacked`, DB write/read, a real approval-gated `fs_write`, and restart persistence |
   | `e2e/marketplace-production.spec.js` | the Marketplace production lifecycle in the packaged app (startup → list → install → validate → enable → update → remove → restart, plus containment) |
   | `e2e/workflow-end-to-end.spec.js` | one realistic full workflow: profile → project root → project intelligence → note → agent run + approval → audit → restart → marketplace |

   Build them first:

   ```bash
   npm run dist:dir    # produces release/win-unpacked/CareerFlow.exe
   npm run test:e2e
   ```

   A main-process change requires a rebuild before these specs mean anything —
   they execute the packaged `main.js`, not your working copy.

8. **Real-Donut E2E specs are excluded by default**
   Nine specs drive the real `DonutBrowser-Integration` workspace. They start
   and stop that backend, delete its `runtime.json`, force-kill processes under
   its root, and create AND DELETE profiles in its shared profile store — the
   same store that holds the protected CF-Sequential corpus. They also share one
   pinned API port (10108), so they must run strictly serially and exclusively
   of any real Donut session.

   `playwright.config.js` excludes them unless you opt in explicitly, so
   `npm run test:e2e` is safe by default:

   ```bash
   npm run test:e2e                                        # hermetic set only
   CAREERFLOW_E2E_REAL_DONUT=1 npm run test:e2e             # + the destructive nine
   CAREERFLOW_E2E_REAL_DONUT=1 npx playwright test e2e/real-donut-e2e.spec.js
   ```

   > [!NOTE]
   > **Post-Migration Boundary Architecture:**
   > The legacy DBI-era real-Donut execution group and `scripts/dbi-preflight.mjs` are retired.
   > CareerFlow does not spawn, manage, or terminate external Donut processes.
   > All active suites in `e2e/` use the hermetic `CAREERFLOW_E2E_DONUT_STUB=1` seam or read-only contracts.

   ### 8a. SAFE isolated real-Donut runs (no protected resource is touched)

   The nine specs do **not** need the shared checkout. Two properties of the
   Donut launcher make a disposable workspace sufficient:

   1. `CareerFlow-Start-Donut.bat` derives every path from `%~dp0`
      (`ROOT`, `DATA_ROOT`, `RUNTIME_JSON`, `EXE`) and exports
      `DONUTBROWSER_DATA_ROOT` to the backend.
   2. It self-validates ownership: it refuses to adopt a backend whose
      `runtime.json` `data_dir` lies outside its own `DATA_ROOT` (exit code 6).

   So build a disposable copy once:

   ```bash
   npm run test:e2e:real-donut:iso
   # optional: -- --target <dir> --source <donut workspace> --force
   ```

   Then point CareerFlow at it. Every spec and
   `e2e/helpers/donut-cleanup.mjs` resolve the workspace from
   `CAREERFLOW_DONUT_WORKSPACE` — the same variable the production app honours
   in `shell/src/services/donut.js` — and all destructive helper actions
   (runtime.json removal, process termination) are proven against the
   executable's path under that root, so they cannot reach the real checkout.

   ```bash
   export CAREERFLOW_DONUT_WORKSPACE="<the printed path>"
   export CAREERFLOW_E2E_REAL_DONUT=1
   node node_modules/@playwright/test/cli.js test e2e/phase5-start-real.spec.js
   ```

   What the script copies, and why each item is required (all four omissions
   were found by real failures, not guessed):

   | Copied | Why it is required |
   | --- | --- |
   | `CareerFlow-Start-Donut.bat` | the launcher; relocatable via `%~dp0` |
   | `DonutBrowser-Unlocked.exe` | the real backend |
   | `donut-proxy.exe` | per-profile local proxy. Without it `POST /v1/profiles/{id}/run` returns 500 `Failed to execute donut-proxy` |
   | `xray.exe` | VPN / proxy transport helper |
   | `_tools/browser-data/data/binaries/` | the **patched** Wayfern engine (~2 GB) |
   | `_tools/browser-data/data/data/downloaded_browsers.json` | browser registry, **rewritten** with an absolute path into the new workspace. Without it `POST /v1/profiles` returns 400. Copying the source file verbatim would point the disposable backend at the real checkout's binaries |
   | `launch_gate_prefs.json`, `tags.json` | trivial, no absolute paths |

   `data/profiles/` is created **empty**. The CF-Sequential corpus is never
   copied, read for content, or written.

   Verified after a full real-Donut run against the isolated workspace: the
   real `DonutBrowser-Integration` checkout was unchanged — 390 profile dirs,
   91031 files, 7629456607 bytes, and its `backend.pid` / `browser-state.txt`
   mtimes untouched.

   ### 8b. E2E window placement — off-screen by default

   `shell/src/main.js` moves the main window to `(-32000, -32000)` whenever
   `CAREERFLOW_E2E=1` and `CAREERFLOW_E2E_VISIBLE` is not `1`.

   The window stays fully REAL: same `BrowserWindow`, same preload bridge, same
   context isolation, same IPC, same native services, and a normal top-level
   HWND with normal visibility and focus semantics. Only its position changes,
   so an automated run never flashes a window over the user's desktop.
   `(-32000, -32000)` lies outside the virtual desktop, so Windows never
   composites it on any display.

   This is the default for **every** E2E spec, including the native
   separate/integrated browser specs. There is currently **no** spec that opts
   back in with `CAREERFLOW_E2E_VISIBLE=1`.

   The gate is `isE2E`-scoped, so the packaged app is unaffected.

   **Known limitation, stated precisely.** The virtual desktop on the
   validation host is a single 1920x1080 display with no secondary output.
   `real-browser-workspace-modes.spec.js` derives real-cursor hit-test
   coordinates from the target window's own client origin. With the window at
   negative coordinates, `SetCursorPos` cannot reach it and
   `WindowFromPoint` returns NULL, so the **screen-absolute native cursor
   input** assertions cannot be satisfied off-screen on a single-display host.
   Every other native assertion in that spec (HWND discovery, process→window
   mapping, parent/renderer thread and HWND relationships, hosted-window
   identity, resize, popup, recovery, focus state) is performed through the
   core native module against window handles and window-relative coordinates
   and is unaffected. This is an environment limit, not a CareerFlow defect,
   and it is not worked around by moving a window onto the operator's desktop.

   When the precondition is unsatisfiable, the spec does **not** swallow the
   error. `nativeInputPointIsReachable()` checks the real primary-display
   bounds reported by the OS, and on failure the run prints
   `NATIVE_CURSOR_INPUT_NOT_PROVEN` with the exact unsatisfiable point and
   attaches a Playwright `issue` annotation. Every other assertion in the test
   still executes and can still fail, and the input helper still throws on a
   genuine injection failure, so a real regression is never masked.

   ### 8c. The DONUT BROWSER window is off-screen too (enforced by the harness)

   `shell/src/main.js` only covers CareerFlow's own `BrowserWindow`. It does
   **not** cover the browser windows the real Donut backend spawns. In separate
   mode Donut opens a top-level Wayfern window at the default cascade position,
   which on this host is the entire primary display:

   ```
   pid=41316 hwnd=10291430 visible=true rect=(0,0)-(1920,1020)
   -> *** VISIBLE ON DESKTOP ***
   ```

   Note the binary is named `chrome.exe` — Donut's engine is a Chromium fork
   called Wayfern — so it is easy to mistake for Google Chrome, and it carries
   its own icon. It is a different binary: Wayfern is version
   **151.0.7922.71**, SHA256 `9AC390BD24A28CFD457CEDA452B048873A6D1618FC1786D934BD0F52F236CD6D`;
   Google Chrome is **153.0.8010.53**, SHA256 `E8BCE39747EA63C9C7D4306F7635D2916C9ECB0CF913FBCF5E7ACC4539B5B8A0`.

   **Enforcing this per-spec does not work.** Of the nine real-Donut specs,
   three launch a real browser with no off-screen call of their own:
   `phase7-real-shortcuts` (clicking a shortcut routes through real Donut),
   `phase8-0-restart-persistence` (reopening reuses the mapped profile) and
   `phase8-profile-isolation`. A real run of those three put three separate
   full-screen `0,0-1920,1020` Wayfern windows on the operator's desktop.

   So the invariant is enforced by the **harness**, not by each spec:

   * `scripts/donut-offscreen-guard.mjs` starts a watcher (Playwright
     `globalSetup`) for the whole session and moves any run-owned window off the
     primary display every second. `scripts/donut-offscreen-guard-teardown.mjs`
     stops it, does a final sweep, and prints `clean: no run-owned window on the
     primary display` — or a WARNING listing anything that got through.
   * Armed automatically by `playwright.config.js` whenever
     `CAREERFLOW_E2E_REAL_DONUT=1` and `CAREERFLOW_E2E_VISIBLE` is not `1`. The
     hermetic specs use the `CAREERFLOW_E2E_DONUT_STUB` seam and never spawn a
     browser, so the guard is not armed for them.

   **What counts as run-owned — the safety boundary.** The guard never touches
   Google Chrome or any browser the operator is using. A PID is eligible only if
   its executable is the Donut backend (`DonutBrowser-Unlocked.exe`), an
   `electron.exe` (CareerFlow), or a `chrome.exe` **whose path is under a Donut
   workspace root**. The path check is the essential one, because the Wayfern
   engine is named `chrome.exe` and name alone cannot distinguish it from Google
   Chrome. Verified: after a guarded run of the three leaking specs, the
   operator's own Google Chrome was still alive, still on-screen at its normal
   maximized position, and untouched.

   `e2e/helpers/offscreen.mjs` remains for specs that want to assert the
   invariant themselves (`moveProcessWindowsOffScreen` /
   `assertNoProcessWindowOnPrimaryDisplay`); `real-browser-workspace-modes.spec.js`
   does exactly that. The guard makes it true everywhere; the assertions prove it.

   ### 8d. The shell unit suite and the real-Donut E2E suite must not run concurrently

   `shell/tests/cdp-adapter.test.js` revalidates the exact owned CDP port
   immediately before constructing a WebSocket. A live Donut backend holds the
   pinned API port (10108), and with one running that test resolves a different
   answer and fails with `feature-not-supported` instead of `backend-unavailable`.

   Run `npm run test:shell` and the real-Donut E2E group **serially**, never at
   the same time. This is a test-isolation constraint, not a product defect.

9. **A single long `npm run test:e2e` fails in a scattered, changing way**
   Symptom: a handful of specs fail with

   ```
   Error: page.evaluate: Target page, context or browser has been closed
   Error: locator.waitFor: Timeout 120000ms exceeded
   ```

   ...in specs that pass in isolation, and a *different* set fails on every run.
   Some fail implausibly fast (1-3s) for tests that normally take that long to
   pass.

   Cause: the suite is 93 tests that each launch a real Electron application
   serially (`workers: 1`). Over one long invocation the Electron/Chromium
   process footprint accumulates; on a host that is also running a desktop
   browser, apps start getting reaped mid-test. This is host/process pressure,
   **not** a product defect — verified by every affected spec passing in
   isolation and by the batched run below being 93/93.

   Use the batched runner, which runs the identical specs in bounded batches
   and reclaims leftover processes between them:

   ```bash
   npm run test:e2e:batched              # default batch of 10 specs
   node scripts/run-e2e-batched.mjs --batch 8
   node scripts/run-e2e-batched.mjs --batch 5 e2e/smoke.spec.js e2e/today.spec.js
   ```

   Measured on a Windows host with a desktop browser open:
   `npx playwright test` -> 92/93, 91/93, 89/93 across three runs, different
   spec failing each time; `npm run test:e2e:batched` -> **93/93, exit 0**, in
   11m56s.


## Sub-agent workflow

Multi-slot sub-agent dispatch follows `.agents/STANDING-RULES.md`: max 7
active agents (`rntm-1`, `rntm-2`, `hcnsec`, `sensenova`, `xkiro`,
`opencode`, `openrouter`), bounded tasks (>5 min → sub-agent, ≤2 min → main
agent), and a shared registry at `.agents/sub-agent-registry.md`. Every
sub-agent prompt must start with the skill line:

> Apply the following skills as relevant: unlazy, ponytail, understand-anything,
> superpowers, frontend-design, superdesign. Read `.agents/STANDING-RULES.md`
> first.