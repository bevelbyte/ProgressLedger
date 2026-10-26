// Shared shell layout numbers (V2-43, Phase 4).
//
// ONE module, used by BOTH sides:
//   * main imports it directly (plain JS, no Electron imports — the
//     policy.js pattern), for bounds validation;
//   * the renderer imports the SAME file via the preload bridge's
//     layout getter (see shell/src/preload.cjs: the bridge returns a
//     frozen copy of LAYOUT, so the UI can never drift from main's
//     numbers by editing its own copy).
//
// Every number below is MEASURED, not copied from a design doc:
//   * live run V2D4Measure (2026-10-26, real app, throwaway data,
//     inner window 1386x779, devicePixelRatio 1.25): titlebar 46,
//     rail 216, context header 52 at y=80, pane header 34, pane
//     grid 590, status bar 26 at y=753, operator dock bar ~31
//     (the 722-753 gap under the pane grid);
//   * the same values are the CSS tokens in ui/src/app.css
//     (--shell-titlebar-h, --shell-ctxstrip-h, --shell-context-h,
//     --shell-panehead-h, --shell-status-h, --shell-rail-w*), so a
//     token change without a layout-module change is caught by the
//     layout test, which asserts the two agree.
// Compact density ([data-density="compact"]) tightens the vertical
// rhythm: titlebar 42, ctxstrip 30, context 46, panehead 30. The
// module carries both sets; the caller picks by density.

export const LAYOUT = Object.freeze({
  titleBarHeight: 46,
  contextStripHeight: 34,
  contextHeaderHeight: 52,
  paneHeaderHeight: 34,
  statusBarHeight: 26,
  operatorDockHeight: 31,
  railWidth: 216,
  railCollapsedWidth: 56,
  railSlimWidth: 64,
  dividerWidth: 4,
  // No enforced window minimum exists in createWindow (verified):
  // the OS minimum applies. This is the USABLE floor used by the
  // Phase 5 screenshots and the layout test, not a limit the app
  // enforces on the user.
  usableMinWindowWidth: 1024,
  usableMinWindowHeight: 640,
  minViewSize: 1,
});

export const LAYOUT_COMPACT = Object.freeze({
  ...LAYOUT,
  titleBarHeight: 42,
  contextStripHeight: 30,
  contextHeaderHeight: 46,
  paneHeaderHeight: 30,
});

export function layoutForDensity(compact) {
  return compact === true ? LAYOUT_COMPACT : LAYOUT;
}

/**
 * The content rectangle a browser view may occupy inside one pane:
 * the pane box minus its header. `pane` is the pane's own box in
 * window CSS pixels (the surface measures its own box; main never
 * trusts a renderer's guess about the whole window).
 */
export function browserRectForPane(pane, layout = LAYOUT) {
  const x = Math.round(pane.x);
  const y = Math.round(pane.y + layout.paneHeaderHeight);
  const width = Math.max(0, Math.round(pane.width));
  const height = Math.max(0, Math.round(pane.height - layout.paneHeaderHeight));
  return { x, y, width, height };
}

/**
 * Split a pane-grid box into `count` equal panes along `dir`
 * ("row" = side by side, "col" = stacked), with a divider between
 * neighbours. The returned rects are disjoint and all lie inside
 * `grid` — the Phase 4 split proof in one pure function.
 */
export function splitPaneRects(grid, count, dir = "row") {
  if (!Number.isInteger(count) || count < 1) return [];
  const div = LAYOUT.dividerWidth;
  const rects = [];
  if (dir === "col") {
    const totalDiv = div * (count - 1);
    const each = Math.max(0, Math.floor((grid.height - totalDiv) / count));
    let y = grid.y;
    for (let i = 0; i < count; i++) {
      const h = i === count - 1 ? grid.y + grid.height - y : each;
      rects.push({ x: grid.x, y, width: grid.width, height: h });
      y += h + div;
    }
  } else {
    const totalDiv = div * (count - 1);
    const each = Math.max(0, Math.floor((grid.width - totalDiv) / count));
    let x = grid.x;
    for (let i = 0; i < count; i++) {
      const w = i === count - 1 ? grid.x + grid.width - x : each;
      rects.push({ x, y: grid.y, width: w, height: grid.height });
      x += w + div;
    }
  }
  return rects;
}

/** True when `a` and `b` overlap with positive area. */
export function rectsOverlap(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** True when `inner` lies fully inside `outer`. */
export function rectInside(inner, outer) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}
