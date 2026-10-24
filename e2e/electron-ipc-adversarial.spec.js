import { test, expect, _electron as electron } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function makeServer() {
  return http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (path === "/child") {
      res.end("<!doctype html><title>child</title><h1>child</h1>");
      return;
    }
    res.end("<!doctype html><title>parent</title><iframe src='/child'></iframe>");
  });
}

test("real Electron IPC rejects an untrusted renderer sender", async () => {
  const server = makeServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-ipc-adversarial-"));
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1", PROGRESSLEDGER_V2_E2E_DISABLE_SYSTEM_FALLBACK: "1" },
    timeout: 60000,
  });
  try {
    await app.firstWindow();
    const attacker = await app.evaluate((_electron, { url }) => {
      const { BrowserWindow } = process.getBuiltinModule("module")
        .createRequire(process.cwd() + "/shell/src/main.js")("electron");
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: process.cwd() + "/e2e/fixtures/ipc-attacker-preload.cjs",
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: true,
          sandbox: false,
        },
      });
      void window.loadURL(url);
      return window.id;
    }, { url: `http://127.0.0.1:${port}/` });

    const page = await app.waitForEvent("window", { timeout: 10000 }).catch(() => null);
    // The existing application window is the first window. Locate the attacker
    // by its navigation URL so this remains robust to BrowserWindow ordering.
    const attackerWindow = page || (await (async () => {
      for (const candidate of app.windows()) {
        if (candidate !== (await app.firstWindow()) && candidate.url().includes(`127.0.0.1:${port}`)) return candidate;
      }
      return null;
    })());
    expect(attacker).toBeGreaterThan(0);
    expect(attackerWindow).not.toBeNull();

    await expect.poll(async () => attackerWindow.title(), { timeout: 10000 })
      .toBe("main:unknown-origin");
    // The same real preload runs inside the untrusted child frame. Verify the
    // child frame's own ipcRenderer.invoke is rejected by the privileged IPC
    // boundary; this is genuine child-frame E2E, not a direct primitive call.
    const iframe = attackerWindow.locator("iframe");
    await expect(iframe).toHaveCount(1, { timeout: 10000 });
    const childFrame = await iframe.contentFrame();
    expect(childFrame).toBeTruthy();
    await expect.poll(() => childFrame.locator("title").textContent(), { timeout: 10000 })
      .toBe("child:untrusted-frame");
  } finally {
    await app.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});
