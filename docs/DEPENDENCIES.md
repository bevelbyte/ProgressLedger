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
TO BE SET after the Phase 1 install audit. Expected minimal entry: electron
(its install script places the Electron binary; the investigation proved
npm 11.19 otherwise leaves the binary missing and a dev run cannot start).
Every entry here will carry its own reason. Never allow all.

## CareerFlow inherited dependencies — audit status
- npm audit: TO BE AUDITED in Phase 1 (real numbers to be recorded).
- cargo audit: TO BE AUDITED if possible offline; otherwise recorded as
  NOT VERIFIED (stated plainly, not guessed).
- Install scripts, abandoned packages, known vulnerabilities: TO BE FLAGGED
  in Phase 2. Fix by updating where it is safe; report the rest.
- TypeScript compiler / type-check step for main process and UI: the
  browser code stays TypeScript. If v2 needs a TS step, the smallest tool
  passing all six checks above is added and listed here with reasons.
  The browser is NOT rewritten to JavaScript.

## Fonts
Bundled locally, no CDN (see DECISIONS.md V2-10): Inter + a mono font as
local files. Exact files and licenses recorded here once bundled in Phase 2.
