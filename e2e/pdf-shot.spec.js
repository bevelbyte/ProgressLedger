// PDF render probe (test-only, not shipped). Loads the local PDF in the
// bare engine window, waits for the viewer to attach, and captures the
// page bitmap (webContents capture, off-screen) so rendering can be
// verified instead of inferred from DOM markers alone.
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
const SHOT_PATH = process.env.PDF_SHOT_PATH || "";

test.setTimeout(300_000);

function buildPdf() {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length 44 >>\nstream\nBT /F1 24 Tf 100 700 Td (Hello PDF) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const offsets = [0];
  let out = "%PDF-1.4\n";
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

test("pdf render probe", async () => {
  test.skip(!process.env.SITECOMPAT_BARE_DIR, "SITECOMPAT_BARE_DIR not set (diagnostic probe)");
  test.skip(!SHOT_PATH, "PDF_SHOT_PATH not set");
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
  const origin = `http://127.0.0.1:${port}`;
  const bareData = mkdtempSync(join(tmpdir(), "pl-v2-pdfshot-bare-"));
  const bare = await electron.launch({ executablePath: ELECTRON_EXE, args: [BARE_DIR, `--user-data-dir=${bareData}`] });
  try {
    const page = await bare.firstWindow();
    await page.goto(`${origin}/local.pdf`, { timeout: 60_000, waitUntil: "domcontentloaded" });
    let info = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      info = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        contentType: document.contentType,
        embeds: document.querySelectorAll("embed").length,
        embedTypes: [...document.querySelectorAll("embed")].map((e) => e.getAttribute("type")),
      }));
      if (info.embeds > 0 || info.title) break;
      await page.waitForTimeout(2000);
    }
    console.log(`PDF_SHOT_EVIDENCE ${JSON.stringify(info)}`);
    await page.screenshot({ path: SHOT_PATH });
    console.log(`PDF_SHOT_EVIDENCE ${JSON.stringify({ shot: SHOT_PATH })}`);
  } finally {
    await bare.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});
