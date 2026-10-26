// Browser profile manager, CareerFlow style — real app, off-screen E2E.
// Covers what jsdom cannot: search + sort in the live list, double-click
// to open, the tabbed details side panel, Copy ID, F2 rename, and
// "Set as current" — all through the running app's own UI.
import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

const START_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Local Start</title></head>
  <body><h1>local start page</h1></body>
</html>
`;

async function startOrigin() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(START_HTML);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
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
  await addWorkspaceProfile(win, "Manager Workspace");
  await reloadShell(win);
  await selectProfileThroughUi(win);
  return { app, win };
}

async function reloadShell(win) {
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible({ timeout: 60_000 });
}

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

async function gotoManager(win) {
  await win.evaluate(() => window.dispatchEvent(new CustomEvent("cf:navigate", { detail: { view: "browser-profiles" } })));
  await expect(win.getByTestId("browser-profiles")).toBeVisible({ timeout: 30_000 });
}

function rowFor(win, name) {
  return win.locator('[data-testid^="browser-profile-row-"]').filter({ hasText: name }).first();
}

async function createProfileViaUi(win, name, startPages) {
  await win.getByTestId("browser-profiles-new").click();
  await win.getByTestId("browser-profile-name").fill(name);
  if (startPages) await win.getByTestId("browser-profile-start-pages").fill(startPages);
  await win.getByText("Create profile").click();
  await expect(rowFor(win, name)).toBeVisible({ timeout: 30_000 });
}

test.describe("manager search, sort, open, details, rename, current", () => {
  test.setTimeout(300_000);
  let origin;

  test.beforeEach(async () => {
    origin = await startOrigin();
  });

  test.afterEach(async () => {
    await origin?.close();
  });

  test("search, sort, double-click open, details tabs, copy id, F2 rename, set as current", async () => {
    const { app, win } = await launch(mkdtempSync(join(tmpdir(), "cf-mgr-")));
    try {
      await gotoManager(win);
      await createProfileViaUi(win, "Alpha", `${origin.origin}/`);
      await createProfileViaUi(win, "Zulu");

      // Search filters by name.
      await win.getByTestId("browser-profile-search").fill("Alp");
      await expect(rowFor(win, "Alpha")).toBeVisible();
      await expect(rowFor(win, "Zulu")).not.toBeVisible();
      await win.getByTestId("browser-profile-search").fill("");
      await expect(rowFor(win, "Zulu")).toBeVisible();

      // Sort: A-Z, then Z-A.
      await win.getByTestId("browser-profile-sort").click();
      await expect(win.locator('[data-testid^="browser-profile-row-"]').first()).toContainText("Alpha");
      await win.getByTestId("browser-profile-sort").click();
      await expect(win.locator('[data-testid^="browser-profile-row-"]').first()).toContainText("Zulu");

      // Double-click opens the profile's start page as a real page tab.
      await rowFor(win, "Alpha").dblclick();
      await expect(win.locator('[data-testid="browser-surface"]')).toBeVisible({ timeout: 60_000 });

      // Back to the manager: details panel tabs.
      await gotoManager(win);
      await rowFor(win, "Zulu").locator('[data-testid^="browser-profile-details-"]').click();
      const info = win.getByTestId("browser-profile-info");
      await expect(info).toBeVisible({ timeout: 30_000 });
      await expect(info).toContainText("Zulu");
      await win.getByTestId("browser-profile-tab-start-pages").click();
      await expect(info).toContainText("No start pages set");
      await win.getByTestId("browser-profile-tab-network").click();
      await expect(info).toContainText("No proxy");
      await win.getByTestId("browser-profile-tab-overview").click();
      await win.getByTestId("browser-profile-info-copy-id").click();
      await expect(win.getByText("Profile ID copied")).toBeVisible({ timeout: 30_000 });
      await win.getByTestId("browser-profile-info-close").click();
      await expect(info).not.toBeVisible();

      // F2 on the focused row opens rename with the name focused.
      await rowFor(win, "Zulu").click();
      await win.keyboard.press("F2");
      const nameInput = win.getByTestId("browser-profile-name");
      await expect(nameInput).toBeVisible({ timeout: 30_000 });
      await expect(nameInput).toHaveValue("Zulu");
      await win.getByText("Cancel").click();

      // Menu labels and Set as current.
      await rowFor(win, "Zulu").locator('[data-testid^="browser-profile-menu-"]').click();
      await expect(win.getByTestId("browser-profile-menu")).toBeVisible();
      await expect(win.getByText("Open", { exact: true })).toBeVisible();
      await expect(win.getByText("Open details")).toBeVisible();
      await expect(win.getByText("Set as current")).toBeVisible();
      await expect(win.getByText("Rename (F2)")).toBeVisible();
      await expect(win.getByText("Copy ID")).toBeVisible();
      await expect(win.getByText("Use for new tabs")).toHaveCount(0);
      await win.getByText("Set as current").click();
      const { wsId, zuluId } = await win.evaluate(async () => {
        const list = await window.progressLedger.profiles.list();
        const profiles = list?.profiles ?? list ?? [];
        const wsId = profiles[0]?.id ?? profiles[0]?.profileId;
        const browsers = await window.progressLedger.browser.listProfiles(wsId);
        const rows = browsers?.profiles ?? [];
        const zulu = rows.find((r) => r.displayName === "Zulu");
        return { wsId, zuluId: zulu?.localId ?? null };
      });
      expect(zuluId, "Zulu browser profile not found").not.toBe(null);
      await expect
        .poll(
          () =>
            win.evaluate(
              (key) => localStorage.getItem(key),
              `progressledger_v2_browser_profile_${wsId}`,
            ),
          { timeout: 15_000 },
        )
        .toBe(zuluId);
    } finally {
      await app.close();
    }
  });
});
