import { test, expect, _electron as electron } from "@playwright/test";
import { openNewWebPage } from "./helpers/browser-page-ui.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * R1 of the current roadmap — "Browser session/profile isolation".
 *
 * WHAT THIS SPEC PROVES, AND WHY IT CANNOT BE PROVEN IN jsdom.
 *
 * Approved decision B settled the model: ONE persistent browser partition per
 * CareerFlow PROFILE, derived in the MAIN process from the profile id
 * (`services/browser/policy.js: partitionFor`), and workspace contexts map to NO
 * browser storage at all. The unit suites (`shell/tests/browser-policy.test.js`,
 * `browser-registry.test.js`) prove the pure decisions — that `partitionFor(7)`
 * is `persist:cf-browser-7`, that junk never mints a partition, that the
 * renderer-visible page shape carries no partition. They cannot prove that two
 * REAL Electron profiles actually end up with separate cookies and separate
 * localStorage, or that a profile's browser state is still there after the app
 * is restarted. Only a real Chromium can answer those, so this file asks it.
 *
 * HOW ISOLATION IS MEASURED. The app loads a page from a loopback origin served
 * by this test process (http on loopback is on the allow-list). That page writes
 * a cookie and a localStorage entry when told to, and ALWAYS reports back what
 * `document.cookie` and `localStorage` currently show FROM INSIDE the page — the
 * same origin in every leg, so a shared partition would be a visible, not a
 * theoretical, leak. Every assertion is made against what the page actually
 * executed, never against a mock of it.
 *
 * DONUT IS ABSENT FOR EVERY TEST IN THIS FILE (asserted at launch, not assumed):
 * a settings directory that does not exist and no hermetic stub. If the embedded
 * browser ever grew a Donut dependency, this file would fail — that is the
 * mandatory independence property of R1, and the full Phase 1 acceptance path is
 * re-run separately by `e2e/browser-page.spec.js`.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT COVER: the navigation/permission refusal
 * matrix (R2), downloads and popups (R3), crash recovery (R4). Those are later
 * roadmap phases.
 */

