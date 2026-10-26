// Browser profile manager Play flow — real app, off-screen E2E window.
//
// What this proves that jsdom cannot: clicking Play on a manager row in
// the RUNNING app creates a real embedded page in exactly that profile's
// partition, activates a workspace tab for it, leaves the current
// profile untouched, records last-used, and isolates storage between
// two Play-created pages. The jsdom suite (browser-profiles-play.test.js)
// covers the same contract at the mocked boundaries; this spec covers
// it end to end.
import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

const PROBE_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Play Probe</title></head>
  <body>
    <h1 id="probe">play probe</h1>
    <script>
      (function () {
        var params = new URLSearchParams(location.search);
        var write = params.get("write");
        if (write !== null) {
          document.cookie = "cf_probe=" + encodeURIComponent(write) + "; path=/; max-age=86400";
          try { localStorage.setItem("cf_probe", write); } catch (e) {}
        }
        var ls;
        try { ls = localStorage.getItem("cf_probe"); } catch (e) { ls = "threw:" + e.message; }
        var out = { tag: params.get("tag") || "read", origin: String(location.origin), cookie: String(document.cookie), ls: ls };
        try { fetch("/report?d=" + encodeURIComponent(JSON.stringify(out))); } catch (e) {}
      })();
    </script>
  </body>
</html>
`;

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
  return { origin: `http://127.0.0.1:${port}`, reports, close: () => new Promise((resolve) => server.close(resolve)) };
}

function stateUrl(origin, tag, write) {
  const base = `${origin}/state?tag=${encodeURIComponent(tag)}`;
  return write === undefined ? base : `${base}&write=${encodeURIComponent(write)}`;
}

async function launch(userDataDir) {
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1", PROGRESSLEDGER_V2_E2E_USER_DATA: userDataDir },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible({ timeout: 60_000 });
  // The boot state has NO workspace profile at all (status bar reads
  // "workspace: none"), and the manager's profileId comes from the
  // active profile — without a profile, every browser IPC call fails
  // unknown-profile. Mirror the isolation spec: create one through
  // the bridge, reload, then select it through its own card.
  await addWorkspaceProfile(win, "Play Workspace");
  await reloadShell(win);
  await selectProfileThroughUi(win);
  return { app, win };
}

async function reloadShell(win) {
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible({ timeout: 60_000 });
}

/** Create a workspace profile through the app's own bridge. */
async function addWorkspaceProfile(win, name) {
  const id = await win.evaluate(async (profileName) => {
    const slug = profileName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const created = await window.progressLedger.profiles.add(profileName, slug);
    const p = created?.profile || created;
    return p?.id ?? p?.profileId ?? (typeof created === "number" ? created : null);
  }, name);
  expect(id, "profile creation returned no id").not.toBe(null);
  return Number(id);
}

/** Select a profile through the app's own profile card, and wait for the hand-off. */
async function selectProfileThroughUi(win) {
  await win.getByRole("button", { name: "Profiles", exact: true }).first().click();
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
}

function snapshot(app) {
  return app.evaluate(() => {
    const host = globalThis.__cfBrowserE2E;
    return host ? host.debugSnapshot() : null;
  });
}

async function gotoManager(win) {
  await win.evaluate(() => window.dispatchEvent(new CustomEvent("cf:navigate", { detail: { view: "browser-profiles" } })));
  await expect(win.getByTestId("browser-profiles")).toBeVisible({ timeout: 30_000 });
}

function rowFor(win, name) {
  return win.locator('[data-testid^="browser-profile-row-"]').filter({ hasText: name }).first();
}

async function createProfileViaUi(win, name) {
  await win.getByTestId("browser-profiles-new").click();
  await win.getByTestId("browser-profile-name").fill(name);
  await win.getByText("Create profile").click();
  await expect(rowFor(win, name)).toBeVisible({ timeout: 30_000 });
}

async function navigateActiveSurface(win, url) {
  await win.locator('[data-testid="browser-address"]').fill(url);
  await win.locator('[data-testid="browser-go"]').click();
}

function probe(rep) {
  const match = /(?:^|;\s*)cf_probe=([^;]*)/.exec(String(rep?.cookie ?? ""));
  return { cookie: match ? decodeURIComponent(match[1]) : null, ls: rep?.ls ?? null };
}

async function report(origin, tag) {
  await expect
    .poll(() => origin.reports.filter((r) => r.tag === tag).length, { timeout: 120_000 })
    .toBeGreaterThan(0);
  return origin.reports.filter((r) => r.tag === tag).at(-1);
}

