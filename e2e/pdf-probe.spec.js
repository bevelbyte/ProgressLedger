// PDF viewer probe (test-only, not shipped). The public W3C dummy.pdf URL
// used by the first site-compat run is dead (it returns a W3C "Page Not
// Found" page), so this probe serves a minimal valid PDF locally and
// checks the app view loads it and the engine window shows the viewer.
import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const BARE_DIR = process.env.SITECOMPAT_BARE_DIR || "";
const ELECTRON_EXE = join(projectRoot, "node_modules", "electron", "dist", "electron.exe");

test.setTimeout(300_000);


function buildPdf() {
  const parts = [];
  const offsets = [0];
  let out = "%PDF-1.4\n";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length 44 >>\nstream\nBT /F1 24 Tf 100 700 Td (Hello PDF) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function startServer(pdf) {
  const server = http.createServer((req, res) => {
    if (req.url === "/local.pdf") {
      res.writeHead(200, { "content-type": "application/pdf", "content-length": pdf.length });
      res.end(pdf);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("pdf viewer probe", async () => {
  test.skip(!process.env.SITECOMPAT_BARE_DIR, "SITECOMPAT_BARE_DIR not set (diagnostic probe)");
  const pdf = buildPdf();
  const { origin, close } = await startServer(pdf);
  const userDataDir = mkdtempSync(join(tmpdir(), "pl-v2-pdf-"));
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1", PROGRESSLEDGER_V2_E2E_USER_DATA: userDataDir },
  });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
    await win.reload();
    await win.waitForLoadState("domcontentloaded");
    await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible({ timeout: 60_000 });
    const wsId = await win.evaluate(async () => {
      const created = await window.progressLedger.profiles.add("PDF Probe", "pdf-probe");
      const p = created?.profile || created;
      return p?.id ?? p?.profileId ?? null;
    });
    expect(wsId, "workspace profile creation returned no id").not.toBe(null);
    const created = await win.evaluate(
      async ({ wsId: id, url }) => {
        const res = await window.progressLedger.browser.createPage({ profileId: id, url });
        return { ok: res?.ok === true, pageId: res?.page?.id ?? null };
      },
      { wsId, url: `${origin}/local.pdf` },
    );
    let live = null;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const state = await win.evaluate(() => window.progressLedger.browser.state());
      live = (state?.pages ?? []).find((p) => p?.id === created.pageId) ?? null;
      if (live && live.url && live.url !== "about:blank" && live.title) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log(`PDF_EVIDENCE ${JSON.stringify({ case: "pdf-app-view", createOk: created.ok, liveUrl: live?.url ?? null, liveTitle: live?.title ?? null, loaded: Boolean(live?.url && live?.title) })}`);
  } finally {
    await app.close().catch(() => {});
  }

  expect(BARE_DIR, "SITECOMPAT_BARE_DIR required").not.toBe("");
  expect(existsSync(BARE_DIR), "bare driver dir missing").toBe(true);
  const bareData = mkdtempSync(join(tmpdir(), "pl-v2-pdf-bare-"));
  const bare = await electron.launch({ executablePath: ELECTRON_EXE, args: [BARE_DIR, `--user-data-dir=${bareData}`] });
  try {
    const page = await bare.firstWindow();
    await page.goto(`${origin}/local.pdf`, { timeout: 60_000, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5000);
    const info = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      contentType: document.contentType,
      embeds: [...document.querySelectorAll("embed")].map((e) => e.getAttribute("type")),
      objects: document.querySelectorAll("object").length,
    }));
    console.log(`PDF_EVIDENCE ${JSON.stringify({ case: "pdf-engine", ...info })}`);
  } finally {
    await bare.close().catch(() => {});
  }
  await close();
});
