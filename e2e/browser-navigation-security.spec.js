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
 * R2 of the current roadmap — "Browser navigation and permission security".
 *
 * WHAT THIS SPEC PROVES, AND WHY IT CANNOT BE PROVEN IN jsdom.
 *
 * The scheme allowlist and the deny-by-default permission table are pure
 * decisions, and they ARE proven in plain Node (shell/tests/browser-policy.test.js,
 * browser-navigation.test.js, browser-permissions.test.js). What only a real
 * Chromium can answer is the other half of the same claim:
 *
 *   * that the gates are really installed on the real webContents BEFORE
 *     anything is loaded, so a page cannot outrun them;
 *   * that an actual navigation attempt from real page content is refused, and
 *     that the document it came from is still there afterwards;
 *   * that a real HTTP redirect to a forbidden scheme dies at `will-redirect`
 *     rather than at the next navigation;
 *   * that a real subframe gets the same allowlist;
 *   * that the real permission handlers answer real web-API requests
 *     (`Notification`, `geolocation`, `clipboard.readText`, `getUserMedia`,
 *     `requestFullscreen`) the way the table says;
 *   * that the renderer's own bridge cannot express a navigation or a
 *     permission grant the policy refuses.
 *
 * HOW THE EVIDENCE IS GATHERED. Page content reports what it can see from
 * INSIDE itself (`location.href` after the attempt), so "the navigation did not
 * happen" is a fact about the live document, not an inference. Main's refusals
 * are read from the app's own `browser:on-event` push — the same stream the
 * shell consumes. Nothing here mocks the browser.
 *
 * DONUT IS ABSENT FOR EVERY TEST IN THIS FILE, asserted at launch rather than
 * assumed. If the embedded browser ever grew a Donut dependency, this file
 * would fail — which is the mandatory independence property.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT COVER: downloads and popups (R3), crash
 * and recovery (R4).
 */

