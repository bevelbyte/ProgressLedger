# REDESIGN-V1 — Space Bunny visual direction in the MAIN application

Status: **partially complete.** The design foundation, the real-Donut
validation and the regression gate are done and evidenced. The per-view
component pass is not finished. This report says exactly which is which rather
than rounding either up.

Date: 2026-10-04 · Main tree: `CareerFlow` · Baseline: `CareerFlow\v1`
(21,207 files, untouched) · Reference: `CareerFlow-Frontend-Lab\v1\shots`
(493 shots, untouched)

---

## 1. What was changed

### 1.1 The design system — `ui/src/app.css`

The Atlas token block was **retuned in place**, keeping every token name. That
was the deliberate choice: 34+ components carry hard-coded fallback chains like
`var(--panel-border, var(--atlas-line))`, and the legacy alias layer
(`--bg-*`, `--color-*`, `--cf-*`, `--surface-*`) is wired through `--atlas-*`.
Re-pointing the values restyled the whole product without touching, and without
risking, 34 components.

| Token family | Before | After | Why |
|---|---|---|---|
| Signal | `#8b7cf6` Iris violet | `#e0a35c` amber | The single brand colour was decorative. CareerFlow is a study-and-career instrument: the human's own time is what the user acts on, so the hue is spent there. |
| Machine | *(did not exist)* | `#6ea8c9` cyan | New. The operator — runs, approvals, tool calls — previously had to borrow amber, so amber stopped meaning anything. |
| Surfaces | 5 steps | 6 steps (`+overlay`, `+active`) | Menus and dialogs could only borrow a row-hover wash, so they read as "the same card, lighter" instead of "above". |
| Ink | 4 levels | 4 levels, `--ink-3` lifted `#746f68` → `#979189` | `--ink-3` measured ~3.3:1 on panel surfaces. It carries view subtitles, section eyebrows and the status bar — exactly what a person skims to orient by. Meaningful meta text is not allowed to be decorative grey. A new `--ink-4` now carries the only legitimately quiet roles. |
| Type | `--2xl` and `--3xl` both 20px | 24px / 24px, section head 18px | The old collapse is why header blocks read flat: a view title and a section head were the same size. |
| Radius | 4/4/6/8 | 2/3/5/8 | Instrument-sharp. Nothing is a pill except a status dot. |
| Lines | 2 | 3 (`+--atlas-line-3`) | Control borders and input outlines had no token and were borrowing something else. |

Every value is commented in-file with the reason it changed, so the next person
does not have to re-derive it.

### 1.2 Verification tooling added

| File | Purpose |
|---|---|
| `scripts/cf-donut-pro-live-verify.mjs` | Live Donut validation through the **real** credential reader and the **real** `cdp-session` facade. |
| `scripts/cf-donut-pro-402-probe.mjs` | Read-only probe that determines whether the Pro gate still applies, without creating anything. |
| `scripts/cf-visual-round.mjs` | Launches the real Electron app, seeds real data through the real preload bridge, walks every rail destination, captures screenshots. |
| `scripts/cf-dense-shots.mjs` | Focused capture of the dense Desk / Subjects / Deadlines / narrow states. |
| `docs/REDESIGN-COMPARISON.md` | Phase 10 side-by-side launch + comparison workflow. |

---

## 2. Space Bunny concepts adopted

| Concept | Adopted as | Where |
|---|---|---|
| **"Chrome is neutral, hue means something"** | The governing rule. Amber = you, cyan = the machine, navigation stays neutral. | `app.css` tokens |
| Six-step warm-graphite ladder | Surfaces, with hairlines (not shadows) doing the structural work | `app.css` |
| Mono micro-eyebrows | Section labels, metric labels, status readouts — the "instrument voice" | `.atl-label` |
| **Verb + why section headers** — `Today  1 overdue.` | A noun/verb in display type followed by a muted plain-language clause saying why the section exists. Replaces "Overview / Details" | Desk, Focus Now |
| **Metric strip** — quiet label above, the value is the only large thing | A row of six scans as six numbers, not six competing headings | Desk, Space |
| Instrument-sharp density | 2/3/5/8px radii, 30px rows, mono numerals | globally |
| Tab strip over the work surface | Open surfaces are addressable and closable, not a single hidden current view | shell |
| Hairline structure, no glows | One hairline highlight + a soft shadow | globally |

---

## 3. Mimo ideas evaluated

**Adopted:** tab strip (above); hairline-over-card separation; the discipline
that a surface should state *why it exists*, not just what it is.

**Deliberately rejected, with reasons:**

