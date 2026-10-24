// R5 — capture the REAL embedded browser in the REAL Electron window.
//
// WebContentsView is native and paints above the renderer, so a Playwright DOM
// screenshot alone is not sufficient. This harness drives Progress Ledger through
// its own profile/workspace controls and captures the top-level desktop window.
// It writes only new, uniquely named files under shots/r5 and refuses overwrite.

import { _electron as electron, expect } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import http from "node:http";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "shots", "r5");
const prefix = process.env.PROGRESSLEDGER_V2_R5_SHOT_PREFIX ?? "capture";
if (!/^[a-z0-9-]+$/i.test(prefix)) throw new Error("Invalid R5 screenshot prefix");
mkdirSync(outDir, { recursive: true });

const absentDonutDir = join(tmpdir(), `cf-r5-donut-absent-${process.pid}`);
if (existsSync(absentDonutDir)) throw new Error(`Refusing to reuse existing temporary Donut settings path: ${absentDonutDir}`);
const fixtureTitle = "Minimum Vertex Cover in Scheduled Course Timetables";
const hangingResponses = new Set();
const requestPaths = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  requestPaths.push(url.pathname);
  if (url.pathname === "/hang") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.write("<!doctype html><html><head><title>R5 loading fixture</title></head><body><h1>Loading fixture</h1>");
    hangingResponses.add(res);
    res.on("close", () => hangingResponses.delete(res));
    return;
  }
  if (url.pathname !== "/article") {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${fixtureTitle}</title>
<style>body{font:16px/1.65 system-ui,sans-serif;color:#252525;max-width:820px;margin:36px auto;padding:0 34px}h1{font-size:32px;line-height:1.15}h2{font-size:22px;margin-top:32px}p{max-width:72ch;color:#454545}</style></head>
<body><p>arXiv.org · Preprint · arXiv</p><h1>${fixtureTitle}</h1>
<p>Course scheduling reduces to minimum vertex cover on the conflict graph: two courses sharing a slot are adjacent, and a cover is a set of slots to drop so that no conflict survives.</p>
<h2>1. The reduction</h2><p>Given a set of courses and a set of candidate slots, build a graph whose vertices are courses and whose edges join any two courses that cannot co-occur. A valid timetable retains a set of vertices that contains no edge — an independent set — so the slots we must drop form a vertex cover.</p>
<h2>2. On the approximation ratio</h2><p>The reduction is exact in both directions: every timetable corresponds to a cover of the same size, and every cover yields a timetable. This is what makes the problem tractable rather than merely similar to it.</p></body></html>`);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const fixtureUrl = `http://127.0.0.1:${port}/article`;
const userDataDir = mkdtempSync(join(tmpdir(), "cf-r5-browser-shots-"));
const env = {
  ...process.env,
  PROGRESSLEDGER_V2_E2E: "1",
  PROGRESSLEDGER_V2_E2E_BROWSER_NAVIGATION_TIMEOUT_MS: "10000",
  PROGRESSLEDGER_V2_DONUT_SETTINGS_DIR: absentDonutDir,
};
delete env.PROGRESSLEDGER_V2_E2E_DONUT_STUB;
delete env.PROGRESSLEDGER_V2_E2E_DONUT_MODE;

function captureWindow(hwndHex, outputPath) {
  const escapedPath = outputPath.replace(/'/g, "''");
  const hwnd = BigInt(`0x${Buffer.from(hwndHex, "hex").reverse().toString("hex")}`).toString(10);
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CfR5Win32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
}
'@
$hwnd = [IntPtr]([Int64]${hwnd})
[CfR5Win32]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 350
$rect = New-Object CfR5Win32+RECT
if (-not [CfR5Win32]::GetWindowRect($hwnd, [ref]$rect)) { throw 'GetWindowRect failed' }
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -lt 100 -or $height -lt 100) { throw "Invalid window rectangle: $width x $height" }
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $hdc = $graphics.GetHdc()
  try { $printed = [CfR5Win32]::PrintWindow($hwnd, $hdc, 2) } finally { $graphics.ReleaseHdc($hdc) }
  $visiblePixels = 0
  foreach ($point in @(@(20,20), @([Math]::Floor($width/2),20), @(20,[Math]::Floor($height/2)), @([Math]::Floor($width/2),[Math]::Floor($height/2)), @([Math]::Max(0,$width-20),[Math]::Max(0,$height-20)))) {
    $pixel = $bitmap.GetPixel([int]$point[0], [int]$point[1])
    if ($pixel.R -gt 8 -or $pixel.G -gt 8 -or $pixel.B -gt 8) { $visiblePixels++ }
  }
  if (-not $printed -or $visiblePixels -lt 3) {
    $graphics.Clear([System.Drawing.Color]::Black)
    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
    $visiblePixels = 0
    foreach ($point in @(@(20,20), @([Math]::Floor($width/2),20), @(20,[Math]::Floor($height/2)), @([Math]::Floor($width/2),[Math]::Floor($height/2)), @([Math]::Max(0,$width-20),[Math]::Max(0,$height-20)))) {
      $pixel = $bitmap.GetPixel([int]$point[0], [int]$point[1])
      if ($pixel.R -gt 8 -or $pixel.G -gt 8 -or $pixel.B -gt 8) { $visiblePixels++ }
    }
  }
  if ($visiblePixels -lt 3) { throw 'Both PrintWindow and desktop capture appear black; refusing to record invalid visual evidence' }
  $bitmap.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output ("captured=" + $width + "x" + $height + "; visibleSamples=" + $visiblePixels)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}`;
  const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`Window capture failed: ${result.stderr || result.stdout}`);
  console.log(result.stdout.trim());
}

let app;
try {
  app = await electron.launch({ args: [root, `--user-data-dir=${userDataDir}`], env });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 1000));
  await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();

  const profileId = await win.evaluate(async () => {
    const result = await window.progressLedger.profiles.add("R5 Visual Acceptance", "r5-visual-acceptance");
    const profile = result?.profile || result;
    return profile?.id ?? profile?.profileId ?? (typeof result === "number" ? result : null);
  });
  if (profileId == null) throw new Error("Could not create the isolated R5 test profile");
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();
  await win.locator('button.nav-item:has-text("Profiles")').first().click();
  const profileCard = win.locator("button.profile-main").first();
  await profileCard.waitFor({ state: "visible", timeout: 15_000 });
  await profileCard.click();
  await expect.poll(() => win.locator(".ctx-chip-wrap.active .ctx-chip").textContent()).toContain("Study");
  await win.locator('[data-ctx="operator"]').click();
  await expect(win.locator('[data-ctx="operator"]')).toHaveAttribute("aria-selected", "true");

  const newTab = win.locator('button[aria-label="New tab"]');
  if (await newTab.count()) {
    await newTab.first().click();
    await win.getByRole("menuitem", { name: "New web page" }).click();
  } else {
    // Initial baseline only: the pre-R5 tree has the old direct button.
    await win.locator('button[aria-label="New web page"]').first().click();
  }
  await expect(win.locator('[data-testid="browser-surface"]')).toBeVisible();
  await win.locator('[data-testid="browser-address"]').fill(fixtureUrl);
  await win.locator('[data-testid="browser-go"]').click();
  await expect(win.locator('[data-testid="browser-title"]')).toHaveText(fixtureTitle, { timeout: 20_000 });
  await expect.poll(() => app.evaluate(() => globalThis.__cfBrowserE2E?.debugSnapshot()?.pages?.filter((p) => p.visible).length ?? 0)).toBe(1);
  await win.getByTestId("research-save-source").click();
  await expect(win.getByTestId("research-save-source")).toBeDisabled();
  await win.waitForTimeout(450);

  const nativeHandle = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().toString("hex"));
  const captureNamedState = async (name, condition) => {
    await expect(condition).toBeVisible({ timeout: 15_000 });
    await win.waitForTimeout(300);
    const target = join(outDir, `${prefix}-${name}.png`);
    if (existsSync(target)) throw new Error(`Refusing to overwrite existing screenshot: ${target}`);
    captureWindow(nativeHandle, target);
    console.log(`screenshot=${target}; state=${name}`);
  };

  for (const [width, height, name] of [[1600, 1000, "wide"], [1180, 820, "narrow"]]) {
    if (name === "wide") {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 1000));
    } else {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1180, 820));
    }
    await win.waitForTimeout(900);
    const target = join(outDir, `${prefix}-browser-page-${name}.png`);
    if (existsSync(target)) throw new Error(`Refusing to overwrite existing screenshot: ${target}`);
    captureWindow(nativeHandle, target);
    console.log(`screenshot=${target}; contentSize=${width}x${height}; state=ready; url=${new URL(fixtureUrl).origin}/article`);
  }

  // The Research screenshots use a real profile and the real SQLite/IPC bridge.
  // Capture the ledger, explicit return to the existing source page, persisted
  // passage/count, and Space Bunny Margin mode without replacing prior evidence.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 1000));
  await win.evaluate(() => window.dispatchEvent(new CustomEvent("cf:navigate", { detail: { view: "research-ledger" } })));
  await expect(win.getByTestId("research-ledger-page")).toBeVisible();
  await expect(win.locator("[data-source-id]")).toHaveCount(1);
  await captureNamedState("research-ledger-wide", win.getByTestId("research-ledger-page"));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1180, 820));
  await captureNamedState("research-ledger-narrow", win.getByTestId("research-ledger-page"));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 1000));

  await win.locator("[data-source-id] button").first().click();
  await expect(win.getByTestId("browser-surface")).toBeVisible();
  await expect(win.getByTestId("browser-page-id")).toHaveAttribute("data-page-id", /^bp-/);
  await expect(win.locator('[data-testid="research-kept-count"]')).toBeAttached();
  await expect(win.getByTestId("research-return")).toBeVisible();
  await captureNamedState("research-returned-source", win.getByTestId("browser-surface"));

  await win.getByTestId("research-return").click();
  await expect(win.getByTestId("research-ledger-page")).toBeVisible();
  const passage = win.getByTestId("research-passage-text");
  await passage.fill("A saved passage captured during R5 visual acceptance.");
  await win.getByTestId("research-keep-passage").click();
  await expect(win.getByText("A saved passage captured during R5 visual acceptance.", { exact: true })).toBeVisible();
  await win.locator("[data-source-id] button").first().click();
  await expect(win.getByTestId("research-kept-count")).toHaveText("1 kept");
  await captureNamedState("research-kept-count", win.getByTestId("research-kept-count"));

  await win.getByTestId("research-return").click();
  await expect(win.getByTestId("research-ledger-page")).toBeVisible();
  // The margin must be bound to the actual browser-page tab, not to the ledger
  // tab that happened to be active after saving. Splitting while the ledger is
  // active produces two ledger panes and does not exercise the page-bound margin.
  await win.locator(`[data-pane-tab]`).filter({ hasText: fixtureTitle }).first().click();
  await expect(win.getByTestId("browser-surface")).toBeVisible();
  await win.getByRole("button", { name: "Split pane vertically" }).click();
  await expect(win.locator('[data-pane-id]')).toHaveCount(2);
  // Splitting can leave the same page active in both pane records. Select the
  // ledger tab in the other pane so the margin-mode page can follow the actual
  // content pane while its sibling shows the Research ledger.
  const ledgerTabs = win.locator('[data-pane-id] [data-pane-tab][data-view="research-ledger"]');
  if (!(await ledgerTabs.count())) throw new Error("The split did not preserve an available Research ledger tab");
  await ledgerTabs.last().click();
  const paneModes = win.locator('[data-pane-id] select[aria-label="Pane mode"]');
  const paneLabels = await win.locator('[data-pane-id]').evaluateAll((panes) => panes.map((pane) => ({
    id: pane.getAttribute("data-pane-id"),
    page: pane.querySelector('[data-view="page"][aria-selected="true"]') !== null,
  })));
  const marginIndex = paneLabels.findIndex((pane) => !pane.page);
  if (marginIndex < 0) throw new Error("Could not identify a pane that does not own the active page for Margin acceptance");
  await paneModes.nth(marginIndex).selectOption("margin");
  await expect(win.locator('[data-pane-id][data-pane-mode="margin"]')).toBeVisible();
  await expect(win.locator('[data-pane-id][data-pane-mode="margin"] [data-testid="research-ledger-page"]')).toBeVisible();
  await captureNamedState("research-margin", win.locator('[data-pane-id][data-pane-mode="margin"] [data-testid="research-ledger-page"]'));

  console.log(`fixtureRequests=${requestPaths.join(",")}`);
  console.log("R5 required Research screenshot capture complete. Existing references were read only.");
} finally {
  try { await app?.close(); } catch {}
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  // Only remove the uniquely created temporary profile and the unique absent
  // Donut path used by this capture run; no existing user data is touched.
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(absentDonutDir, { recursive: true, force: true });
}
