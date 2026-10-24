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
 * R3 of the current roadmap — "Downloads, popups and external navigation".
 *
 * THIS FILE IS THE POPUP HALF, and it exists because of a defect the unit tests
 * could not see. `decidePopup` is pure and was fully unit-proven, but the code
 * that CALLED it — `host.js`'s `onWindowOpen` hook — invoked a bare
 * `createPage(...)` identifier that does not exist in that scope. The popup
 * path was written and never executed: every approved popup would have thrown
 * `ReferenceError: createPage is not defined` inside the window-open handler.
 * A guard nobody can reach is a guard nobody has tested, so this spec exists to
 * run it.
 *
 * WHAT IT PROVES IN THE REAL APP
 *   * an approved popup becomes an UNFOCUSED Progress Ledger workspace tab;
 *   * the tab the user was reading stays active, and the pane trail is untouched;
 *   * NO OS-level BrowserWindow is ever created — the handler denies it and main
 *     creates its own page instead;
 *   * the third popup in one page load is refused with `popup-budget`;
 *   * a popup to a forbidden scheme is refused by the R2 allowlist;
 *   * closing popups does not leak WebContentsView instances;
 *   * a popup whose page cannot be created is a stated refusal, not a crash.
 *
 * DONUT IS ABSENT FOR EVERY TEST, asserted at launch rather than assumed.
 */

/** A directory guaranteed NOT to exist: Donut is "absent from the machine". */
const ABSENT_DONUT_DIR = join(
  tmpdir(),
  `cf-donut-absent-r3-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

/**
 * The probe page. `?program=` selects what it does; reports are per-SLOT so one
 * page can answer several questions without one overwriting another.
 */
const PAGE_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>R3 Popup Probe</title></head>
  <body>
    <h1 id="probe">r3 popup probe</h1>
    <script>
      (function () {
        var params = new URLSearchParams(location.search);
        var program = params.get("program") || "idle";
        var slots = {};

        function report(slot, extra) {
          if (slots[slot]) return;
          slots[slot] = true;
          var out = { program: program, slot: slot, href: String(location.href), title: String(document.title) };
          for (var k in (extra || {})) out[k] = extra[k];
          try { fetch("/report?d=" + encodeURIComponent(JSON.stringify(out))); } catch (e) {}
        }

        function later(ms, fn) { setTimeout(fn, ms); }
        function openIt(url) {
          try { window.open(url, "_blank"); } catch (e) { report("auto", { threw: String(e) }); }
        }

        // The spec drives popups through THIS hook rather than letting the page
        // fire them during parse, because a load-time popup would make
        // "how many pages exist before the popup" untestable — the popup would
        // already have happened by the time an assertion ran.
        window.__open = openIt;

        switch (program) {
          case "open-file":
            // A popup to a FORBIDDEN scheme: the R2 allowlist is the only answer.
            openIt("file:///C:/Windows/win.ini");
            break;
          case "open-data":
            openIt("data:text/html,<h1>data popup</h1>");
            break;
          case "open-progressledger":
            openIt("progressledger-v2://app/index.html");
            break;
          default:
            report("auto", { note: "idle" });
        }
      })();
    </script>
  </body>
</html>
`;

/** A loopback origin that serves the probe page and logs what pages reported. */
async function startOrigin() {
  const reports = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/report") {
      try {
        reports.push(JSON.parse(url.searchParams.get("d") ?? "{}"));
      } catch {
        reports.push({ program: "unparseable" });
      }
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/landed") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        '<!doctype html><html><head><title>landed</title></head><body><h1>landed</h1></body></html>',
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE_HTML);
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
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-r3-popup-"));
  const env = {
    ...process.env,
    PROGRESSLEDGER_V2_E2E: "1",
    PROGRESSLEDGER_V2_E2E_USER_DATA: userDataDir,
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

  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) w.setContentSize(1600, 1000);
  });

  await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();

  // Main's own push stream: popups, refusals, everything.
  await win.evaluate(() => {
    window.__cfEvents = [];
    window.progressLedger.browser.onEvent((event) => window.__cfEvents.push(event));
  });
  return { app, win, userDataDir };
}

/** Seed one Progress Ledger profile and select it through the app's own card. */
async function seedAndSelectProfile(win) {
  const pid = await win.evaluate(async () => {
    const created = await window.progressLedger.profiles.add("R3 Popup", "r3-popup");
    const p = created?.profile || created;
    return p?.id ?? p?.profileId ?? (typeof created === "number" ? created : null);
  });
  expect(pid, `profile creation returned no id: ${JSON.stringify(pid)}`).not.toBe(null);

  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();
  await win.evaluate(() => {
    window.__cfEvents = [];
    window.progressLedger.browser.onEvent((event) => window.__cfEvents.push(event));
  });

  await win.locator('button.nav-item:has-text("Profiles")').first().click();
  const card = win.locator("button.profile-main").first();
  await card.waitFor({ state: "visible", timeout: 10_000 });
  await card.click();
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
  return Number(pid);
}

