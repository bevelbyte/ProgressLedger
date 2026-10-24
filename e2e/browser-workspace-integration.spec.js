import { test, expect, _electron as electron } from "@playwright/test";
import { openNewWebPage } from "./helpers/browser-page-ui.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * PHASE 2 of the approved D2-D6 plan — the embedded browser AS A WORKSPACE TAB,
 * on the REAL surface.
 *
 * WHAT THIS SPEC IS FOR. Phase 1 (`browser-page.spec.js`) proved that ONE page
 * is owned, placed, hidden, occluded and destroyed correctly. Phase 2 is the
 * integration half, and every one of its claims is invisible to jsdom:
 *
 *   - two pages in ONE pane are two tabs, and the pane trail steps to the EXACT
 *     page (design 2.3.1: entries are tab ids, so Back cannot land on the other
 *     page);
 *   - a page tab moves to another pane with its identity — the same page id, the
 *     same page record, no reload, no second webContents, bounds re-measured for
 *     the pane it arrived in;
 *   - focus-from-native: a focus INSIDE the OS-painted view focuses the pane
 *     holding that page (the shell cannot see that click any other way);
 *   - every overlay hides the page, because a `WebContentsView` is painted above
 *     the renderer's DOM and cannot be z-covered — proven with a screenshot of a
 *     palette open over the page area.
 *
 * The unit layers (`ui/tests/workspace-model.test.js`, `workspace-shell.test.js`)
 * prove the pure decisions and the chrome wiring; they cannot see a native view,
 * a real focus event or a real rectangle. That is why this file exists.
 *
 * DONUT IS ABSENT FOR EVERY TEST HERE, ON PURPOSE (same launch env as Phase 1):
 * nothing in this feature may depend on it, including the move and the trail.
 */

/** A directory that is guaranteed NOT to exist: Donut is "absent from the machine". */
const ABSENT_DONUT_DIR = join(
  tmpdir(),
  `cf-p2-donut-absent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

/** Two distinguishable pages, so a spec can never confuse one for the other. */
const PAGES = {
  "/probe": { title: "CF Browser Probe", heading: "probe" },
  "/second": { title: "CF Browser Second", heading: "second" },
};

/** A throwaway loopback origin serving the two pages. */
async function startServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    hits.push(url.pathname);
    const page = PAGES[url.pathname];
    if (!page) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>${page.title}</title></head>` +
        `<body><h1 id="page">${page.heading}</h1></body></html>`,
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function launch() {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-p2-"));
  const env = {
    ...process.env,
    PROGRESSLEDGER_V2_E2E: "1",
    PROGRESSLEDGER_V2_DONUT_SETTINGS_DIR: ABSENT_DONUT_DIR,
  };
  delete env.PROGRESSLEDGER_V2_E2E_DONUT_STUB;
  delete env.PROGRESSLEDGER_V2_E2E_DONUT_MODE;

  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env,
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");

  // The REAL window is resized, not the viewport (see the Phase 1 spec's note:
  // a viewport override would make main clamp the declared rectangle into a
  // content box that disagrees with the renderer's CSS viewport).
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) w.setContentSize(1600, 1000);
  });

  await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();
  return { app, win };
}

/** Seed one Progress Ledger profile and select it through the app's own UI. */
async function seedAndSelectProfile(win) {
  const pid = await win.evaluate(async () => {
    const created = await window.progressLedger.profiles.add("Browser Phase Two", "browser-phase-two");
    const p = created?.profile || created;
    return p?.id ?? p?.profileId ?? (typeof created === "number" ? created : null);
  });
  expect(pid, `profile creation returned no id: ${JSON.stringify(pid)}`).not.toBe(null);

  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();

  await win.locator('button.nav-item:has-text("Profiles")').first().click();
  const card = win.locator("button.profile-main").first();
  await card.waitFor({ state: "visible", timeout: 10_000 });
  await card.click();

  // Wait for the hand-off, not merely for a pane (the boot context already has
  // one before `selectProfile`'s 500ms timer fires).
  await expect
    .poll(
      async () =>
        win.evaluate(() => {
          const el = document.querySelector(".ctx-chip-wrap.active .ctx-chip");
          return el ? el.textContent.replace(/\s+/g, " ").trim() : null;
        }),
      { timeout: 15_000 },
    )
    .toBe("Study");
  await expect
    .poll(async () => win.locator("[data-pane-id]").count(), { timeout: 15_000 })
    .toBeGreaterThan(0);
  return Number(pid);
}

/** The pane's own way in to a browser surface: no rail item exists for it. */
async function openPageTab(scope) {
  await openNewWebPage(scope);
}

