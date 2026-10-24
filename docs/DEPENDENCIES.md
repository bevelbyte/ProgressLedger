# Progress Ledger v2 — dependencies (DRAFT staging copy, 2026-10-24)

Status: DRAFT written on the Muse machine while waiting for the laptop helper
to run again. Copied into the v2 repo in Phase 0 and updated after the real
audits in Phases 1–2. Nothing below is an audit result yet — audit results
will replace the "TO BE AUDITED" lines with real numbers.

## Rules for adding a package (user's Section 2 — ALL must be true)
1. Needed — my own small code cannot do it.
2. Widely used and maintained.
3. License allows the user's use.
4. No install scripts.
5. No network calls.
6. Bundled for offline use.
If a feature can be written in a reasonable amount of code, write it
instead of adding a package.

## Packages added by v2 (new, beyond CareerFlow's own list)
None yet. This section stays empty until a package passes all six checks;
each entry will list the package, version, what it is needed for, and the
six check results.

## allowScripts (npm 11 blocks install scripts unless allowed)
Recorded by npm's own approve command in Phase 1 (see DECISIONS.md V2-14).
Never allow all.
- electron@44.3.0: its install script places the Electron binary. Without
  it no dev or e2e run can start (proven: binary missing after the first
  install). Provisioned by running the approved install.js directly after
  npm rebuild proved to be a no-op.
- better-sqlite3@13.0.3: its install script is node-gyp rebuild. Approved
  so the option exists; the shipped prebuild suffices and no rebuild was
  run (proven by load test under system Node, FTS5 included).
- esbuild@0.21.5: explicitly NOT allowed. The UI build passes without its
  postinstall (binary arrives via @esbuild/win32-x64).

## CareerFlow inherited dependencies — audit status (Phase 1, real numbers)
- npm install: 442 packages added, 446 audited, in 43s.
- npm audit: 27 vulnerabilities (1 low, 5 moderate, 16 high, 5 critical).
  No fixes applied in Phase 1 (baseline); Phase 2 triages.
- Deprecated warnings at install: inflight@1.0.6, glob@7.2.3 and glob@10.5.0,
  whatwg-encoding@3.1.1, lodash.isequal@4.5.0, tar@6.2.1, lucide-svelte@1.0.1
  ("Please use @lucide/svelte instead").
- cargo audit: NOT VERIFIED (not run offline; stated plainly, not guessed).
- Install scripts flagged by npm: better-sqlite3, esbuild (see allowScripts
  above). Abandoned packages and known vulnerabilities: triage in Phase 2.
- TypeScript compiler / type-check step for main process and UI: the
  browser code stays TypeScript. If v2 needs a TS step, the smallest tool
  passing all six checks above is added and listed here with reasons.
  The browser is NOT rewritten to JavaScript.

## Fonts
Bundled locally, no CDN (see DECISIONS.md V2-10): Inter + a mono font as
local files. Status after Phase 1: NOT VERIFIED — no .woff2/.ttf files
were found under ui/src at import. Exact files and licenses recorded here
once bundled in Phase 2.

## Fonts bundled in Phase 2 (assets, not packages)
- Inter Variable, latin subset, normal + italic (variable weight
  100–900, woff2): copied from @fontsource-variable/inter as installed
  in the Progress Ledger repo (node_modules/@fontsource-variable/inter/
  files/inter-latin-wght-normal.woff2 + inter-latin-wght-italic.woff2).
  License OFL-1.1. Latin only by decision (V2-19): the UI is English.
- Cascadia Mono, Regular (ttf): copied from C:\Windows\Fonts\
  CascadiaMono.ttf. License OFL-1.1. Chosen because it is present on
  the machine; JetBrains Mono was not installed and was not downloaded.
- No new npm or cargo package was added in Phase 2. Font files are
  bundled into ui/dist by Vite (hashed assets); nothing is fetched from
  the internet at runtime.

## typescript 5.9.3 (devDependency, added Phase 3)
- Needed: the ported browser logic is TypeScript (V2-22); a TS compiler
  cannot reasonably be hand-written, and the shell is plain ESM with no
  TS step today.
- Widely used and maintained: the standard TypeScript compiler, the
  same tool the UI's Vite toolchain already depends on.
- License: Apache-2.0 (allows use).
- Install scripts: none that run on install (package.json carries
  no preinstall, install or postinstall entries — verified on the
  installed copy; its only script is a custom `setup-hooks` helper
  that npm never runs automatically, and it is not in `allowScripts`
  because it needs no approval to stay unrunnable).
- Network calls: none at runtime; tsc runs locally on the repo.
- Bundled for offline use: dev-only tool; its output is plain JS
  committed nowhere (gitignored dist dir) and rebuilt locally by npm
  pre-hooks. No runtime network fetch.

## sha2 0.10 (cargo, added 2026-10-25 for the backup snapshot check)
- Needed: backup export must verify each snapshot file's SHA-256
  against its research_sources row, and import must verify bundle
  snapshot bytes against the manifest SHA, before trusting them.
- Widely used and maintained: the RustCrypto SHA-2 implementation,
  the standard Rust SHA-256 crate, millions of downloads.
- License: MIT OR Apache-2.0.
- No install scripts: cargo builds it from source; no postinstall.
- No network calls: pure computation, compiled into the core.
- Bundled offline: part of the core binary, nothing fetched at runtime.
