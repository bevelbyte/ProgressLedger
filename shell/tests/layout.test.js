import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LAYOUT,
  LAYOUT_COMPACT,
  layoutForDensity,
  browserRectForPane,
  splitPaneRects,
  rectsOverlap,
  rectInside,
} from "../src/shared/layout.js";

// Phase 4 layout (V2-43): one shared module, measured numbers.
// The module is plain JS with no Electron import, so it loads under
// plain node --test. The CSS-token agreement check reads
// ui/src/app.css and fails if a token moves without the module.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function cssToken(name) {
  const css = readFileSync(join(root, "ui", "src", "app.css"), "utf8");
  const m = css.match(new RegExp(`--${name}:\\s*(\\d+)px`));
  assert.ok(m, `CSS token --${name} not found`);
  return Number(m[1]);
}

describe("shared shell layout (V2-43)", () => {
  it("matches the CSS tokens for the default density", () => {
    assert.equal(LAYOUT.titleBarHeight, cssToken("shell-titlebar-h"));
    assert.equal(LAYOUT.contextStripHeight, cssToken("shell-ctxstrip-h"));
    assert.equal(LAYOUT.contextHeaderHeight, cssToken("shell-context-h"));
    assert.equal(LAYOUT.paneHeaderHeight, cssToken("shell-panehead-h"));
    assert.equal(LAYOUT.statusBarHeight, cssToken("shell-status-h"));
    assert.equal(LAYOUT.railWidth, cssToken("shell-rail-w"));
    assert.equal(LAYOUT.railCollapsedWidth, cssToken("shell-rail-w-collapsed"));
    assert.equal(LAYOUT.railSlimWidth, cssToken("shell-rail-w-slim"));
  });

  it("matches the measured live run at 1386x779", () => {
    // V2D4Measure, 2026-10-26: titlebar 46, rail 216, context
    // header 52 at y=80 (46 + 34 strip), pane header 34, status 26
    // at y=753. The chrome stack must add up to the window height
    // once the operator dock bar is counted.
    const stack =
      LAYOUT.titleBarHeight +
      LAYOUT.contextStripHeight +
      LAYOUT.contextHeaderHeight +
      590 + // measured pane-grid height at this window size
      LAYOUT.operatorDockHeight +
      LAYOUT.statusBarHeight;
    assert.equal(stack, 779);
  });

  it("compact density tightens only the vertical rhythm", () => {
    assert.equal(LAYOUT_COMPACT.titleBarHeight, 42);
    assert.equal(LAYOUT_COMPACT.contextStripHeight, 30);
    assert.equal(LAYOUT_COMPACT.contextHeaderHeight, 46);
    assert.equal(LAYOUT_COMPACT.paneHeaderHeight, 30);
    assert.equal(LAYOUT_COMPACT.railWidth, LAYOUT.railWidth);
    assert.equal(layoutForDensity(true), LAYOUT_COMPACT);
    assert.equal(layoutForDensity(false), LAYOUT);
  });

  it("browser rect is the pane minus its header, inside the pane", () => {
    const pane = { x: 216, y: 132, width: 1170, height: 590 };
    const rect = browserRectForPane(pane);
    assert.deepEqual(rect, { x: 216, y: 166, width: 1170, height: 556 });
    assert.ok(rectInside(rect, pane));
  });

  it("a two-pane row split is disjoint and inside the grid", () => {
    const grid = { x: 216, y: 132, width: 1170, height: 590 };
    const [a, b] = splitPaneRects(grid, 2, "row");
    assert.ok(!rectsOverlap(a, b), "split panes must not overlap");
    assert.ok(rectInside(a, grid) && rectInside(b, grid));
    assert.equal(b.x, a.x + a.width + LAYOUT.dividerWidth);
    // Each pane's browser rect stays inside its own pane.
    assert.ok(rectInside(browserRectForPane(a), a));
    assert.ok(rectInside(browserRectForPane(b), b));
    assert.ok(!rectsOverlap(browserRectForPane(a), browserRectForPane(b)));
  });

  it("the enforced minimum comes from the layout module, not a literal", () => {
    // Item 3: the module is the single source. If the usable floor
    // and the enforced minimum ever differ, this fails.
    assert.equal(LAYOUT.minWindowWidth, 1024);
    assert.equal(LAYOUT.minWindowHeight, 640);
    assert.equal(LAYOUT.minWindowWidth, LAYOUT.usableMinWindowWidth);
    assert.equal(LAYOUT.minWindowHeight, LAYOUT.usableMinWindowHeight);
    // And createWindow must actually use those fields (main.js imports
    // Electron, so it cannot load under node --test; read its source).
    const main = readFileSync(join(root, "shell", "src", "main.js"), "utf8");
    assert.match(main, /from "\.\/shared\/layout\.js"/);
    assert.match(main, /minWidth: LAYOUT\.minWindowWidth/);
    assert.match(main, /minHeight: LAYOUT\.minWindowHeight/);
    assert.ok(!/minWidth: 1024/.test(main), "main must not hardcode the minimum");
    assert.ok(!/minHeight: 640/.test(main), "main must not hardcode the minimum");
  });

  it("a two-pane column split is disjoint and inside the grid", () => {
    const grid = { x: 216, y: 132, width: 1170, height: 590 };
    const [a, b] = splitPaneRects(grid, 2, "col");
    assert.ok(!rectsOverlap(a, b));
    assert.ok(rectInside(a, grid) && rectInside(b, grid));
    assert.equal(b.y, a.y + a.height + LAYOUT.dividerWidth);
  });
});