/** The pane's own way in to a browser surface. */
async function openPageTab(win) {
  await openNewWebPage(win);
  await expect(win.locator('[data-testid="browser-surface"]')).toBeVisible();
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

/** How many real OS windows the app has. A popup must never raise this. */
function browserWindowCount(app) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

/** How many webContents the whole app has (the leak detector). */
function webContentsCount(app) {
  return app.evaluate(({ webContents }) => webContents.getAllWebContents().length);
}

/**
 * Run code inside the browser page's own webContents. This is how a popup is
 * triggered: `window.open` fires Electron's `setWindowOpenHandler` WITHOUT a
 * user gesture (the design records that the handler has no gesture flag), so a
 * scripted call is indistinguishable from a click — which is exactly why the
 * handler must always deny and main must re-decide for itself.
 */
function runInPage(app, code) {
  return app.evaluate(
    async ({ webContents }, spec) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => String(w.getURL()).includes("127.0.0.1"));
      if (!wc) return { ok: false, reason: "no-page-webcontents" };
      try {
        await wc.executeJavaScript(spec.code);
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: String(e?.message ?? e) };
      }
    },
    { code },
  );
}

/** Events main has pushed since the renderer started recording. */
function events(win) {
  return win.evaluate(() => window.__cfEvents.slice());
}

/** Page tabs in the pane, in strip order. Selected by VIEW, never by label. */
const pageTabs = (win) => win.locator('[data-pane-id] [data-view="page"]');

