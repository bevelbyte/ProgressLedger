# CareerFlow — "Atlas" Design Specification

**Status:** Authoritative. Supersedes `docs/DESIGN.md` (Meridian) for all UI work.
**Scope:** `ui/src/**` (Svelte 5 renderer) and shell window chrome.
**Version:** 2.0 — 2026-09-20

---

## 0.1 Repo-state audit and decision record — 2026-09-21

Atlas was designed in a session that ended mid-implementation (provider rate
limit, then a machine shutdown). A later session re-audited the repository
rather than trusting the plan, and re-derived every decision below from the code.

**What the audit found in the working tree**

| Surface | State found | Verdict |
|---|---|---|
| `docs/DESIGN-ATLAS.md` (this file) | Complete and coherent design argument | **KEEP**, corrected — see §0.2 |
| `ui/src/app.css` Atlas tokens | Complete (`--atlas-*` + Meridian aliases) | **KEEP** |
| `ui/src/shell/` TitleBar, NavRail, ContextHeader, StatusBar, OperatorConsole, `operator.svelte.js`, `view-registry.js` | Written, coherent, consistent with this document | **KEEP** |
| `ui/src/App.svelte` rewritten to compose the shell | Written, but imported two files that did not exist | **MODIFY** |
| `ui/src/shell/KeyboardHelp.svelte` | Referenced by `App.svelte`, absent | **CREATE** |
| `ui/src/shell/SettingsHub.svelte` | Referenced by `App.svelte`, absent — the entire Settings surface (six panels) was unreachable | **CREATE** |
| `ui/tests/**` | 542 tests passing — none covered the shell, which is why its regressions were silent | **MODIFY** (add contract coverage) |
| ~170 feature components | Un-migrated Meridian/GitHub-dark components rendering inside the new shell | **MIGRATE** (in progress, §12) |

**Four regressions the audit found and fixed.** All four were invisible to
`npm run test:ui` because the suite had no shell coverage.

1. **The renderer did not build.** `App.svelte` imported `KeyboardHelp.svelte`
   and `SettingsHub.svelte`, neither of which existed on disk. `vite build`
   failed to resolve both.
2. **`CareerFlow core online` had left the DOM.** 20 E2E spec files wait on that
   exact text as their "the app is up" gate. The new status bar paraphrased the
   native `ping()` response into `core ok`, which would have failed every one of
   them at the readiness step — long before reaching the behaviour they test.
   The status bar now renders the native response verbatim (§4.5).
3. **Settings had no content.** The vault, cloud sync, sync automation, grading,
   diagnostics and updates panels were dropped by the rewrite and never restored,
   so `Settings` rendered an empty stage and the whole-profile backup/restore
   E2E flow had nothing to click.
4. **21 design tokens were referenced but never defined.** Un-migrated
   components wrote `var(--panel-border, #2a313a)` and similar, so instead of
   failing loudly they silently rendered a *different product's* palette —
   GitHub-dark's cooler blue-grey — inside Atlas surfaces. The names are now
   defined in `app.css` (§10), which makes those fallbacks dead code and pulls
   the regions onto the real palette.

Two robustness bugs surfaced while writing the contract tests and were fixed at
the source rather than worked around in the test:

- An unparseable timestamp in vault metadata threw a `RangeError` during render,
  blanking the entire Settings pane. Formatting now goes through
  `formatTimestamp()` (`shared/utils/local-date.js`), which states `Unknown` and
  renders an unparseable string verbatim for diagnosis.
- A diagnostics report missing `data` or `sync` threw while rendering its summary
  tiles and took the pane down with it. Reads are now optional-chained, and a
  missing check reads as `—`, not as `0`.

## 0.1b Second wave — 2026-09-22

The ledgers in this file name the surfaces that were "not started" or "partial".
This revision implements them: **Goals**, **Career**, **Research**, the **Runs
console**, and **first run**, followed by a product-wide consistency pass over
colour, type, radius, spacing and iconography (§10.1).

Two things are worth recording because they are decisions, not work items:

1. **The Runs console deviates from §5.3's first draft, deliberately.** Approvals
   and the tool trace are *not* inspector tabs; they are live run state, and an
   approval is the agent blocking on the user. Tabs are for looking things up,
   not for noticing things. The E2E gates on that surface (asserted visible with
   no prior interaction) had already reached the same conclusion independently.
2. **First run deviates from §5.7's first draft, deliberately.** The plan asked
   for "what are you studying?"; there is no honest way to ask that before a
   profile exists. §5.7 records why, and what replaced it.

A third finding is a *product* defect rather than a design decision, found by
running the Electron specs instead of reading code: the shell's context header
rendered an `h1` that duplicated each panel's own heading (making a role query
resolve to two elements), and its view icon was written `<icon>` in lowercase, so
no view icon had ever rendered. Both are fixed and now covered by tests (§9.1).

---

### 0.2 What this revision changed in the specification

