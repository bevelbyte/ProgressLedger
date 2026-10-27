// Bug 3 wiring: the page network log end to end through the real IPC
// bridge — off by default, records only failed requests while on,
// clears on toggle-off and on page close, and reports the UA facts.
// The shell unit tests prove the entry shape; this spec proves the
// host wiring (enabled flag, current-page tracking, close clearing).
import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

test.setTimeout(300_000);

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
  return { app, win };
}

async function createWorkspace(win, name, slug) {
  const wsId = await win.evaluate(async ({ name: n, slug: s }) => {
    const created = await window.progressLedger.profiles.add(n, s);
    const p = created?.profile || created;
    return p?.id ?? p?.profileId ?? null;
  }, { name, slug });
  expect(wsId, "workspace profile creation returned no id").not.toBe(null);
  return Number(wsId);
}

async function openPanePage(win, startUrl, profileName) {
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible({ timeout: 60_000 });
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
  await win.evaluate(() => window.dispatchEvent(new CustomEvent("cf:navigate", { detail: { view: "browser-profiles" } })));
  await expect(win.getByTestId("browser-profiles")).toBeVisible({ timeout: 30_000 });
  await win.getByTestId("browser-profiles-new").click();
  await win.getByTestId("browser-profile-name").fill(profileName);
  await win.getByTestId("browser-profile-start-pages").fill(startUrl);
  await win.getByText("Create profile").click();
  const row = win.locator('[data-testid^="browser-profile-row-"]', { hasText: profileName });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.dblclick();
  await expect(win.getByTestId("browser-address")).toBeVisible({ timeout: 30_000 });
  const pageId = await win.evaluate((url) => {
    return window.progressLedger.browser.state().then((state) => {
      const found = (state?.pages ?? []).find((p) => p?.url === url);
      return found?.id ?? null;
    });
  }, startUrl);
  expect(pageId, "pane page for the start URL was not found").not.toBe(null);
  return pageId;
}

async function bridge(win, fn, ...args) {
  return win.evaluate(
    ({ name, params }) => window.progressLedger.browser[name](...params),
    { name: fn, params: args },
  );
}

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

test("page network log: off by default, records while on, clears on off and close", async () => {
  const { server, port } = await startServer((req, res) => {
    if (req.url === "/app") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>App</title></head><body><h1>app</h1><script>fetch("/api-fail?token=secret").catch(() => {});</script></body></html>`);
    } else if (req.url.startsWith("/api-fail")) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "down" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const userDataDir = mkdtempSync(join(tmpdir(), "pl-v2-pagenetlog-app-"));
  const { app, win } = await launch(userDataDir);
  try {
    await createWorkspace(win, "Page Netlog", "page-netlog");
    const pageId = await openPanePage(win, `http://127.0.0.1:${port}/app`, "PageNetlog");
    await bridge(win, "setVisible", pageId, true);
    await new Promise((r) => setTimeout(r, 3000));

    // Off by default: the load-time failing fetch recorded nothing.
    let log = await bridge(win, "getPageNetworkLog");
    expect(log?.enabled).toBe(false);
    expect(log?.pageId).toBe(pageId);
    expect(log?.entries).toEqual([]);
    expect(typeof log?.pageUserAgent).toBe("string");
    expect(log?.pageUserAgent.length).toBeGreaterThan(0);
    expect(typeof log?.sessionUserAgentContainsElectron).toBe("boolean");

    // On: a fresh failing fetch is recorded with host + path + status only.
    await bridge(win, "setPageNetworkLogEnabled", true);
    await bridge(win, "navigate", pageId, `http://127.0.0.1:${port}/app`);
    await new Promise((r) => setTimeout(r, 3000));
    log = await bridge(win, "getPageNetworkLog");
    expect(log?.enabled).toBe(true);
    expect(log?.entries.length).toBeGreaterThanOrEqual(1);
    const apiEntry = log.entries.find((e) => e.path === "/api-fail");
    expect(apiEntry, `no /api-fail entry in ${JSON.stringify(log.entries)}`).toBeTruthy();
    expect(apiEntry.host).toBe("127.0.0.1");
    expect(apiEntry.status).toBe(503);
    expect(apiEntry.error).toBeUndefined();
    expect(JSON.stringify(apiEntry).includes("token")).toBe(false);
    expect(Object.keys(apiEntry).sort()).toEqual(["at", "host", "path", "status"]);

    // Toggle-off clears everything at once.
    await bridge(win, "setPageNetworkLogEnabled", false);
    log = await bridge(win, "getPageNetworkLog");
    expect(log?.enabled).toBe(false);
    expect(log?.entries).toEqual([]);

    // Close clears the current page: there is no page left to read.
    await bridge(win, "setPageNetworkLogEnabled", true);
    await bridge(win, "navigate", pageId, `http://127.0.0.1:${port}/app`);
    await new Promise((r) => setTimeout(r, 3000));
    log = await bridge(win, "getPageNetworkLog");
    expect(log?.entries.length).toBeGreaterThanOrEqual(1);
    await bridge(win, "closePage", pageId);
    log = await bridge(win, "getPageNetworkLog");
    expect(log?.pageId).toBe(null);
    expect(log?.entries).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});