test.describe("R3 popups — an approved popup is an unfocused Progress Ledger tab, never an OS window", () => {
  let app;
  let win;
  let origin;

  test.beforeEach(async () => {
    origin = await startOrigin();
    ({ app, win } = await launch());
  });

  test.afterEach(async () => {
    try {
      await app?.close();
    } finally {
      await origin?.close();
    }
  });

  test("an approved popup becomes an UNFOCUSED tab, and the user's tab and trail are untouched", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, `${origin.origin}/probe`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R3 Popup Probe");
    await expect.poll(async () => (await snapshot(app)).pages.length).toBe(1);

    // --- What the user was looking at, BEFORE. ---
    const windowsBefore = await browserWindowCount(app);
    const contentsBefore = await webContentsCount(app);
    const tabsBefore = await pageTabs(win).count();
    const activeBefore = await win
      .locator('[data-pane-id] .tab-wrap.active [data-pane-tab]')
      .first()
      .getAttribute("data-pane-tab");
    expect(tabsBefore, "one page tab to start").toBe(1);

    // --- Trigger the popup from inside the page, under the test's control. ---
    const opened = await runInPage(app, 'window.__open("/landed");');
    expect(opened.ok, `could not drive the page: ${opened.reason}`).toBe(true);

    // --- MAIN created a second page, and it is NOT the one on screen. ---
    await expect.poll(async () => (await snapshot(app)).pages.length).toBe(2);
    const pages = (await snapshot(app)).pages;
    const popupPage = pages.find((p) => p.id !== pages[0].id);
    expect(popupPage, "the popup minted its own page id").toBeTruthy();
    expect(popupPage.visible, "the popup page is never put on screen by main").toBe(false);
    expect(popupPage.attached, "and is not even attached to the window").toBe(false);

    // --- NO OS WINDOW WAS CREATED. This is the invariant that matters most:
    //     the handler denies, and main substitutes its own page. ---
    expect(await browserWindowCount(app), "no second BrowserWindow").toBe(windowsBefore);
    // The popup's own webContents exists (it is a real page), but nothing else
    // was spawned.
    expect(await webContentsCount(app), "no stray webContents").toBe(contentsBefore + 1);

    // --- The shell gave it an UNFOCUSED tab. ---
    await expect.poll(async () => pageTabs(win).count(), { timeout: 10_000 }).toBe(tabsBefore + 1);
    const tabs = pageTabs(win);
    // The popup tab is the one APPENDED to the strip…
    const lastTab = tabs.nth((await tabs.count()) - 1);
    expect(
      await lastTab.getAttribute("aria-selected"),
      "the popup tab is in the background",
    ).toBe("false");
    // …and the tab the user was reading is STILL the active one.
    const activeAfter = await win
      .locator('[data-pane-id] .tab-wrap.active [data-pane-tab]')
      .first()
      .getAttribute("data-pane-tab");
    expect(activeAfter, "the user's tab stays active").toBe(activeBefore);
    expect(
      await win.locator('[data-pane-id] .tab-wrap.active').count(),
      "exactly one active tab",
    ).toBe(1);

    // --- The page that asked is still showing what it was showing. ---
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R3 Popup Probe");
  });

  test("the third popup in one page load is refused with popup-budget", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, `${origin.origin}/probe`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R3 Popup Probe");
    await expect.poll(async () => (await snapshot(app)).pages.length).toBe(1);

    // Three popups from the SAME page load. The first two are within budget and
    // become Progress Ledger tabs; the third is refused.
    for (let i = 0; i < 3; i += 1) {
      const opened = await runInPage(app, 'window.__open("/landed");');
      expect(opened.ok, `popup ${i + 1} could not be driven`).toBe(true);
    }

    // Exactly TWO popups are approved...
    await expect
      .poll(async () => (await events(win)).filter((e) => e.kind === "popup").length, {
        timeout: 20_000,
      })
      .toBe(2);
    await expect.poll(async () => (await snapshot(app)).pages.length).toBe(3);
    // ...and the THIRD is refused, by name.
    await expect
      .poll(
        async () =>
          (await events(win)).filter(
            (e) => e.at === "window-open" && e.reason === "popup-budget",
          ).length,
        { timeout: 20_000 },
      )
      .toBe(1);

    // No OS window, ever.
    expect(await browserWindowCount(app), "no second BrowserWindow").toBe(1);
    // The budget-refused popup created no page.
    expect((await snapshot(app)).pages.length, "a refused popup adds no page").toBe(3);
  });

  /**
   * MEASURED, NOT ASSUMED — which popup schemes reach the handler at all.
   *
   * Chromium itself stops some popup schemes before Electron's handler is
   * consulted. Measured on this host by driving each one from real page
   * content: `data:` and `progressLedger:` DO reach `setWindowOpenHandler`, while
   * `file:` and `view-source:` are stopped inside Chromium and produce no
   * Electron event at all.
   *
   * So this spec asserts on the schemes that actually reach the gate, and adds
   * an OUTCOME test for `file:` (no page created, no OS window) — because "the
   * page did not escape" is the real requirement, whichever layer enforced it.
   */
  test("forbidden popup schemes are refused by name at the window-open gate", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, `${origin.origin}/probe`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R3 Popup Probe");

    // --- data: reaches the handler and is refused. ---
    await navigateTo(win, `${origin.origin}/probe?program=open-data`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R3 Popup Probe");
    await expect
      .poll(
        async () =>
          (await events(win)).filter(
            (e) => e.at === "window-open" && e.scheme === "data:",
          ).length,
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    const dataRefusal = (await events(win)).find(
      (e) => e.at === "window-open" && e.scheme === "data:",
    );
    expect(dataRefusal.reason, "the refusal states why").toBe("blocked-scheme");

    // --- progressLedger: reaches the handler and is refused. ---
    await navigateTo(win, `${origin.origin}/probe?program=open-progressledger`);
    await expect
      .poll(
        async () =>
          (await events(win)).filter(
            (e) => e.at === "window-open" && e.scheme === "progressLedger:",
          ).length,
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    // Neither created a page, and no OS window ever appeared.
    expect((await snapshot(app)).pages.length, "forbidden popups add no page").toBe(1);
    expect(await browserWindowCount(app), "no OS window").toBe(1);
  });

  test("a file: popup never escapes, whichever layer stops it", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, `${origin.origin}/probe?program=open-file`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R3 Popup Probe");

    // Give Chromium every chance to do whatever it would do, then check the
    // OUTCOME rather than an event that provably does not fire for this scheme.
    await win.waitForTimeout(1500);

    // No page was created for it.
    expect((await snapshot(app)).pages.length, "a file: popup adds no page").toBe(1);
    // No OS window appeared.
    expect(await browserWindowCount(app), "no OS window").toBe(1);
    // And the page that asked is still on its own origin, not showing a file.
    const page = (await snapshot(app)).pages.at(-1);
    expect(page.url).toContain("127.0.0.1");
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R3 Popup Probe");
  });

  test("an https popup is APPROVED (the allowlist allows it) and still opens no OS window", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, `${origin.origin}/probe`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R3 Popup Probe");

    // https: is on the allow-list, so it is re-decided into a Progress Ledger tab —
    // which is the whole point of the budget: external links stay INSIDE the
    // product rather than launching the user's system browser.
    const opened = await runInPage(app, 'window.__open("https://example.com/");');
    expect(opened.ok, `could not drive the page: ${opened.reason}`).toBe(true);

    await expect
      .poll(async () => (await events(win)).filter((e) => e.kind === "popup").length, {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);
    const popup = (await events(win)).find((e) => e.kind === "popup");
    expect(popup.url).toBe("https://example.com/");

    await expect.poll(async () => (await snapshot(app)).pages.length).toBe(2);
    expect(await browserWindowCount(app), "no OS window").toBe(1);
    // The unfocused tab appeared.
    await expect.poll(async () => pageTabs(win).count(), { timeout: 10_000 }).toBe(2);
  });

  test("closing popups leaves no WebContentsView behind and the workspace stays consistent", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, `${origin.origin}/probe`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R3 Popup Probe");
    await expect.poll(async () => (await snapshot(app)).pages.length).toBe(1);

    // Two approved popups, both unfocused.
    for (let i = 0; i < 2; i += 1) {
      const opened = await runInPage(app, 'window.__open("/landed");');
      expect(opened.ok, `popup ${i + 1} could not be driven`).toBe(true);
    }
    await expect.poll(async () => (await snapshot(app)).pages.length).toBe(3);
    await expect.poll(async () => pageTabs(win).count(), { timeout: 10_000 }).toBe(3);

    const windowsBefore = await browserWindowCount(app);
    const contentsBefore = await webContentsCount(app);

    // Close the two popup tabs through the app's own tab close control. The tab
    // is selected by VIEW, never by the label "Web page", which is only a
    // placeholder until the page loads (Phase 2 settled rule).
    for (let i = 0; i < 2; i += 1) {
      await win
        .locator('[data-pane-id] .tab-wrap:has([data-view="page"]) .tab-close')
        .last()
        .click();
      await expect.poll(async () => pageTabs(win).count(), { timeout: 10_000 }).toBe(2 - i);
    }

    // Every popup page is gone, and no renderer process survived.
    await expect.poll(async () => (await snapshot(app)).pages.length).toBe(1);
    expect(await webContentsCount(app), "no leaked webContents").toBe(contentsBefore - 2);
    expect(await browserWindowCount(app), "no leaked window").toBe(windowsBefore);

    // The pane it all started in is still showing the original page.
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R3 Popup Probe");
    await expect(pageTabs(win), "exactly the original page tab remains").toHaveCount(1);
  });

  test("a popup whose page cannot be created is a stated refusal, not a crash", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);

    // Fill the pane to the live-page cap (4) with real pages, then ask for a
    // popup: the creation is refused and the app must survive and say so.
    await navigateTo(win, `${origin.origin}/probe`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R3 Popup Probe");
    const first = await runInPage(app, 'window.__open("/landed");');
    expect(first.ok, `could not drive the page: ${first.reason}`).toBe(true);
    await expect.poll(async () => (await snapshot(app)).pages.length).toBe(2);

    // Two more pages through the app's own bridge, taking us to the cap.
    for (let i = 0; i < 2; i += 1) {
      await win.evaluate(
        (url) => window.progressLedger.browser.createPage(1, url),
        `${origin.origin}/landed`,
      );
    }
    await expect.poll(async () => (await snapshot(app)).pages.length).toBe(4);

    // A further popup on the FIRST page cannot create a fifth page, so it is
    // refused with the registry's own reason.
    const blocked = await runInPage(app, 'window.__open("/landed");');
    expect(blocked.ok, `could not drive the page: ${blocked.reason}`).toBe(true);
    await expect
      .poll(
        async () =>
          (await events(win)).filter(
            (e) => e.at === "window-open" && e.kind === "blocked",
          ).length,
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    // The app is still alive and still governed.
    expect((await snapshot(app)).pages.length, "no page was created").toBe(4);
    expect(await browserWindowCount(app), "no OS window").toBe(1);
    await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();
  });

  test("Donut is completely absent and the popup policy still works", async () => {
    expect(existsSync(ABSENT_DONUT_DIR), "the Donut settings dir must not exist").toBe(false);
    const donut = await app.evaluate(() => ({
      stub: process.env.PROGRESSLEDGER_V2_E2E_DONUT_STUB ?? null,
      recorder: globalThis.__cfDonutE2E ?? null,
      settingsDir: process.env.PROGRESSLEDGER_V2_DONUT_SETTINGS_DIR ?? null,
    }));
    expect(donut.stub, "the Donut E2E stub must not be in play").toBe(null);
    expect(donut.recorder, "no Donut collaboration was installed").toBe(null);

    await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, `${origin.origin}/probe`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R3 Popup Probe");
    const opened = await runInPage(app, 'window.__open("/landed");');
    expect(opened.ok, `could not drive the page: ${opened.reason}`).toBe(true);
    await expect
      .poll(async () => (await events(win)).filter((e) => e.kind === "popup").length, {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);
    expect(await browserWindowCount(app), "no OS window").toBe(1);
    expect((await snapshot(app)).pages.length).toBe(2);
    await expect(pageTabs(win), "the popup got an unfocused tab").toHaveCount(2);
  });
});