/** A directory guaranteed NOT to exist: Donut is "absent from the machine". */
const ABSENT_DONUT_DIR = join(
  tmpdir(),
  `cf-donut-absent-r2-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

/**
 * The page under test.
 *
 * `?program=` selects ONE thing the page does. Reports are per SLOT, each slot
 * reporting at most once, so one page can give a first answer and a second
 * answer later (that is how "nothing is remembered" is proven).
 *
 * The auto report for a navigation program is scheduled BEFORE the attempt: if
 * a hostile navigation were honoured, this document would be replaced and the
 * report would never arrive, so a missing report is a failure, not a false
 * pass.
 */
const PAGE_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>R2 Navigation Probe</title></head>
  <body>
    <h1 id="probe">r2 probe</h1>
    <script>
      (function () {
        var params = new URLSearchParams(location.search);
        var program = params.get("program") || "idle";
        var slots = {};

        function report(slot, extra) {
          if (slots[slot]) return;
          slots[slot] = true;
          var out = {
            program: program,
            slot: slot,
            href: String(location.href),
            title: String(document.title),
          };
          for (var k in (extra || {})) out[k] = extra[k];
          try {
            fetch("/report?d=" + encodeURIComponent(JSON.stringify(out)));
          } catch (e) {
            /* the assertion then fails on a missing report, which is honest */
          }
        }

        function later(ms, fn) { setTimeout(fn, ms); }

        function attempt(target) {
          try {
            location.replace(target);
          } catch (e) {
            report("auto", { threw: String(e) });
          }
        }

        // Programs that do ONE attempt and then say where they ended up. The
        // timer is registered before the attempt on purpose.
        var AUTO = program.indexOf("nav-") === 0 || program === "frames" ||
                   program.indexOf("open-") === 0;
        if (AUTO) later(1200, function () { report("auto", {}); });

        switch (program) {
          case "nav-file": attempt("file:///C:/Windows/win.ini"); break;
          case "nav-data": attempt("data:text/html,<h1>data%20escaped</h1>"); break;
          case "nav-blob": {
            // A REAL blob URL minted by this very page: the scheme is the point.
            try {
              var blob = new Blob(["<h1>blob escaped</h1>"], { type: "text/html" });
              attempt(URL.createObjectURL(blob));
            } catch (e) { report("auto", { threw: String(e) }); }
            break;
          }
          case "nav-view-source": attempt("view-source:https://example.com/"); break;
          case "nav-mailto": attempt("mailto:someone@example.invalid"); break;
          case "nav-progressledger": attempt("progressledger-v2://app/index.html"); break;
          case "nav-javascript": attempt("javascript:void(0)"); break;

          // window.open() is the broadest sweep available: it reaches
          // setWindowOpenHandler for MOST schemes (measured: data:, mailto:,
          // progressledger-v2:), whereas a page navigation is stopped inside Chromium
          // before any event fires for some of them. Both are page-initiated
          // and both must fail closed.
          case "open-mailto":
            try {
              window.open("mailto:someone@example.invalid", "_blank");
            } catch (e) { report("auto", { threw: String(e) }); }
            break;
          case "open-progressledger":
            try {
              window.open("progressledger-v2://app/index.html", "_blank");
            } catch (e) { report("auto", { threw: String(e) }); }
            break;
          case "open-data":
            try {
              window.open("data:text/html,<h1>data popup</h1>", "_blank");
            } catch (e) { report("auto", { threw: String(e) }); }
            break;

          case "frames":
            try {
              var bad = document.createElement("iframe");
              bad.id = "bad";
              bad.src = "data:text/html,<h1>data frame</h1>";
              var good = document.createElement("iframe");
              good.id = "good";
              good.src = "/frame-ok";
              document.body.appendChild(bad);
              document.body.appendChild(good);
            } catch (e) { report("auto", { threw: String(e) }); }
            break;

          case "permissions": {
            // Each permission is reported in its OWN slot, as soon as it
            // answers. One combined "all four" report would make a single
            // hanging API (geolocation waits on the handler) block the
            // evidence for the others, and a test should never have to guess
            // which half is missing.
            function permReport(name, value) {
              var o = {};
              o[name] = value;
              report("perm-" + name, { permissions: o });
            }
            try {
              Notification.requestPermission().then(
                function (r) { permReport("notifications", String(r)); },
                function (e) { permReport("notifications", "rejected:" + e.name); },
              );
            } catch (e) { permReport("notifications", "threw:" + e.name); }
            try {
              navigator.geolocation.getCurrentPosition(
                function () { permReport("geolocation", "granted"); },
                function (e) { permReport("geolocation", "code:" + e.code); },
              );
            } catch (e) { permReport("geolocation", "threw:" + e.name); }
            try {
              navigator.clipboard.readText().then(
                function () { permReport("clipboard-read", "granted"); },
                function (e) { permReport("clipboard-read", e.name); },
              );
            } catch (e) { permReport("clipboard-read", "threw:" + e.name); }
            try {
              navigator.mediaDevices.getUserMedia({ audio: true }).then(
                function (s) {
                  s.getTracks().forEach(function (t) { t.stop(); });
                  permReport("media", "granted");
                },
                function (e) { permReport("media", e.name); },
              );
            } catch (e) { permReport("media", "threw:" + e.name); }
            // A SECOND round of the same notifications request, so a silent
            // one-time grant would show up as "granted" here.
            later(900, function () {
              try {
                Notification.requestPermission().then(
                  function (r) { permReport("notifications-again", String(r)); },
                  function (e) { permReport("notifications-again", "rejected:" + e.name); },
                );
              } catch (e) {
                permReport("notifications-again", "threw:" + e.name);
              }
            });
            break;
          }

          case "fullscreen":
            // Fullscreen is the ONE focused-only capability in the table, and it
            // needs a real user gesture. The test supplies one by clicking the
            // native view at the rectangle main reported for it.
            document.addEventListener("click", function () {
              var el = document.documentElement;
              try {
                var p = el.requestFullscreen ? el.requestFullscreen() : null;
                if (p && p.then) {
                  p.then(
                    function () { report("fs", { fullscreen: "entered" }); },
                    function (e) { report("fs", { fullscreen: "rejected:" + e.name }); },
                  );
                } else {
                  report("fs", { fullscreen: "unavailable" });
                }
              } catch (e) { report("fs", { fullscreen: "threw:" + e.name }); }
            }, { once: true });
            // If the promise never settles, say so rather than timing out.
            later(6000, function () { report("fs", { fullscreen: "pending" }); });
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
    if (url.pathname === "/frame-ok") {
      // The frame itself reports, so a frame that really rendered is a fact.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><head><title>ok frame</title></head><body><h1>frame</h1><script>
          fetch("/report?d=" + encodeURIComponent(JSON.stringify({ program: "frame-ok" })));
        <\/script></body></html>`,
      );
      return;
    }
    if (url.pathname === "/redirect-ok") {
      res.writeHead(302, { location: "/landed" });
      res.end();
      return;
    }
    if (url.pathname === "/redirect-file") {
      res.writeHead(302, { location: "file:///C:/Windows/win.ini" });
      res.end();
      return;
    }
    if (url.pathname === "/redirect-data") {
      res.writeHead(302, { location: "data:text/html,<h1>redirect+escaped</h1>" });
      res.end();
      return;
    }
    if (url.pathname === "/redirect-javascript") {
      res.writeHead(302, { location: "javascript:alert(1)" });
      res.end();
      return;
    }
    if (url.pathname === "/redirect-mailto") {
      res.writeHead(302, { location: "mailto:someone@example.invalid" });
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
    if (url.pathname === "/plain") {
      // A plain page with no program, so it does nothing hostile: this is the
      // "the browser works" baseline every other leg starts from.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE_HTML);
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

/** A URL for the probe page on the one origin every leg uses. */
function programUrl(origin, program) {
  return `${origin}/probe?program=${encodeURIComponent(program)}`;
}

async function launch() {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-r2-"));
  const env = {
    ...process.env,
    PROGRESSLEDGER_V2_E2E: "1",
    PROGRESSLEDGER_V2_E2E_USER_DATA: userDataDir,
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

  // A real window resize, not a CDP device-metrics override (see the note in
  // browser-page.spec.js: the override would make the renderer's viewport and
  // the window's content area disagree, and this spec measures real geometry).
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) w.setContentSize(1600, 1000);
  });

  await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();

  // Record main's own push stream: every refusal, every denial. Installed AFTER
  // the boot reload so it is not wiped by it.
  await win.evaluate(() => {
    window.__cfEvents = [];
    window.progressLedger.browser.onEvent((event) => window.__cfEvents.push(event));
  });
  return { app, win };
}

