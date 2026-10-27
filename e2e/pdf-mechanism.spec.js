// PDF viewer mechanism probe, round 2 (test-only, not shipped).
//
// Round 1 proved plugins:true does NOT attach the viewer on navigation.
// This probe separates three mechanisms in one plugins:true bare window:
//   (a) navigate to the PDF (repeat of round 1),
//   (b) an HTML page with an explicit <embed type="application/pdf">
//       pointing at the PDF (is the plugin available at all?),
//   (c) navigate to chrome://pdf-viewer (does the viewer component load?).
// If (b) works but (a) does not, the fix is a viewer-wrapper page. If
// all three fail, the viewer is unavailable in this Electron build and
// the fallback is the download + message path.
import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const BARE_DIR = process.env.PDF_PLUGINS_BARE_DIR || "";
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

test("pdf viewer mechanism, three arms", async () => {
  test.skip(!process.env.PDF_PLUGINS_BARE_DIR, "PDF_PLUGINS_BARE_DIR not set (diagnostic probe)");
  const pdf = buildPdf();
  const server = http.createServer((req, res) => {
    if (req.url === "/local.pdf") {
      res.writeHead(200, { "content-type": "application/pdf", "content-length": pdf.length });
      res.end(pdf);
      return;
    }
    if (req.url === "/embed.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>embed test</title><embed type="application/pdf" src="/local.pdf" width="800" height="600">`);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const pdfUrl = `http://127.0.0.1:${port}/local.pdf`;
  const embedUrl = `http://127.0.0.1:${port}/embed.html`;
  expect(BARE_DIR, "PDF_PLUGINS_BARE_DIR required").not.toBe("");
  expect(existsSync(BARE_DIR), "plugins bare driver dir missing").toBe(true);
  const bareData = mkdtempSync(join(tmpdir(), "pl-v2-pdfmech-"));
  const bare = await electron.launch({ executablePath: ELECTRON_EXE, args: [BARE_DIR, `--user-data-dir=${bareData}`] });
  try {
    const page = await bare.firstWindow();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e?.message ?? e).slice(0, 200)));

    // Arm (a): navigate to the PDF.
    await page.goto(pdfUrl, { timeout: 60_000, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5000);
    const nav = await page.evaluate(() => ({
      contentType: document.contentType,
      embeds: [...document.querySelectorAll("embed")].map((e) => e.getAttribute("type")),
      bodyChildren: document.body ? document.body.childElementCount : -1,
    }));
    console.log(`PDFMECH_EVIDENCE ${JSON.stringify({ case: "navigate", ...nav })}`);

    // Arm (b): explicit embed in an HTML page.
    await page.goto(embedUrl, { timeout: 60_000, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5000);
    const emb = await page.evaluate(() => ({
      title: document.title,
      embeds: [...document.querySelectorAll("embed")].map((e) => ({ type: e.getAttribute("type"), src: (e.getAttribute("src") ?? "").slice(0, 60) })),
      bodyChildren: document.body ? document.body.childElementCount : -1,
    }));
    console.log(`PDFMECH_EVIDENCE ${JSON.stringify({ case: "explicit-embed", ...emb, pageErrors: pageErrors.slice(0, 5) })}`);

    // Arm (c): the viewer component itself.
    await page.goto("chrome://pdf-viewer", { timeout: 60_000, waitUntil: "domcontentloaded" }).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }));
    await page.waitForTimeout(3000);
    const comp = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      bodyChildren: document.body ? document.body.childElementCount : -1,
      bodyText: document.body ? (document.body.innerText ?? "").slice(0, 200) : "",
    })).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }));
    console.log(`PDFMECH_EVIDENCE ${JSON.stringify({ case: "viewer-component", ...comp })}`);
  } finally {
    await bare.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});