- **§4.4 corrected.** The original text claimed the Operator Console renders
  sanitized tool *arguments*, on the grounds that the main process sends them.
  It does not: `shell/src/services/agent/event-sanitizer.js` deliberately
  projects only tool name, call id, permission, elapsed time and error code. The
  implementation was already honest ("Arguments are not projected to the
  interface"); the document was not. The design now leans on making the
  **permission** legible in plain language and pointing at the transcript for
  detail, which is what the code does. A security boundary is not a design
  choice to be overridden by a nicer mockup.
- **Verbatim-native readouts** are now an explicit principle (§4.5, §11): where a
  native subsystem reports a fact, the interface repeats it rather than
  paraphrasing it. Paraphrase is where drift and regressions hide.
- **A migration ledger** (§12) records what is actually done, partial, or
  untouched, so "the design is finished" and "the app is finished" cannot be
  confused.
- **Contract coverage** (§9.1) names the shell behaviours that must be locked by
  tests, because the absence of that coverage is what let all four regressions
  above land silently.

---

## 0. Why this document exists

Meridian described CareerFlow as *"a calm, instrument-like desktop workspace"* and
then expressed that idea as **sixteen nav items in six groups, all equally loud**,
a home screen that repeated the same information four times, and an Agent surface
that stacked twenty panels into three columns with no hierarchy.

Atlas is a **product redesign**, not a restyle. It starts from the question:

> What should a user think CareerFlow *is*?

The answer Atlas commits to:

> **CareerFlow is a desk with three things on it — today's work, the spaces where
> your work lives, and an operator that does work for you.**

Everything below follows from that sentence.

---

## 1. Product model

### 1.1 The four nouns

| Noun | What it is | Where it lives |
|---|---|---|
| **Desk** | The present tense. What is due, what is next, what to start. | `Home` view — the default landing surface |
| **Space** | A durable body of work. Either a **Subject** (academic) or a **Project** (build). | `Subjects`, `Projects` — both open the same workspace shell |
| **Run** | One execution of the operator inside a Space. | `Project` view (Runs console) + the Operator console |
| **Library** | Knowledge that outlives any one Space. | `Flashcards`, `Mistakes`, `Formulas` (+ notes/PDFs surfaced contextually) |

Two supporting surfaces: **Plan** (`Deadlines`, `Study Sessions`, `Goals`,
`Career`) and **System** (`Profiles`, `Settings`).

### 1.2 The core IA insight

Subjects and Projects are the **same shape**: something you work on over months,
which accumulates deadlines, tasks, notes, cards, mistakes, sessions, research,
and eventually an Agent.

The old UI treated them as unrelated silos and buried the Agent inside
"Project Mode" — an application inside the application that a student never
opens, because a student's work is a *subject*, not a git repository.

Atlas unifies them at the presentation layer:

```
SPACE = { Subject | Project }

  Overview    identity, progress, next action
  Work        deadlines, tasks, labs, milestones
  Knowledge   notes, PDFs, cards, mistakes, formulas, links
  Sessions    study time, focus history
  Research    browser workspace, saved places, captures
  Agent       runs attached to this Space
```

Backend ownership is unchanged: a Subject is still
`profile → track → semester → milestone → subject`, a Project is still
`profile → project`. Atlas does not invent data; it unifies *how the user
addresses it*.

### 1.3 What the user should feel in the first 10 seconds

1. **"It knows what I should do."** The Desk opens on the agenda, not on metrics.
2. **"I can just type."** The command bar is physically in the title bar.
3. **"The machine is visible."** Operator state (idle / running / waiting for me)
   is always on screen, and an approval can never be missed.

---

## 2. Design directions considered and rejected

Recorded so the choice is legible, not so it is re-litigated.

**A. "Notebook" — light-first paper + ink, vermilion accent.**
Rejected. A desktop app used daily for years, holding a live browser and an
agent transcript, reads better dark. Also: every existing component assumes
dark surfaces, and a light-first inversion would have forced a token fork.

**B. "Drawer cabinet, reorganised." — keep the shell, regroup the sidebar.**
Rejected. Explicitly what the brief forbids, and it does not fix the real
problems (no hierarchy in the Agent surface, no global operator state, three
competing browser surfaces, a settings dumping ground).

**C. "Split-pane everywhere." — browser and agent permanently docked.**
Rejected as the *default*. Desktop screens are wide but not infinite; two
permanent docks plus a rail leaves a column too narrow for tables. Adopted
selectively instead: the research pane is dockable, the operator console is a
drawer that opens when it has something to say.

**D. "Atlas" — Desk / Spaces / Runs, warm-graphite instrument, one signal accent.**
**Chosen.** It fixes the Agent surface (the worst offender), makes the operator
globally visible, collapses three browser surfaces into one, gives Subjects and
Projects a shared workspace archetype, and gives the product a first sentence.

---

## 3. Visual identity — "Kiln"

A **warm-graphite instrument**: a drafting surface with hairlines and mono
readouts, not a wall of rounded cards.

Three adjectives: **warm, exact, awake.**

### 3.1 The five visual devices

These are what make Atlas recognisably *not* Meridian. A restyle changes colour;
Atlas changes construction.

1. **Hairlines instead of card walls.**
   Dense regions — nav, lists, tables, transcript rows, inspector rows — are
   separated by 1px rules on the surface, **not** wrapped in bordered cards.
   A bordered `surface-1` panel is reserved for a genuinely discrete object
   (a Space card, a run card, a dialog). Previously *everything* was a card.

2. **Mono micro-labels.**
   Every section label, metric label, status readout and table header is
   `--font-mono`, 10–11px, uppercase, `0.08em` tracking. This is the instrument
   voice and it is used consistently — never a sans-serif uppercase label.

3. **The spine.**
   The active nav item carries a 2px accent spine that continues as a continuous
   vertical hairline down the rail, so the rail reads as a map legend rather than
   a stack of pills. Active state = spine + ink, **not** a filled pill.

4. **Reduced radius.**
   `8px` panels · `6px` controls · `4px` micro · `999px` pills only.
   Meridian used `14px` panels and `10px` buttons — the rounder, softer read is
   gone on purpose.

5. **One hairline highlight for elevation.**
   Floating surfaces get `inset 0 1px 0 rgba(255,255,255,.04)` plus a soft
   shadow. Resting surfaces get **no shadow at all**; their edge is a hairline.

### 3.2 Colour

Warm neutral, single signal accent. The neutrals are warm-shifted (a hint of
red/yellow), which is the largest single departure from Meridian's blue-cast
grays.

```
SURFACES (dark → light, warm graphite)
  --atlas-void     #08080a    window backdrop behind dialogs
  --atlas-base     #0f0f11    app background
  --atlas-chrome   #141416    title bar, nav rail, status bar, docks
  --atlas-panel    #1a1a1d    discrete objects (cards, panels)
  --atlas-raise    #212125    nested blocks, inputs, hover rows
  --atlas-hover    #292930    selected / pressed

INK (warm paper, not blue-white)
  --atlas-ink      #efece6    primary
  --atlas-ink-2    #a8a49d    secondary
  --atlas-ink-3    #746f68    muted (non-essential, ≥12px only)

LINES
  --atlas-line     #27272b
  --atlas-line-2   #36363c    emphasized edges, focus-adjacent hover

SIGNAL — "Iris" (the only brand colour)
  --atlas-signal       #8b7cf6
  --atlas-signal-2     #a99cff    hover / strong text on dark
  --atlas-signal-soft  rgba(139,124,246,.14)
  --atlas-signal-softer rgba(139,124,246,.07)
  --atlas-signal-ink   #0f0f11    text on a signal-filled control

SEMANTIC (state only, never decoration)
  --atlas-ok     #5cc08a   --atlas-ok-bg     rgba(92,192,138,.13)
  --atlas-warn   #e0b45c   --atlas-warn-bg   rgba(224,180,92,.14)
  --atlas-bad    #f0716f   --atlas-bad-bg    rgba(240,113,111,.13)
```

**Rule: one accent.** Iris is the only brand hue. The Agent does **not** get a
second colour; machine action is signalled by *treatment* — a live pulse dot, a
dashed hairline "live rail", and a mono `OPERATOR` micro-label — never by a new
hue. This keeps semantic colour unambiguous: green/amber/red always mean
state, never "the AI".

Contrast: body ink ≥ 12:1 on base, secondary ≥ 5:1, muted reserved for
non-essential text ≥ 12px.

### 3.3 Typography

No webfont is bundled and none is added. Atlas earns its typographic identity
from **treatment**, not from a new family — this keeps the renderer offline,
local-first and free of a font-loading flash.

```
--font-sans   ui-sans-serif, "Segoe UI Variable Text", "Segoe UI",
              -apple-system, Inter, system-ui, sans-serif
--font-mono   ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace
```

| Token | Size | Weight | Tracking | Use |
|---|---|---|---|---|
| `--text-micro` | 10px | 600 | .08em | mono micro-labels, status readouts |
| `--text-xs` | 11px | 600 | .06em | table headers, mono eyebrows |
| `--text-sm` | 12px | 400 | 0 | captions, row metadata |
| `--text-md` | 13px | 400 | 0 | **default body** (was 14px) |
| `--text-lg` | 14px | 500 | -0.005em | item titles |
| `--text-xl` | 16px | 600 | -0.01em | section headings |
| `--text-2xl` | 20px | 600 | -0.02em | page titles (was 26px) |
| `--text-metric` | 26px | 600 | -0.03em | metric numerals |

Body drops to 13px and page titles drop from 26px to 20px. Density up,
shouting down. All numerals are `tabular-nums`.

### 3.4 Spacing and density

4px grid, unchanged token names, tighter usage:

```
--space-1 4  --space-2 8  --space-3 12  --space-4 16
--space-5 20 --space-6 24 --space-8 32  --space-10 40
```

- List row height **28px** (was 32–36). Table row **30px**.
- Control height: **26px** compact, **30px** default, **34px** large.
  (Meridian: 28/32/36.)
- Content column max-width **1400px** (was 1200) — the app is a desktop tool and
  should use a desktop's width.
- Page padding 24px horizontal, section gap 20px.

### 3.5 Motion

```
--ease      cubic-bezier(.16, 1, .3, 1)
--dur-fast  110ms     colour, background, border, spine
--dur-med   160ms     fade, small translate, drawer
--dur-slow  220ms     dialogs, palette, view change
```

- View change: **fade + 4px rise**, 220ms. Never a slide.
- Nav spine: grows from 0 → 100% height in 110ms.
- Panels entering a docked column: fade + 6px slide from the dock edge.
- **Never animate**: the main column width, number values, or text content.
- Pulse (running agent, waiting approval): 1.8s opacity loop on a 6px dot.
- `prefers-reduced-motion: reduce` disables all of it globally.

### 3.6 Iconography

`lucide-svelte` only. **14px** inline, **15px** nav, **16px** section headers.
Stroke **1.6**. Icons never appear without a label except in the title bar and
row-level affordances, where they carry `aria-label` + `title`.

---

## 4. Application shell

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ⬢ CareerFlow   ⌘K  Search or run a command…   ● Ada ▾   ▣  ◐  ⚙  ▤  ─ □ ✕  │ 46px  TITLE BAR
├────────┬──────────────────────────────────────────────────────────────────┤
│        │  CONTEXT HEADER   Title · subtitle              [view actions]   │ 52px
│  RAIL  ├──────────────────────────────────────────────────────────────────┤
│ 216px  │                                                                  │
│        │                     WORK SURFACE                                 │
│        │                                       ┌────────────────────────┐ │
│        │                                       │  aside.right-sidebar   │ │
│        │                                       │  (Quick Actions)       │ │
│        ├───────────────────────────────────────┴────────────────────────┤ │
│        │  OPERATOR CONSOLE  Approvals · Runs · Activity        ⌄          │ drawer
├────────┴──────────────────────────────────────────────────────────────────┤
│ ada · local   ● core ok   ◐ 1 waiting for you   ⌘K commands   14:32       │ 26px  STATUS BAR
└───────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Title bar (46px, `-webkit-app-region: drag`)

Order: brand mark → **command bar** → right utilities.

- **Command bar** is a real input, not a button that opens a modal. Clicking it
  (or `Ctrl+K`) expands it into the full command palette in place. This is the
  single most desktop-native change in Atlas: the product is command-first, and
  the affordance is visible at all times rather than hidden behind a shortcut.
- **Profile chip** — a popover switcher. Profile is *context*, not a destination.
  Switching is one click from anywhere. (`Profiles` nav item still opens the full
  manager: create, import, export, delete.)
- **Operator chip** — shows operator state (idle / running / waiting). Clicking
  opens the Operator Console drawer. Pulses when waiting for the user.
- Utilities: browser workspace toggle, quick actions toggle, notifications,
  tutorial.

### 4.2 Nav rail (216px, collapsible to 56px icon rail)

Plane-labelled groups, mono eyebrows, hairline separators, spine on active.

```
TODAY      Home
SPACES     Subjects · Projects · Degree · Labs
PLAN       Deadlines · Study Sessions · Goals · Career
LIBRARY    Flashcards · Mistakes · Formulas
OPERATOR   Project · Browser
SYSTEM     Profiles · Settings
```

The sixteen route names are the **routing vocabulary** and are preserved
verbatim (they are functional contracts — see §9). What changes is the model
above them: they are grouped by *plane of activity*, the rail collapses to an
icon rail, and the active state is a spine rather than a filled pill.

`Profiles` and `Settings` are pinned to the rail footer, separated by a
hairline, because they are workspace-level, not work-level.

### 4.3 Context header (52px)

Every view declares a title, an optional one-line subtitle, and its view-level
actions. Previously each view invented its own header. This is now the one place
a view states what it is and what you can do to it.

### 4.4 Operator Console (bottom drawer)

The most important new surface. A collapsible drawer at the bottom of the work
surface with three tabs:

- **Approvals** — every pending tool approval across every run. The row states
  the tool, the permission it is asking for (READ / WRITE / EXECUTE / NETWORK /
  DESTRUCTIVE, each with a plain-language gloss of what that means), and how long
  it has been waiting.

  **Arguments are not projected to the renderer.** This is a main-process
  security boundary (`shell/src/services/agent/event-sanitizer.js`), not a
  display preference: the interface receives the tool name, call id, permission,
  elapsed time and error code, and nothing else. Meridian hid this behind
  *"Arguments hidden for security"*, which told the user nothing; Atlas states
  the permission in words and sends them to the transcript for the payload, so
  the decision is still informed — you know a `fs_write` is asking to write, and
  you can read exactly what it will write one click away.
  Keyboard: `a` allow, `d` deny — for the **oldest** pending request, since
  "whichever row happens to have focus" is the wrong subject for a destructive
  decision. The chords only fire while focus is inside the console, so holding
  `a` while typing a note can never approve a privileged tool.
- **Runs** — live runs with state, elapsed time, current step, token usage.
- **Activity** — the recent tool-call stream across all runs.

**Auto-opens** when a new approval arrives or a run starts. Collapses to a
single 30px strip showing a count when idle. Also opened by `Ctrl+Shift+A` or
the title-bar operator chip.

This is where the "the machine is visible" promise is kept: the user never has
to be inside the Runs view to know what the operator is doing or to unblock it.

### 4.5 Status bar (26px)

Left: active profile + storage locality (`local`). Centre-left: core health.
Centre: operator state (`idle` / `N waiting for you` / `running: <step>`).
Right: clock. Mono, 10px, muted — a readout strip, not a UI region.

**The core readout is the native response, verbatim.** `
window.careerflow.ping()` returns `CareerFlow core online`, and that exact string
is what the strip renders — not a paraphrase like "core ok". Two reasons: the
strip's job is to report what the Rust core actually said, and 20 E2E specs use
that text as their app-is-up gate. Paraphrasing native output is how a green
suite turns red without a single behaviour changing.

### 4.6 Right sidebar

Retained as the **Quick Actions** panel (`aside.right-sidebar`), because it is a
functional contract and because pinned browser shortcuts genuinely belong one
click from anywhere. Redesigned as a hairline list with mono section labels.
Width contract unchanged (450px open / 0 closed).

### 4.7 Browser workspace pane

Retained as a dockable right pane (`browser-workspace-host`), rendered *left of*
the Quick Actions sidebar so existing layout contracts hold. Redesigned:
tab strip on top, omnibox row, live surface or screenshot preview, and a
**capture bar** that files a clip into the current Space.

---

## 5. Surface-by-surface design

### 5.1 Desk (`Home`)

Three bands, in priority order. No metric wall above the fold.

1. **Agenda** (`.today`) — a single chronological instrument:
   Overdue → Today → Next 7 days, as one continuous hairline list with a
   left date gutter. Replaces Meridian's four parallel columns that showed the
   same deadlines twice ("Due & Overdue" *and* "Overdue").
2. **Focus** (`.focus-now`) — the ranked "what to do next" queue, rendered as
   three ranked cards with the reason for each rank stated in words.
3. **Standing** — degree progress, streak, resources, next career step,
   curriculum counts, recent activity, mistake patterns — collapsed into a
   compact two-column readout band *below* the action bands. These are
   *reference*, not *decisions*, so they no longer occupy the top of the screen.

First-run, no-profile and loading states are all first-class: each states the
fact and offers the one action that resolves it.

### 5.2 Spaces

`Subjects` and `Projects` list Spaces. A Space opens the shared workspace shell
with the six faces from §1.2. The Agent face deep-links into the Runs console
filtered to that Space's runs.

#### The Space archetype as implemented

The "Space workspace" is a structural grammar, not a template. Every Space
surface shares these parts, each of which a domain may make its own:

| Part | Contract |
|---|---|
| **Orientation head** | one `h1` naming the surface, a `standing` readout of real counts, and the primary action on the right — never inside the body. |
| **Face strip** | `FaceStrip.svelte` (shared primitive): the horizontal section switch of a Space, bound to one `active` state, with `role="group"` + `aria-label`. Consumed by Subjects, Degree, Projects. |
| **Scope line** | domain-specific filter row *below* the head (subject scope, category pills, degree chips) — filters never masquerade as navigation. |
| **Working area** | the primary list/table/board, hairline rows before cards. |
| **Context rail** (where a domain needs one) | readouts and secondary tools, always subordinate to the working area. |

Density is one rhythm everywhere: `--space-4` section gaps, hairline separators,
no boxed panels inside the working area.

**The pre-profile state is a global convention, not per-view copy.** Before a
profile exists every data-backed view renders the same `.cf-empty` frame — one
line, one pointer to Profiles. Verified across all twelve reachable views in the
DOM audit (§12.2); a view that invents its own empty state is a defect.

### 5.3 Runs console (`Project`)

Replaces the twenty-eight-panel three-column wall.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ PROJECT NAME   [state]        ?   Guide   Export                            │
├─────────────────────────────────────────────────────────────────────────────┤
│ objective input                            [ Run agent ] [ Promote to Goal ] │
├─────────────────────────────────────────────────────────────────────────────┤
│ APPROVAL QUEUE — full width, always here, never behind a tab                │
├──────────────────────────────────────┬──────────────────────────────────────┤
│ TRANSCRIPT                           │ INSPECTOR                            │
│  conversation (scrolls)              │  Plan · Changes · Context ·          │
│  ───────────────────────────────     │  Budget · Extensions · History       │
│  LIVE TOOL TRACE                     │  (one tab visible; badges carry      │
│  (tool rows as hairlines)            │   real counts, no invented numbers)  │
└──────────────────────────────────────┴──────────────────────────────────────┘
```

The inspector is **tabbed**, not stacked:

| Tab | Contains |
|---|---|
| **Plan** | plan view, plan templates |
| **Changes** | changed files, working-tree diff, project diff |
| **Context** | subagent tree, subagent activity, session timeline, memory viewer |
| **Budget** | token budget, default provider, provider config, provider health, audit retention |
| **Extensions** | tool inventory, skills, plugins, marketplace |
| **History** | run history, error log, hooks log, shell history |

A tab carries a **count badge** when the store holds a real number for it (plan
steps, editing tool calls). A tab with no honest number shows no badge — a zero
dressed up as information is worse than silence.

**Why approvals and the tool trace are NOT tabs** (this revises the first draft
of this section). Both are the *live state of the run*, not reference material:

* An approval is the agent **blocking on the user**. Hiding it behind a tab is a
defect the user cannot see; it is the only region on this surface that can stop
work, so it sits directly under the objective, full width, with a semantic edge
when it holds something.
* The tool trace is the run's live evidence. Making "what is it doing right now"
a navigation task inverts the point of watching a run.

Tabs are for looking things up; they are not for noticing things. The E2E gates
on this surface had independently encoded that conclusion — `approval-queue`,
`approval-row`, `approval-approve` and `tool-activity [tool-row]` are all
asserted visible with zero prior interaction, which a tabbed design cannot
satisfy.

**Provider configuration is an exception worth naming.** It now lives in the
Budget tab (it is what the run spends against), which means the two credential
specs must open that tab before asserting. They do, and their behaviour
contract is unchanged — the credentials are still written to the supported
store through the same panel.

### 5.4 Library (`Flashcards`, `Mistakes`, `Formulas`)

Each keeps its own view (they have distinct interaction models: SM-2 review,
ledger, LaTeX board) but shares the Atlas list/table language and gains a
**cross-space filter** so "all due cards" is answerable without picking a
subject first.

Structural state after the third wave:

- **Flashcards (Recall Deck)** — orientation head with a standing readout
  (due / total, real store numbers), a scope bar separating *what you're
  studying* from *what you're reviewing*, and the All-cards view as a
  deck list (hairline rows) instead of a card wall. The review flow itself is
  untouched — SM-2 grading is the one interaction this surface exists for.
- **Mistakes** — ledger structure with the shared dialog primitive for
  destruction (`confirmDialog`, never `window.confirm`) and the shared modal
  for the entry form.
- **Formulas** — orientation head (subject scope + category filter pills as
  chips, not a second nav), row menus through the shared `Menu` primitive,
  honest empty state, and a live-preview LaTeX modal built on `Modal`.

### 5.5 Research (`Browser`)

Collapses three competing surfaces into one console:

- **Saved places** — browser profiles + their shortcuts (was Browser Manager: a
  card stack in which every row carried eight buttons). Now a master list of
  rows: one visible primary verb (`Launch`), a `Shortcuts (n)` disclosure, and a
  real `role="menu"` overflow holding rename / enable / reorder / remove.
- **Live workspace** — a factual readout of the docked browser (backend mode,
  tab count, active tab, last error) and the single action that opens it. Every
  field is real store state; nothing is inferred.
- **Operator activity** — what actually happened in the browser, newest first,
  fed only by the real pushed event stream (`launched` / `navigated` /
  `new-tab` / `*-failed` / `stopped`). Bounded to 40 entries in the store, and
  honestly empty when the backend is in polling mode and pushes nothing — it is
  a trace, not an audit log, and it never synthesises history.

`Quick Actions` remains a shortcut surface in the right sidebar, not a third
implementation of the browser.

### 5.6 Settings

Two-pane: a section rail (Workspace · Data · Sync · Grading · Diagnostics ·
Updates) and a detail pane. Previously six unrelated panels were stacked into
one scrolling column with no navigation.

### 5.7 First run

A single-purpose, three-step flow: **What this is → Your profile → Get started.**

The six-slide carousel (Welcome → Create Profile → Academic Tree → Research
Links → Knowledge Engine → Ready) is gone. Only one of those six slides asked
anything, and it was the second, so a new user's first interaction with the
product was to click *Next* through four panels that explained a workspace they
had not seen yet — and then be told "Ready!" over an empty app.

The flow now consists of a progress rail and one panel:

1. **What this is** — one screen, one sentence, plus the three planes the
   product actually has (Academic / Knowledge / Operator).
2. **Your profile** — the one real input, writing a real row through the existing
   `profiles.add` path. Nothing advances until it exists, and a failure is
   stated inline instead of silently blocking.
3. **Get started** — where to go first, named as destinations rather than as a
tour of unseen panels.

**Deviation from the first draft, stated plainly:** the plan was *Who are you? →
What are you studying? → You're set.* There is no safe way to create academic
structure at first run — subjects belong to a semester, which belongs to a
profile that does not exist yet — so promising to ask "what are you studying"
would have meant either inventing a capability or shipping a control that does
nothing. The second step asks the only question the product can act on. The
deleted slides' explanations were not deleted as content: they live in the
contextual guide and the `?` keyboard reference, where a user needs them — while
looking at the thing being explained.

**Dismissal contract (load-bearing for ~15 Electron specs):** the root stays
`.onboarding-overlay`; a `button.skip-btn` reading exactly `Skip Tutorial` exists
on every step *except* the last; the last step renders `button.complete-btn`.
Specs click Skip when present and otherwise fall through to Complete.

---

## 6. System states

| State | Treatment |
|---|---|
| **Loading** | Skeleton mirrors the final layout. Used only for >300ms loads; shorter loads render nothing. No spinners inside buttons — pending buttons dim to .6 and set `cursor: progress`. |
| **Empty** | One factual line + at most one ghost action. Dashed hairline container only when the emptiness *is* the view. |
| **Error** | Inline at the source first; toast only for global failure. Error text 13px `--atlas-bad`. Recoverable errors carry the retry inline. Agent failures render the verbatim failure reason. |
| **Offline / local** | Status bar states `local`. No fake connectivity indicators, ever. |
| **Confirmation** | `confirmDialog()` — dialog, `Escape` cancels, destructive action is never the default focus. |
| **Notifications** | Bottom-right, max 4, hairline left edge in the semantic colour. success/info 4s, warning 7s, error 9s. `role="alert"`, stack is `role="region" aria-label="Notifications"`. |

---

## 7. Keyboard model

| Chord | Action | Scope |
|---|---|---|
| `Ctrl+K` | Command bar / palette | global |
| `Ctrl+Shift+A` | Toggle Operator Console | global |
| `Ctrl+1..9` | Jump to the Nth rail destination | global |
| `Ctrl+B` | Collapse / expand the rail | global |
| `Alt+N` | Quick note | global |
| `a` / `d` | Allow / deny the focused approval | Operator Console |
| `Escape` | Close the topmost layer | global |
| `?` | Keyboard reference | global |

Tab order follows DOM order. No positive `tabindex`. Focus is always visible:
2px `--atlas-signal` outline, 2px offset, radius-following.

---

## 8. Accessibility

- WCAG AA everywhere; interactive targets ≥ 26px with a ≥ 28px hit area.
- Landmarks: `header`, `nav`, `main`, `aside`, `footer`.
- Dialogs: `role="dialog"` + `aria-modal="true"` + focus trap + restore.
- Icon-only controls carry `aria-label` **and** `title`.
- Status is never colour-only: every pill pairs colour with a word.
- The nav rail exposes `aria-current="page"`.
- The Operator Console is `role="region" aria-label="Operator console"` and its
  approval list announces arrivals via `aria-live="polite"`.
- Reduced motion honoured globally.

---

## 9. Functional contracts that must survive the redesign

Atlas changes presentation, never capability. The following are load-bearing and
were verified against the existing suites before implementation.

> **Rule for anyone editing these surfaces: a control that gates a spec is not
> "old markup", it is the contract.** More than one of the migrations in §0.1b
> was constrained by a single text selector — `CareerFlow core online`,
> `Skip Tutorial`, `New browser profile`, `Add shortcut` — and in each case the
> selector was standing in for a real product guarantee ("the app is up", "first
> run can be dismissed", "a saved place can be created"). Reword them and the
> guarantee is still there but the suite can no longer see it.

**Navigation.** `button.nav-item` must exist with these exact accessible labels:
`Home`, `Degree`, `Subjects`, `Labs`, `Projects`, `Flashcards`, `Mistakes`,
`Formulas`, `Browser`, `Deadlines`, `Study Sessions`, `Profiles`, `Project`,
`Goals`, `Career`, `Settings`.  Note `Project` (the Runs console) is matched with
an anchored regex (`/^\s*Project\s*$/`), so it must not be renamed.

**Deep links and labels.** The Desk offers an `Open Degree planner` deep-link
button; navigation specs must therefore target `button.nav-item` (the rail) or
`getByRole('button', { name, exact: true })`, never a bare `button:has-text(...)`
that also matches deep links. Label text is a contract: the SubjectFormModal
fields read **Obtained Marks** / **Max Marks** (existing specs locate inputs by
that text); the Degree modal placeholder stays `e.g. B.Tech`.

**View contracts.** `.today` and `.focus-now` on the Desk; `.section-tab-btn`
in the Degree view; `.subject-hub-v2`, `.subject-row` in Subjects;
`.semester-progress`, `.sem-row-card`, `.pattern-btn`, `.semester-details-panel`
in Degree; `.milestone`, `.link-picker`, `.m-link-subject` in Career;
`.toggle-btn`, `.card-item` in Flashcards; `.profile-card`, `.profile-main`,
`aria-label="Select <name>"`, `input[placeholder^="New profile name"]` in
Profiles; `.backup-row`, `.restore-btn`, `button.primary` "Backup Active
Profile" in Settings; `.onboarding-overlay`, `.skip-btn` in first run;
`.focus-modal`, `.focus-backdrop`, `.clock`, `#focus-objective`, `.context`,
`.capture-btn`, `.cancel-btn` in Focus; `.toast-stack .toast` in Toaster;
`.cf-modal`, `.cf-backdrop` in confirm dialogs.

**Shell testids.** `browser-workspace-toggle`, `nav-goals`, `nav-career`.

**The shell context header is not a heading.** It renders the view title as a
`span`. Two reasons, both verified against the suites: every view's own panel
already opens with a heading, so an `h1` here made the outline announce the view
twice; and where a panel's heading matches the view name (Study Sessions,
Deadlines) a role-based query resolved to *two* elements — a real ambiguity for
assistive technology, not merely a Playwright strict-mode failure. The icon slot
is a component reference: it was written `<icon …>` (lowercase), which Svelte
treats as an unknown HTML element, so no view icon had ever rendered.

