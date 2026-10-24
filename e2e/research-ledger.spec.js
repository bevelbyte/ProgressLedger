import { test, expect, _electron as electron } from "@playwright/test";
import { openNewWebPage } from "./helpers/browser-page-ui.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const root = process.cwd();

test("Research sources and passages persist, deduplicate, and return to the existing page tab", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-research-ledger-"));
  const absentDonutDir = join(tmpdir(), `cf-research-donut-absent-${process.pid}-${Date.now()}`);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>Research Fixture</title><main><h1>Research Fixture</h1><p>Visible local test article.</p></main>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/article#section`;
  let app;
  try {
    app = await electron.launch({
      args: [root, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1", PROGRESSLEDGER_V2_DONUT_SETTINGS_DIR: absentDonutDir },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
    await win.reload();
    await expect.poll(async () => win.evaluate(() => window.progressLedger.ping())).toMatch(/Progress Ledger core online/i);

    const profile = await win.evaluate(async () => {
      const result = await window.progressLedger.profiles.add("Research Contract", `research-e2e-${Date.now()}`);
      const value = result?.profile || result;
      return value?.id ?? value?.profileId ?? result;
    });
    expect(Number(profile)).toBeGreaterThan(0);
    await win.reload();
    await win.waitForLoadState("domcontentloaded");
    const profileCard = win.locator("button.profile-main").first();
    await expect(profileCard).toBeVisible({ timeout: 15_000 });
    await profileCard.click();
    await expect.poll(async () => win.locator("[data-pane-id]").count()).toBeGreaterThan(0);

    // Browser pages and the Research ledger are Operator-owned workspace views.
    // Enter that context before opening the page so the capture form can receive
    // the page identity from its actual owning pane rather than a stale context.
    await win.locator('[data-ctx="operator"]').click();
    await expect(win.locator('[data-ctx="operator"]')).toHaveAttribute("aria-selected", "true");
    await win.evaluate(() => window.dispatchEvent(new CustomEvent("cf:navigate", { detail: { view: "browser" } })));
    await expect(win.getByRole("button", { name: "New tab" }).first()).toBeVisible();

    await openNewWebPage(win);
    await win.locator('[data-testid="browser-address"]').fill(url);
    await win.locator('[data-testid="browser-go"]').click();
    await expect(win.getByText("Research Fixture", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await win.getByTestId("research-save-source").click();
    await expect(win.getByTestId("research-save-source")).toBeDisabled();
    await expect(win.getByTestId("research-return")).toBeVisible();
    await win.evaluate(() => window.dispatchEvent(new CustomEvent("cf:navigate", { detail: { view: "research-ledger" } })));
    await expect(win.getByTestId("research-ledger-page")).toBeVisible();
    await expect(win.locator("[data-source-id]")).toHaveCount(1);

    await win.evaluate(() => document.querySelector("[data-source-id] button")?.click());
    await expect(win.getByTestId("browser-surface")).toBeVisible();
    await expect(win.getByTestId("browser-page-id")).toHaveAttribute("data-page-id", /^bp-/);
    await expect(win.getByTestId("research-kept-count")).toHaveText("");
    const pageTabCount = await win.locator('[data-pane-id] [data-pane-tab][data-view="page"]').count();
    await win.evaluate(() => window.dispatchEvent(new CustomEvent("cf:navigate", { detail: { view: "research-ledger" } })));
    await win.getByTestId("research-passage-text").fill("A kept passage from the local article.");
    await win.getByTestId("research-keep-passage").click();
    await expect(win.getByText("A kept passage from the local article.", { exact: true })).toBeVisible();
    await win.evaluate(() => document.querySelector("[data-source-id] button")?.click());
    await expect(win.getByTestId("research-kept-count")).toHaveText("1 kept");
    await expect.poll(async () => win.locator('[data-pane-id] [data-pane-tab][data-view="page"]').count()).toBe(pageTabCount);

    await win.evaluate(() => window.dispatchEvent(new CustomEvent("cf:navigate", { detail: { view: "research-ledger" } })));
    await expect(win.getByTestId("research-ledger-page")).toBeVisible();
    await expect(win.locator("[data-capture-id]")).toHaveCount(1);
    await expect.poll(async () => await win.evaluate(async (profileId) => (await window.progressLedger.research.listCaptures(Number(profileId))).length, Number(profile))).toBe(1);
  } finally {
    await app?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(userDataDir, { recursive: true, force: true });
    // Donut settings path is intentionally never created; preserve that fact.
  }
});

test("Research rejects invalid IPC inputs and real SQLite write failures without false success, then retries", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-research-failure-e2e-"));
  const absentDonutDir = join(tmpdir(), `cf-research-failure-donut-absent-${process.pid}-${Date.now()}`);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>Research Failure Fixture</title><main><h1>Research Failure Fixture</h1><p>Failure path content.</p></main>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/failure`;
  let app;
  let db;
  try {
    app = await electron.launch({
      args: [root, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1", PROGRESSLEDGER_V2_DONUT_SETTINGS_DIR: absentDonutDir },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
    await win.reload();
    await expect.poll(async () => win.evaluate(() => window.progressLedger.ping())).toMatch(/Progress Ledger core online/i);

    const profileId = await win.evaluate(async () => {
      const result = await window.progressLedger.profiles.add("Research Failure Contract", `research-failure-${Date.now()}`);
      const value = result?.profile || result;
      return value?.id ?? value?.profileId ?? result;
    });
    expect(Number(profileId)).toBeGreaterThan(0);
    await win.reload();
    await win.waitForLoadState("domcontentloaded");
    await expect(win.locator("button.profile-main").first()).toBeVisible({ timeout: 15_000 });
    await win.locator("button.profile-main").first().click();
    await win.locator('[data-ctx="operator"]').click();
    await win.evaluate(() => window.dispatchEvent(new CustomEvent("cf:navigate", { detail: { view: "browser" } })));
    await openNewWebPage(win);
    await win.locator('[data-testid="browser-address"]').fill(url);
    await win.locator('[data-testid="browser-go"]').click();
    await expect(win.getByText("Research Failure Fixture", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    const pageId = await win.getByTestId("browser-page-id").getAttribute("data-page-id");
    expect(pageId).toMatch(/^bp-/);

    // These calls use the real preload -> IPC -> Main validation -> native path.
    const invalid = await win.evaluate(async ({ profileId, pageId }) => {
      const api = window.progressLedger.research;
      const rejected = async (fn) => {
        try {
          const result = await fn();
          return result?.ok === false || result?.reason != null;
        } catch { return true; }
      };
      return {
        badKind: await rejected(() => api.capture(Number(profileId), pageId, "unknown-kind", "Passage")),
        empty: await rejected(() => api.capture(Number(profileId), pageId, "clip", "   ")),
        oversized: await rejected(() => api.capture(Number(profileId), pageId, "clip", "x".repeat(8001))),
        invalidPage: await rejected(() => api.saveSource(Number(profileId), "bp-not-owned-by-main")),
      };
    }, { profileId, pageId });
    expect(invalid).toEqual({ badKind: true, empty: true, oversized: true, invalidPage: true });
    expect(await win.evaluate(async (id) => (await window.progressLedger.research.listCaptures(Number(id))).length, profileId)).toBe(0);

    // Open only the disposable E2E workspace DB. SQLite triggers force a genuine
    // native write failure while all normal Main ownership checks, N-API calls
    // and the production Rust transaction remain in path.
    const dbPath = join(userDataDir, "progress-ledger-v2.db");
    await expect.poll(() => require("node:fs").existsSync(dbPath)).toBe(true);
    db = new Database(dbPath, { timeout: 5000 });
    db.pragma("busy_timeout = 5000");

    db.exec("CREATE TRIGGER e2e_reject_research_source BEFORE INSERT ON research_sources BEGIN SELECT RAISE(ABORT, 'e2e-source-write-failure'); END;");
    await win.getByTestId("research-save-source").click();
    await expect(win.locator('[data-testid="research-ledger"] [role="status"]')).toContainText("Source was not saved");
    expect(await win.evaluate(async (id) => (await window.progressLedger.research.listSources(Number(id))).length, profileId)).toBe(0);
    db.exec("DROP TRIGGER e2e_reject_research_source;");
    await win.getByTestId("research-save-source").click();
    await expect(win.getByTestId("research-save-source")).toBeDisabled();
    await expect(win.getByText("Source saved to Research")).toBeVisible();
    expect(await win.evaluate(async (id) => (await window.progressLedger.research.listSources(Number(id))).length, profileId)).toBe(1);

    await expect(win.getByTestId("browser-surface")).toBeVisible();
    await expect(win.getByTestId("research-kept-count")).toHaveText("");
    await win.getByTestId("research-passage-text").fill("Keep this exact passage if persistence fails.");
    db.exec("CREATE TRIGGER e2e_reject_research_capture BEFORE INSERT ON research_captures BEGIN SELECT RAISE(ABORT, 'e2e-capture-write-failure'); END;");
    await win.getByTestId("research-keep-passage").click();
    await expect(win.locator('[data-testid="research-ledger"] [role="status"]')).toContainText("Passage was not saved");
    await expect(win.getByTestId("research-passage-text")).toHaveValue("Keep this exact passage if persistence fails.");
    await expect(win.getByTestId("research-kept-count")).toHaveText("");
    expect(await win.evaluate(async (id) => (await window.progressLedger.research.listCaptures(Number(id))).length, profileId)).toBe(0);

    db.exec("DROP TRIGGER e2e_reject_research_capture;");
    await win.getByTestId("research-keep-passage").click();
    await expect(win.getByText("Keep this exact passage if persistence fails.", { exact: true })).toBeVisible();
    await expect(win.getByTestId("research-passage-text")).toHaveValue("");
    await expect(win.getByTestId("research-kept-count")).toHaveText("1 kept");
    expect(await win.evaluate(async (id) => (await window.progressLedger.research.listCaptures(Number(id))).length, profileId)).toBe(1);

    // A query failure is induced by hiding the real capture table in this
    // disposable database. The renderer's existing successful rows/count must
    // remain visible and must not be reset to an optimistic or empty state.
    db.exec("ALTER TABLE research_captures RENAME TO research_captures_e2e_hidden;");
    await win.getByRole("button", { name: "Refresh Research ledger" }).click();
    await expect(win.locator('[data-testid="research-ledger"] [role="status"]')).toContainText("Research ledger could not be loaded");
    await expect(win.getByTestId("research-kept-count")).toHaveText("1 kept");
    await expect(win.getByText("Keep this exact passage if persistence fails.", { exact: true })).toBeVisible();
    db.exec("ALTER TABLE research_captures_e2e_hidden RENAME TO research_captures;");
    await win.getByRole("button", { name: "Refresh Research ledger" }).click();
    await expect(win.locator('[data-testid="research-ledger"] [role="status"]')).toHaveCount(0);
    await expect(win.getByTestId("research-kept-count")).toHaveText("1 kept");
  } finally {
    try { db?.close(); } catch {}
    await app?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
