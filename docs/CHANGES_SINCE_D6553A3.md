# Changes since d6553a3 — audit

- Baseline: `d6553a3` (branch `main`, "Items 11-12: feature gap report, screenshots list, second-session report").
- Snapshot: `2e87673` ("Snapshot", 2026-10-27 03:39 IST, author bevelbyte) on branches
  `user-session-snapshot` and `v2-continue` (same commit; `v2-continue` is checked out).
- Method: `git diff d6553a3..HEAD --stat` (29 files), full diff of the source files,
  security-settings grep of the main window and browser host, dependency diff,
  and the read-only outside-repo checks listed below. All test/build numbers
  were produced on the laptop on the snapshot branch (job V2Audit1, standard
  rights, whoami Mandatory line in its log).

## 1. Snapshot note (Stage 1 step 1)

On arrival the tree was already clean and the two branches already existed,
so no new snapshot commit was needed: step 1 was already satisfied by
`2e87673`. Nothing was left out of that commit that needed leaving out —
the 29 files contain no secrets, no `node_modules`, no build output
(`ui/dist`, `release/`), and no big binaries. No `.env` or token file is
among them. No stash exists. No tags exist. No git remotes exist
(`git remote -v` is empty). Local git config is stock only
(`core.filemode=false`, `ignorecase=true`, etc.). `.git/hooks` holds only
`.sample` files — no active hook.

## 2. Repo changes (29 files)

Class key: GOOD = keeps or improves the app. NEUTRAL = harmless.
RISKY = weakens security/privacy, adds a network call, unknown package,
elevated rights, or a new startup item. BROKEN = breaks tests or the build.
UNKNOWN = intent cannot be shown from evidence.

### GOOD (13 files)

| File | Change | Evidence / reason |
|---|---|---|
| `ui/src/App.svelte` (+7/−3) | Profile landing guard changed from `ws.currentView() === "profiles"` to `ws.anyPaneShows("profiles")` | Fixes the reported second-card no-op (split pane, unfocused chooser). Single-pane behaviour unchanged. |
| `ui/src/shell/workspace/store.svelte.js` (+14) | New `anyPaneShows(view)` helper (any pane of the active context showing the view) | Focus-independent check; no other caller behaviour changed. |
| `shell/src/ipc/browser.js` (+11) | `touchProfile()` records last-used on page creation/restore, fail-closed | Metadata only; a failed touch cannot fail the page. Persistent profiles only. |
| `ui/src/features/browser/components/BrowserProfiles.svelte` (+501/−82) | Play button per row, row ⋯ + right-click menu, info panel, duplicate/clear/delete | The authorized Browser Profile UX mission work. Uses the existing bridge only. |
| `ui/src/features/browser/components/BrowserProfileInfo.svelte` (new, 190) | Read-only profile details (name, color, notes, proxy, bypass, clear-on-close, created, last used) | Display only; no password blob reaches the renderer (see its header comment). |
| `ui/tests/browser-profiles-play.test.js` (new, 330) | jsdom suite for the Play/menu/info behaviour | Test-only. |
| `e2e/browser-profile-play.spec.js` (new, 272) | Playwright spec: Play targeting, current-unchanged, last-used, partition isolation, double-click guard, menu/info | Test-only, fresh data dir. |
| `e2e/profile-card-select.spec.js` (new, 172) | Single-pane card selection regression spec | Test-only, fresh data dir. |
| `e2e/profile-card-select-packaged.spec.js` (new, 181) | Same flow against the packaged exe, with a fresh-dir guard | Test-only; aborts unless the dir starts with zero profiles. |
| `e2e/profile-card-split-page.spec.js` (new, 148) | Split-focus card regression spec (reproduced the bug pre-fix) | Test-only, fresh data dir. |
| `e2e/profile-card-split-page-packaged.spec.js` (new, 156) | Same split flow against a packaged build | Test-only, fresh data dir. |
| `docs/browser-profile-ux/BASELINE.md` (121) | UX mission baseline evidence | Docs only. |
| `docs/browser-profile-ux/REPORT.md` (152) | UX mission final report | Docs only. |