/** A directory guaranteed NOT to exist: Donut is "absent from the machine". */
const ABSENT_DONUT_DIR = join(
  tmpdir(),
  `cf-donut-absent-r1-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

/**
 * The probe page. `?write=<value>` sets a cookie and a localStorage entry FIRST
 * and then reads them back, so the writing page proves its own write landed;
 * without `?write` it only reads, which is what proves what ANOTHER profile can
 * and cannot see. `?tag=<id>` labels the report so concurrent pages in one run
 * can be told apart.
 */
const PROBE_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>CF Isolation Probe</title></head>
  <body>
    <h1 id="probe">isolation probe</h1>
    <script>
      (function () {
        var params = new URLSearchParams(location.search);
        var write = params.get("write");
        if (write !== null) {
          document.cookie = "cf_probe=" + encodeURIComponent(write) + "; path=/; max-age=86400";
          try { localStorage.setItem("cf_probe", write); } catch (e) { /* reported below */ }
        }
        var ls;
        try {
          ls = localStorage.getItem("cf_probe");
        } catch (e) {
          ls = "threw:" + e.message;
        }
        var out = {
          tag: params.get("tag") || "read",
          origin: String(location.origin),
          cookie: String(document.cookie),
          ls: ls,
        };
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

/** A throwaway loopback origin plus the log of what pages reported from inside. */
async function startOrigin() {
  const reports = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/report") {
      try {
        reports.push(JSON.parse(url.searchParams.get("d") ?? "{}"));
      } catch {
        reports.push({ tag: "unparseable" });
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

/** A URL on the one origin every leg uses. `write === undefined` means read-only. */
function stateUrl(origin, tag, write) {
  const base = `${origin}/state?tag=${encodeURIComponent(tag)}`;
  return write === undefined ? base : `${base}&write=${encodeURIComponent(write)}`;
}

/**
 * Launch the real app against a SPECIFIC user-data dir.
 *
 * Both `--user-data-dir` (Chromium's profile dir, so `Partitions/<name>` is
 * stable) and `CAREERFLOW_E2E_USER_DATA` (Electron's `app.getPath("userData")`,
 * where the workspace DB lives) point at the SAME directory, which is what makes
 * "relaunch with the same dir" a genuine restart of ONE CareerFlow install
 * rather than a fresh one with a coincidentally equal partition name.
 */
async function launch(userDataDir) {
  const env = {
    ...process.env,
    CAREERFLOW_E2E: "1",
    CAREERFLOW_E2E_USER_DATA: userDataDir,
    // Donut absent: no stub, and a settings directory that is not there.
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
  await win.evaluate(() => localStorage.setItem("careerflow_onboarding_complete", "true"));
  await reloadShell(win);

  // Donut really is absent, asserted rather than assumed: the settings directory
  // does not exist, no stub was injected, and no collaboration recorder exists.
  expect(existsSync(ABSENT_DONUT_DIR), "the Donut settings dir must not exist").toBe(false);
  const donut = await app.evaluate(() => ({
    settingsDir: process.env.CAREERFLOW_DONUT_SETTINGS_DIR ?? null,
    stub: process.env.CAREERFLOW_E2E_DONUT_STUB ?? null,
    recorder: globalThis.__cfDonutE2E ?? null,
  }));
  expect(donut.settingsDir).toBe(ABSENT_DONUT_DIR);
  expect(donut.stub, "the Donut E2E stub must not be in play").toBe(null);
  expect(donut.recorder, "no Donut collaboration was installed").toBe(null);
  return { app, win };
}

async function reloadShell(win) {
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();
}

/**
 * Seed one CareerFlow profile through the app's own bridge. The browser
 * partition is derived from this profile's id, so the id has to be a REAL row in
 * the local database — which is also what the `browser:create-page` ownership
 * gate checks before any partition is minted.
 */
async function addProfile(win, name) {
  const id = await win.evaluate(async (profileName) => {
    const slug = profileName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const created = await window.careerflow.profiles.add(profileName, slug);
    const p = created?.profile || created;
    return p?.id ?? p?.profileId ?? (typeof created === "number" ? created : null);
  }, name);
  expect(id, `profile creation returned no id: ${JSON.stringify(id)}`).not.toBe(null);
  return Number(id);
}

/**
 * Create a page in a SPECIFIC profile's partition. This is the app's own browser
 * bridge, not a test-only seam: the address bar cannot express "a page for a
 * non-active profile", and R1 requires two profiles to be live at once.
 */
async function createPage(win, profileId, url) {
  const res = await win.evaluate(
    (spec) => window.careerflow.browser.createPage(spec.profileId, spec.url),
    { profileId, url },
  );
  expect(res?.ok, `createPage refused: ${JSON.stringify(res)}`).toBe(true);
  return res.page;
}

async function goto(win, pageId, url) {
  const res = await win.evaluate(
    (spec) => window.careerflow.browser.navigate(spec.pageId, spec.url),
    { pageId, url },
  );
  expect(res?.ok, `navigate refused: ${JSON.stringify(res)}`).toBe(true);
}

/** The newest report for `tag`, once the page has actually reported in. */
async function report(origin, tag) {
  await expect
    .poll(() => origin.reports.filter((r) => r.tag === tag).length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  return origin.reports.filter((r) => r.tag === tag).at(-1);
}

/**
 * What a page could see of its own origin's storage. `cookie: null` is meaningfully
 * different from `cookie: <value>`: it is the difference between two profiles
 * sharing a browser identity and two profiles not sharing one.
 */
function probe(rep) {
  const match = /(?:^|;\s*)cf_probe=([^;]*)/.exec(String(rep?.cookie ?? ""));
  return {
    cookie: match ? decodeURIComponent(match[1]) : null,
    ls: rep?.ls ?? null,
  };
}

/**
 * Chromium keeps a `persist:` partition ON DISK at `<userData>/Partitions/<name>`
 * (the `persist:` prefix is dropped from the directory name). Asserting this
 * turns "the state came back" into "the state came back FROM THIS INSTALL": if
 * `--user-data-dir` were ignored, the storage would live in the developer's real
 * profile and the isolation evidence below would be worthless.
 */
function partitionDirNames(userDataDir) {
  try {
    return readdirSync(join(userDataDir, "Partitions"));
  } catch {
    return [];
  }
}

/** Main-process truth, installed only in E2E runs (`shell/src/ipc/browser.js`). */
function snapshot(app) {
  return app.evaluate(() => {
    const host = globalThis.__cfBrowserE2E;
    return host ? host.debugSnapshot() : null;
  });
}

/** Select a profile through the app's own profile card, and wait for the hand-off. */
async function selectProfileThroughUi(win) {
  await win.locator('button.nav-item:has-text("Profiles")').first().click();
  const card = win.locator("button.profile-main").first();
  await card.waitFor({ state: "visible", timeout: 10_000 });
  await card.click();
  // Wait for the HAND-OFF, not merely for a pane: the boot context already has a
  // pane, and opening a page into it would put the page in the wrong context —
  // a test bug that looks exactly like a product bug.
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
}

/** The pane's own way in to a browser surface (`New web page`); no rail item exists. */
async function openPageTab(win) {
  await openNewWebPage(win);
  await expect(win.locator('[data-testid="browser-surface"]')).toBeVisible();
}

async function navigateTo(scope, url) {
  await scope.locator('[data-testid="browser-address"]').fill(url);
  await scope.locator('[data-testid="browser-go"]').click();
}

const activeContextName = (win) =>
  win.evaluate(() => {
    const el = document.querySelector(".ctx-chip-wrap.active .ctx-chip");
    return el ? el.textContent.replace(/\s+/g, " ").trim() : null;
  });

test.describe("R1 browser session/profile isolation — CareerFlow-owned browser, Donut absent", () => {
  let origin;

  test.beforeEach(async () => {
    origin = await startOrigin();
  });

  test.afterEach(async () => {
    await origin?.close();
  });

  test("profile A's cookie and localStorage are invisible to profile B — and A keeps its own", async () => {
    const { app, win } = await launch(mkdtempSync(join(tmpdir(), "cf-r1-iso-")));
    try {
      const a = await addProfile(win, "R1 Isolation A");
      const b = await addProfile(win, "R1 Isolation B");
      expect(a, "the two profiles must be different profiles").not.toBe(b);

      // --- Profile A writes a unique cookie + localStorage entry. ---
      const pageA = await createPage(win, a, stateUrl(origin.origin, "a-write", "alpha"));
      const written = await report(origin, "a-write");
      expect(written.origin, "both legs must be the SAME origin").toBe(origin.origin);
      expect(probe(written), "A must see its own write").toEqual({
        cookie: "alpha",
        ls: "alpha",
      });

      // --- Profile B loads the same origin and must see NOTHING. ---
      await createPage(win, b, stateUrl(origin.origin, "b-read"));
      expect(
        probe(await report(origin, "b-read")),
        "profile B must see no trace of profile A's cookie or localStorage",
      ).toEqual({ cookie: null, ls: null });

      // --- …and A still sees its own state: isolation, not a lost write. ---
      await goto(win, pageA.id, stateUrl(origin.origin, "a-read"));
      expect(probe(await report(origin, "a-read"))).toEqual({ cookie: "alpha", ls: "alpha" });

      // --- Two profiles ARE two storage boundaries, each named from its own id. ---
      const pages = (await snapshot(app)).pages;
      expect(pages.length, "both pages are live at once").toBe(2);
      expect(new Set(pages.map((p) => p.partition)).size).toBe(2);
      expect(pages.map((p) => p.partition).sort()).toEqual(
        [`persist:cf-browser-${a}`, `persist:cf-browser-${b}`].sort(),
      );

      // --- The renderer cannot mint, name or steer a partition. ---
      // The ownership gate: an id that is not a real CareerFlow profile gets no
      // partition and no page…
      const unknown = await win.evaluate(() =>
        window.careerflow.browser.createPage(999999, "about:blank"),
      );
      expect(unknown.ok).toBe(false);
      expect(unknown.reason).toBe("unknown-profile");
      // …and neither does a supply that tries to LOOK like a partition name. The
      // bridge has no partition parameter at all, so this can only ever be read
      // as a profile id, and it is not one.
      const steered = await win.evaluate(() =>
        window.careerflow.browser.createPage("1;persist:cf-browser-2", "about:blank"),
      );
      expect(steered.ok).toBe(false);
      expect(steered.reason).toBe("unknown-profile");
      expect((await snapshot(app)).pages.length, "a refused create must add no page").toBe(2);
    } finally {
      await app.close();
    }
  });

  test("profile B's cookie and localStorage are invisible to profile A — the reverse direction", async () => {
    const { app, win } = await launch(mkdtempSync(join(tmpdir(), "cf-r1-rev-")));
    try {
      const a = await addProfile(win, "R1 Reverse A");
      const b = await addProfile(win, "R1 Reverse B");

      // A browses FIRST and sees an empty origin, so the reverse direction cannot
      // be an artifact of creation order.
      const pageA = await createPage(win, a, stateUrl(origin.origin, "a-first"));
      expect(probe(await report(origin, "a-first"))).toEqual({ cookie: null, ls: null });

      // --- Profile B now writes its own unique state. ---
      const pageB = await createPage(win, b, stateUrl(origin.origin, "b-write", "beta"));
      expect(probe(await report(origin, "b-write"))).toEqual({ cookie: "beta", ls: "beta" });

      // --- A is asked to look again and must still see nothing… ---
      await goto(win, pageA.id, stateUrl(origin.origin, "a-read"));
      expect(
        probe(await report(origin, "a-read")),
        "profile A must see no trace of profile B's cookie or localStorage",
      ).toEqual({ cookie: null, ls: null });

      // --- …while B keeps its own. ---
      await goto(win, pageB.id, stateUrl(origin.origin, "b-read"));
      expect(probe(await report(origin, "b-read"))).toEqual({ cookie: "beta", ls: "beta" });
    } finally {
      await app.close();
    }
  });

  test("profile A keeps its cookie and localStorage after CareerFlow restarts", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "cf-r1-persist-"));
    let app = null;
    let win = null;
    try {
      // ---------- First run: write state in profile A. ----------
      ({ app, win } = await launch(userDataDir));
      const pid = await addProfile(win, "R1 Persist Profile");
      const first = await createPage(win, pid, stateUrl(origin.origin, "p1-write", "alpha"));
      expect(probe(await report(origin, "p1-write"))).toEqual({ cookie: "alpha", ls: "alpha" });
      const before = (await snapshot(app)).pages.find((p) => p.id === first.id);
      expect(before.partition).toBe(`persist:cf-browser-${pid}`);

      // The persistent partition is a real directory in THIS install's user-data
      // dir, named from the profile id and nothing else.
      expect(
        partitionDirNames(userDataDir),
        "the persistent partition must live inside this install's user-data dir",
      ).toContain(`cf-browser-${pid}`);

      // A graceful close is the ordinary way out of the app — the shutdown the
      // storage layer flushes on. Nothing is asserted about a forced kill.
      await app.close();
      app = null;

      // ---------- Second run: the SAME install (same user-data dir). ----------
      ({ app, win } = await launch(userDataDir));

      // The profile row survived with the same id, so main derives the same
      // partition name for it…
      const rows = await win.evaluate(() => window.careerflow.profiles.list());
      expect(
        rows.some((r) => String(r.id) === String(pid)),
        `profile ${pid} must survive the restart`,
      ).toBe(true);

      // …and the browser storage behind that partition survived with it.
      const again = await createPage(win, pid, stateUrl(origin.origin, "p2-read"));
      expect(
        probe(await report(origin, "p2-read")),
        "profile A's browser state must survive a restart",
      ).toEqual({ cookie: "alpha", ls: "alpha" });
      const after = (await snapshot(app)).pages.find((p) => p.id === again.id);
      expect(after.partition).toBe(before.partition);

      // ---------- …and the ordinary user path lands in the same storage. ----------
      // Select the profile through the app's own card, open a page through the
      // pane's own control, and ask the page what it can see.
      await selectProfileThroughUi(win);
      await openPageTab(win);
      await navigateTo(win, stateUrl(origin.origin, "p3-ui-read"));
      expect(
        probe(await report(origin, "p3-ui-read")),
        "a page opened through the UI must land in the profile's persistent storage",
      ).toEqual({ cookie: "alpha", ls: "alpha" });
    } finally {
      await app?.close();
    }
  });

  test("two CareerFlow contexts in ONE profile share exactly one browser storage boundary", async () => {
    const { app, win } = await launch(mkdtempSync(join(tmpdir(), "cf-r1-ctx-")));
    try {
      const pid = await addProfile(win, "R1 Context Profile");
      await reloadShell(win);
      await selectProfileThroughUi(win);
      expect(await activeContextName(win)).toBe("Study");

      // Write state in the Study context.
      await openPageTab(win);
      await navigateTo(win, stateUrl(origin.origin, "ctx1-write", "gamma"));
      expect(probe(await report(origin, "ctx1-write"))).toEqual({ cookie: "gamma", ls: "gamma" });
      const studyPageId = await win
        .locator('[data-testid="browser-page-id"]')
        .first()
        .getAttribute("data-page-id");

      // Switch to a DIFFERENT CareerFlow context and open a page there.
      await win.locator('button.ctx-chip[data-ctx="desk"]').first().click();
      await expect.poll(() => activeContextName(win), { timeout: 15_000 }).toBe("Desk");
      await openPageTab(win);
      await navigateTo(win, stateUrl(origin.origin, "ctx2-read"));

      // A context is a layout body, NOT a browser storage boundary: the page in
      // Desk sees what the page in Study wrote, because both belong to the one
      // profile.
      expect(
        probe(await report(origin, "ctx2-read")),
        "a second context must not become a second browser storage boundary",
      ).toEqual({ cookie: "gamma", ls: "gamma" });

      const pages = (await snapshot(app)).pages;
      expect(pages.length, "both contexts' pages are live").toBe(2);
      expect(new Set(pages.map((p) => p.partition)).size, "one profile ⇒ one partition").toBe(1);
      expect(pages[0].partition).toBe(`persist:cf-browser-${pid}`);
      expect(pages.some((p) => p.id === studyPageId)).toBe(true);

      // The renderer never receives the partition string, in either context.
      const mirror = await win.evaluate(() => window.careerflow.browser.state());
      expect(mirror.pages.length).toBe(2);
      for (const page of mirror.pages) {
        expect(page.partition).toBeUndefined();
        expect(page.profileId).toBeUndefined();
      }
    } finally {
      await app.close();
    }
  });
});
