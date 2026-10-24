# Manual comparison — CURRENT MAIN vs V1 BASELINE

Two apps, side by side, for human review. **Neither is modified by this workflow.**

| | Path |
|---|---|
| **Current main CareerFlow** (the redesign) | `D:\10_Dev_Workspace\Projects\laboratory\CareerFlow` |
| **V1 baseline** (frozen snapshot) | `D:\10_Dev_Workspace\Projects\laboratory\CareerFlow\versions\v1` (restorable to working copy via version manager) |
| **Space Bunny visual reference** (do not edit) | `D:\10_Dev_Workspace\Projects\laboratory\CareerFlow-Frontend-Lab\v1\shots` |

---

## Launching CURRENT MAIN

```powershell
cd D:\10_Dev_Workspace\Projects\laboratory\CareerFlow
npm run build          # Rust core + Svelte UI  (first run only)
npm run dev            # Vite on :5173 + Electron shell
```
Production build instead of dev:
```powershell
cd D:\10_Dev_Workspace\Projects\laboratory\CareerFlow
npm run build
npx electron .
```

## Accessing the V1 BASELINE

The historical v1 baseline is preserved exclusively as an immutable snapshot in
`versions\v1`. Because `v1` is a compiled release snapshot without a root Electron
entry point or top-level `package.json`, it cannot be launched directly in place.

### Visual Comparison Baseline (Authoritative)
The authoritative visual reference for Space Bunny v1 is located in:
`D:\10_Dev_Workspace\Projects\laboratory\CareerFlow-Frontend-Lab\v1\shots`
Compare current views against the reference captures listed in the table below.

### Restoring the V1 Codebase via Version Manager
To restore the v1 baseline assets into the working tree (with automatic pre-restore backup):
```powershell
cd D:\10_Dev_Workspace\Projects\laboratory\CareerFlow
node scripts/version-manager.mjs restore v1
```
(or use `restore.bat v1`).

When launching the active application for visual comparison, supply an isolated user-data directory:
```powershell
$env:CAREERFLOW_E2E = "1"
npx electron . --user-data-dir="$env:TEMP\cf-compare-profile"
```

---

## What to compare, and against which reference shot

| Surface | Reference shot (Frontend-Lab\v1\shots) |
|---|---|
| Desk | `regression-v2z\01-desk.png`, `look\a-desk.png` |
| Graph | `regression-v2z\06-graph.png`, `look\g4-select.png` |
| Reader | `regression-v2z\10-reader.png`, `look\c-reader.png` |
| Space / subject | `regression-v2z\04-space.png` |
| Contextual pane + Margin | `regression-v2z\ctx-thesis.png` |
| High density | `regression-dense\01-desk.png` |

## The four things that should be recognisably different

1. **Signal colour.** The brand hue is now warm amber (`--atlas-signal: #e0a35c`),
   not the old Iris violet. Amber means *you* — the human''s own time and
   obligations. The operator (runs, approvals, tool calls) now has its own cyan
   (`--atlas-machine: #6ea8c9`). Chrome itself stayed neutral.
2. **Surface ladder.** Six warm-graphite steps (`void/base/chrome/panel/raise/
   overlay`) instead of five, so menus and dialogs sit *above* panels instead
   of borrowing a row-hover wash.
3. **Type ladder.** Real separation restored between view title (24px), section
   head (18px) and body (13px). `--atlas-ink-3` was lifted to `#979189` because
   it was measuring ~3.3:1 on panel surfaces.
4. **Density.** Instrument-sharp radii (2/3/5/8px) and a 30px row height, so
   lists read as instrument readouts rather than as cards.

## Keyboard

`Ctrl+K` commands · `?` keyboard help · `Ctrl+B` rail mode · `Ctrl+1..9` rail
jumps · `Esc` closes overlays. The rail items keep their exact labels
(`Home`, `Subjects`, `Projects`, `Degree`, `Labs`, `Deadlines`, `Goals`,
`Flashcards`, `Mistakes`, `Formulas`, `Project`, `Browser`, `Profiles`,
`Settings`) because the E2E suite drives navigation by that text.