**First run.** `.onboarding-overlay` + `button.skip-btn` "Skip Tutorial" on every
non-final step + `button.complete-btn` on the final step; `Escape` skips. Roughly
fifteen specs dismiss first run through exactly these hooks.

**Runs console.** `role="tablist"` with six tabs (`Plan`, `Changes`, `Context`,
`Budget`, `Extensions`, `History`), `aria-selected` + roving `tabindex`, arrow-key
movement, and a linked `role="tabpanel"`. `approval-queue` / `approval-row` /
`approval-approve` / `tool-activity [tool-row]` must be visible with **no prior
interaction** — they are the run, not reference material.

**Research console.** `section.browser-manager` root; a button containing `New
browser profile`; `form.row` with `input[placeholder*="Name"]` and
`button[type="submit"]`; a `Shortcuts` disclosure button; `Add shortcut`; a
second `form.row` with two inputs; `.sc-list link-btn` rows each containing a
`Pin` button. Critically, the profile-add form and the shortcut-add form are
*both* `form.row`, and the shortcut flow queries `form.row input` globally with
`.first()` — so at most one may be open at a time (adding a profile closes its
form; that is asserted).

**Right sidebar.** `button.duck-sidebar-toggle.right-sidebar-toggle`,
`aside.right-sidebar.open`, and pinned shortcut rows (`.qa-item`, `.sc-list`)
visible immediately after opening.