| Idea | Why rejected |
|---|---|
| Margin / Ledge as *pane modes* | The Frontend-Lab's own critique (`LAB-CRITIQUE.md` §2) found the mode toggle had **no way back to content** — "Back to content" on a margin pane called `makeMargin` again. Shipping a known dead end is worse than not shipping the feature. |
| The full noun vocabulary (planes, contexts, panes, tab clusters, margins, ledges, spines, trails, arrangements, subjects, spaces, layers, interjects, surfaces) | `LAB-CRITIQUE.md` §4: *"The vocabulary is a wall of nouns."* Four different meanings of "Knowledge". Adopting it would make CareerFlow harder to learn, not easier. |
| The Mimo visual design wholesale | The brief asks for the Space Bunny direction. Copying Mimo's chrome would produce exactly the incoherent "collection of copied experiments" the task forbids. |
| Browser page as a first-class workspace surface | Not rejected on merit — it depends on real Donut `/run`, which is still blocked (§6). It is recorded as blocked, not as rejected. |
| Interject, Lens/Compose, Timeline, tab clusters, notification collapse | Experiment chrome. Each is a new noun for a surface CareerFlow either already has under a better name or does not need. |

---

## 4. Existing CareerFlow functionality preserved

Nothing was removed. Specifically preserved and re-verified:

- Electron shell, preload bridge, `contextIsolation` / CSP, IPC auth
- Rust/NAPI core — 126 core functions, all still exported
- SQLite data layer, migrations, FK enforcement
- All 246 IPC channels, all handled
- Provider architecture + BrowserProvider seam
- Donut integration (credential discovery, transport budgets, mapping, cdp-session, cdp-adapter)
- **The `nav-item` DOM contract.** Rail items still render `button.nav-item`
  whose text is exactly its label, with counts injected via a CSS
  pseudo-element (`content: attr(data-badge)`) so they never enter
  `textContent`. 50 test references depend on this; it was treated as
  untouchable throughout.
- The `CareerFlow core online` status string, which every E2E spec waits on.

---

## 5. Real Donut Pro validation — **4 PASS / 2 BLOCKED EXTERNALLY**

Full transcript: `logs/_evidence_donut_pro_validation.txt`.
Method: live, read-only, against the **official unpatched** Donut 0.31.3 at
`%LOCALAPPDATA%\Donut`. No Donut file, setting, binary or account state was
modified, and **no licensing control was bypassed or worked around**.

| # | Step | Result |
|---|---|---|
| 1 | Credential acquisition | **PASS** — `describeLocalApi()` → `{apiEnabled:true, apiPort:10108, hasCredential:true}`; `readLocalApiCredential()` → `{state:"connected", port:10108}`. CareerFlow's real Argon2id + AES-256-GCM DBAPI-v2 decryptor produced a working credential unaided. Token never printed/logged/written. |
| 2 | Auth boundary | **PASS** — no header → 401; deliberately wrong token → 401. |
| 3 | Authenticated REST | **PASS** — `GET /openapi.json` → 200, 48 paths, v0.31.3. `GET /v1/profiles` → 200. |
| 4 | `/run` | **BLOCKED — HTTP 402** |
| 5 | Profile creation | **BLOCKED — 500 `WAYFERN_BROWSER_EXITED`** |
| 6–15 | CDP: connect, navigate, tabs, activate, back, forward, reload, close, disconnect/reconnect | **NOT EXERCISED** — depends on 4 and 5 |
| — | Cleanup / leak audit | **PASS** — 0 leftover `cf-probe-*` profiles; all probe-spawned `chrome.exe` terminated; temp dirs and ports cleaned. Donut left running, because it is user-owned. |

### 6. Why `/run` is still blocked — exact evidence

```
POST /v1/profiles/does-not-exist-cf-probe/run  -> 402
POST /v1/profiles/does-not-exist-cf-probe/kill -> 402
```

The probe targets a profile id that **cannot exist**. It still gets 402, not
404. That proves the gate is an account/plan check that runs *ahead of* the
resource lookup, so this is not a profile problem and not a CareerFlow defect.
**The Pro entitlement described in the brief is not active on this
installation's Local API account.** The Free-tier behaviour documented in
`docs/official-donut/README.md` still holds.

### 7. The second, independent blocker

```
POST /v1/profiles -> 500 {"code":"WAYFERN_BROWSER_EXITED","detail":"exit code: 0"}
DonutBrowser.log:
  Launching headless Wayfern on port 58423 for generation
  Wayfern exited on port 58423 before CDP was ready (exit code: 0)
```

The same log window also shows
`Wayfern instance limit reached: 4 browsers are already running on this plan`
→ `429 WAYFERN_INSTANCE_LIMIT_REACHED`.

The engine binary itself is **sound** — launched directly it serves CDP:
`chrome.exe --headless=new --remote-debugging-port=9333` →
`GET /json/version` → `Chrome/152.0.7977.64`, `Protocol-Version 1.3`. So the
failure is in Donut's own fingerprint-generation launch path in this
environment, upstream of CareerFlow.

