// PDF viewer mechanism proof (test-only, not shipped).
//
// Same valid PDF as pdf-viewer2, but in a bare Electron window built
// with webPreferences.plugins = true. If the viewer attaches here
// (an <embed type="application/pdf"> appears) while the plugins:false
// window showed none, the root cause is proven: the viewer component
// exists, it was only never enabled.
import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const BARE_PLUGINS_DIR = process.env.PDF_PLUGINS_BARE_DIR || "";
const ELECTRON_EXE = join(projectRoot, "node_modules", "electron", "dist", "electron.exe");

test.setTimeout(300_000);

function buildPdf() {
  const offsets = [0];
  let out = "%PDF-1.4\n";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length 42 >>\nstream\nBT /F1 24 Tf 100 700 Td (Hello PDF) Tj ET\nendstream",
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

test("pdf viewer attaches with plugins enabled", async () => {
  test.skip(!process.env.PDF_PLUGINS_BARE_DIR, "PDF_PLUGINS_BARE_DIR not set (diagnostic probe)");
  const pdf = buildPdf();
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
  const pdfUrl = `http://127.0.0.1:${port}/local.pdf`;
  expect(BARE_PLUGINS_DIR, "PDF_PLUGINS_BARE_DIR required").not.toBe("");
  expect(existsSync(BARE_PLUGINS_DIR), "plugins bare driver dir missing").toBe(true);
  const bareData = mkdtempSync(join(tmpdir(), "pl-v2-pdfplugins-"));
  const bare = await electron.launch({ executablePath: ELECTRON_EXE, args: [BARE_PLUGINS_DIR, `--user-data-dir=${bareData}`] });
  try {
    const page = await bare.firstWindow();
    const consoleLines = [];
    const pageErrors = [];
    page.on("console", (m) => consoleLines.push(`${m.type()}:${String(m.text()).slice(0, 200)}`));
    page.on("pageerror", (e) => pageErrors.push(String(e?.message ?? e).slice(0, 200)));
    await page.goto(pdfUrl, { timeout: 60_000, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(8000);
    const info = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      contentType: document.contentType,
      pdfViewerEnabled: navigator.pdfViewerEnabled,
      embeds: [...document.querySelectorAll("embed")].map((e) => ({ type: e.getAttribute("type"), src: (e.getAttribute("src") ?? "").slice(0, 80) })),
      objects: document.querySelectorAll("object").length,
      bodyChildren: document.body ? document.body.childElementCount : -1,
      bodyTextLength: document.body ? (document.body.innerText ?? "").length : -1,
    }));
    let shot = null;
    try {
      const buf = await page.screenshot({ timeout: 15_000 });
      shot = { bytes: buf.length, saved: true };
    } catch (e) {
      shot = { bytes: 0, saved: false, error: String(e?.message ?? e).slice(0, 120) };
    }
    console.log(`PDFPLUGINS_EVIDENCE ${JSON.stringify({ ...info, console: consoleLines.slice(0, 10), pageErrors: pageErrors.slice(0, 5), shot })}`);
    expect(info.embeds.length, "viewer did not attach even with plugins:true").toBeGreaterThan(0);
  } finally {
    await bare.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});