**Browser workspace.** `browser-workspace-dock`, `bw-not-ready`, `bw-preview`,
`qa-*` testids, and all `aria-label`s on dock controls.

**Operator surfaces.** Every `data-testid` in `ui/src/features/project-mode/**`
is preserved, including `project-workspace`, `start-agent`, `objective-input`,
`approval-*`, `plan-view`, `tool-*`, `provider-*`, `token-budget-*`,
`memory-viewer-*`, `changed-files-*`, `agent-run-history`, `agent-error-log`,
`session-timeline`, `resume-banner-*`, `keybindings-*`, `search-*`,
`onboarding-tour-*`, `plan-templates-*`, `marketplace-*`, `skill-*`, `plugin-*`,
`hooks-*`, `shell-history-*`, `audit-retention-*`, `sub-agent-*`, `activity-*`,
`help-menu-*`, `export-session-btn`, `promote-to-goal`, `open-guide-btn`.

**Data and behaviour.** IPC names and arity (including the positional
`startAgent(profileId, agentId)` contract), `profileId` ownership on every call,
the Rust database, the Agent loop, the approval lifecycle, the CDP boundary,
Browser Workspace security, persistence, and recovery behaviour are untouched.

---

## 10. Token migration

### 10.1 The three codemods

Colour, rhythm and iconography were migrated mechanically rather than by hand,
because they are mechanical and there were thousands of them. All three scripts
are idempotent, skip token definitions and comments, and only ever touch CSS
declarations — `.svelte` files are split so that `<script>` blocks are never
rewritten (a `var(--text-md)` injected into JavaScript builds fine and then
throws at runtime).

