import { test, expect, _electron as electron } from "@playwright/test";
import { openNewWebPage } from "./helpers/browser-page-ui.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * PHASE 1 of the approved D2-D6 plan — the Progress Ledger-owned embedded browser,
 * on the REAL surface.
 *
 * WHAT THIS SPEC IS FOR. Everything about the embedded browser that jsdom
 * cannot see: that a `WebContentsView` is really constructed, really attached to
 * the window, really placed at the rectangle the shell measured, really taken
 * cannot see: that a `WebContentsView` is really constructed, really attached to
 * the window, really placed at the rectangle the shell measured, really taken
 * off screen and really destroyed without leaking a renderer process. The unit
 * suites (`shell/tests/browser-policy.test.js`, `browser-registry.test.js`,
 * `ui/tests/browser-surface.test.js`) prove the pure decisions and the renderer
 * mirror; they cannot prove any of the above, and they say so.
 *
 * DONUT IS ABSENT FOR EVERY TEST IN THIS FILE, ON PURPOSE. The launch env points
 * `PROGRESSLEDGER_V2_DONUT_SETTINGS_DIR` at a directory that does not exist and leaves
 * the hermetic stub (`PROGRESSLEDGER_V2_E2E_DONUT_STUB`) unset, so there is no Donut
 * backend, no Donut stub, no Donut credentials and nothing to call. If the
 * embedded browser ever grew a Donut dependency, every test here would fail -
 * which is exactly the mandatory Phase 1 independence property.
 */