No new network call was found in any changed product file (grep of the
changed sources for `fetch(`, `WebSocket`, `XMLHttpRequest` is empty). The
one loopback-only `fetch("/report?...")` sits in the Playwright play spec,
which spins up its own `127.0.0.1` test server — test harness only, never
shipped, never leaves the machine.

### NEUTRAL (16 files)

`docs/browser-profile-ux/*.exit` and `*.done` (16 marker files:
`baseline-shell.exit`, `baseline-ui.exit`, `baseline.done`, `e2e.done`,
`e2e.exit`, `focused.done`, `focused.exit`, `gate-build.exit`,
`gate-core.exit`, `gate-shell.exit`, `gate-ui.exit`, `gate.done`,
`overlay.done`, `overlay.exit`, `shell2.done`, `shell2.exit`). Job marker
noise swept into the snapshot commit. Harmless, no code effect. Kept.

### RISKY (0) — BROKEN (0)

No security setting changed (see §3). No package added, removed, or updated
(see §4). No schema change (see §5). Tests and build pass on the snapshot
branch (see §6).

### UNKNOWN (3, all pre-existing, all left alone)

These are not v2 changes and not mine; intent cannot be shown from evidence.
Each is listed with its exact removal command, and left running:

| Item | What it is | Removal command (not run) |
|---|---|---|
| Scheduled task `\RunDonutTest` (2026-10-25, Limited, daily 23:59) | Runs a Donut-browser .bat under `D:\Muse_Workspace\projects\browser_lab\` | `schtasks /Delete /TN RunDonutTest /F` |
| Scheduled task `\cua-driver-serve` (no date, Highest, logon) | Hidden PowerShell launching a Cua driver binary under AppData | `schtasks /Delete /TN cua-driver-serve /F` |
| Scheduled task `\CoolControl` (no date, Highest, logon) | `D:\1_Education\AsusPowerFlow\coolcontrol\...CoolControl.exe` | `schtasks /Delete /TN CoolControl /F` |

## 3. Security review (unchanged since d6553a3)

None of these files appear in the diff, so every value below is identical
to the baseline. Verified by reading the current files:

- Main window (`shell/src/main.js`, `createWindow`): `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`, preload bridge only;
  `will-navigate` / `will-redirect` backstop to trusted URLs only
  (`file:` built UI, `progressledger-v2://app/index.html`, dev `127.0.0.1:5173`);
  `setWindowOpenHandler` denies; strict CSP set on `session.defaultSession`.
- Browser pages (`shell/src/services/browser/host.js`, `webPreferencesFor`):
  verified partition, `contextIsolation: true`, `nodeIntegration: false`,
  `nodeIntegrationInWorker/SubFrames: false`, `sandbox: true`.
- Permissions (`shell/src/services/browser/permissions.js`, via host.js):
  deny by default, decided in main on the page's own partition session.
- Preload (`shell/src/preload.cjs`): `contextBridge` + `ipcRenderer.invoke`
  only; no `remote`, no `shell`, no Node access.
- No permission-request handler override, certificate-error handler,
  remote-debugging/CDP switch, protocol handler change, auto-updater, or
  `child_process`/`exec`/`eval` in `main.js` (grep empty for all of these).
- No file:// or internal-scheme page loads from browser pages: pages load
  remote URLs through their verified partition; the app UI scheme is
  main-window-only.

## 4. Dependencies (unchanged)

`git diff d6553a3..HEAD -- package.json package-lock.json Cargo.toml
Cargo.lock` is empty. No package added, removed, or updated; no new script;
no `allowScripts` change. npm registry is the official one
(`https://registry.npmjs.org/`). Global npm packages are the user's own
tooling (codex, qodercli, argon2, asar, n8n, opencode, pnpm, rea-agents,
ws) — none v2-related, none installed by this audit.

## 5. Data and schema (unchanged)

No `core/` file appears in the diff, so no migration was added or changed
and the schema version is unchanged from d6553a3. Nothing was written by
tools outside the app into the repo. Real app data was not read, deleted,
or reset by this audit (test runs used fresh temp dirs only).