| Script | Scope | What it fixes |
|---|---|---|
| `scripts/codemod-hex-to-atlas-tokens.mjs` | 54 files | ~1,215 literal colours → Atlas tokens. Also maps the legacy GitHub-dark `rgba()` tints, and converts white-on-filled-semantic pairs to `--atlas-on-fill` (white on `--atlas-ok` is ~1.8:1) |
| `scripts/codemod-legacy-css-to-atlas-tokens.mjs` | 71 files | ~800 font sizes across 37 values → the nine type steps; ~400 radii across 11 values → five radii; grid-exact spacing → the 4px scale |
| iconography (by hand, 12 files) | 67 emoji + all glyph pseudo-icons | Emoji and `✕ × ↑ ↓ ✓ ▸ ▾` → the icon set, including view headings, disclosure chevrons, toast icons and result-kind icons. **Zero emoji remain in `ui/src`** |

Two deliberate non-goals: off-grid spacing (6px, 10px, 18px) and negative margins
are left alone — the 4px grid is a guideline, and `calc(-1 * var(--space-2))` is
worse than `-8px`; and widths, heights, border-width and outline-offset are
metrics, not rhythm, so snapping them would silently move control hit areas that
WCAG minimums depend on.

### 10.2 Legacy aliases

`app.css` keeps Meridian's token names as **aliases** mapped onto Atlas values,
so the components that were not individually restructured still adopt the
new identity instead of rendering with stale values:

