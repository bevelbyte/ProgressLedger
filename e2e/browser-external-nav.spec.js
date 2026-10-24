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
 * R3 of the current roadmap â€” "Downloads, popups and external navigation".
 *
 * THIS FILE IS THE EXTERNAL-NAVIGATION AND IPC HALF. It answers one question
 * from every angle the roadmap asks it: can page content, or a compromised
 * renderer, get the app to launch an OS application or open a URL outside
 * CareerFlow's own policy?
 *
 * WHAT IT PROVES IN THE REAL APP
 *   * the embedded browser exposes NO path to `shell.openExternal` â€” there is no
 *     IPC channel, no preload method and no DOM affordance for it;
 *   * every dangerous scheme is refused at the navigation gates (the R2 policy,
 *     reused unchanged, not re-implemented);
 *   * a redirect to a dangerous scheme cannot smuggle one past them;
 *   * a popup target cannot be used to reach a forbidden scheme;
 *   * the renderer cannot rename itself into a permission or an external opener;
 *   * the renderer's bridge surface is pinned, so a channel that could open an
 *     external application cannot appear unnoticed;
 *   * fabricated download ids and unknown page ids are refused.
 *
 * DONUT IS ABSENT FOR EVERY TEST, asserted at launch rather than assumed. This
 * is CareerFlow's own embedded browser: no Donut path is involved anywhere.
 */

