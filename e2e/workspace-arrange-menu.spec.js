import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * W1 workspace chrome - REAL-LAYOUT guard for the context strip's Arrange menu.
 *
 * WHY THIS SPEC EXISTS
 * The Arrange dropdown is absolutely positioned inside a 34px strip. When the
 * strip still declared `overflow: hidden`, the 140px menu was clipped down to
 * about 3px of visible height: every one of the five shapes was present in the
 * DOM and clickable by a Playwright locator, but `elementFromPoint` at each
 * item's centre returned the context header underneath - so a person could not
 * reach the arrangements at all, and the arrangements were a required W1
 * deliverable.
 *
 * The unit suite could not catch it, and cannot in principle: jsdom performs no
 * layout, so there is no clipping to observe. Hence this guard lives here and
 * measures the real Electron renderer:
 *   1. no ancestor with a non-visible overflow axis cuts the menu's box, and
 *   2. every menuitem hit-tests to itself, which is what a real click resolves
 *      to (hit testing honours ancestor clips).
 *
 * If a future change re-introduces a clip (or shifts the menu under the header,
 * or off the right edge on a narrow window), step 1 or 2 fails with the exact
 * offending ancestor.
 */

/** Every shape the strip offers, in menu order. */
const ARRANGEMENTS = [
  { label: "Single", panes: 1 },
  { label: "Split", panes: 2 },
  { label: "Margin", panes: 2 },
  { label: "Trio", panes: 3 },
  { label: "Ledge", panes: 2 },
];

async function launch() {
  // Same trap as the workspace-integration spec: the --user-data-dir switch
  // does NOT move app.getPath("userData"), so without E2E_USER_DATA every
  // launch shares the default data dir and a previous run's split layout
  // is restored instead of the expected single pane.
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-arrange-"));
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1", PROGRESSLEDGER_V2_E2E_USER_DATA: userDataDir },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();
  return { app, win };
}

/** Open the Arrange menu through the real control. */
async function openArrange(win) {
  await win.locator('button:has-text("Arrange")').first().click();
  await win.locator("[role='menu']").first().waitFor({ state: "attached", timeout: 5000 });
  await win.waitForTimeout(250);
}

/**
 * Measure the open menu against the real layout. Returns the evidence so the
 * test can assert on it and print it on failure.
 */
async function measureMenu(win) {
  return win.evaluate(() => {
    const menu = document.querySelector("[role='menu']");
    if (!menu) return { found: false };
    const m = menu.getBoundingClientRect();

    // (1) Clipping ancestors. A clip counts per axis: `overflow: hidden` cuts
    // both, `overflow-x: auto` on the chips row cuts only horizontally.
    const violations = [];
    for (let n = menu.parentElement; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const clipsX = cs.overflowX !== "visible";
      const clipsY = cs.overflowY !== "visible";
      if (!clipsX && !clipsY) continue;
      const b = n.getBoundingClientRect();
      const cutY = clipsY && (m.top < b.top - 0.5 || m.bottom > b.bottom + 0.5);
      const cutX = clipsX && (m.left < b.left - 0.5 || m.right > b.right + 0.5);
      if (cutY || cutX) {
        violations.push({
          by: (n.className || n.tagName).toString().trim().slice(0, 60),
          overflow: cs.overflow,
          cut: cutX && cutY ? "both" : cutX ? "x" : "y",
          ancestorBox: `${Math.round(b.top)}->${Math.round(b.bottom)}`,
        });
      }
    }

    // (2) Real hit testing, the same question a click asks.
    const items = [...menu.querySelectorAll("[role='menuitem']")].map((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return {
        label: el.textContent.trim(),
        hitIsSelf: hit === el || el.contains(hit),
        hitBy: hit ? (hit.className || hit.tagName).toString().trim().slice(0, 60) : null,
      };
    });

    const strip = document.querySelector(".ctx-strip");
    const s = strip.getBoundingClientRect();

    return {
      found: true,
      violations,
      items,
      menuBox: {
        top: Math.round(m.top),
        bottom: Math.round(m.bottom),
        right: Math.round(m.right),
        height: Math.round(m.height),
      },
      stripBox: { top: Math.round(s.top), bottom: Math.round(s.bottom), height: Math.round(s.height) },
      stripOverflow: getComputedStyle(strip).overflow,
      windowWidth: window.innerWidth,
    };
  });
}