```
--bg-base → --atlas-base        --bg-raised → --atlas-chrome
--surface-1 → --atlas-panel     --surface-2 → --atlas-raise
--surface-3 → --atlas-hover     --fg → --atlas-ink
--fg-secondary → --atlas-ink-2  --fg-muted → --atlas-ink-3
--border → --atlas-line         --border-strong → --atlas-line-2
--accent → --atlas-signal       --accent-strong → --atlas-signal-2
--success/--warning/--danger → --atlas-ok/--atlas-warn/--atlas-bad
--radius-lg → 8px  --radius-md → 6px  --radius-sm → 4px
--text-base → 13px  --text-3xl → 20px
--trans-* → Atlas durations and easing
--cf-* → the same mapping
```

New code uses `--atlas-*` only. Aliases are removed once migration completes.

---

## 11. Do / Don't

**Do:** one accent per view · mono micro-labels · hairlines for density ·
tabular numerals on every metric · a text label on every primary action ·
state colours only for state · empty states that state a fact · the operator
visible at all times.

**Don't:** gradients · glassmorphism · glows · decorative colour · spinners in
buttons · zebra tables · emoji as UI icons · shadows on resting surfaces ·
nested cards more than two deep · a new hex value inside a component — use a
token · hide the machine's work behind a shortcut.