## 6. Tests and build on the snapshot branch (real numbers, laptop)

Job V2Audit1 (standard rights, `/RL LIMITED /IT`, minimized, whoami
Mandatory line first in its log): `npm run test` exit 0, `npm run build`
exit 0.

- IPC/NAPI/ESM checks: pass (pipeline reached the suites).
- Shell suite (`node --test`): **1204 pass / 0 fail**.
- UI suite (vitest): **71 files, 875 tests, all passed**.
- Core (cargo): **122 passed / 0 failed** across all test binaries.
- Full build (`npm run build`): exit 0.

## 7. Outside the repo (read-only)

- Desktop: `Progress Ledger v2.bat` (2026-10-26, 402 B) rebuilds
  (`npm run dist:dir`) and launches
  `release\win-unpacked\Progress Ledger v2.exe` — this is the v2 launcher
  the user runs. `Progress Ledger.lnk` (2026-10-23) points to the OLD app:
  `C:\Users\Asus\AppData\Local\Programs\Progress Ledger\Progress Ledger.exe`
  (left untouched).
- `release/`: `win-unpacked/` (live build, 2026-10-26), `fix-test/`
  (prior-session packaged proof build, 2026-10-27 02:37), plus the two
  builder config files. The live folder was not touched by this audit.
- `D:\Muse_Workspace` top level: only the standard structure
  (`archive/`, `projects/`, `tasks/`, `_scratch/`, `_shared/`, `INDEX.md`,
  `README.md`). No new loose files; `projects/` and `tasks/` mtimes are
  from this session's own work.
- Helper folder (`_shared/tools/agent-helper/`): `helper.bat`,
  `README.txt`, `jobs/` (only the pre-existing `cleanup1`,
  `helper_test`, `mycampus_phone` jobs — not mine, not run, left alone),
  `results/` (`test1` artefacts from 2026-10-24).
- Scheduled tasks (non-Microsoft, full detail captured): AMD (2),
  NVIDIA (2), OneDrive (3), Realtek, StartCN, StartDVR, FxSound updater,
  Google Platform Experience Helper (3), SoftLanding (4), Zoom updater
  (disabled), User Feed Sync (disabled), ZennoLab updater, Trae voice tool,
  plus the three UNKNOWN items in §2. **V2GFinalGate is ABSENT**
  (confirmed deleted). Vendor tasks are vendor-managed and were left alone.
- Startup: user Startup folder holds only `start-ai-memory.vbs`
  (2026-09-03); common Startup holds `FxSound.lnk` and `Tailscale.lnk`.
  Run keys (user + machine) hold only known apps (f.lux, IDM, Surfshark,
  Edge auto-launch, FxSound, Docker Desktop, ZennoBrowser, SecurityHealth,
  Bitdefender, CloudflareWARP). Nothing v2-related.
- Services: 1480 lines captured; zero matches for
  progress/muse/mycampus/cvrp/oracle/donut — no project-related service.
- User environment variables (names only, values never printed): no new
  project variable. `CLOUDFLARE_API_TOKEN` is pre-existing (2026-10-26);
  the rest are the user's toolchain vars (Android, Ghidra, Hermes, Ollama,
  Java, OneDrive, TraeVoiceTool).
- Global git config: stock keys plus `user.name`/`user.email` set
  (values not reproduced here).

## 8. Stage 1B cleanup record (on v2-continue)

- Reverts: **none required**. No change weakens a security rule, no new
  network call or telemetry, no unvetted package with an install script,
  and no BROKEN change exists (tests + build green). Nothing was reverted.
- Own scheduled tasks deleted (V2* only): `V2Audit2` (this audit's job)
  and `V2Shot9` (leftover from the 2026-10-27 visual-inspection session,
  found still present during this audit). Both deletions verified by
  `schtasks /Query` returning file-not-found. `V2Audit1` (this audit's test/build job) was deleted after its
  results were collected, verified by Query file-not-found.
- Everything GOOD or NEUTRAL, and everything that looks like the user's
  intentional work, was kept. RISKY/UNKNOWN items not reverted are the
  three in §2, left running with removal commands listed.
