import { test, expect, _electron as electron } from "@playwright/test";
import { openNewWebPage } from "./helpers/browser-page-ui.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import { MAX_LIVE_PAGES } from "../shell/src/services/browser/registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const ABSENT_DONUT_DIR = join(tmpdir(), `cf-r4-donut-absent-${Date.now()}`);

async function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/hang") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.write("<!doctype html><title>Hanging navigation</title><body>waiting");
      // Deliberately never end this response. The browser host must fail it on
      // its own bounded timer; this fixture does not depend on public networking.
      return;
    }
    const label = url.searchParams.get("label") ?? "Recovered Page";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>${label}</title><body><h1>${label}</h1></body>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function launch() {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-browser-r4-"));
  const env = {
    ...process.env,
    PROGRESSLEDGER_V2_E2E: "1",
    PROGRESSLEDGER_V2_E2E_BROWSER_NAVIGATION_TIMEOUT_MS: "1200",
    PROGRESSLEDGER_V2_DONUT_SETTINGS_DIR: ABSENT_DONUT_DIR,
  };
  delete env.PROGRESSLEDGER_V2_E2E_DONUT_STUB;
  delete env.PROGRESSLEDGER_V2_E2E_DONUT_MODE;
  const app = await electron.launch({ args: [projectRoot, `--user-data-dir=${userDataDir}`], env });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 1000));
  await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();
  return { app, win };
}

async function seedAndSelectProfile(win) {
  const profileId = await win.evaluate(async () => {
    const created = await window.progressLedger.profiles.add("Browser R4", "browser-r4");
    const profile = created?.profile || created;
    return profile?.id ?? profile?.profileId ?? (typeof created === "number" ? created : null);
  });
  expect(profileId).not.toBeNull();
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();
  await win.locator('button.nav-item:has-text("Profiles")').first().click();
  await win.locator("button.profile-main").first().waitFor({ state: "visible", timeout: 10_000 });
  await win.locator("button.profile-main").first().click();
  await expect
    .poll(() => win.evaluate(() => document.querySelector(".ctx-chip-wrap.active .ctx-chip")?.textContent.trim() ?? null), { timeout: 15_000 })
    .toBe("Study");
  return Number(profileId);
}

async function openPageTab(win) {
  await openNewWebPage(win);
  await expect(win.locator('[data-testid="browser-surface"]')).toBeVisible();
}

async function navigateTo(win, url) {
  await win.locator('[data-testid="browser-address"]').fill(url);
  await win.locator('[data-testid="browser-go"]').click();
}

const snapshot = (app) => app.evaluate(() => globalThis.__cfBrowserE2E?.debugSnapshot() ?? null);
const webContentsCount = (app) => app.evaluate(({ webContents }) => webContents.getAllWebContents().length);

async function runInPageAt(app, urlPrefix, code) {
  return app.evaluate(async ({ webContents }, spec) => {
    const wc = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(spec.urlPrefix));
    if (!wc) return { ok: false, reason: "no-matching-page" };
    try {
      return { ok: true, value: await wc.executeJavaScript(spec.code) };
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) };
    }
  }, { urlPrefix, code });
}