---

## 9.1 Shell contract coverage

Four regressions landed silently in the shell because the component suite had no
shell tests at all. `ui/tests/shell-contracts.test.js` now locks the behaviours
that the E2E suite and the product depend on:

| Contract | Why it is load-bearing |
|---|---|
| The status bar renders `ping()` verbatim | 20 E2E spec files gate on the text |
| Every rail destination exists as `button.nav-item` with its exact label | 18 E2E files navigate by label |
| `Project` stays matchable by `/^\s*Project\s*$/` | Counts must ride `data-badge`, never `textContent` |
| The view registry equals the shell's route allowlist | A destination must never be navigable-but-unroutable |
| Settings opens on the vault | The backup/restore flow clicks `Backup Active Profile` on arrival |
| `?` opens the keyboard reference, `Escape` closes it | Discoverability of the keyboard model |
| The shell composes: App mounts, the rail routes, a view renders | The only test that would have caught "the renderer does not build" |
| The Desk's Today band keeps `.today .today-col` (matching /Study/) with the `.today-study > div > strong` + `span` read-out, the Start Focus / Start a session labels, a clickable deadline title, and the "N flashcards due" affordance | The focus E2E flow drives all four; the agenda restructure had to preserve them |
| The shell context header renders no heading | Two identical headings broke a role query in `today.spec.js`; the panel owns the heading |

The desk-level contract is asserted in `ui/tests/Dashboard.test.js` beside the agenda
it guards, so a future restructure of the front door fails in seconds instead of
at the end of a four-minute Electron run.

The second wave of migrations (Goals, Career, Research, the Runs console, first
run) added four more five-second suites, one per surface, each built around the
selectors its Electron specs actually use rather than around the new markup:

| Suite | Locks |
|---|---|
| `ui/tests/research-console.test.js` (13) | The four-spec browser-manager flow, including the one-form-at-a-time ordering trap, the overflow menu's `role="menu"` + Escape + focus restore, and that the activity list stays empty until a real event arrives |
| `ui/tests/runs-console.test.js` (8) | Approvals and the tool trace visible with zero interaction; six-tab tablist with roving focus; badges only for real counts |
| `ui/tests/first-run.test.js` (13) | The dismissal trio, three steps, and that nothing advances without a real profile |
| `ui/tests/browser-workspace.test.js` (+5) | The bounded activity trace: real events only, newest first, capped at 40, cleared by the reset |

`ui/tests/local-date.test.js` also gained `timeAgo` coverage: it was copy-pasted
into six surfaces with six different rules for unreadable and future values, so
the shared helper's boundaries are pinned once.

Anything that a test can only observe through a *rendered* surface belongs here,
not only in E2E: E2E proves the system works, but it is too slow to be the thing
that notices a missing import.

---

## 12. Migration ledger

Updated 2026-09-22, third wave. The named remaining legacy surfaces — Subjects,
Projects, Degree, Labs, Flashcards, Mistakes, Formulas, Notes, Focus, Deadlines,
Study Sessions, and the Desk's lower band — have now been structurally migrated
to the shared Space workspace archetype (§5.2): orientation head with standing
readout, `FaceStrip` section switch where a surface has sections, scope/filter
chips below the head, hairline-row working areas, shared `Menu`/`Modal`/
`confirmDialog` primitives for row actions and destructive confirmation. This
table is the honest answer to "is it done".

| Surface | State |
|---|---|
| `app.css` — Atlas tokens, primitives (`cf-btn`, `cf-badge`, `cf-kbd`, `atl-*`), legacy aliases, reduced motion | **Done** |
| Shell composition (`App.svelte`) — routing, deep links, overlays, global keyboard | **Done** |
| Title bar, nav rail, context header, status bar | **Done** |
| Operator Console (approvals / runs / activity) + global operator store | **Done** |
| Keyboard reference (`?`) | **Done** |
| Settings — two-pane, six panels preserved | **Done** |
| Diagnostics panel | **Done** (migrated to Atlas tiles and shared primitives) |
| Desk (`Home`) — the Today band | **Done** — one chronological agenda (overdue → today → next 7 days) with a mono date gutter, replacing the two parallel deadline columns; `buildAgenda` / `agendaGutter` / `agendaSummary` are pure and unit-tested |
| Desk (`Home`) — focus queue and standing readout | **Done** — FocusNowPanel restructured; the metrics/curriculum/exams band below merged into one standing band per §5.1, with the test-asserted strings preserved |
| Subjects / Projects / Degree / Labs | **Done** — restructured to the Space archetype (§5.2): orientation head + FaceStrip faces (Subjects: Overview/Notes/Links; Degree: My Degrees/Progress; Projects: Brief/Plan/Progress), scope chips, shared primitives; all E2E contracts preserved (`subject-hub-v2`, `subject-row`, `section-tab-btn`, `semester-progress`, `pattern-btn`) |
| Runs console (`Project`) | **Done** — 28 stacked panels → objective + attention band + transcript/trace lane + six-tab inspector (§5.3). `ProjectList` is now a rail of hairline rows with a current-page rule, and the help menu uses the shared button primitives |
| Flashcards · Mistakes · Formulas · Notes · Focus · Deadlines · Study sessions | **Done** — Flashcards: scope bar + deck-list All view (`.card-item`, `.toggle-btn` preserved); Mistakes/Formulas: shared `confirmDialog`, `Modal`, `Menu`; Deadlines/Study Sessions: orientation head + standing readout, hairline lists; Focus: restyled onto the control grammar (its discard semantics and 15 E2E tests were already correct); Notes: capture/editor modals on the shared control grammar — notes deliberately remain subject-attached (no separate list surface exists by design) |
| Career | **Done** |
| Goals | **Done** — list-first panel, creation in a real dialog (`Modal.svelte`), native `confirm()` replaced by `confirmDialog()` |
| Research (`Browser`) | **Done** — one console of three parts (§5.5), with the operator-activity trace added to the workspace store |
| First run / onboarding | **Done** — three steps, one real input (§5.7) |
| Backup vault · Cloud sync · Sync automation · Updates · Grading · Diagnostics | **Done** — token/type/icon pass complete; diagnostics migrated to shared tiles; Backup/CloudSync restructured onto Atlas panels in the second wave |
| Iconography | **Done** — no emoji anywhere in `ui/src`; glyph pseudo-icons replaced; one icon family (lucide) |
| Colour · type scale · radius · spacing | **Done** — no literal colour, font size, radius or grid spacing outside `app.css` token definitions |

