// Bare-window smoke probe: launches only the bare Electron app and
// reports whether its window appears. Diagnostic, not shipped.
import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const BARE_DIR = process.env.CHATGPT_BARE_DIR || "";
const ELECTRON_EXE = join(projectRoot, "node_modules", "electron", "dist", "electron.exe");

test.setTimeout(120_000);


test("bare window smoke", async () => {
  test.skip(!process.env.CHATGPT_BARE_DIR, "CHATGPT_BARE_DIR not set (diagnostic probe)");
  expect(BARE_DIR, "CHATGPT_BARE_DIR required").not.toBe("");
  expect(existsSync(BARE_DIR), "bare driver dir missing").toBe(true);
  const bareData = mkdtempSync(join(tmpdir(), "pl-v2-bare-smoke-"));
  const bare = await electron.launch({
    executablePath: ELECTRON_EXE,
    args: [BARE_DIR, `--user-data-dir=${bareData}`],
    timeout: 60_000,
  });
  try {
    const page = await bare.firstWindow({ timeout: 60_000 });
    const title = await page.title().catch(() => null);
    console.log(`BARE_SMOKE ${JSON.stringify({ title, url: page.url() })}`);
    await page.goto("https://example.com", { timeout: 60_000, waitUntil: "domcontentloaded" });
    console.log(`BARE_SMOKE ${JSON.stringify({ title: await page.title(), url: page.url() })}`);
  } finally {
    await bare.close().catch(() => {});
  }
});