test("Arrange menu is unclipped, hit-testable, and does not disturb the strip", async () => {
  const { app, win } = await launch();
  try {
    await openArrange(win);
    const m = await measureMenu(win);
    expect(m.found, "the Arrange menu must render when Arrange is clicked").toBe(true);

    // The two checks that would have failed before the fix.
    expect(
      m.violations,
      `an ancestor clips the menu (${JSON.stringify(m.violations)})`,
    ).toEqual([]);
    expect(
      m.items.filter((i) => !i.hitIsSelf).map((i) => `${i.label} -> ${i.hitBy}`),
      "every shape must be the topmost element at its own centre",
    ).toEqual([]);

    // The whole menu is on screen, with all five shapes.
    expect(m.items.map((i) => i.label)).toEqual(ARRANGEMENTS.map((a) => a.label));
    expect(m.menuBox.height).toBeGreaterThan(100);
    expect(m.menuBox.right).toBeLessThanOrEqual(m.windowWidth);

    // The fix must not change the strip itself: same 34px row, and the menu
    // still opens BELOW it rather than covering it.
    expect(m.stripBox.height).toBe(34);
    expect(m.stripOverflow).toBe("visible");
    expect(m.menuBox.top).toBeGreaterThanOrEqual(m.stripBox.bottom - 2);
  } finally {
    await app.close();
  }
});

test("Arrange stays reachable on a narrow window", async () => {
  const { app, win } = await launch();
  try {
    await win.setViewportSize({ width: 1080, height: 820 });
    await win.waitForTimeout(600);
    await openArrange(win);
    const m = await measureMenu(win);
    expect(m.found).toBe(true);
    expect(m.violations, "clipped at 1080px").toEqual([]);
    expect(
      m.items.filter((i) => !i.hitIsSelf).map((i) => i.label),
      "shapes unreachable at 1080px",
    ).toEqual([]);
    expect(m.menuBox.right).toBeLessThanOrEqual(m.windowWidth);
  } finally {
    await app.close();
  }
});

test("choosing a shape reshapes the panes without losing tabs, modes or place", async () => {
  const { app, win } = await launch();
  try {
    // The Study context seeds five distinct destinations, so a reshape has
    // something to redistribute.
    await win.locator('button.nav-item:has-text("Subjects")').first().click();
    await win.waitForTimeout(1200);

    const snapshot = () =>
      win.evaluate(() => ({
        panes: document.querySelectorAll("[data-pane-id]").length,
        modes: [...document.querySelectorAll("[data-pane-id]")].map((p) =>
          p.getAttribute("data-pane-mode"),
        ),
        // Distinct destinations open right now. Arrangements may redistribute or
        // fold duplicate tabs, but must never CLOSE a destination.
        destinations: [
          ...new Set([...document.querySelectorAll(".tab-label")].map((t) => t.textContent.trim())),
        ].sort(),
        focusedTab:
          document.querySelector(".pane.focused .tab-wrap.active .tab-label")?.textContent.trim() ??
          null,
      }));

    const before = await snapshot();
    expect(before.panes).toBe(1);
    expect(before.destinations.length).toBeGreaterThanOrEqual(5);

    for (const { label, panes } of ARRANGEMENTS) {
      await openArrange(win);
      await win.locator(`[role='menuitem']:has-text("${label}")`).first().click();
      await win.waitForTimeout(700);

      const after = await snapshot();
      expect(after.panes, `${label} → pane count`).toBe(panes);
      // Nothing is closed by an arrangement: the Lab's recorded loss bug.
      expect(after.destinations, `${label} must not close a destination`).toEqual(before.destinations);
      // The user stays where they were.
      expect(after.focusedTab, `${label} must not move the active view`).toBe(before.focusedTab);
      // The menu closes behind the choice.
      expect(await win.locator("[role='menu']").count()).toBe(0);
    }

    // Margin establishes a real margin pane, bound to the content pane.
    await openArrange(win);
    await win.locator('[role="menuitem"]:has-text("Margin")').first().click();
    await win.waitForTimeout(700);
    const marginShape = await snapshot();
    expect(marginShape.modes.filter((m) => m === "margin")).toEqual(["margin"]);

    // ---- The Lab's known loss bug: a pane MODE must survive a reshape -------
    // System holds exactly two destinations, so Split's groups line up with the
    // panes Margin just made and the margin mode has to be carried, not dropped.
    await win.getByRole("button", { name: "Profiles", exact: true }).first().click();
    await win.waitForTimeout(1000);

    await openArrange(win);
    await win.locator('[role="menuitem"]:has-text("Margin")').first().click();
    await win.waitForTimeout(700);
    expect((await snapshot()).modes.filter((m) => m === "margin").length).toBe(1);

    await openArrange(win);
    await win.locator('[role="menuitem"]:has-text("Split")').first().click();
    await win.waitForTimeout(700);
    const carried = await snapshot();
    expect(carried.modes, "the margin mode must survive Split, not be silently dropped").toContain(
      "margin",
    );
  } finally {
    await app.close();
  }
});
