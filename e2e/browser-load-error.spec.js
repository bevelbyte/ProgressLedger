// Load-error page: a failing URL shows the real Chromium error, the
// attempted URL, and the profile name (Task B Part 1). Hidden window.
// The exact numeric code is Chromium's to report (DNS behaviour varies),
// so the spec asserts the block carries the pane page's own numeric code
// and description, the attempted URL, and the profile name — never a
// hardcoded code value. Two layers are proven: the bridge/host layer
// (state failed + lastError + snapshot instrument) and the surface
// layer (the error block the user actually sees).
import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

test.setTimeout(300_000);

const FAIL_URL = "https://nonexistent.invalid/";

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

async function pollPage(win, predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const state = await win.evaluate(() => window.progressLedger.browser.state());
    const pages = state?.pages ?? [];
    const found = pages.find(predicate);
    if (found) return found;
    last = pages;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${label}; last pages: ${JSON.stringify(last)}`);
}

test("failed page shows code, description, URL, and profile name", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "pl-v2-loaderror-"));
  const { app, win } = await launch(userDataDir);
  try {
    const wsId = await createWorkspace(win, "Load Error", "load-error");

    // Layer 1 — bridge/host: a page opened at the failing URL reaches
    // state failed with a numeric code and a non-empty description, and
    // the debug snapshot exposes the failed-request instrument array.
    const created = await win.evaluate(async (id) => {
      const res = await window.progressLedger.browser.createProfile(id, "ErrorTest", null, null, null);
      return res?.profile ?? res;
    }, wsId);
    const localId = created?.localId ?? null;
    expect(localId, "browser profile creation returned no localId").not.toBe(null);
    const page = await win.evaluate(
      async ({ wsId: id, pageUrl, browserProfileId: bp }) => {
        const res = await window.progressLedger.browser.createPage({ profileId: id, url: pageUrl, browserProfileId: bp });
        return { ok: res?.ok === true, reason: res?.reason ?? null, detail: res?.detail ?? null, pageId: res?.page?.id ?? null };
      },
      { wsId, pageUrl: FAIL_URL, browserProfileId: localId },
    );
    expect(page.ok, `createPage for ${FAIL_URL} failed: ${page.reason} detail=${page.detail}`).toBe(true);
    const failed = await pollPage(
      win,
      (p) => p.id === page.pageId && p.state === "failed" && p.lastError && typeof p.lastError.code === "number" && !!p.lastError.description,
      "bridge page failed with code + description",
    );
    expect(failed.url).toBe(FAIL_URL);
    const snap = await app.evaluate((e) => globalThis.__cfBrowserE2E.debugSnapshot());
    const snapPage = (snap?.pages ?? []).find((p) => p?.id === page.pageId);
    expect(snapPage, "debug snapshot has no entry for the failed page").toBeTruthy();
    expect(Array.isArray(snapPage.failedRequests)).toBe(true);
    console.log(`LOADERROR_EVIDENCE ${JSON.stringify({ layer: "bridge", url: FAIL_URL, code: failed.lastError.code, description: failed.lastError.description })}`);

    // Layer 2 — surface: the same failing URL opened through the UI
    // (profile with the failing start page, row double-clicked) shows
    // the error block in the pane, with that pane page's own code,
    // description, URL, and profile name. The window is reloaded first,
    // exactly like the bar test: the workspace list is loaded at
    // startup, and a workspace added through the bridge does not refresh
    // it until a reload.
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
    await win.getByTestId("browser-profile-name").fill("ErrorSurface");
    await win.getByTestId("browser-profile-start-pages").fill(FAIL_URL);
    await win.getByText("Create profile").click();
    const row = win.locator('[data-testid^="browser-profile-row-"]', { hasText: "ErrorSurface" });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.dblclick();
    const block = win.getByTestId("browser-load-error");
    await expect(block).toBeVisible({ timeout: 30_000 });
    // The pane's own page id, so the block is checked against exactly
    // the page the user sees — not against the layer-1 page.
    const panePageId = await win.getByTestId("browser-page-id").getAttribute("data-page-id");
    const panePage = await pollPage(
      win,
      (p) => p.id === panePageId && p.state === "failed" && p.lastError && typeof p.lastError.code === "number" && !!p.lastError.description,
      "pane page failed with code + description",
    );
    expect(panePage.url).toBe(FAIL_URL);
    const text = await block.textContent();
    expect(text).toContain("could not be loaded");
    expect(text).toContain(`Error code: ${panePage.lastError.code}`);
    expect(text).toContain(panePage.lastError.description);
    expect(text).toContain(FAIL_URL);
    expect(text).toContain("ErrorSurface");
    console.log(`LOADERROR_EVIDENCE ${JSON.stringify({ layer: "surface", url: FAIL_URL, code: panePage.lastError.code, description: panePage.lastError.description, profile: "ErrorSurface", block: true })}`);
  } finally {
    await app.close().catch(() => {});
  }
});