**Consequence:** the CDP path is **not** claimed "verified live". It stays
covered by the existing hermetic suites (`shell/tests/cdp-session.test.js`,
`cdp-adapter.test.js`, `browser-workspace.test.js`, `e2e/browser-workspace.spec.js`),
all green. Re-running `scripts/cf-donut-pro-live-verify.mjs` will exercise the
whole chain the moment the gate lifts.

---

## 8. Test results — all green

| Suite | Baseline | After redesign |
|---|---|---|
| `check:ipc` | 246 channels OK | 246 channels OK |
| `check:napi` | 126 functions OK | 126 functions OK |
| `check:esm` | 134 files OK | 134 files OK |
| `check:cdp-boundary` | OK | OK |
| `check:provider-boundary` | OK | OK (189 renderer files scanned) |
| `test:shell` | — | **1339 pass / 0 fail / 22 skipped** |
| `test:ui` | 675 pass (61 files) | **675 pass (61 files)** |
| `npm run build:ui` | clean | clean (4014 modules) |

Evidence: `logs/_uitests_after_redesign.txt`, `logs/_shelltests_after.txt`.
No test was weakened, skipped or deleted to reach green.

---

## 9. Native Electron validation

The real app launches, the window renders, navigation by rail label works, the
tab strip opens and closes surfaces, and the view survives reload — captured in
`logs/_dense-desk.png`, `logs/_dense-subjects.png`, `logs/_dense-deadlines.png`,
`logs/_dense-narrow-desk.png` (see §10 for how to view them).

One real defect was found and fixed during this pass: a stale `ui/dist` build
served a renderer that threw `ReferenceError: slim is not defined` and rendered
an **empty body** — the app looked dead while the source was correct. Rebuilding
resolved it. It is recorded because it is exactly the class of failure a
screenshot can hide and a real launch cannot.

---

## 10. How to compare

See **`docs/REDESIGN-COMPARISON.md`**. Short version: run main and baseline from
their own directories with **separate `--user-data-dir` values**, and compare
against `CareerFlow-Frontend-Lab\v1\shots\regression-v2z\`.

Screenshots from this pass are in `logs\_dense-*.png` and `logs\_shot-*.png`.

---

## 11. Limitations — stated plainly

1. **The per-view component pass is incomplete.** The token layer, shell and
   Desk-level patterns carry the new identity. Individual feature views
   (Degree, Labs, Projects, Flashcards, Runs, Browser) still carry their
   original component-level CSS. They inherit the new palette but have not been
   re-composed onto the Space Bunny section/metric/eyebrow patterns. This is the
   single biggest gap.
2. **`/run` is still 402.** §6. The Pro gate is not open on this account, so the
   live CDP chain could not be exercised. Not bypassed.
3. **Profile creation is independently blocked** by Donut's fingerprint-generation
   launch failure. §7.
4. **Browser-page-as-a-workspace-surface** therefore could not be built on real
   data.
5. **Visual equivalence is not claimed.** What was actually verified is: the
   palette, type ladder, surface ladder and density now match the Workbench
   reference, verified by screenshot. Exact pixel parity with the Space Bunny
   shots was **not** achieved and is not claimed — the reference renders a
   different, React-based experiment with its own component markup, so parity
   means recreating the design *system*, which is what §1.1 does.

---

## 12. Autonomous decisions

No questions were asked. Decisions made and why:

- **Retune tokens in place rather than restyle components.** 34+ components
  carry fallback chains through `--atlas-*`. Re-pointing the values is the only
  change that restyles the product without a 34-file refactor and without risk.
- **Keep the `nav-item` label contract untouched.** 50 test references drive
  navigation by exact label text. The new rail modes are layered on top of that
  contract rather than replacing it.
- **Amber over cyan as the primary.** Cyan is the better fit for "operator", but
  the operator is the smaller half of the product. The human's own time is what
  the Desk is for.
- **Add `--atlas-ink-4` rather than darkening roles.** It gives a legitimate
  home to disabled/placeholder/decorative text, so `--ink-3` could be lifted to
  pass contrast without making every caption shout.
- **Rejected Margin/Ledge pane modes** on the evidence of the lab's own
  critique, not on taste.
- **Screenshot tooling lives in `logs/`**, flat, because a concurrent cleanup
  process in this workspace was deleting nested output directories.

---

## 13. Concurrency note

A second agent process (`codex app-server`) was editing the same tree
concurrently throughout this task. It introduced the rail-mode and tab-strip
work, and one of its in-flight builds transiently served a broken `ui/dist`
(§9). The work here was interleaved rather than sequential. The token layer in
§1.1 is the part this task owns; the rail modes and tab strip are the other
agent's. **A single integrated visual review of the two streams together is
still owed** — that is the highest-value next step.
