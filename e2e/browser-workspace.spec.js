import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("Donut page control fails closed while Browser Manager Local API operations remain available", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-r6-boundary-"));
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, CAREERFLOW_E2E: "1", CAREERFLOW_E2E_DONUT_STUB: "1" },
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await expect(win.getByText(/CareerFlow core online/i)).toBeVisible();

    const ids = await win.evaluate(async () => {
      const p = await window.careerflow.profiles.add("R6 Workspace Owner", `r6-${Date.now()}`);
      const profile = await window.careerflow.browserManager.add(Number(p.id), `r6-bp-${Date.now()}`, "R6 Study Browser");
      const shortcut = await window.careerflow.browserManager.addShortcut(Number(p.id), profile.localId, "Example", "https://example.com/");
      return { cfId: Number(p.id), localId: profile.localId, shortcutId: shortcut.id ?? shortcut.shortcutId };
    });
    expect(ids.cfId).toBeGreaterThan(0);
    expect(ids.localId).toBeTruthy();
    expect(Number(ids.shortcutId)).toBeGreaterThan(0);

    // Supported Local API open paths remain available through Browser Manager.
    const opened = await win.evaluate(({ localId, cfId }) =>
      window.careerflow.browserManager.openBrowserProfile(localId, cfId), ids);
    expect(opened.ok).toBe(true);
    const shortcutOpened = await win.evaluate(({ shortcutId, cfId }) =>
      window.careerflow.browserManager.openShortcutUrl(shortcutId, cfId), ids);
    expect(shortcutOpened.opened).toBe(true);

    const priorCalls = await app.evaluate(() => ({
      runs: globalThis.__cfDonutE2E?.donutRuns?.length ?? 0,
      opens: globalThis.__cfDonutE2E?.donutOpens?.length ?? 0,
    }));

    // Legacy page/tab surface is retained only to give callers an explicit refusal.
    const refused = await win.evaluate(async () => ({
      launch: await window.careerflow.browserWorkspace.launch("not-used", 1),
      state: await window.careerflow.browserWorkspace.state(),
      navigate: await window.careerflow.browserWorkspace.navigate("not-used", 1, "https://example.org/"),
      screenshot: await window.careerflow.browserWorkspace.screenshot("not-used", 1, "tab-id"),
    }));
    for (const [name, result] of Object.entries(refused)) {
      expect(result.ok, `${name} unexpectedly succeeded`).toBe(false);
      expect(result.reason).toBe("feature-not-supported");
      expect(result.message).toMatch(/supported Local API/i);
    }

    // Unsupported page requests do not cause a Donut run, stop, or URL open.
    const afterCalls = await app.evaluate(() => ({
      runs: globalThis.__cfDonutE2E?.donutRuns?.length ?? 0,
      opens: globalThis.__cfDonutE2E?.donutOpens?.length ?? 0,
    }));
    expect(afterCalls).toEqual(priorCalls);
  } finally {
    await app.close();
  }
});