async function navigateTo(scope, url) {
  await scope.locator('[data-testid="browser-address"]').fill(url);
  await scope.locator('[data-testid="browser-go"]').click();
}

/** Main-process truth, exposed only in E2E runs (`shell/src/ipc/browser.js`). */
function snapshot(app) {
  return app.evaluate(() => {
    const host = globalThis.__cfBrowserE2E;
    return host ? host.debugSnapshot() : null;
  });
}

function webContentsCount(app) {
  return app.evaluate(({ webContents }) => webContents.getAllWebContents().length);
}

/** The page main currently has ON SCREEN — there must only ever be one. */
async function visiblePageId(app) {
  const snap = await snapshot(app);
  const visible = (snap?.pages ?? []).filter((p) => p.visible === true);
  return visible.length === 1 ? visible[0].id : `visible=${visible.length}`;
}

/** The pane the shell considers focused, by its own aria readout. */
function focusedPaneId(win) {
  return win.evaluate(() => {
    const el = document.querySelector('[data-pane-id][aria-label="Pane focused"]');
    return el ? el.getAttribute("data-pane-id") : null;
  });
}

const near = (a, b) => Math.abs(a - b) <= 2;

test.describe("Phase 2 embedded browser — a page is an ordinary workspace tab (D2-D6)", () => {
  let app;
  let win;
  let server;

  test.beforeEach(async () => {
    server = await startServer();
    ({ app, win } = await launch());
  });

  test.afterEach(async () => {
    try {
      await app?.close();
    } finally {
      await server?.close();
    }
  });

  test("holds two pages in ONE pane as two tabs, and the trail steps to the exact page", async () => {
    await seedAndSelectProfile(win);
    const pane = win.locator("[data-pane-id]").first();

    // Page one, through the pane's own control.
    await openPageTab(pane);
    await navigateTo(pane, `${server.origin}/probe`);
    await expect.poll(async () => (await snapshot(app))?.pages?.length ?? 0).toBe(1);
    const first = (await snapshot(app)).pages[0];
    await expect(pane.locator('[data-testid="browser-page-id"]')).toHaveAttribute(
      "data-page-id",
      first.id,
    );

    // Page two in the SAME pane: a second "Web page" tab, which adopts the page
    // it navigates to. Two pages, one pane — the case the old view-keyed dedupe
    // could not represent at all.
    await openPageTab(pane);
    await navigateTo(pane, `${server.origin}/second`);
    await expect.poll(async () => (await snapshot(app))?.pages?.length ?? 0).toBe(2);
    const second = (await snapshot(app)).pages.find((p) => p.id !== first.id);

    // Two page tabs, told apart by their real titles (main reports the <title>,
    // the shell renames the tab) — not by two identical "Web page" labels. The
    // pane also holds the context's seeded destinations, so this reads the PAGE
    // tabs only: `data-view` is the seam for exactly that question.
    const pageLabels = pane.locator('[data-view="page"] .tab-label');
    await expect.poll(async () => (await pageLabels.allTextContents()).sort()).toEqual([
      "CF Browser Probe",
      "CF Browser Second",
    ]);
    expect(await visiblePageId(app), "exactly the active page is on screen").toBe(second.id);

    // BACK — one step lands on page ONE, the page this pane actually showed
    // before. With view-named trail entries both pages are "page" and the step
    // had to guess, which is the defect design 2.3.1 closes.
    await pane.locator('button[aria-label="Back"]').click();
    await expect.poll(() => visiblePageId(app)).toBe(first.id);
    await expect(pane.locator('[data-testid="browser-page-id"]')).toHaveAttribute(
      "data-page-id",
      first.id,
    );
    // …and the pane is showing one page, not both stacked.
    const back = await snapshot(app);
    expect(back.pages.filter((p) => p.visible === true).length).toBe(1);

    // FORWARD returns to page two: the step moved the pointer, it did not spend
    // the forward history.
    await pane.locator('button[aria-label="Forward"]').click();
    await expect.poll(() => visiblePageId(app)).toBe(second.id);
    const forward = await snapshot(app);
    expect(forward.pages.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());
  });

  test("moves a page tab to another pane: same page, same identity, no reload, no leak", async () => {
    await seedAndSelectProfile(win);
    const panes = win.locator("[data-pane-id]");

    // Split FIRST so the new pane is seeded from a plain destination: a split of
    // a pane SHOWING a page would copy the page into it, which is the identity
    // half rather than the move being tested here.
    await win.locator('button[aria-label="Split pane vertically"]').first().click();
    await expect.poll(async () => panes.count()).toBe(2);

    await openNewWebPage(panes.nth(0));
    await navigateTo(panes.nth(0), `${server.origin}/probe`);
    await expect.poll(async () => (await snapshot(app))?.pages?.length ?? 0).toBe(1);
    const before = (await snapshot(app)).pages[0];
    const contentsBefore = await webContentsCount(app);

    // The page is really inside pane 1's rectangle (Phase 1 proved the
    // placeholder match; this pins it to the pane the tab belongs to).
    await expect
      .poll(async () => {
        const current = (await snapshot(app)).pages[0];
        const box = await panes.nth(0).locator('[data-testid="browser-placeholder"]').boundingBox();
        if (!current?.bounds || !box) return "not-measured";
        return near(box.x, current.bounds.x) && near(box.y, current.bounds.y) ? "inside" : "outside";
      })
      .toBe("inside");

    // MOVE — the pane header's own control (the drag onto the pane is the mouse
    // path to the same call; the control is what a test can drive reliably).
    await panes.nth(0).locator('button[aria-label="Move active tab to the next pane"]').click();

    // The tab left pane 1 and arrived in pane 2, page identity intact.
    await expect(panes.nth(0).locator('[data-testid="browser-page-id"]')).toHaveCount(0);
    await expect(panes.nth(1).locator('[data-testid="browser-page-id"]')).toHaveAttribute(
      "data-page-id",
      before.id,
    );

    // No reload: the SAME page record, with the same createdAt, still the only
    // page — a move is not a re-open.
    const after = (await snapshot(app)).pages;
    expect(after.length).toBe(1);
    expect(after[0].id).toBe(before.id);
    expect(after[0].createdAt).toBe(before.createdAt);
    expect(after[0].url).toBe(before.url);
    expect(after[0].visible, "the moved page is on screen in its new pane").toBe(true);

    // No leak: the move created no process and destroyed none.
    expect(await webContentsCount(app)).toBe(contentsBefore);

    // …and the native view was re-measured for its NEW pane: the rectangle main
    // placed it at is pane 2's placeholder, not the old one.
    await expect
      .poll(
        async () => {
          const current = (await snapshot(app)).pages[0];
          const box = await panes
            .nth(1)
            .locator('[data-testid="browser-placeholder"]')
            .boundingBox();
          if (!current?.bounds || !box || !current.actualBounds) return "not-measured";
          return near(box.x, current.bounds.x) &&
            near(box.y, current.bounds.y) &&
            near(box.width, current.bounds.width) &&
            near(box.height, current.bounds.height) &&
            current.actualBounds.x === current.bounds.x
            ? "moved"
            : `placeholder=${JSON.stringify(box)} bounds=${JSON.stringify(current.bounds)}`;
        },
        { timeout: 10_000 },
      )
      .toBe("moved");
  });

  test("the browser chrome yields to a narrow margin pane without clipping or crossing native bounds", async () => {
    await seedAndSelectProfile(win);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1180, 820));
    const panes = win.locator("[data-pane-id]");

    // Create the second pane before opening a page so the page identity is not
    // copied into both panes by the normal split behaviour.
    await win.locator('button[aria-label="Split pane vertically"]').first().click();
    await expect.poll(async () => panes.count()).toBe(2);
    await panes.nth(1).locator('select[aria-label="Pane mode"]').selectOption("margin");

    await openNewWebPage(panes.nth(0));
    await navigateTo(panes.nth(0), `${server.origin}/probe`);
    await expect(panes.nth(0).locator('[data-testid="browser-title"]')).toHaveText("CF Browser Probe");
    await expect(panes.nth(0).locator('[data-testid="browser-address"]')).toBeVisible();

    await expect.poll(async () => {
      const bar = panes.nth(0).locator(".browser-bar");
      const box = await bar.evaluate((el) => ({ clientWidth: el.clientWidth, scrollWidth: el.scrollWidth }));
      return box.scrollWidth <= box.clientWidth;
    }).toBe(true);

    const paneContent = await panes.nth(0).boundingBox();
    const marginContent = await panes.nth(1).boundingBox();
    expect(paneContent).not.toBeNull();
    expect(marginContent).not.toBeNull();
    await expect.poll(async () => {
      const current = (await snapshot(app))?.pages?.find((p) => p.visible === true);
      const placeholder = await panes.nth(0).locator('[data-testid="browser-placeholder"]').boundingBox();
      if (!current?.bounds || !placeholder || !paneContent || !marginContent) return false;
      return near(placeholder.x, current.bounds.x) &&
        near(placeholder.y, current.bounds.y) &&
        near(placeholder.width, current.bounds.width) &&
        near(placeholder.height, current.bounds.height) &&
        current.bounds.x >= paneContent.x - 2 &&
        current.bounds.x + current.bounds.width <= marginContent.x + 2;
    }, { timeout: 10_000 }).toBe(true);
  });

  test("focus inside the native page focuses the pane that holds it", async () => {
    await seedAndSelectProfile(win);
    const panes = win.locator("[data-pane-id]");
    await win.locator('button[aria-label="Split pane vertically"]').first().click();
    await expect.poll(async () => panes.count()).toBe(2);

    await openNewWebPage(panes.nth(0));
    await navigateTo(panes.nth(0), `${server.origin}/probe`);
    await expect.poll(async () => (await snapshot(app))?.pages?.length ?? 0).toBe(1);
    const page = (await snapshot(app)).pages[0];

    const pane1 = await panes.nth(0).getAttribute("data-pane-id");
    const pane2 = await panes.nth(1).getAttribute("data-pane-id");
    expect(pane1).not.toBe(pane2);

    // Focus pane 2 through the DOM, so the assertion below cannot pass because
    // pane 1 was already focused.
    await panes.nth(1).locator(".tab").first().click();
    await expect.poll(() => focusedPaneId(win)).toBe(pane2);

    // Now focus the PAGE. This is the E2E seam for a click inside an OS-painted
    // view: the shell cannot see it, so main reports it and the shell answers.
    // The seam drives MAIN'S OWN report (`reportPageFocus`, the same call the
    // live webContents `focus` listener makes) because Chromium only delivers
    // that event to a window the OS considers focused, which an automated run
    // cannot guarantee; `nativeFocus` records whether Chromium also moved the
    // real focus.
    const focus = await app.evaluate((_electron, id) => {
      return globalThis.__cfBrowserE2E.focusPage(id);
    }, page.id);
    expect(focus?.ok, `focusPage refused: ${JSON.stringify(focus)}`).toBe(true);

    await expect
      .poll(() => focusedPaneId(win), { timeout: 10_000 })
      .toBe(pane1);
  });

  test("every overlay hides the page, proven with a screenshot over the page area", async ({}, testInfo) => {
    await seedAndSelectProfile(win);
    const pane = win.locator("[data-pane-id]").first();
    await openPageTab(pane);
    await navigateTo(pane, `${server.origin}/probe`);
    await expect.poll(() => visiblePageId(app)).toMatch(/^bp-\d+$/);

    // The Space Bunny destination menu is also an overlay: because the page is
    // a native WebContentsView, it must be hidden until the menu closes.
    await pane.locator('button[aria-label="New tab"]').click();
    await expect(pane.getByRole("menuitem", { name: "New web page" })).toBeVisible();
    await expect.poll(async () => (await snapshot(app))?.occluded).toBe(true);
    expect((await snapshot(app)).pages.every((p) => p.visible === false)).toBe(true);
    await win.keyboard.press("Escape");
    await expect(pane.getByRole("menuitem", { name: "New web page" })).toHaveCount(0);
    await expect.poll(async () => (await snapshot(app))?.occluded).toBe(false);
    await expect.poll(() => visiblePageId(app), { timeout: 10_000 }).toMatch(/^bp-\d+$/);

    // The command palette is centred over the work surface — the hardest case
    // for a native view, which cannot be z-covered by DOM.
    await win.locator('button[aria-label="Search or run a command"]').click();
    await expect(win.locator(".palette-modal")).toBeVisible();
    await expect.poll(async () => (await snapshot(app))?.occluded).toBe(true);
    expect(
      (await snapshot(app)).pages.every((p) => p.visible === false),
      "no page may stay on screen under an overlay",
    ).toBe(true);

    // The proof artifact: the palette open over the pane that holds a page. If
    // the occlusion rule regressed, the native page would be painted over this
    // modal and the capture would show it.
    // Keep generated evidence inside Playwright's per-test output directory;
    // never overwrite the pre-existing untracked shots/p2 artifact.
    await win.screenshot({ path: testInfo.outputPath("overlay-hides-page.png") });

    // Closing the overlay restores the SAME page, without the renderer having to
    // re-ask: the visibility request was recorded while it was hidden.
    await win.keyboard.press("Escape");
    await expect(win.locator(".palette-modal")).toHaveCount(0);
    await expect.poll(async () => (await snapshot(app))?.occluded).toBe(false);
    await expect
      .poll(() => visiblePageId(app), { timeout: 10_000 })
      .toMatch(/^bp-\d+$/);
  });
});
