# CareerFlow Design System — "Meridian" (ARCHIVED)

**Status:** Superseded. **Not** a source of truth. Read
[`DESIGN-ATLAS.md`](./DESIGN-ATLAS.md) instead.

**Version:** 1.0 — 2026-09-20 · **Archived:** 2026-09-21

---

## Why this document is archived

Meridian described CareerFlow as *"a calm, instrument-like desktop workspace"*.
That instinct was right, and it is fully carried forward: dark-first, one accent,
semantic colour reserved for meaning, compact typography, 8px rhythm, density with
air. Atlas inherits all of it.

What Meridian got wrong was the step *after* the visual identity. It applied an
excellent surface language to an unchanged product: sixteen nav items in six
groups all equally loud, a home screen that showed the same deadlines twice, and
an Agent surface where twenty panels were stacked into three columns with no
hierarchy. The result would have been *the old CareerFlow, better coloured* —
which is the one outcome the product brief rules out.

Atlas keeps Meridian's principles and replaces its information architecture,
navigation model, shell, and component construction. The superseded document is
kept here only so the reasoning is still legible; it must not be used as a
reference for new work.

## What survives from Meridian (now expressed in Atlas)

| Meridian idea | Where it lives now |
|---|---|
| Dark-first, warm-shifted neutrals over pure black | Atlas §3.2 — surfaces warm-shifted further, one step sharper |
| One restrained accent; semantic colour for state only | Atlas §3.2 — Iris signal + the "one accent" rule, unchanged |
| Compact typography, information-dense but calm | Atlas §3.3 — body drops 14px → 13px, titles 26px → 20px |
| 8px / 4px rhythm | Atlas §3.4 — same scale, tighter usage |
| Motion that explains, never performs | Atlas §3.5 — same intent, shorter durations |
| Desktop-native, keyboard-first | Atlas §7 — promoted from a principle to a stated keyboard model |
| Lucide-only icon language, no emoji | Atlas §3.6 |

## What Atlas replaced

- **Navigation**: six unnamed groups of sixteen equal items → six named *planes*
  (Today · Spaces · Plan · Library · Operator · System) with a spine-based active
  state and a System plane pinned to the rail footer.
- **Home**: a metric wall with duplicated deadline columns → an agenda-first Desk:
  one chronological instrument, then the ranked focus queue, then standing
  reference below the fold.
- **Agent**: buried inside "Project Mode" with twenty simultaneous panels → a Runs
  console with a tabbed inspector, plus a global Operator Console so a run can
  never be blocked on the user unnoticed.
- **Browser**: three competing surfaces → one Research console plus one dockable
  workspace pane.
- **Settings**: six panels stacked in one scrolling column → a two-pane surface
  with a section rail, one pane mounted at a time.
- **Construction**: card-wall layouts and 10–14px radii → hairlines for density,
  mono micro-labels, 4–8px radii, elevation by surface step rather than shadow.

## If you are looking for…

- The design principles, IA, shell geometry, and visual system → `DESIGN-ATLAS.md` §1–§11
- What is actually implemented versus still to migrate → `DESIGN-ATLAS.md` §12
- The contracts a redesign must not break → `DESIGN-ATLAS.md` §9 and §9.1
- How this state was audited and decided → `DESIGN-ATLAS.md` §0.1