/** A directory that is guaranteed NOT to exist: Donut is "absent from the machine". */
const ABSENT_DONUT_DIR = join(
  tmpdir(),
  `cf-donut-absent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

const PROBE_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>CF Browser Probe</title></head>
  <body>
    <h1 id="probe">probe</h1>
    <script>
      (function () {
        var names = ["progressledger", "require", "process", "module", "electron", "ipcRenderer", "Buffer"];
        var surface = {};
        names.forEach(function (n) { surface[n] = typeof window[n]; });
        var out = {
          probe: "ok",
          url: String(location.href),
          title: String(document.title),
          surface: surface,
          progressledgerKeys: window.progressLedger ? Object.keys(window.progressLedger) : [],
          globals: names.filter(function (n) { return Object.prototype.hasOwnProperty.call(window, n); }),
        };
        try {
          out.popup = window.open("https://example.com/") === null ? "null" : "window";
        } catch (e) {
          out.popup = "threw:" + e.message;
        }
        try {
          fetch("/report?d=" + encodeURIComponent(JSON.stringify(out)));
        } catch (e) {
          /* the assertion then fails on a missing report, which is honest */
        }
      })();
    </script>
  </body>
</html>
`;

/** A throwaway loopback origin plus a log of what the page reported. */
async function startProbeServer() {
  const reports = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/report") {
      try {
        reports.push(JSON.parse(url.searchParams.get("d") ?? "{}"));
      } catch {
        reports.push({ probe: "unparseable" });
      }
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PROBE_HTML);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    reports,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function launch() {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-browser-"));
  const env = {
    ...process.env,
    PROGRESSLEDGER_V2_E2E: "1",
    // Donut absent: no stub, and a settings directory that is not there.
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

  // Resize the REAL window — NOT `win.setViewportSize()`, which installs a CDP
  // device-metrics override. Under that override the renderer's CSS viewport
  // (1600x1000) and the window's actual content area (1400x900 minus frame,
  // i.e. 1386x779) disagree, and `clampRect` then correctly clamps the declared
  // rectangle into the real content box — so this spec would be measuring the
  // emulator rather than the app. A real run has no such divergence: CSS pixels
  // in the renderer ARE DIPs in the window content area.
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

/**
 * Seed one Progress Ledger profile through the app's own bridge, then select it
 * through the app's own profile card. The browser partition is derived from this
 * profile's id (approved decision B), so the id has to be a REAL row.
 */
async function seedAndSelectProfile(win) {
  const pid = await win.evaluate(async () => {
    const created = await window.progressLedger.profiles.add("Browser Phase One", "browser-phase-one");
    const p = created?.profile || created;
    return p?.id ?? p?.profileId ?? (typeof created === "number" ? created : null);
  });
  expect(pid, `profile creation returned no id: ${JSON.stringify(pid)}`).not.toBe(null);

  // Reload so the shell's own boot-time profile load sees the new row.
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();

  await win.locator('button.nav-item:has-text("Profiles")').first().click();
  const card = win.locator("button.profile-main").first();
  await card.waitFor({ state: "visible", timeout: 10_000 });
  await card.click();

  // Wait for the HAND-OFF, not merely for a pane: `selectProfile` hands the user
  // to their work on a 500ms timer (App.svelte), and the boot context already
  // has a pane before that fires. Opening a page tab into the boot context would
  // put it in the wrong context's pane entirely — a test bug that looks exactly
  // like a product bug.
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
async function openPageTab(win) {
  await openNewWebPage(win);
}

/**
 * Type an address into a browser surface. `scope` is the Page when only one
 * surface is on screen, or a PANE locator when several panes each host one — the
 * surface is per pane, so an unscoped locator would be ambiguous.
 */
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

// The pane's page tab, found by VIEW rather than by label: a page tab takes the
// page's real <title> as its label as soon as main reports it (Phase 2), so
// "Web page" is only what it is called until it loads — a selector on that text
// would work until the page has a title, which is exactly when the test needs it.
const pageTabs = (win) => win.locator('[data-pane-id] [data-view="page"]');

test.describe("Phase 1 embedded browser (D2-D6) — Progress Ledger-owned and Donut-independent", () => {
  let app;
  let win;
  let server;

  test.beforeEach(async () => {
    server = await startProbeServer();
    ({ app, win } = await launch());
  });

  test.afterEach(async () => {
    try {
      await app?.close();
    } finally {
      await server?.close();
    }
  });

  test("owns one real page: creates it, places it at the measured rectangle, hides and shows it, then destroys it cleanly", async () => {
    const pid = await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, `${server.origin}/probe`);

    // Exactly one page the USER opened exists. Since R3 the probe page's
    // `window.open("https://example.com/")` is re-decided by main into an
    // unfocused Progress Ledger tab (approved decision D3-3), so a second, NEVER
    // VISIBLE page may also exist. The claim under test is the page this pane
    // owns; the popup is proven separately in e2e/browser-popups.spec.js.
    await expect
      .poll(async () => (await snapshot(app))?.pages?.filter((p) => p.visible)?.length ?? 0)
      .toBe(1);

    const page = (await snapshot(app)).pages.find((p) => p.visible);
    expect(page.id).toMatch(/^bp-\d+$/);
    expect(page.attached, "the view is attached to the window").toBe(true);
    expect(page.visible, "the view is on screen").toBe(true);
    expect(page.requestVisible).toBe(true);
    // Approved decision B: ONE persistent partition per Progress Ledger profile.
    expect(page.partition).toBe(`persist:cf-browser-${pid}`);

    // The renderer DECLARED a rectangle; main clamped it and decided. The view
    // is exactly where main said…
    expect(page.bounds.width).toBeGreaterThan(100);
    expect(page.bounds.height).toBeGreaterThan(100);
    expect(page.actualBounds).toEqual(page.bounds);

    // …and the rectangle main was told is the surface the shell actually laid
    // out. Polled, because the declaration is coalesced (rAF, with a timer
    // fallback for a throttled renderer) rather than sent on every observation.
    const near = (a, b) => Math.abs(a - b) <= 2;
    await expect
      .poll(
        async () => {
          const current = (await snapshot(app)).pages.find((p) => p.visible);
          const box = await win.locator('[data-testid="browser-placeholder"]').boundingBox();
          if (!current?.bounds || !box) return "not-measured";
          return near(box.x, current.bounds.x) &&
            near(box.y, current.bounds.y) &&
            near(box.width, current.bounds.width) &&
            near(box.height, current.bounds.height)
            ? "match"
            : `placeholder=${JSON.stringify(box)} bounds=${JSON.stringify(current.bounds)}`;
        },
        { timeout: 10_000 },
      )
      .toBe("match");

    const box = await win.locator('[data-testid="browser-placeholder"]').boundingBox();
    expect(box.width, "the pane is a real surface, not a sliver").toBeGreaterThan(100);

    // The RENDERER's view of the page is sanitized: the opaque id is there, the
    // partition (a main-process fact) is not.
    const mirror = await win.evaluate(() => window.progressLedger.browser.state());
    const mirrored = mirror.pages.find((p) => p.id === page.id);
    expect(mirrored, "the page this pane owns is in the renderer mirror").toBeTruthy();

    expect(mirrored.partition).toBeUndefined();
    expect(mirrored.profileId).toBeUndefined();

    // Managed downloads (approved decision D) are reachable through the app's own
    // bridge, start empty, and hand the renderer no path and no directory. This is
    // the renderer-facing half of the download foundation: the destination rules
    // themselves are unit-tested in shell/tests/browser-downloads.test.js, and a
    // real download landing on disk is a later phase's acceptance.
    const downloads = await win.evaluate(() => window.progressLedger.browser.downloads());
    expect(downloads.ok).toBe(true);
    expect(downloads.downloads).toEqual([]);
    expect(JSON.stringify(downloads)).not.toContain("downloads\\");
    expect(JSON.stringify(downloads)).not.toContain("downloads/");

    // HIDE — leaving the tab takes the page off screen but does NOT close it.
    await win.locator('[data-pane-id] .tab', { hasText: "Subjects" }).first().click();
    await expect.poll(async () => (await snapshot(app))?.pages?.[0]?.visible).toBe(false);
    const hidden = await snapshot(app);
    const hiddenPage = hidden.pages.find((p) => p.id === page.id);
    expect(hiddenPage, "backgrounding must not close the page").toBeTruthy();
    expect(hiddenPage.attached).toBe(false);

    // SHOW — returning restores the same page.
    await pageTabs(win).first().click();
    await expect
      .poll(async () => (await snapshot(app))?.pages?.find((p) => p.id === page.id)?.visible)
      .toBe(true);

    // OCCLUDE — the operator console is an overlay, and a native view cannot be
    // z-covered by DOM, so main must take every page off screen instead.
    await win.locator("button.operator-chip, button.sb-operator").first().click();
    await expect.poll(async () => (await snapshot(app))?.occluded).toBe(true);
    expect((await snapshot(app)).pages.find((p) => p.id === page.id).visible).toBe(false);
    await win.locator("button.operator-chip, button.sb-operator").first().click();
    await expect.poll(async () => (await snapshot(app))?.occluded).toBe(false);
    await expect
      .poll(async () => (await snapshot(app))?.pages?.find((p) => p.id === page.id)?.visible)
      .toBe(true);

    // DESTROY - closing the tab releases the page and leaks no renderer
    // process. The probe page's window.open (R3) also created an unfocused
    // popup tab, which SURVIVES its opener exactly as a browser's popup tab
    // does. Both tabs are closed here, so the "nothing leaks" claim covers
    // the whole run. Neither is identifiable by label (a page tab takes the
    // page's real title), so both are closed by VIEW.
    const before = await webContentsCount(app);
    for (let i = 0; i < 2; i += 1) {
      await win
        .locator('[data-pane-id] .tab-wrap:has([data-view="page"]) .tab-close')
        .last()
        .click();
    }
    await expect.poll(async () => (await snapshot(app))?.pages?.length ?? -1).toBe(0);
    expect(await webContentsCount(app), "the page's webContents must not survive").toBe(
      before - 2,
    );
    expect(
      await win.locator('[data-testid="browser-surface"]').count(),
      "the surface leaves with its tab",
    ).toBe(0);
  });

  test("carries the page identity on the workspace tab — the approved (view, entity) contract", async () => {
    await seedAndSelectProfile(win);
    const panes = win.locator("[data-pane-id]");

    // Split FIRST, so the second pane is seeded from a plain destination and has
    // no page tab of its own. (A split of a pane that is SHOWING a page copies
    // that tab AND its entity — the same page reached from two panes, which is
    // the fold half of the contract rather than the identity half.)
    await win.locator('button[aria-label="Split pane vertically"]').first().click();
    await expect.poll(async () => panes.count()).toBe(2);

    // Pane 1 opens a page through the pane's own control.
    await openNewWebPage(panes.nth(0));
    await navigateTo(panes.nth(0), `${server.origin}/probe`);
    await expect
      .poll(async () => (await snapshot(app))?.pages?.filter((p) => p.visible)?.length ?? 0)
      .toBe(1);
    const first = (await snapshot(app)).pages.find((p) => p.visible);

    // The surface resolves its page BY the tab's entity: this readout can only
    // render because `entity` really is the main-minted page id.
    const surfaceId = (i) => panes.nth(i).locator('[data-testid="browser-page-id"]');
    await expect(surfaceId(0)).toHaveAttribute("data-page-id", first.id);

    // The pane's tab strip gained exactly one "Web page" tab: an ordinary
    // workspace tab in the pane the user asked for, not a parallel navigation
    // model and not a second workspace.
    const labels = await panes.nth(0).locator(".tab-label").allTextContents();
    expect(labels.filter((l) => l.trim() === "Web page").length).toBe(1);

    // Pane 2 opens its OWN page: same VIEW, different ENTITY. This is the whole
    // point of `(view, entity)` — view identity alone could not tell these two
    // browser tabs apart.
    await panes.nth(1).locator(".tab").first().click();
    await openNewWebPage(panes.nth(1));
    await navigateTo(panes.nth(1), `${server.origin}/second`);
    await expect
      .poll(async () => (await snapshot(app))?.pages?.filter((p) => p.visible)?.length ?? 0)
      .toBe(2);

    // The two pages the USER opened, in creation order. A popup the probe page
    // triggers (R3) is never visible, so filtering on visibility is exactly
    // "the pages this shell asked for".
    const all = await snapshot(app);
    const visible = all.pages
      .filter((p) => p.visible)
      .sort((a, b) => Number(a.id.replace(/\D/g, "")) - Number(b.id.replace(/\D/g, "")));
    const second = visible.find((p) => p.id !== first.id);
    expect(second, "the second pane minted its own page id").toBeTruthy();
    await expect(surfaceId(1)).toHaveAttribute("data-page-id", second.id);
    // …and pane 1 is untouched: the two panes are two entities, not one page
    // rendered twice.
    await expect(surfaceId(0)).toHaveAttribute("data-page-id", first.id);
    expect(visible.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());
    // Both pages share the ONE partition the Progress Ledger profile owns (approved
    // decision B) — the identity is per page, the storage is per profile.
    expect(new Set(visible.map((p) => p.partition)).size).toBe(1);
  });

  test("page content gets no Progress Ledger bridge, no Node and no popup window", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, `${server.origin}/probe`);

    // The page itself reported back, so these are observations made FROM inside
    // the untrusted content, not guesses about it.
    await expect.poll(() => server.reports.length).toBeGreaterThan(0);
    const report = server.reports[0];
    expect(report.probe).toBe("ok");
    expect(report.surface.progressledger, "no Progress Ledger preload on a web page").toBe("undefined");
    expect(report.surface.require, "no Node require").toBe("undefined");
    expect(report.surface.process, "no Node process").toBe("undefined");
    expect(report.surface.module, "no Node module").toBe("undefined");
    expect(report.surface.electron, "no electron module").toBe("undefined");
    expect(report.surface.ipcRenderer, "no ipcRenderer").toBe("undefined");
    expect(report.progressledgerKeys).toEqual([]);
    expect(report.globals).toEqual([]);
    // NO OS WINDOW IS CREATED (R3, approved decision D3-3). `setWindowOpenHandler`
    // denies unconditionally, so `window.open` returns null and the page never
    // sees an OS window. Since R3, an http(s) popup is additionally RE-DECIDED
    // by main into an unfocused Progress Ledger browser tab, so a page may now exist
    // in main that this pane did not ask for — that is the approved behaviour and
    // is proven in `e2e/browser-popups.spec.js`. What is asserted here is the OS
    // window invariant, which is the security property Phase 1 owns.
    expect(report.popup, "window.open is still denied by the handler").toBe("null");
    // …and no OS window was created. NOTE: Playwright's `app.windows()` also
    // lists the embedded `WebContentsView` as a Page (which is itself useful
    // evidence that a real browser page exists), so the claim is asserted against
    // the REAL BrowserWindow list instead.
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      "no second BrowserWindow",
    ).toBe(1);

    // No debugger is attached to any webContents: the embedded browser is not
    // driven over CDP, and no remote-debugging listener is part of this feature.
    const debuggers = await app.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .filter((w) => {
          try {
            return w.debugger.isAttached();
          } catch {
            return false;
          }
        }).length,
    );
    expect(debuggers).toBe(0);
  });

  test("works with Donut stopped, unavailable and absent from the machine", async () => {
    // Preconditions, asserted rather than assumed: the settings directory does
    // not exist, the hermetic stub is off, and no Donut recorder was installed.
    expect(existsSync(ABSENT_DONUT_DIR), "the Donut settings dir must not exist").toBe(false);
    const donut = await app.evaluate(() => {
      let dirExists = null;
      try {
        dirExists = require("node:fs").existsSync(process.env.PROGRESSLEDGER_V2_DONUT_SETTINGS_DIR);
      } catch {
        dirExists = false;
      }
      return {
        stubEnv: process.env.PROGRESSLEDGER_V2_E2E_DONUT_STUB ?? null,
        recorder: globalThis.__cfDonutE2E ?? null,
        settingsDir: process.env.PROGRESSLEDGER_V2_DONUT_SETTINGS_DIR ?? null,
        settingsDirExists: dirExists,
      };
    });
    expect(donut.settingsDir).toBe(ABSENT_DONUT_DIR);
    expect(donut.settingsDirExists).toBe(false);
    expect(donut.stubEnv, "the Donut E2E stub must not be in play").toBe(null);
    expect(donut.recorder, "no Donut collaboration was installed").toBe(null);

    // …and the embedded browser still creates, attaches, displays and navigates.
    await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, `${server.origin}/probe`);

    await expect
      .poll(async () => (await snapshot(app))?.pages?.filter((p) => p.visible)?.length ?? 0)
      .toBe(1);
    const page = (await snapshot(app)).pages.find((p) => p.visible);
    expect(page.attached).toBe(true);
    expect(page.visible).toBe(true);

    // It really rendered OUR page: the title came from the document, the request
    // reached our server, and the page executed its own script.
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("CF Browser Probe");
    // The title is available before the page's asynchronous fetch reaches /report.
    // Poll the observable report rather than racing the browser's event loop.
    await expect.poll(() => server.reports.length, { timeout: 5_000 }).toBeGreaterThan(0);
    expect(server.reports[0].title).toBe("CF Browser Probe");
  });
});