/** A directory guaranteed NOT to exist: Donut is "absent from the machine". */
const ABSENT_DONUT_DIR = join(
  tmpdir(),
  `cf-donut-absent-r3ext-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

/** Schemes that must never be able to leave the app, and how a page asks. */
const EXTERNAL_SCHEMES = [
  ["mailto:", "mailto:someone@example.invalid"],
  ["tel:", "tel:+15551234567"],
  ["sms:", "sms:+15551234567"],
  ["magnet:", "magnet:?xt=urn:btih:abcdef"],
  ["javascript:", "javascript:alert(1)"],
  ["file:", "file:///C:/Windows/win.ini"],
  ["data:", "data:text/html,<h1>x</h1>"],
  ["blob:", "blob:https://example.com/x"],
  ["view-source:", "view-source:https://example.com/"],
  ["careerflow:", "careerflow://app/index.html"],
];

/** The bridge's exact public surface. A new key here is a new capability. */
const BROWSER_BRIDGE_KEYS = [
  "cancelDownload",
  "closePage",
  "createPage",
  "downloads",
  "navigate",
  "onEvent",
  "reload",
  "setBounds",
  "setOccluded",
  "setVisible",
  "state",
];

const PAGE_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>R3 External Probe</title></head>
  <body>
    <h1 id="probe">r3 external probe</h1>
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
        function attempt(target) {
          try { location.replace(target); } catch (e) { report("auto", { threw: String(e) }); }
        }
        var AUTO = program.indexOf("ext-") === 0;
        if (AUTO) later(1200, function () { report("auto", {}); });

        // window.__go(url) navigates the top-level document, which is the
        // broadest page-initiated navigation available.
        window.__go = function (url) { attempt(url); };
        // window.__open(url) opens a popup.
        window.__open = function (url) { try { window.open(url, "_blank"); } catch (e) {} };

        switch (program) {
          case "ext-anchor": {
            // A real <a> the user would click. Rendered so the DOM contains it.
            var a = document.createElement("a");
            a.id = "ext-link";
            a.href = "mailto:someone@example.invalid";
            a.textContent = "mail me";
            document.body.appendChild(a);
            report("auto", { anchor: "present" });
            break;
          }
          default:
            report("auto", { note: "idle" });
        }
      })();
    </script>
  </body>
</html>
`;

async function startOrigin() {
  const reports = [];
  const server = http.createServer((req, res) => {
    try {
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
      if (url.pathname === "/redirect-mailto") {
        res.writeHead(302, { location: "mailto:someone@example.invalid" });
        res.end();
        return;
      }
      if (url.pathname === "/redirect-tel") {
        res.writeHead(302, { location: "tel:+15551234567" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE_HTML);
    } catch {
      try {
        res.writeHead(500);
        res.end();
      } catch {
        /* socket already gone */
      }
    }
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
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-r3-ext-"));
  const env = {
    ...process.env,
    CAREERFLOW_E2E: "1",
    CAREERFLOW_E2E_USER_DATA: userDataDir,
    CAREERFLOW_DONUT_SETTINGS_DIR: ABSENT_DONUT_DIR,
  };
  delete env.CAREERFLOW_E2E_DONUT_STUB;
  delete env.CAREERFLOW_E2E_DONUT_MODE;

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

  await win.evaluate(() => localStorage.setItem("careerflow_onboarding_complete", "true"));
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();

  await win.evaluate(() => {
    window.__cfEvents = [];
    window.careerflow.browser.onEvent((event) => window.__cfEvents.push(event));
  });
  return { app, win, userDataDir };
}

async function seedAndSelectProfile(win) {
  const pid = await win.evaluate(async () => {
    const created = await window.careerflow.profiles.add("R3 External", "r3-external");
    const p = created?.profile || created;
    return p?.id ?? p?.profileId ?? (typeof created === "number" ? created : null);
  });
  expect(pid, `profile creation returned no id: ${JSON.stringify(pid)}`).not.toBe(null);

  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();
  await win.evaluate(() => {
    window.__cfEvents = [];
    window.careerflow.browser.onEvent((event) => window.__cfEvents.push(event));
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

async function openPageTab(win) {
  await openNewWebPage(win);
  await expect(win.locator('[data-testid="browser-surface"]')).toBeVisible();
}

async function navigateTo(scope, url) {
  await scope.locator('[data-testid="browser-address"]').fill(url);
  await scope.locator('[data-testid="browser-go"]').click();
}

function snapshot(app) {
  return app.evaluate(() => {
    const host = globalThis.__cfBrowserE2E;
    return host ? host.debugSnapshot() : null;
  });
}

function browserWindowCount(app) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

function webContentsCount(app) {
  return app.evaluate(({ webContents }) => webContents.getAllWebContents().length);
}

function events(win) {
  return win.evaluate(() => window.__cfEvents.slice());
}

function runInPage(app, code) {
  return app.evaluate(
    async ({ webContents }, spec) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => String(w.getURL()).includes("127.0.0.1"));
      if (!wc) return { ok: false, reason: "no-page-webcontents" };
      try {
        const value = await wc.executeJavaScript(spec.code);
        return { ok: true, value };
      } catch (e) {
        return { ok: false, reason: String(e?.message ?? e) };
      }
    },
    { code },
  );
}

test.describe("R3 external navigation â€” no page, popup, redirect or IPC path can open an OS application", () => {
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

  test("the embedded browser exposes NO path to shell.openExternal", async () => {
    // (a) The channels the embedded browser actually registered. `ipcMain`
    //      exposes no enumeration for `handle`, so the observable surface is the
    //      renderer's own bridge below; what IS assertable here is that nothing
    //      was registered for an external-open channel by the time the browser
    //      registrar ran.
    const allChannels = await app.evaluate(({ ipcMain }) =>
      ipcMain.eventNames().map((n) => String(n)).sort(),
    );
    expect(
      allChannels.filter((n) => /open-external|openExternal|external-open/i.test(n)),
      "no external-open IPC event exists",
    ).toEqual([]);

    // (b) The renderer's bridge has exactly the pinned surface: nothing that
    //     could open, grant, name a session or name a path.
    const surface = await win.evaluate(() => Object.keys(window.careerflow.browser).sort());
    expect(surface).toEqual([...BROWSER_BRIDGE_KEYS].sort());

    // (c) No method on that surface could open, launch or exec anything.
    const opens = await win.evaluate(() =>
      Object.keys(window.careerflow.browser).filter((k) =>
        /open|external|launch|exec|spawn/i.test(k),
      ),
    );
    expect(opens, "nothing on the bridge can open an external target").toEqual([]);

    // (d) No preload method anywhere in the renderer's namespace does it either.
    const anyExternal = await win.evaluate(() => {
      const cf = window.careerflow ?? {};
      return Object.keys(cf).filter((k) => /openExternal|openexternal/i.test(k));
    });
    expect(anyExternal).toEqual([]);

    // (e) The whole bridge surface â€” every namespace, not just `browser` â€” is
    //     checked, so a NEW top-level opener cannot be missed either.
    const topLevel = await win.evaluate(() =>
      Object.keys(window.careerflow ?? {}).filter((k) =>
        /openExternal|openexternal|launchExternal/i.test(k),
      ),
    );
    expect(topLevel).toEqual([]);
  });

  test("every dangerous scheme is refused when a page navigates to it", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, `${origin.origin}/probe`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R3 External Probe");

    for (const [scheme, url] of EXTERNAL_SCHEMES) {
      const before = (await snapshot(app)).pages.at(-1).url;
      const driven = await runInPage(app, `window.__go(${JSON.stringify(url)});`);
      expect(driven.ok, `could not drive the page for ${scheme}`).toBe(true);

      // The page did not move, and main never recorded the foreign URL. That is
      // the observable invariant regardless of which layer stopped it.
      const after = (await snapshot(app)).pages.at(-1).url;
      expect(after, `${scheme} must not navigate`).toBe(before);
      expect(after).toContain("127.0.0.1");
    }

    // No OS window, and the app is still alive.
    expect(await browserWindowCount(app), "no OS window").toBe(1);
    await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();
    // The page that made all those attempts is STILL our page.
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R3 External Probe");
  });

  test("a redirect to a dangerous scheme cannot smuggle one past the gates", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);

    // A 302 straight to mailto: â€” measured in R2, this DOES reach will-redirect.
    await navigateTo(win, `${origin.origin}/redirect-mailto`);
    await expect
      .poll(
        async () =>
          (await events(win)).filter(
            (e) => e.at === "will-redirect" && e.scheme === "mailto:",
          ).length,
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    const page = (await snapshot(app)).pages.at(-1);
    expect(page.url, "the redirect target was never recorded").toContain(
      "/redirect-mailto",
    );

    // A 302 to tel:.
    await navigateTo(win, `${origin.origin}/redirect-tel`);
    await expect
      .poll(
        async () =>
          (await events(win)).filter(
            (e) => e.at === "will-redirect" && e.scheme === "tel:",
          ).length,
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    expect(await browserWindowCount(app), "no OS window").toBe(1);
    // Still on our origin, never on the handler.
    expect((await snapshot(app)).pages.at(-1).url).toContain("127.0.0.1");
  });

  test("a popup target cannot reach a forbidden scheme either", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, `${origin.origin}/probe`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R3 External Probe");

    // mailto: via window.open reaches the handler and is refused by name.
    const driven = await runInPage(app, 'window.__open("mailto:someone@example.invalid");');
    expect(driven.ok, `could not drive the page: ${driven.reason}`).toBe(true);
    await expect
      .poll(
        async () =>
          (await events(win)).filter(
            (e) => e.at === "window-open" && e.scheme === "mailto:",
          ).length,
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    const refusal = (await events(win)).find(
      (e) => e.at === "window-open" && e.scheme === "mailto:",
    );
    expect(refusal.reason, "the refusal states why").toBe("blocked-scheme");

    // No page was created for it, and no OS window appeared.
    expect((await snapshot(app)).pages.length, "a forbidden popup adds no page").toBe(1);
    expect(await browserWindowCount(app), "no OS window").toBe(1);
  });

  test("a real <a href=mailto:> in the page cannot launch a mail client", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, `${origin.origin}/probe?program=ext-anchor`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R3 External Probe");

    // The link really exists in the document â€” this is a real user-click
    // surface, not a scripted navigation.
    const anchor = await runInPage(
      app,
      '(() => { const a = document.getElementById("ext-link"); if (!a) return null; const r = a.getBoundingClientRect(); return { href: a.href, x: r.x, y: r.y, width: r.width, height: r.height, tagName: a.tagName }; })();',
    );
    expect(anchor.ok, `could not inspect the page anchor: ${anchor.reason}`).toBe(true);
    expect(anchor.value, "the actual anchor exists and has geometry").toMatchObject({ tagName: "A" });
    expect(anchor.value.href).toBe("mailto:someone@example.invalid");
    expect(anchor.value.width).toBeGreaterThan(0);
    expect(anchor.value.height).toBeGreaterThan(0);

    // WebContentsView bounds are in the BrowserWindow content coordinate space;
    // the anchor rect is in that view's own viewport coordinate space. Translate
    // the anchor's center by the actual native view origin rather than clicking
    // an assumed point such as the view center.
    const page = (await snapshot(app)).pages.at(-1);
    expect(page.actualBounds, "main placed the view at a real rectangle").toBeTruthy();
    expect(page.attached, "the view is attached to the BrowserWindow contentView").toBe(true);
    expect(page.visible, "the view is visible for native input").toBe(true);
    const b = page.actualBounds;
    const clickX = b.x + anchor.value.x + anchor.value.width / 2;
    const clickY = b.y + anchor.value.y + anchor.value.height / 2;
    expect(clickX).toBeGreaterThanOrEqual(b.x);
    expect(clickX).toBeLessThan(b.x + b.width);
    expect(clickY).toBeGreaterThanOrEqual(b.y);
    expect(clickY).toBeLessThan(b.y + b.height);
    const clickProbe = await runInPage(
      app,
      '(() => { document.addEventListener("click", e => { const a = e.target.closest("#ext-link"); fetch("/report?d=" + encodeURIComponent(JSON.stringify({ program: "ext-anchor", slot: "native-click", isTrusted: e.isTrusted, targetId: a?.id ?? null, targetTag: e.target?.tagName ?? null, href: a?.href ?? null, x: e.clientX, y: e.clientY }))).catch(() => {}); }, { capture: true, once: true }); return true; })();',
    );
    expect(clickProbe.ok && clickProbe.value, "the page click observer was installed").toBe(true);
    const navigationTraceInstalled = await app.evaluate(({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => String(w.getURL()).includes("/probe?program=ext-anchor"));
      if (!wc) return false;
      globalThis.__cfD22NavigationTrace = [];
      for (const name of ["will-navigate", "will-redirect", "will-frame-navigate", "did-start-navigation", "will-prevent-unload"]) {
        wc.on(name, (_event, url, isInPlace, isMainFrame) => globalThis.__cfD22NavigationTrace.push({ name, url: String(url ?? ""), isInPlace: Boolean(isInPlace), isMainFrame: Boolean(isMainFrame) }));
      }
      return true;
    });
    expect(navigationTraceInstalled).toBe(true);
    // Playwright's app-window mouse API has repeatedly failed to dispatch into
    // this native WebContentsView on this host. Use Electron's supported
    // WebContents input API as a second, independently observable delivery path
    // to the actual page WebContents. This is still the real Electron page and
    // real production navigation policy; it does not mock the policy or invoke
    // the policy handler directly. Keep the OS-window mouse attempt as the first
    // experiment, then fall back only if no page-side click report arrives.
    await win.mouse.click(clickX, clickY);
    try {
      await expect.poll(() => origin.reports.some((r) => r.slot === "native-click"), { timeout: 1_000 }).toBe(true);
    } catch {
      const delivered = await app.evaluate(({ webContents }, spec) => {
        const wc = webContents.getAllWebContents().find((w) => String(w.getURL()).includes("/probe?program=ext-anchor"));
        if (!wc) return { ok: false, reason: "no-page-webcontents" };
        try {
          wc.sendInputEvent({ type: "mouseDown", x: spec.x, y: spec.y, button: "left", clickCount: 1 });
          wc.sendInputEvent({ type: "mouseUp", x: spec.x, y: spec.y, button: "left", clickCount: 1 });
          return { ok: true };
        } catch (error) { return { ok: false, reason: String(error?.message ?? error) }; }
      }, { x: anchor.value.x + anchor.value.width / 2, y: anchor.value.y + anchor.value.height / 2 });
      expect(delivered.ok, `Electron sendInputEvent delivery failed: ${delivered.reason}`).toBe(true);
    }
    await expect.poll(() => origin.reports.some((r) => r.slot === "native-click"), { timeout: 5_000 }).toBe(true);
    const nativeClick = origin.reports.find((r) => r.slot === "native-click");
    expect(nativeClick.isTrusted, "the click was a trusted native user gesture").toBe(true);
    expect(nativeClick.targetId, "the click hit the actual mailto anchor").toBe("ext-link");
    expect(nativeClick.href).toBe("mailto:someone@example.invalid");

    // A real click must reach the page's mailto anchor and be refused by the
    // installed main-process navigation policy, not merely leave the app alive.
    await win.waitForTimeout(500);
    const navigationTrace = await app.evaluate(() => globalThis.__cfD22NavigationTrace ?? []);
    const browserEvents = await events(win);
    const blockedEvent = browserEvents.some(
      (e) => e.kind === "blocked" && ["will-navigate", "will-frame-navigate"].includes(e.at) && e.scheme === "mailto:" && e.reason === "blocked-scheme",
    );
    expect(blockedEvent, `Main-process refusal was not observed; Electron navigation trace: ${JSON.stringify(navigationTrace)}; browser events: ${JSON.stringify(browserEvents.filter((e) => e.kind === "blocked"))}`).toBe(true);

    // Nothing left the app, and the page is still ours.
    expect(await browserWindowCount(app), "no OS window").toBe(1);
    expect((await snapshot(app)).pages.at(-1).url).toContain("127.0.0.1");
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R3 External Probe");
  });

  test("the renderer cannot steer a page or fabricate a download id", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, `${origin.origin}/probe`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R3 External Probe");
    const pageId = (await snapshot(app)).pages.at(-1).id;
    const urlBefore = (await snapshot(app)).pages.at(-1).url;

    // Every hostile URL through the app's own navigation bridge.
    for (const [, url] of EXTERNAL_SCHEMES) {
      const res = await win.evaluate(
        (spec) => window.careerflow.browser.navigate(spec.pageId, spec.url),
        { pageId, url },
      );
      expect(res.ok, `${url} must be refused`).toBe(false);
      expect(["invalid-url"]).toContain(res.reason);
    }
    expect((await snapshot(app)).pages.at(-1).url, "the page never moved").toBe(urlBefore);

    // Fabricated download ids through the app's own cancel bridge.
    for (const bogus of ["dl-99999", "..", "", "dl-1;rm -rf"]) {
      const res = await win.evaluate(
        (id) => window.careerflow.browser.cancelDownload(id),
        bogus,
      );
      expect(res.ok, `${JSON.stringify(bogus)} must not be accepted`).toBe(false);
      expect(res.reason).toBe("unknown-download");
    }

    // A page id that does not exist cannot be operated on.
    const unknown = await win.evaluate(
      (url) => window.careerflow.browser.navigate("bp-99999", url),
      "https://example.com",
    );
    expect(unknown.ok).toBe(false);
    expect(unknown.reason).toBe("unknown-page");

    // And the renderer cannot name a download's path: the only strings it gets
    // are the opaque id and the safe base name.
    const downloads = await win.evaluate(() => window.careerflow.browser.downloads());
    for (const d of downloads.downloads ?? []) {
      expect(Object.keys(d).sort()).toEqual(
        [
          "filename",
          "finishedAt",
          "id",
          "reason",
          "receivedBytes",
          "startedAt",
          "state",
          "totalBytes",
          "url",
        ].sort(),
      );
      expect(d.filename).not.toContain("\\");
      expect(d.filename).not.toContain("/");
    }
    expect(JSON.stringify(downloads)).not.toContain("C:\\");
    expect(JSON.stringify(downloads)).not.toContain("/downloads/");
  });

  test("the app has not opened any OS application, and Donut is still absent", async () => {
    expect(existsSync(ABSENT_DONUT_DIR), "the Donut settings dir must not exist").toBe(false);

    await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, `${origin.origin}/probe`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R3 External Probe");

    // The strongest observable proxies for "nothing was launched":
    //   * no event claims an external open;
    //   * exactly one OS-level BrowserWindow;
    //   * no extra renderer process.
    // (Electron exposes no portable child-process count from a test harness, so
    // a direct process census is not available; these three are.)
    const openedEvents = (await events(win)).filter((e) =>
      /open|external|launch/i.test(String(e.kind)),
    );
    expect(openedEvents, "no event claims an external open").toEqual([]);
    expect(await browserWindowCount(app), "no OS window").toBe(1);
    expect(await webContentsCount(app), "no extra renderer process").toBeLessThanOrEqual(3);

    const donut = await app.evaluate(() => ({
      stub: process.env.CAREERFLOW_E2E_DONUT_STUB ?? null,
      recorder: globalThis.__cfDonutE2E ?? null,
    }));
    expect(donut.stub).toBe(null);
    expect(donut.recorder).toBe(null);
  });
});
