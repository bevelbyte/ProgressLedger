// Address-bar search engine, real app, off-screen E2E (test-only).
// Test 1: the Settings > Browser select writes the engine key.
// Test 2: typing plain text in the browser address bar searches with the
// chosen engine (Bing here, preset via the same key test 1 proves the
// select writes). Only the tab URL is asserted: whether the search
// engine answers is the engine's business, not the app's. The default
// (DuckDuckGo) is covered by the addressBar unit tests.
import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

test.setTimeout(300_000);

const START_HTML = `<!doctype html>\n<html><head><meta charset="utf-8"><title>Local Start</title></head>\n<body><h1>local start page</h1></body></html>\n`;

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

async function openSettingsBrowser(win) {
  await win.getByRole("button", { name: "Settings" }).first().click();
  await expect(win.getByText("Data and vault")).toBeVisible({ timeout: 30_000 });
  await win.locator('nav[aria-label="Settings sections"] button', { hasText: "Browser" }).click();
  await expect(win.getByLabel("Address bar search engine")).toBeVisible({ timeout: 30_000 });
}

test("settings browser section writes the search engine", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "pl-v2-search-"));
  const { app, win } = await launch(userDataDir);
  try {
    await openSettingsBrowser(win);
    const select = win.getByLabel("Address bar search engine");
    await expect(select).toHaveValue("duckduckgo");
    await select.selectOption("bing");
    await expect
      .poll(() => win.evaluate(() => localStorage.getItem("progressledger_v2_search_engine")), { timeout: 10_000 })
      .toBe("bing");
    await select.selectOption("google");
    await expect
      .poll(() => win.evaluate(() => localStorage.getItem("progressledger_v2_search_engine")), { timeout: 10_000 })
      .toBe("google");
    await select.selectOption("duckduckgo");
    await expect
      .poll(() => win.evaluate(() => localStorage.getItem("progressledger_v2_search_engine")), { timeout: 10_000 })
      .toBe("duckduckgo");
    console.log("SEARCH_EVIDENCE {\"case\":\"settings-select\",\"bing\":true,\"google\":true,\"duckduckgo\":true}");
  } finally {
    await app.close().catch(() => {});
  }
});

test("address bar searches with the chosen engine", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(START_HTML);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const startUrl = `http://127.0.0.1:${port}/`;
  const userDataDir = mkdtempSync(join(tmpdir(), "pl-v2-search-bar-"));
  const { app, win } = await launch(userDataDir);
  try {
    // Manager-spec launch, verbatim: create a workspace through the API,
    // reload the shell, then select the first card through the UI. The
    // browser profile created below via the UI dialog then lands in the
    // selected workspace, so its row appears in the manager list.
    const wsId = await win.evaluate(async () => {
      const created = await window.progressLedger.profiles.add("Search Engine", "search-engine");
      const p = created?.profile || created;
      return p?.id ?? p?.profileId ?? null;
    });
    expect(wsId, "workspace profile creation returned no id").not.toBe(null);
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
    // A browser profile with a local start page, opened through the UI
    // so the browser surface shows with its address bar.
    await win.evaluate(() => window.dispatchEvent(new CustomEvent("cf:navigate", { detail: { view: "browser-profiles" } })));
    await expect(win.getByTestId("browser-profiles")).toBeVisible({ timeout: 30_000 });
    await win.getByTestId("browser-profiles-new").click();
    await win.getByTestId("browser-profile-name").fill("SearchBar");
    await win.getByTestId("browser-profile-start-pages").fill(startUrl);
    await win.getByText("Create profile").click();
    const row = win.locator('[data-testid^="browser-profile-row-"]', { hasText: "SearchBar" });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.dblclick();
    const bar = win.locator('form[role="search"] input').first();
    await expect(bar).toBeVisible({ timeout: 30_000 });
    // Choose Bing through the same key the settings select writes.
    await win.evaluate(() => localStorage.setItem("progressledger_v2_search_engine", "bing"));
    await bar.fill("cats");
    await bar.press("Enter");
    const want = "https://www.bing.com/search?q=cats";
    let found = null;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const state = await win.evaluate(() => window.progressLedger.browser.state());
      found = (state?.pages ?? []).find((p) => p?.url === want) ?? null;
      if (found) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(found, `no tab navigated to ${want}`).not.toBe(null);
    console.log(`SEARCH_EVIDENCE ${JSON.stringify({ case: "address-bar-search", engine: "bing", url: want, found: true })}`);
  } finally {
    await app.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});