test.describe("R4 browser failure, crash, reload and recovery", () => {
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

  test("a stalled navigation becomes an explicit timeout and a later safe navigation recovers", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, `${server.origin}/hang`);

    await expect.poll(async () => {
      const page = (await snapshot(app))?.pages?.[0];
      return page ? `${page.state}:${page.lastError?.reason ?? ""}` : "missing";
    }, { timeout: 10_000 }).toBe("failed:navigation-timeout");
    await expect(win.locator('[data-testid="browser-state"]')).toHaveText("Navigation timed out");
    const publicState = await win.evaluate(() => window.progressLedger.browser.state());
    expect(publicState.pages[0]).toMatchObject({ state: "failed", loading: false });

    await navigateTo(win, `${server.origin}/good?label=Recovered`);
    await expect.poll(async () => (await snapshot(app))?.pages?.[0]?.state, { timeout: 10_000 }).toBe("ready");
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("Recovered");
    expect((await snapshot(app)).pages[0].lastError).toBeNull();
  });

  test("a forced browser renderer crash is isolated, and reload uses the recorded safe URL", async () => {
    await seedAndSelectProfile(win);
    await openPageTab(win);
    await navigateTo(win, `${server.origin}/good?label=FirstPage`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("FirstPage");
    const first = (await snapshot(app)).pages.find((page) => page.url.includes("label=FirstPage"));
    expect(first).toBeTruthy();

    await openPageTab(win);
    await navigateTo(win, `${server.origin}/good?label=SiblingPage`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("SiblingPage");
    const sibling = (await snapshot(app)).pages.find((page) => page.url.includes("label=SiblingPage"));
    expect(sibling).toBeTruthy();

    const crash = await app.evaluate((_electron, pageId) => globalThis.__cfBrowserE2E.crashPage(pageId), first.id);
    expect(crash).toEqual({ ok: true });
    await expect.poll(async () => (await snapshot(app)).pages.find((page) => page.id === first.id)?.state, { timeout: 10_000 }).toBe("crashed");

    await expect(win.locator('[data-testid="browser-surface"]')).toBeVisible();
    const siblingState = (await snapshot(app)).pages.find((page) => page.id === sibling.id);
    expect(siblingState.state).toBe("ready");
    const siblingScript = await runInPageAt(app, `${server.origin}/good?label=SiblingPage`, "document.title");
    expect(siblingScript).toEqual({ ok: true, value: "SiblingPage" });

    await win.locator('[data-pane-id] [data-view="page"]').first().click();
    await expect(win.locator('[data-testid="browser-state"]')).toHaveText("This page crashed");
    await win.locator('[data-testid="browser-reload"]').click();
    await expect.poll(async () => (await snapshot(app)).pages.find((page) => page.id === first.id)?.state, { timeout: 10_000 }).toBe("ready");
    expect((await snapshot(app)).pages.find((page) => page.id === first.id).url).toContain("label=FirstPage");
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("FirstPage");
    expect((await snapshot(app)).pages.find((page) => page.id === sibling.id).state).toBe("ready");
    await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();
  });

  test("renderer reload reconciles orphan native views and repeated create/destroy cycles return to baseline", async () => {
    const profileId = await seedAndSelectProfile(win);
    const baseline = await webContentsCount(app);
    await openPageTab(win);
    await navigateTo(win, `${server.origin}/good?label=BeforeReload`);
    await expect(win.locator('[data-testid="browser-title"]')).toHaveText("BeforeReload");
    expect(await webContentsCount(app)).toBe(baseline + 1);

    await win.reload();
    await win.waitForLoadState("domcontentloaded");
    await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();
    await expect.poll(async () => (await snapshot(app))?.pages?.length ?? -1, { timeout: 10_000 }).toBe(0);
    await expect.poll(() => webContentsCount(app), { timeout: 10_000 }).toBe(baseline);

    // Repeated native view creation/destruction must not accumulate webContents.
    for (let i = 0; i < 3; i += 1) {
      const created = await win.evaluate(async (spec) => window.progressLedger.browser.createPage(spec.profileId, spec.url), {
        profileId,
        url: `${server.origin}/good?label=Cycle${i}`,
      });
      expect(created.ok).toBe(true);
      await expect.poll(() => webContentsCount(app), { timeout: 5_000 }).toBe(baseline + 1);
      const closed = await win.evaluate((id) => window.progressLedger.browser.closePage(id), created.page.id);
      expect(closed.ok).toBe(true);
      await expect.poll(async () => (await snapshot(app))?.pages?.some((page) => page.id === created.page.id) ?? false, { timeout: 5_000 }).toBe(false);
      await expect.poll(() => webContentsCount(app), { timeout: 5_000 }).toBe(baseline);
    }

    // Closing a page while its navigation is still pending must cancel its
    // timeout ownership; a late loading/failure callback may not resurrect it.
    const transient = await win.evaluate(async (spec) => window.progressLedger.browser.createPage(spec.profileId, spec.url), {
      profileId,
      url: `${server.origin}/hang`,
    });
    expect(transient.ok).toBe(true);
    const transientId = transient.page.id;
    expect((await win.evaluate((id) => window.progressLedger.browser.closePage(id), transientId)).ok).toBe(true);
    await expect.poll(async () => (await snapshot(app))?.pages?.some((page) => page.id === transientId) ?? false, { timeout: 5_000 }).toBe(false);
    await win.waitForTimeout(1_500);
    expect((await snapshot(app)).pages.some((page) => page.id === transientId)).toBe(false);
    await expect.poll(() => webContentsCount(app), { timeout: 5_000 }).toBe(baseline);

    const live = [];
    for (let i = 0; i < MAX_LIVE_PAGES; i += 1) {
      const created = await win.evaluate(async (spec) => window.progressLedger.browser.createPage(spec.profileId, "about:blank"), { profileId });
      expect(created.ok).toBe(true);
      live.push(created.page.id);
    }
    const overCap = await win.evaluate(async (spec) => window.progressLedger.browser.createPage(spec.profileId, "about:blank"), { profileId });
    expect(overCap).toMatchObject({ ok: false, reason: "live-cap-reached" });
    for (const id of live) {
      const closed = await win.evaluate((pageId) => window.progressLedger.browser.closePage(pageId), id);
      expect(closed.ok).toBe(true);
    }
    await expect.poll(async () => (await snapshot(app))?.pages?.length ?? -1, { timeout: 10_000 }).toBe(0);
    await expect.poll(() => webContentsCount(app), { timeout: 10_000 }).toBe(baseline);
  });
});
