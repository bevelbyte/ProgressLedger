# Test counts — Progress Ledger v2

Exact pass/fail counts per suite, measured on the laptop. No number here is
guessed: every count comes from a job log in the task folder named below.
A step that exits 0 but runs no tests is recorded as such, not as a pass count.

## Baseline e585d3b (2026-10-27)

- Commit: e585d3b ("PROGRESS-2026-10-27-audit-and-followup-rounds"), tree clean
  before and after the run (`git status --porcelain` empty).
- Job: V2C1Base, temporary Task Scheduler task, standard rights only
  (`whoami /groups` = Medium Mandatory Level), run minimized 2026-10-27
  ~15:50–15:54 IST, deleted after verification.
- Logs: `D:\Muse_Workspace\tasks\2026-10-27_v2_localfiles_errorpage\logs\`
  (`c1-<step>.log` + `c1-<step>.exit` per step, `c1.whoami`, `c1.done`).
- Every step exited 0.

| Step | Suite / command | Result |
| --- | --- | --- |
| build | `npm run build` | exit 0, built in 11.35 s (one chunk-size warning, not a failure) |
| check-ipc | `node scripts/check-ipc.mjs` | exit 0, 244 channels, all handled |
| check-napi | `node scripts/check-napi.mjs` | exit 0, 124 core functions referenced by IPC handlers, all exported |
| check-esm | `node scripts/check-esm.mjs` | exit 0, all relative shell imports resolve (131 files) |
| shell | `node --test shell/tests/*.test.js` | 1224 passed, 0 failed |
| ui | `npm run test -w @progress-ledger/ui` | 71 files passed, 884 tests passed, 0 failed |
| core | `cargo test --manifest-path core/Cargo.toml -- --test-threads=1` | 124 passed, 0 failed (16 test binaries, summed from their `test result` lines) |
| isolation | `e2e/browser-profile-isolation.spec.js` | 4 passed, 0 failed |
| guard2 | `e2e/e2e-data-guard2.spec.js` | 4 passed, 0 failed |
| search | `e2e/search-engine.spec.js` | 2 passed, 0 failed |
| pdf | `e2e/pdf-viewer2.spec.js` | 1 skipped, 0 passed, 0 failed |
| mgr | `e2e/browser-profile-manager.spec.js` | 1 passed, 0 failed |
| play | `e2e/browser-profile-play.spec.js` | 2 passed, 0 failed |
| split | `e2e/profile-card-split-page.spec.js` | 1 passed, 0 failed |
| chat | `e2e/chatgpt-connect.spec.js` | 1 skipped, 0 passed, 0 failed |

### Why pdf and chat show "skipped", not "passed"

Both are diagnostic probes that skip themselves when their harness variable
is absent; the baseline job does not set it, so the skip is the correct,
expected outcome for a plain suite run — not a failure and not a pass:

- `e2e/pdf-viewer2.spec.js:93`:
  `test.skip(!process.env.SITECOMPAT_BARE_DIR, "SITECOMPAT_BARE_DIR not set (diagnostic probe)")`
- `e2e/chatgpt-connect.spec.js:87`:
  `test.skip(!process.env.CHATGPT_BARE_DIR, "CHATGPT_BARE_DIR not set (diagnostic probe)")`

The Final run (C2) must use the identical job shape so its numbers stay
comparable with this baseline. If a later run sets those variables, the
difference must be recorded here next to that run, not silently merged.

## Final (C2, 2026-10-27)

- Job: V2C2, temporary Task Scheduler task, standard rights only
  (`whoami /groups` = Medium Mandatory Level), run minimized 2026-10-27
  ~17:12–17:20 IST, deleted after verification. Same step shape as the
  baseline job above, plus the three new specs from this round (local,
  loaderror, chatgpt) at the end.
- Logs: `D:\Muse_Workspace\tasks\2026-10-27_v2_localfiles_errorpage\logs\`
  (`c2-<step>.log` + `c2-<step>.exit` per step, `c2.whoami`, `c2.done`).
- Every step exited 0. The tree at run time was the round's working tree
  (uncommitted); the commit that follows contains exactly that tree plus
  this Final section and the DECISIONS append — docs only, no code
  difference, so these counts describe the committed code.

| Step | Suite / command | Result |
| --- | --- | --- |
| build | `npm run build` | exit 0 |
| check-ipc | `node scripts/check-ipc.mjs` | exit 0, 245 channels, all handled |
| check-napi | `node scripts/check-napi.mjs` | exit 0, 124 core functions referenced by IPC handlers, all exported |
| check-esm | `node scripts/check-esm.mjs` | exit 0, all relative shell imports resolve (132 files) |
| shell | `node --test shell/tests/*.test.js` | 1233 passed, 0 failed |
| ui | `npm run test -w @progress-ledger/ui` | 72 files passed, 894 tests passed, 0 failed |
| core | `cargo test --manifest-path core/Cargo.toml -- --test-threads=1` | 124 passed, 0 failed (16 test binaries, summed from their `test result` lines) |
| isolation | `e2e/browser-profile-isolation.spec.js` | 4 passed, 0 failed |
| guard2 | `e2e/e2e-data-guard2.spec.js` | 4 passed, 0 failed |
| search | `e2e/search-engine.spec.js` | 2 passed, 0 failed |
| pdf | `e2e/pdf-viewer2.spec.js` | 1 skipped, 0 passed, 0 failed |
| mgr | `e2e/browser-profile-manager.spec.js` | 1 passed, 0 failed |
| play | `e2e/browser-profile-play.spec.js` | 2 passed, 0 failed |
| split | `e2e/profile-card-split-page.spec.js` | 1 passed, 0 failed |
| chat | `e2e/chatgpt-connect.spec.js` | 1 skipped, 0 passed, 0 failed |
| local | `e2e/local-file.spec.js` | 3 passed, 0 failed |
| loaderror | `e2e/browser-load-error.spec.js` | 1 passed, 0 failed |
| chatgpt | `e2e/chatgpt-cause.spec.js` | 1 passed, 0 failed |

### Differences from the baseline, and why each is expected

- check-ipc 244 → 245: the one new channel from this round,
  `browser:open-local-file` (plus its preload entry). No other channel
  changed.
- check-esm 131 → 132 files: the one new shell module,
  `shell/src/services/browser/local-file.js`.
- shell 1224 → 1233 (+9): the 8 new local-file tests plus the 1 new
  `isEphemeralViewerUrl` test. No existing shell test changed outcome.
- ui 884 → 894 (+10): the 8 new address-bar tests plus the 2 new
  load-error tests (store failed-event preservation, error-block render).
  No existing UI test changed outcome.
- pdf and chat are still skipped by design, for the same reason as the
  baseline (their harness variables are not set by a plain suite run).
  The new chatgpt-cause spec is a different, self-contained matrix and
  does not set those variables.
