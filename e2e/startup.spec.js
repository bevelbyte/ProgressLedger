import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * Startup guard: the cheapest possible check that the Electron MAIN process
 * loads its ESM module graph and reaches a rendered window with the Rust core
 * online. A broken import in shell/src (e.g. a missing named export) crashes
 * here immediately, independent of any UI flow. Keep this test first and fast.
 */
test("electron main process boots and the Rust core responds", async () => {
  const app = await electron.launch({
    args: [projectRoot],
    env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1" },
  });

  // Surface a main-process crash as a clear failure instead of a hang.
  let mainProcessError = null;
  app.process().stderr?.on("data", (d) => {
    const s = String(d);
    if (/SyntaxError|does not provide an export|Cannot find module|A JavaScript error occurred/.test(s)) {
      mainProcessError = s;
    }
  });

  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible({ timeout: 15000 });

  expect(mainProcessError, `main process reported a load error:\n${mainProcessError}`).toBeNull();

  await app.close();
});