/**
 * Seed one Progress Ledger profile through the app's own bridge, then select it
 * through the app's own profile card. The browser partition is derived from
 * this profile's id (approved decision B), so the id has to be a REAL row.
 */
async function seedAndSelectProfile(win) {
  const pid = await win.evaluate(async () => {
    const created = await window.progressLedger.profiles.add("R2 Security", "r2-security");
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

  await win.getByRole("button", { name: "Profiles", exact: true }).first().click();
  const card = win.locator("button.profile-main").first();
  await card.waitFor({ state: "visible", timeout: 10_000 });
  await card.click();
  // Wait for the HAND-OFF, not merely for a pane: opening a page tab into the
  // boot context would be a test bug that looks exactly like a product bug.
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

/** The pane's own way in to a browser surface: no rail item exists for it. */
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

/** The refusals and denials main has pushed to the shell so far. */
function blockedEvents(win) {
  return win.evaluate(() =>
    window.__cfEvents.filter((e) => e.kind === "blocked").map((e) => ({ ...e })),
  );
}

function deniedPermissions(win) {
  return win.evaluate(() =>
    window.__cfEvents.filter((e) => e.kind === "permission-denied").map((e) => ({ ...e })),
  );
}

/** The newest report for `program`, once that page has actually reported in. */
async function reportFor(origin, program, slot) {
  await expect
    .poll(
      () =>
        origin.reports.filter(
          (r) => r.program === program && (slot === undefined || r.slot === slot),
        ).length,
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  return origin.reports
    .filter((r) => r.program === program && (slot === undefined || r.slot === slot))
    .at(-1);
}

/** Find the browser page's real webContents and run code inside it. */
function runInPage(app, code) {
  return app.evaluate(
    async ({ webContents }, spec) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => String(w.getURL()).startsWith(spec.origin));
      if (!wc) return { ok: false, reason: "no-page-webcontents" };
      try {
        return { ok: true, value: await wc.executeJavaScript(spec.code) };
      } catch (e) {
        return { ok: false, reason: String(e?.message ?? e) };
      }
    },
    { code, origin: originRef.origin },
  );
}

/** Assert that Donut really is absent — the mandatory independence property. */
async function assertDonutAbsent(app) {
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
}

  /**
   * MEASURED, NOT ASSUMED — how the navigation API treats each route.
   *
   * Chromium stops `file:`, `data:`, `blob:`, `view-source:` and `javascript:`
   * page initiations INSIDE itself, before any Electron event fires. For those
   * there is no main-process refusal to observe: the proof that the page cannot
   * escape is that the DOCUMENT SURVIVES, still on its own origin, and that main
   * never recorded the new URL.
   *
   * `mailto:` and `progressledger-v2:` DO reach `will-frame-navigate`, and are covered
   * by the dedicated per-scheme tests below rather than here — because their
   * events are dispatched asynchronously and a shared loop would race them.
   *
   * `window.open()` is different again: it reaches `setWindowOpenHandler` for
   * every scheme, which is why the popup test is the broad sweep.
   */
  const IN_PAGE_ATTEMPTS = [
    ["nav-file", "file:", false],
    ["nav-data", "data:", false],
    ["nav-blob", "blob:", false],
    ["nav-view-source", "view-source:", false],
    ["nav-javascript", "javascript:", false],
  ];

/**
 * A stable reference to the loopback origin for the module-level `runInPage`
 * helper, which cannot reach a describe-scoped `origin`.
 */
let originRef = { origin: "http://127.0.0.1" };

test.describe("R2 navigation + permission security — embedded browser, Donut absent", () => {
  let app;
  let win;
  let origin;

  test.beforeEach(async () => {
    origin = await startOrigin();
    originRef = origin;
    ({ app, win } = await launch());
  });

  test.afterEach(async () => {
    try {
      await app?.close();
    } finally {
      await origin?.close();
    }
  });

  test("loads a real https origin, an http origin and about:blank — the allowed destinations keep working", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);

    // --- HTTPS: a REAL origin, loaded and rendered by the embedded browser. ---
    await navigateTo(win, "https://example.com");
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("Example Domain", {
      timeout: 30_000,
    });
    await expect(win.locator('[data-testid="browser-notice"]')).toHaveCount(0);
    // Main recorded an https URL, which only happens after the gate accepted it.
    expect((await snapshot(app)).pages.at(-1).url).toBe("https://example.com/");

    // --- HTTP on loopback: explicitly on the allow-list, marked insecure. ---
    await navigateTo(win, `${origin.origin}/plain`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R2 Navigation Probe");
    expect((await snapshot(app)).pages.at(-1).url).toBe(`${origin.origin}/plain`);

    // --- about:blank: the exact destination every page starts at. ---
    await navigateTo(win, "about:blank");
    await expect.poll(async () => (await snapshot(app)).pages.at(-1).url).toBe("about:blank");
    await expect(win.locator('[data-testid="browser-notice"]')).toHaveCount(0);

    // Nothing was refused on the way.
    expect((await blockedEvents(win)).length, "no navigation was refused").toBe(0);
  });

  test("the address bar refuses every forbidden scheme with a stated reason and leaves the page alone", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, `${origin.origin}/plain`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R2 Navigation Probe");
    const before = (await snapshot(app)).pages.at(-1).url;

    for (const [target, reason] of [
      ["javascript:alert(1)", "blocked-scheme"],
      ["file:///C:/Windows/win.ini", "blocked-scheme"],
      ["data:text/html,<h1>x</h1>", "blocked-scheme"],
      ["blob:https://example.com/abc", "blocked-scheme"],
      ["view-source:https://example.com/", "blocked-scheme"],
      ["mailto:someone@example.invalid", "blocked-scheme"],
      ["progressledger-v2://app/index.html", "blocked-scheme"],
    ]) {
      await navigateTo(win, target);
      // The user is TOLD, with the reason — a refusal is never a silent drop.
      await expect(win.locator('[data-testid="browser-notice"]')).toContainText(
        `Refused: ${reason}`,
      );
      // …and the page under the bar did not move off its own origin.
      const after = (await snapshot(app)).pages.at(-1).url;
      expect(after, `${target} must not navigate`).toBe(before);
    }
  });

  test("page content cannot navigate itself out of the policy — and the document survives the attempt", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);
    // Land on a real page first, so there IS a page record to compare against:
    // "New web page" only opens the surface, it does not create a page.
    await navigateTo(win, `${origin.origin}/plain`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R2 Navigation Probe");

    for (const [program, scheme, reachesGate] of IN_PAGE_ATTEMPTS) {
      await navigateTo(win, programUrl(origin.origin, program));

      // FIRST wait for the page's own report, which proves the attempt has been
      // MADE and has finished. Measured: some schemes' navigation event (a
      // blob: top-level navigation, a mailto: frame navigation) is dispatched
      // ASYNCHRONOUSLY, so checking the gate before the page reports would race
      // it and could attribute the previous leg's event to this one.
      const rep = await reportFor(origin, program, "auto");
      expect(rep.href.startsWith(origin.origin), `${program} escaped the origin`).toBe(true);
      expect(rep.href, `${program} shows where the page really ended up`).toContain(
        `program=${program}`,
      );
      expect(rep.threw, `${program} threw instead of being refused`).toBeUndefined();

      if (reachesGate) {
        // MAIN refused it, on the gate that catches frame navigation, and named
        // the scheme.
        await expect
          .poll(
            async () =>
              (await blockedEvents(win)).filter(
                (e) => e.at === "will-frame-navigate" && e.scheme === scheme,
              ).length,
            { timeout: 20_000 },
          )
          .toBeGreaterThan(0);
      }

      // Either way, main never recorded the hostile URL for this page.
      const after = (await snapshot(app)).pages.at(-1);
      expect(after.url.startsWith(origin.origin), `${program} left a foreign URL in main`).toBe(
        true,
      );
      expect(after.url, `${program} shows where main thinks the page is`).toContain(
        `program=${program}`,
      );
    }
  });

  /**
   * The two schemes that DO reach the navigation gate, each from a FRESH page
   * and a FRESH launch, so no earlier leg's late event can be mistaken for this
   * one's. Measured: `blob:`'s top-level navigation event can arrive a leg
   * later, so a loop that also asserted the event would be racing itself.
   * Splitting keeps the assertion unambiguous — this is the strongest form of
   * the claim, that MAIN refuses a page-initiated navigation to an unauthorized
   * scheme, and names the scheme and the page that asked.
   */
  for (const [program, scheme] of [
    ["nav-mailto", "mailto:"],
    ["nav-progressledger", "progressledger-v2:"],
  ]) {
    test(`a page navigating itself to ${scheme} is refused by name at the frame gate`, async () => {
      await seedAndSelectProfile(win);
      await openPageTab(win);
      await navigateTo(win, programUrl(origin.origin, program));


      await expect
        .poll(
          async () =>
            (await blockedEvents(win)).filter(
              (e) => e.at === "will-frame-navigate" && e.scheme === scheme,
            ).length,
          { timeout: 20_000 },
        )
        .toBeGreaterThan(0);

      const refusal = (await blockedEvents(win)).find(
        (e) => e.at === "will-frame-navigate" && e.scheme === scheme,
      );
      expect(refusal.reason, "the refusal states why").toBe("blocked-scheme");
      expect(refusal.pageId, "the refusal names the page that asked").toMatch(/^bp-\d+$/);

      // The document is still ours, on our origin.
      const rep = await reportFor(origin, program, "auto");
      expect(rep.href.startsWith(origin.origin)).toBe(true);
      expect((await snapshot(app)).pages.at(-1).url).toContain(`program=${program}`);
    });
  }

  test("window.open is denied for every scheme — no OS window is ever created", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);

    for (const [program, scheme] of [
      ["open-data", "data:"],
      ["open-mailto", "mailto:"],
      ["open-progressledger", "progressledger-v2:"],
    ]) {
      const before = (await blockedEvents(win)).length;
      await navigateTo(win, programUrl(origin.origin, program));
      // The popup handler denies it AND reports the scheme.
      await expect
        .poll(
          async () =>
            (await blockedEvents(win))
              .slice(before)
              .filter((e) => e.at === "window-open" && e.scheme === scheme).length,
          { timeout: 20_000 },
        )
        .toBeGreaterThan(0);
      // The document that asked is still the same one, on its own origin.
      const rep = await reportFor(origin, program, "auto");
      expect(rep.href.startsWith(origin.origin), `${program} escaped the origin`).toBe(true);
    }

    // No OS window was created at any point: the REAL BrowserWindow list, not
    // Playwright's page list (which also counts the WebContentsView).
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    expect(windows, "no second BrowserWindow").toBe(1);
  });

  test("redirects cannot escape the policy — and in-policy redirects still follow", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);

    // MEASURED, NOT ASSUMED: a server 302 to `file:` / `data:` is stopped
    // INSIDE Chromium before `will-redirect` is emitted (the navigation simply
    // fails), whereas a 302 to `mailto:` or `progressledger-v2:` IS dispatched and
    // therefore reaches the gate. So `mailto:` is the case that proves the
    // main-process `will-redirect` guard is really installed and bites, and
    // `file:`/`data:` are proven by "the page did not move".
    const REDIRECTS = [
      ["redirect-mailto", "mailto:", true],
      ["redirect-file", "file:", false],
      ["redirect-data", "data:", false],
    ];

    for (const [route, scheme, reachesGate] of REDIRECTS) {
      const before = (await blockedEvents(win)).length;
      await navigateTo(win, `${origin.origin}/${route}`);

      if (reachesGate) {
        await expect
          .poll(
            async () =>
              (await blockedEvents(win))
                .slice(before)
                .filter((e) => e.at === "will-redirect" && e.scheme === scheme).length,
            { timeout: 20_000 },
          )
          .toBeGreaterThan(0);
      }

      // Whatever Chromium did internally, the page is still OUR page on OUR
      // origin, and main never recorded the redirect target.
      const page = (await snapshot(app)).pages.at(-1);
      expect(page.url.startsWith(origin.origin), `${route} left the origin`).toBe(true);
      expect(page.url, `${route} stayed on the redirecting document`).toContain(`/${route}`);
      // No local file content and no mail client: main's URL record for this
      // page is the only address it ever had, and it is ours. A redirect that
      // had been honoured would have changed this string to file: or mailto:.
    }

    // --- A redirect to ANOTHER http destination is still followed. ---
    await navigateTo(win, `${origin.origin}/redirect-ok`);
    await expect
      .poll(async () => (await snapshot(app)).pages.at(-1).url, { timeout: 20_000 })
      .toContain("/landed");
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("landed");
  });

  test("a subframe gets the same allowlist as the main frame", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, programUrl(origin.origin, "frames"));

    // The data: subframe is refused at will-frame-navigate, naming the scheme.
    await expect
      .poll(
        async () =>
          (await blockedEvents(win)).filter(
            (e) => e.at === "will-frame-navigate" && e.scheme === "data:",
          ).length,
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    // The http subframe really rendered: it is the frame's own report that says
    // so, which is what makes "policy, not breakage" the conclusion.
    await expect
      .poll(() => origin.reports.filter((r) => r.program === "frame-ok").length, { timeout: 20_000 })
      .toBeGreaterThan(0);

    // And the document that asked is still on its own origin.
    expect((await snapshot(app)).pages.at(-1).url).toContain("program=frames");
    const rep = await reportFor(origin, "frames", "auto");
    expect(rep.href.startsWith(origin.origin)).toBe(true);
  });

  test("permissions are deny-by-default on the real session, and nothing is remembered", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, programUrl(origin.origin, "permissions"));

    // Real web APIs, asked from inside the page, answered by the real handlers.
    // NOTE the names: Electron's permission table calls `Notification`'s
    // "notifications", `getCurrentPosition`'s "geolocation", `clipboard.readText`'s
    // "clipboard-read" and `getUserMedia`'s "media" (one name for camera AND
    // microphone). The test asserts on the names Chromium actually asks about.
    const perm = async (name) => (await reportFor(origin, "permissions", `perm-${name}`)).permissions[name];
    expect(await perm("notifications"), "notifications are denied (no notification surface in v1)").toBe(
      "denied",
    );
    expect(await perm("geolocation"), "geolocation is denied (code 1 = PERMISSION_DENIED)").toBe(
      "code:1",
    );
    expect(await perm("clipboard-read"), "reading the clipboard is denied").not.toBe("granted");
    expect(await perm("media"), "camera/microphone are denied").not.toBe("granted");

    // Main reported every denial it made, by permission name.
    const denied = (await deniedPermissions(win)).map((e) => e.permission);
    for (const permission of ["notifications", "geolocation", "clipboard-read", "media"]) {
      expect(denied, `main must report denying ${permission}`).toContain(permission);
    }

    // A SECOND identical request is denied again: there is no remembered
    // one-time grant behind the scenes.
    const again = await perm("notifications-again");
    expect(again, "no persisted permission grant").toBe("denied");
  });

  /**
   * Fullscreen scoping, on the REAL page state.
   *
   * An honest scope note, measured on this host: `requestFullscreen()` driven
   * from an automated run does NOT reach Electron's permission handler here.
   * The click reaches the page — other permissions ARE requested from the same
   * page — but no fullscreen request is dispatched, because Chromium
   * additionally requires the document to be fullscreen-enabled with recorded
   * user activation. Asserting a denial event that never fires would be a
   * vacuous test, so this spec does not pretend one does.
   *
   * What it DOES prove, in the real app, is the state the decision is made
   * from — that main follows the page on and off screen as the workspace
   * changes — and the decision itself is proven against the very same
   * `isActiveFocusedPage` implementation in
   * `shell/tests/browser-permissions.test.js` ("the focused-only allow is
   * scoped BY CONTENTS…"), which is a plain-Node test of `host.js`'s own
   * function. Together: the rule is proven, and its input is proven live.
   */
  test("fullscreen is scoped to the page that is on screen", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, `${origin.origin}/plain`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R2 Navigation Probe");
    await expect.poll(async () => (await snapshot(app)).pages.length).toBe(1);

    // --- The page is on screen, which is exactly what the focused-only allow
    //     reads: no fullscreen denial exists for it. ---
    expect((await snapshot(app)).pages.at(-1).visible, "the page is on screen").toBe(true);
    expect(
      (await deniedPermissions(win)).filter((e) => e.permission === "fullscreen").length,
      "an on-screen page is never denied fullscreen",
    ).toBe(0);

    // --- Leaving the page's tab takes it OFF screen. The tab is selected by
    //     VIEW, never by the label "Web page", which is only a placeholder
    //     until the page loads (Phase 2 settled rule). ---
    await win.locator('[data-pane-id] .tab', { hasText: "Subjects" }).first().click();
    await expect
      .poll(async () => (await snapshot(app)).pages.at(-1).visible, { timeout: 10_000 })
      .toBe(false);

    // --- Returning to the page's tab puts it back on screen. ---
    await win.locator('[data-pane-id] [data-view="page"]').first().click();
    await expect
      .poll(async () => (await snapshot(app)).pages.at(-1).visible, { timeout: 10_000 })
      .toBe(true);

    // Still no denial, because the page is the on-screen one again.
    expect(
      (await deniedPermissions(win)).filter((e) => e.permission === "fullscreen").length,
      "an on-screen page is never denied fullscreen",
    ).toBe(0);
  });

  test("the renderer cannot bypass the navigation policy or grant itself a permission", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, `${origin.origin}/plain`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R2 Navigation Probe");
    const pagesBefore = await snapshot(app);
    const pageId = pagesBefore.pages.at(-1).id;
    const urlBefore = pagesBefore.pages.at(-1).url;
    const profileId = Number(pagesBefore.pages.at(-1).partition.match(/cf-browser-(\d+)/)[1]);
// V2-37: the create-page options object is strictly typed, so the partition
// digits (a string from the regex) must become a number first; a string id
// is refused as invalid-create-page before any URL check runs.

    // --- The bridge surface itself: pinned, so a channel that could grant a
    //     permission (or name a session/partition) cannot appear unnoticed. ---
    const surface = await win.evaluate(() => Object.keys(window.progressLedger.browser).sort());
    // Phase 3B surface (preload.cjs): profile management joined the bridge
    // (listProfiles, createProfile, updateProfile, deleteProfile,
    // duplicateProfile, clearProfileData, createTempProfile, testProxy,
    // setLiveCap, getLiveCap, ledgerCountForProfile, listTabs, navigation,
    // goBack, goForward). The list stays PINNED: any future addition still
    // fails here, and the permission/grant/session/partition name guard
    // below still runs on the same surface.
    expect(surface).toEqual(
      [
        "cancelDownload",
        "clearProfileData",
        "closePage",
        "createPage",
        "createProfile",
        "createTempProfile",
        "deleteProfile",
        "downloads",
        "duplicateProfile",
        "getLiveCap",
        "goBack",
        "goForward",
        "ledgerCountForProfile",
        "listProfiles",
        "listTabs",
        "navigate",
        "navigation",
        "onEvent",
        "reload",
        "setBounds",
        "setLiveCap",
        "setOccluded",
        "setVisible",
        "state",
        "testProxy",
        "updateProfile",
      ].sort(),
    );

    // --- Navigation refusals, asked through the app's own bridge. ---
    for (const target of [
      "javascript:alert(1)",
      "file:///C:/Windows/win.ini",
      "data:text/html,x",
      "blob:https://example.com/x",
      "view-source:https://example.com/",
      "progressledger-v2://app/index.html",
      "not-a-url",
    ]) {
      const res = await win.evaluate(
        (spec) => window.progressLedger.browser.navigate(spec.pageId, spec.url),
        { pageId, url: target },
      );
      expect(res.ok, `${target} must be refused`).toBe(false);
      expect(["invalid-url"], `${target} reason`).toContain(res.reason);
    }
    // A refused navigate left the page exactly where it was.
    expect((await snapshot(app)).pages.at(-1).url).toBe(urlBefore);

    // --- A page cannot be CREATED onto a forbidden destination either. ---
    const created = await win.evaluate(
      (spec) => window.progressLedger.browser.createPage({ profileId: spec.profileId, url: spec.url }),
      { profileId, url: "data:text/html,<h1>smuggled</h1>" },
    );
    expect(created.ok, "createPage must refuse the scheme").toBe(false);
    expect(created.reason).toBe("invalid-url");
    expect((await snapshot(app)).pages.length, "a refused create adds no page").toBe(1);

    // --- An opaque id is required: no page id, no operation. ---
    const unknown = await win.evaluate(
      (url) => window.progressLedger.browser.navigate("bp-999", url),
      "https://example.com",
    );
    expect(unknown.ok).toBe(false);
    expect(unknown.reason).toBe("unknown-page");

    // --- No channel grants a permission, and the renderer cannot name one. ---
    const permissionShaped = await win.evaluate(() =>
      Object.keys(window.progressLedger.browser).filter((k) =>
        /permission|grant|allow|session|partition/i.test(k),
      ),
    );
    expect(permissionShaped).toEqual([]);

    // …and a permission asked from inside the page is still denied: the renderer
    // has nothing it can hand itself to change that answer.
    const stillDenied = await runInPage(
      app,
      "new Promise(function (res) { navigator.geolocation.getCurrentPosition(" +
        "function () { res('granted'); }, function (e) { res('code:' + e.code); }); })",
    );
    expect(stillDenied.ok, `could not ask the page: ${stillDenied.reason}`).toBe(true);
    expect(stillDenied.value).toBe("code:1");
  });

  test("works with Donut completely absent — navigates and enforces the policy anyway", async () => {
    // Preconditions, asserted rather than assumed.
    await assertDonutAbsent(app);

    await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, `${origin.origin}/plain`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("R2 Navigation Probe");

    // It really rendered OUR page, from inside the embedded browser.
    expect(origin.reports.some((r) => r.title === "R2 Navigation Probe")).toBe(true);

    // …and the policy is still enforced with Donut gone.
    await navigateTo(win, "file:///C:/Windows/win.ini");
    await expect(win.locator('[data-testid="browser-notice"]')).toContainText("Refused:");
    expect((await snapshot(app)).pages.at(-1).url).toBe(`${origin.origin}/plain`);

    // A page-initiated attempt is refused too, and the document survives it.
    await navigateTo(win, programUrl(origin.origin, "nav-mailto"));
    await expect
      .poll(async () => (await blockedEvents(win)).length, { timeout: 20_000 })
      .toBeGreaterThan(0);
    const rep = await reportFor(origin, "nav-mailto", "auto");
    expect(rep.href.startsWith(origin.origin)).toBe(true);

    await assertDonutAbsent(app);
  });
});
