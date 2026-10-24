# GATES-manager.md — Donut Browser Manager (phase ledger)

Status after oracle run (`node verify-manager.mjs`): **ALL 12 PASS**.
Oracle re-derives every gate from repo artifacts; this ledger records the
human-level intent plus the executed evidence.

| Gate | Intent | Verdict |
|------|--------|---------|
| G1 | Migration 015 exists and is registered in `core/src/migrations.rs` | MET |
| G2 | `browser_profiles` / `browser_shortcuts` tables with cascade FKs (≥2 ON DELETE CASCADE) | MET (3) |
| M1 | Full 14-fn CRUD napi surface in `core/src/db/browser_manager.rs` | MET |
| M2 | No machine-local Donut id column in durable schema | MET |
| P1 | Portability v2: browser metadata+shortcuts exported; import mints fresh `imp-<pid>-<n>` ids; no UUID in manifest | MET |
| B1 | Binding flow (`createBrowserBindingFlow`, `bfc-` prefix) over workspace `donut-bindings.json` | MET |
| B2 | Duplicate store module `donut-bindings.js` removed — single source of truth | MET |
| O1 | Canonical `createManagerOps` single-defined, pure (no electron/fs/credential imports); `ownedRunning` bug fixed | MET |
| I1 | `bm:*` registered exactly once (11 channels); `ctx.donut` graph attached before manager registrar | MET |
| I2 | Renderer surface free of tokens/PIDs/ports/runtime.json/paths; bearer confined to header construction | MET |
| T1 | Test layers present + wired: unit (donut-manager.test.js), Rust CRUD, Rust roundtrip, E2E spec | MET |
| E1 | Regression evidence fresh for whole matrix | MET |

## EVIDENCE (executed this session)

- `npm test` → **exit 0** (check:ipc 141 channels OK · check:napi OK · check:esm OK
  · shell **90/90** incl. new `donut-manager.test.js` 13 cases · UI vitest **101/101**
  · cargo: all suites green incl. `browser_manager_crud` 7/7 + portability roundtrip)
- `npx playwright test` → **30 passed** (subject-links 5 · donut-manager 9 ·
  lifecycle/provider suites 16)
- `npm run build:ui` → built clean (pre-existing chunk-size warning only)
- `cargo build --release` (addon) → success; regenerated `index.d.ts` exposes all
  browser fns

## SECURITY AUDIT (new surface)

- **P0 none.** Bearer token read fresh per request, confined inside
  `bearerPost` header construction; never returned/logged/persisted. Stub world
  cannot touch real credentials. All SQL parameterized (`params!`). URL
  validation happens main-process-side (`validateHttpUrl`) before any
  `/open-url`; `/run` body is always `{}` (no renderer-controlled flags → no
  CDP/url injection surface).
- **P1 none.** Cross-profile isolation enforced on every read/reorder path;
  unknown owners get empty lists (no existence oracle); busy lifecycle gate
  prevents racing stop/restart; foreign backend never touched (ownership
  anchors reused from provider/lifecycle).
- **P2 (accepted, documented):** (a) metadata mutations keyed by opaque local id
  verify existence but not owning-cf — consistent with the app's
  trusted-renderer model (ids are renderer-minted UUIDs, not capabilities);
  (b) shortcut URLs are validated at *open* time rather than CRUD time, so
  exotic strings can be stored but never launched unsanitized.
- Anti-detection/stealth: none added — only documented contract endpoints
  (`/v1/profiles*`, `/open-url`, `/run`) with paced anti-burst backoff.

## CONSTRAINTS HONORED

- DonutBrowser-Integration untouched (read-only authority).
- Fork dir `C:\Users\Asus\Projects\Donutbrowser` never accessed.
- No Donut process started/stopped/killed outside the hermetic stub seam.
