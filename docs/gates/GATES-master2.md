# Gates: Master task 2 — Browser Manager + Quick Actions + CDP + lifecycle

OWNS: core/src/**/*.rs, shell/src/**/*.js, shell/src/preload.cjs, ui/src/features/browser/**, ui/src/features/quick-actions/**

Scope: Re-verify security fixes, implement Browser Manager UX + Quick Actions + restricted CDP adapter + lifecycle, run full regression.

## Phase 0 — reality check
- [x] P0-R0: HEAD = 82121de, 10 commits verified, 144/112/41/90/115/207 test gates green
  EVIDENCE: see above

## Phase 1 — security regression audit
- [ ] P1-A: cross-profile ownership regression test exists for every module
- [ ] P1-B: pooled DB connections get foreign_keys=ON at construction (no regression)
- [ ] P1-C: every BrowserWindow has contextIsolation + nodeIntegration:false + (sandbox where appropriate)
- [ ] P1-D: IPC has no raw fs / port / pid / CDP endpoint paths
- [ ] P1-E: error messages do not leak SQL/IO internals

## Phase 2 — Browser Manager product audit
- [ ] P2-A: every BM action traced UI → IPC → Rust → DB
- [ ] P2-B: gaps (if any) fixed

## Phase 3 — Quick Actions
- [ ] P3-A: small but useful initial action set shipped
- [ ] P3-B: actions call only safe high-level IPC

## Phase 4 — Browser profile UX
- [ ] P4-A: human-readable names, obvious Add, clear active/running/stopped, no Donut internals

## Phase 5 — Donut lifecycle integration (do not break)
- [ ] P5-A: architecture preserved; no quota/bypass tricks

## Phase 6 — restricted CDP adapter
- [ ] P6-A: only safe high-level methods exposed; renderer cannot pick CDP port/endpoint/pid/token

## Phase 7 — CDP test matrix
- [ ] P7-A: all happy-path + isolation + failure cases covered

## Phase 8 — Quick Action + Browser E2E
- [ ] P8-A: Playwright coverage for the 14-step sequence

## Phase 9 — product loop audit
- [ ] P9-A: every journey (A–H) traced and unbroken

## Phase 10 — data integrity
- [ ] P10-A: FK / UNIQUE / CASCADE / ordering verified + regression tests

## Phase 11 — performance
- [ ] P11-A: no aggressive polling, no process-list scanning, no duplicate startup

## Phase 12 — final security sweep
- [ ] P12-A: every `taskkill`, `killall`, `Process.kill`, `child_process`, `Authorization`, `Bearer`, `runtime.json`, `CDP`, `remote-debugging-port`, `APPDATA` occurrence reviewed

## Phase 13 — full regression
- [ ] P13-A: `npm test` exits 0 three times
- [ ] P13-B: `cargo test` passes
- [ ] P13-C: `svelte-check` clean
- [ ] P13-D: production build succeeds
- [ ] P13-E: complete Playwright suite passes

## Phase 14 — real browser smoke
- [ ] P14-A: real runtime launch + A/B isolation verified (no quota manipulation)

## Phase 15 — cleanup
- [ ] P15-A: no temp files, no unrelated diffs, no machine-specific paths, no secrets

## Phase 16 — final report
- [ ] P16-A: REPORT.md with all 19 sections