test.describe("manager Play launches the clicked profile", () => {
  // Real app + off-screen first navigations can be slow; the default
  // 30 s test timeout would kill a healthy run mid-poll.
  test.setTimeout(300_000);
  let origin;

  test.beforeEach(async () => {
    origin = await startOrigin();
  });

  test.afterEach(async () => {
    await origin?.close();
  });

  test("Play opens a page tab in the clicked profile, keeps current, touches last-used, isolates storage", async () => {
    const { app, win } = await launch(mkdtempSync(join(tmpdir(), "cf-play-")));
    try {
      await gotoManager(win);
      await createProfileViaUi(win, "Play-A");
      await createProfileViaUi(win, "Play-B");

      // Make Play-A the current profile, then Play Play-B: the page
      // must still open in Play-B, and current must stay Play-A.
      await rowFor(win, "Play-A").locator('[data-testid^="browser-profile-menu-"]').click();
      await win.locator('[data-testid^="browser-profile-use-"]').click();
      await rowFor(win, "Play-B").locator('[data-testid^="browser-profile-play-"]').click();
      await expect(win.locator('[data-testid="browser-surface"]')).toBeVisible({ timeout: 60_000 });
      await expect(win.locator('[data-testid="browser-page-profile"]')).toHaveText("Play-B", { timeout: 60_000 });
      await expect(win.locator('button[title="New tabs open in Play-A"]')).toBeVisible({ timeout: 30_000 });

      // The Play-created page really lives in Play-B's partition.
      const pagesB = (await snapshot(app)).pages;
      expect(pagesB.length).toBeGreaterThanOrEqual(1);
      const partitionsB = new Set(pagesB.map((p) => p.partition));
      expect(partitionsB.size).toBe(1);

      // Isolation through Play: B writes, A reads nothing.
      await navigateActiveSurface(win, stateUrl(origin.origin, "play-b-write", "beta"));
      expect(probe(await report(origin, "play-b-write"))).toEqual({ cookie: "beta", ls: "beta" });
      await gotoManager(win);
      await rowFor(win, "Play-A").locator('[data-testid^="browser-profile-play-"]').click();
      await expect(win.locator('[data-testid="browser-page-profile"]')).toHaveText("Play-A", { timeout: 60_000 });
      await navigateActiveSurface(win, stateUrl(origin.origin, "play-a-read"));
      expect(probe(await report(origin, "play-a-read"))).toEqual({ cookie: null, ls: null });
      const pagesBoth = (await snapshot(app)).pages;
      expect(new Set(pagesBoth.map((p) => p.partition)).size).toBe(2);

      // Last-used is no longer "Never" for either played profile.
      await gotoManager(win);
      for (const name of ["Play-A", "Play-B"]) {
        const lastUsed = await rowFor(win, name).locator("td").nth(3).textContent();
        expect(lastUsed?.trim()).not.toBe("Never");
      }

      // Rapid double Play opens exactly one extra page, not two.
      const before = (await snapshot(app)).pages.length;
      await win.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-testid^="browser-profile-row-"]')];
        const row = rows.find((r) => r.textContent.includes("Play-B"));
        const btn = row?.querySelector('[data-testid^="browser-profile-play-"]');
        btn?.click();
        btn?.click();
      });
      await expect.poll(async () => (await snapshot(app)).pages.length, { timeout: 60_000 }).toBe(before + 1);
      await win.waitForTimeout(1000);
      expect((await snapshot(app)).pages.length).toBe(before + 1);
    } finally {
      await app.close();
    }
  });

  test("row menu and read-only information view", async () => {
    const { app, win } = await launch(mkdtempSync(join(tmpdir(), "cf-play-")));
    try {
      await gotoManager(win);
      await createProfileViaUi(win, "Info-A");

      // Right-click opens the menu; information is read-only.
      await rowFor(win, "Info-A").click({ button: "right" });
      await expect(win.getByTestId("browser-profile-menu")).toBeVisible({ timeout: 30_000 });
      await win.locator('[data-testid^="browser-profile-info-"]').click();
      const info = win.getByTestId("browser-profile-info");
      await expect(info).toBeVisible({ timeout: 30_000 });
      await expect(info).toContainText("Info-A");
      expect(await info.locator("input").count()).toBe(0);
      await win.getByTestId("browser-profile-info-close").click();
      await expect(info).not.toBeVisible();

      // Escape closes the menu.
      await rowFor(win, "Info-A").locator('[data-testid^="browser-profile-menu-"]').click();
      await expect(win.getByTestId("browser-profile-menu")).toBeVisible();
      await win.keyboard.press("Escape");
      await expect(win.getByTestId("browser-profile-menu")).not.toBeVisible();

      // Delete cancel leaves the row in place.
      await rowFor(win, "Info-A").locator('[data-testid^="browser-profile-menu-"]').click();
      await win.locator('[data-testid^="browser-profile-delete-"]').click();
      await expect(win.getByTestId("browser-profile-delete-confirm")).toBeVisible({ timeout: 30_000 });
      await win.getByText("Cancel").click();
      await expect(rowFor(win, "Info-A")).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