**The rule for the rest of the migration:** tokens first (cheap, global, safe),
then structure (per surface, with its tests). A surface that has only had the
token pass renders the new identity but not yet the new information hierarchy —
that distinction is exactly what the E2E discipline exists to keep honest.

**Legacy aliases are removed only at the end**, once nothing references them, and
never in the same change that alters behaviour. They are safe to keep meanwhile:
every alias now resolves to an Atlas value, so a component still writing
`var(--surface)` renders the Atlas panel colour, not a stale one.

### 12.1 What the second wave actually verified

> §12.1 records the second wave. The third wave (Space migration) verification
> is in §12.2; the two sections are kept separate so each gate's numbers stay
> attributable.

| Gate | Result |
|---|---|
| `npm run build:ui` | clean, zero Svelte warnings |
| `npx vitest run --root ui` | **640 passed** (60 files; 542 at the start of the redesign) |
| `check:ipc` / `check:napi` / `check:esm` / `check:cdp-boundary` | 250 channels · 126 core fns · 121 files · OK |
| `npm run test:shell` | 1220 passed, 0 failed |
| Electron E2E (targeted) | `today`, `academic-focus`, `goals-navigation`, `career-subject-link`, `project-mode-lifecycle`, `backup-restore`, `credential-config-path`, `credential-store-diagnostic`, `subject-workspace`, `semester-progress`, `study-sessions`, `deadline-completion`, `focus-session`, `focus-lifecycle`, `subject-rename`, `semester-status`, `journey-learning-projects`, `quick-actions`, `phase10-qa-profile-scope`, `phase7-real-shortcuts` — **all passing** |
| Electron E2E (blocked) | `browser-workspace.spec.js` fails at `launch()` with `reason: "separate-focus-failed"` — the stub transport cannot focus a separate browser window in this environment. The refusal happens in the IPC path **before** any redesigned UI is involved; the diagnostic log that prints the reason was added to the spec. Specs needing a real provider or Donut launch (`agent-*`, `real-*`, `packaged-smoke`, `phase5/6`) were not run |

Two product defects were found by these runs, not by reading code: the shell's
context header rendered an `h1` duplicating every panel's heading (breaking
`getByRole("heading", …)` for Study Sessions), and its view icon was written as
`<icon>` (lowercase), so it had never rendered at all. Both are fixed and pinned
by `ui/tests/shell-contracts.test.js`.

### 12.2 What the third wave (Space migration) verified

All twelve named surfaces were restructured; nothing reverted from the second
wave. Gates run against the final state:

| Gate | Result |
|---|---|
| `npm run build:ui` | clean |
| `npx vitest run --root ui` | **640 passed** (60 files) |
| `npm run test:shell` | 0 failed (22 skipped — environment-gated) |
| `check:ipc` / `check:napi` / `check:esm` / `check:cdp-boundary` | 250 channels · 126 core fns · 121 files · CDP-AUTH-BOUNDARY=OK |
| Electron E2E (Space surfaces) | `subject-workspace`, `subject-rename`, `journey-learning-projects`, `cgpa-persistence`, `semester-progress`, `semester-status`, `deadline-completion`, `study-sessions`, `focus-session`, `academic-focus`, `career-subject-link`, `focus-lifecycle` (18 tests), `project-mode-lifecycle`, `subject-links-donut` — **all passing** |

Two contract collisions were found by the E2E runs and fixed in the specs, not
the UI, because the UI behaviour was correct in both cases:

1. `cgpa-persistence.spec.js` used `button:has-text("Degree")`, which also
   matches the Desk's legitimate `Open Degree planner` deep link. Narrowed to
   `button.nav-item` — the documented navigation contract (§9).
2. The same spec located the marks inputs by the text **Obtained Marks** /
   **Max Marks**, which the SubjectFormModal rewrite had silently reworded. The
   original labels were restored — label text on a spec-gated control is the
   contract (§9), and the test was the only thing that caught it.

**DOM/accessibility audit** (plain-browser renderer; the strongest visual
evidence available — the preview webview could not composite screenshots in
this environment, so no pixel-level review is claimed): all twelve reachable
views swept via the accessibility tree. Every view presents the same pre-profile
`.cf-empty` convention; zero glyph/emoji headings; one `h1` per view; no
console errors beyond the expected `window.careerflow` bridge-absence errors
(this is the plain browser, not Electron — the shell itself is reached only
through the E2E suite).

---

## 13. R5 — Space Bunny browser-page surface (2026-10-11)

The embedded page is an ordinary workspace tab (`view: page`, entity = opaque
main-process page id), not a nested browser tab strip. Its compact page chrome
keeps the current title, editable address, Go/reload controls, and a live loading
or failure badge in one row. The opaque page id is not user-facing. The pane's
`New tab` destination menu offers `New web page`; while that menu is open, the
main-owned native `WebContentsView` is occluded so it cannot paint over the
menu. The main process still owns page lifecycle, URL policy, and native bounds.

Real Electron captures, taken from the actual top-level desktop window (not a
renderer-only screenshot), are stored at `shots/r5/`:

- `baseline2-browser-page-wide.png` and `baseline2-browser-page-narrow.png` —
  pre-correction baseline, content sizes 1600×1000 and 1180×820.
- `r5final3-browser-page-wide.png` and `r5final3-browser-page-narrow.png` —
  post-correction ready state at the same content sizes.
- `r5final3-browser-page-loading.png` and `r5final3-browser-page-failed.png` —
  real hanging-navigation and connection-refusal states at 1600×1000.

**R5 remains IN PROGRESS with ACCEPT WITH LIMITATIONS, not DONE.** The Lab's
`BrowserPage.tsx` also depicts a kept-passage count, Save as source, and a
return-to-Research action; the Phase 9 checklist calls out the Research margin
ledger. The current Main app has no web-source/capture persistence contract,
and its settled Browser/Research console is the separate optional Donut-control
surface, not a list of embedded page captures. No decorative controls were
added, note storage was not misused as a source database, and the Donut console
was not repurposed. Those reference requirements remain unresolved until a
supported source/capture model and embedded-page Research surface are authorized.

### R5 source/capture implementation continuation — 2026-10-11

The source/capture model is now implemented behind Main-owned persistence: migration 024, Rust/N-API CRUD/count, validated `research:*` IPC, Save as source, explicit plain-text passage capture, a hidden Research ledger view, same-context page-tab reuse, and a margin-mode ledger surface. The native contract smoke test passes. This is not yet an R5 visual acceptance claim: focused UI tests hung without a result, the new serial E2E failed before reaching the Research workflow during profile bootstrap, and no new Research/margin runtime screenshot was captured. R5 remains IN PROGRESS / ACCEPT WITH LIMITATIONS until live end-to-end and visual evidence pass.
