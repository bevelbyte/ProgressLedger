# Progress Ledger v2 — decisions (DRAFT staging copy, 2026-10-24)

Status: DRAFT written on the Muse machine while waiting for the laptop helper
to run again. Copied into the v2 repo in Phase 0; later decisions are added
there, in the same format: decision, short reason, date.

## V2-01 — v2 starts as a source-only copy of CareerFlow; project-intel is protected first
Reason: the report's condition 1 — `shell/src/services/project-intel/index.js`
is untracked and cannot be restored from git, so it is copied out of any
gitignored path and verified byte for byte BEFORE any copy. The copy leaves
out node_modules, target, ui\dist, .git and other build output; .gitignore
is fixed so project-intel is tracked in v2.
Date: 2026-10-24 (planned, Phase 0).

## V2-02 — laptop runs go through temporary admin Task Scheduler tasks, minimized; SSH is for simple reads and file copies
Reason: the user set this route on 2026-10-24 (no helper.bat needed):
Bitdefender ATD blocks SSH-launched WMI/PowerShell script chains, but a
scheduled task running as admin in the user's own logged-in session runs
cleanly, minimized (start /min) so it does not disturb him, and is deleted
after the work is verified. Simple direct SSH commands were proven
unblocked. This keeps every build, test and screenshot inside the one
route that works. Proven 2026-10-24 22:25 IST with test task V2Check1
(created, ran minimized, log + done verified, deleted, deletion verified).
Date: 2026-10-24.

## V2-03 — data option (c): TypeScript research service stores through CareerFlow's Rust core
Reason: the report's recommendation — one store, one backup, no profile-id
mapping, reusing the existing migration-024 research tables, `research:*`
IPC and main-attested pattern, extended with PL-style live extraction
(innerText/selection + HTML snapshot file + SHA-256), FTS search and delete.
Option (b) (small TS SQLite store beside Rust) is the fallback ONLY if the
Rust toolchain fails, and then the two-store backup contract is written first.
Option (a) (full Rust rewrite) is rejected: too much work for no user gain.
Date: 2026-10-24 (planned, Phase 3).

## V2-04 — downloads: build a minimal managed-download feature in TypeScript
Reason: CareerFlow had managed downloads and the feature table forbids
silently losing a safety/product feature. Minimal means: per-profile download
folder, save with progress and finished/failed state, never auto-open a file.
Fallback, recorded here in advance: if the minimal feature proves too big
inside Phase 3, downloads are turned OFF with an honest "not available"
state instead, and this decision is updated to say so. No silent loss either way.
Date: 2026-10-24 (planned, Phase 3).

## V2-05 — Donut's old tables (browser_profiles, browser_shortcuts): decision deferred to Phase 3B
Reason: the task allows reuse or replacement, decided in 3B. The right call
needs the actual table schemas in hand, which Phase 3B inventories first.
Recorded here so the question is not lost. Until 3B, Donut code is removed
in Phase 2 and no new code depends on those tables.
Date: 2026-10-24 (deferred).

## V2-06 — test-mode window switch is an environment flag only, never in production
Reason: Phase 1 needs screenshots of the app window itself on a real desktop,
but a production back door that forces the window forward would be a
behavior change the user did not ask for. An env flag keeps testing honest
and production clean.
Date: 2026-10-24 (planned, Phase 1).

## V2-07 — no new packages at Phase 0; every later addition must pass all Section 2 checks
Reason: the user's standing rule — if a feature can be written in a
reasonable amount of code, write it instead of adding a package. The
checks (needed, widely used and maintained, license allows use, no install
scripts, no network calls, bundled offline) are applied per package and
recorded in DEPENDENCIES.md.
Date: 2026-10-24.

## V2-08 — layout numbers are measured from CareerFlow in Phase 4, never copied from Progress Ledger
Reason: the user wants CareerFlow's look, and the two apps' geometry differs
(PL numbers are in its own layout.ts). Measuring the real v2 shell keeps
the browser rectangle math honest for this app.
Date: 2026-10-24 (planned, Phase 4).

## V2-09 — cloud-sync, WebDAV and updater are OFF by default and make no network call at startup
Reason: CareerFlow's Settings show a cloud-synced backup folder option; the
task requires it off by default and silent at startup. A test proves it
(startup with no network calls from those features).
Date: 2026-10-24 (planned, Phase 2/5).

## V2-10 — fonts are bundled as local files (Inter + a mono font); no CDN, nothing loads from the internet at runtime
Reason: offline use and the task's Section 2.5 rule. CareerFlow's font
delivery was NOT VERIFIED in the investigation, so v2 does not assume it —
it bundles and proves it.
Date: 2026-10-24 (planned, Phase 2).

## V2-11 — build ID (git short hash + build time) shown in the status bar
Reason: the user must be able to tell at a glance that a screenshot shows
v2 and not an old build (Section 4.4), and the laptop git repo is the
source of truth.
Date: 2026-10-24 (planned, Phase 2).

## V2-12 — v2 data isolation: own app name, app id and userData path; a test proves it never opens CareerFlow, Progress Ledger, or installed-copy data
Reason: the task's Section 1.8 rule. A copy of CareerFlow would otherwise
point at CareerFlow's data by default; the test makes the separation
provable instead of assumed.
Date: 2026-10-24 (planned, Phase 0/1).
