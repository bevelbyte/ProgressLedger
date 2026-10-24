# Progress Ledger

Local-first desktop workspace for students: academic planning, study science,
knowledge management, and (later) career tracking — in one offline-capable app.

**Stack:** Electron (shell) · Svelte 5 + Vite (UI) · Rust/napi-rs (core) · SQLite + FTS5.

This repository is the cleaned-up successor of `Progress Ledger-Opus`. It preserves
that project's working engineering (SQLite schema & migrations, SM-2 engine,
profile portability, PDF/FTS5 knowledge search, feature-based Svelte UI) while
fixing the architectural failures that stalled it — see "What changed" below.

## Layout

```
core/     Rust napi addon (@progress-ledger/core)
  src/db/           domain modules (academic, resources, cards, deadlines,
                    mistakes, courses, lab_tracker, projects, formula_board,
                    subject_links) over a shared r2d2 SQLite pool
  src/migrations.rs + migrations/*.sql   ordered schema migrations (user_version)
  src/sm2.rs        spaced-repetition algorithm (unit-tested)
  src/portability.rs  .cfprofile ZIP export/import/inspect
  src/errors.rs     coded JSON error envelope shared with the UI
  tests/            migration/cascade/search integration suites

shell/    Electron main process (@progress-ledger/shell)
  src/main.js       thin entry: window, workspace init, DB init, IPC wiring
  src/workspace.js  workspace dir validation, locking, path resolution
  src/ipc/*.js      one registrar per channel family; EVERY preload channel
                    must have a handler here (scripts/check-ipc.mjs enforces it)
  src/services/     logger, backup settings, WebDAV client, local vault,
                    sync automation runner, diagnostics, bundle inspection
  src/preload.cjs   the single typed surface exposed to the renderer as
                    window.progressLedger.* (context-isolated)

ui/       Svelte 5 frontend (@progress-ledger/ui)
  src/features/<name>/   components/ + services/ (+ stores where needed),
                         public API via index.js barrel
  src/shared/            toasts, error-envelope parser, onboarding store
```

## Commands

```bash
npm install          # workspaces + electron
npm run build:core   # cargo build → native addon
npm run build:ui     # vite build
npm test             # check:ipc + vitest + cargo test
npm run dev          # vite + electron concurrently
npm run test:e2e     # Playwright smoke test (needs ui/dist built)
npm run dist         # build everything + electron-builder
```

## Pre-commit hook

A staged-file gate runs parity checks (`check:napi`, `check:esm`, `check:ipc`)
plus a fast test subset on agent-loop / UI changes before each commit. The
source lives in `scripts/pre-commit.mjs`; `.git/hooks/pre-commit` is not
tracked, so install it once after cloning:

```bash
bash scripts/install-hooks.sh
```

To bypass the gate for an emergency commit, prefix the message with
`[skip-pre-commit]`.

See [docs/CI-DEV-RUNBOOK.md](docs/CI-DEV-RUNBOOK.md) for the full test matrix,
per-suite commands, CI flow, and common failure modes.

## Rules (keep these small and enforced)

1. **IPC parity.** A channel in `preload.cjs` without an `ipcMain.handle` is a
   silent runtime failure — `npm run check:ipc` fails the build instead.
2. **One data path.** Renderer → service → `window.progressLedger.*` → Rust core →
   SQLite. No business logic in Electron main; main only bridges OS concerns
   (dialogs, files, credentials, updater).
3. **Domain math lives in Rust** (`sm2.rs`, SGPA/deadline-pace functions), pure
   and unit-tested. UI renders results; it does not re-derive them.
4. **Features don't import features.** Cross-feature communication goes through
   stores in `shared/` or explicit barrels, never deep imports.
5. **Schema changes = new migration file**, never edit old ones; keep
   `PRAGMA user_version` semantics intact so existing databases upgrade in place.

## What changed vs Progress Ledger-Opus

- Electron `main.js` (1,337 lines, all handlers inline) split into `ipc/` and
  `services/` modules with the same behavior.
- The dead channels were wired for real: `courses:*`, `labs:*`, `projects:*`,
  `projectTasks:*`, `formulas:*`, `notes:quick` + Alt+N global shortcut now have
  main-process handlers backed by the existing (already tested) Rust functions.
  Labs / Projects / Formula Board become fully functional for the first time.
- Removed browser-integration leftovers: Focus Curtain UI, focus IPC namespace;
  the Browser nav item remains a placeholder by design.
- Removed dead code: `features/academic/`, `shared/services/*` (unused ipc/event/
  storage wrappers), `streak.svelte.js`, duplicate type files, scratch scripts.
- `CgpaPlanner.svelte` and `Onboarding.svelte` moved into `features/`
  (`cgpa`, `onboarding`) unchanged in behavior — they are scheduled for
  decomposition in a later pass; do not add new code to them.
- Known debt carried over deliberately (fix in place later): CgpaPlanner still
  persists degrees to localStorage and mirrors subjects via name matching; some
  components coordinate refreshes via the `cf:data-changed` window event.

## Data locations

Per-user **workspace directory** (chosen at first run): `progress-ledger-v2.db`,
`attachments/<profile_id>/<resource>.pdf`, `Logs/`, `Temp/`,
`backup-settings.json`. `.cfprofile` bundles are portable ZIPs of one profile's
rows plus its attachments.
