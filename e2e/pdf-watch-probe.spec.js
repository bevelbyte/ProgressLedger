// Bare webRequest probe for PDF navigations (test-only, off-screen).
// Answers: does onHeadersReceived fire for a top-level PDF navigation in
// this Electron build, on the default session and on a partition session,
// and does details carry webContentsId? The app's PDF wrapper depends on
// all three. Evidence is the debug file the driver writes.
import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const ELECTRON_EXE = join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
const WATCH_DIR = process.env.SITECOMPAT_BARE_WATCH_DIR ?? "";

test.setTimeout(180_000);

const PDF = Buffer.concat([
  Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 42 >>\nstream\nBT /F1 24 Tf 100 700 Td (Hello PDF) Tj ET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000221 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n307\n%%EOF\n"),
]);

test("webRequest sees a top-level PDF navigation", async () => {
  expect(WATCH_DIR, "SITECOMPAT_BARE_WATCH_DIR required").not.toBe("");
  expect(existsSync(WATCH_DIR), "watch driver dir missing").toBe(true);
  expect(existsSync(ELECTRON_EXE), "electron exe missing").toBe(true);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/pdf", "content-length": PDF.length });
    res.end(PDF);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const pdfUrl = `http://127.0.0.1:${port}/local.pdf`;
  const data = mkdtempSync(join(tmpdir(), "pl-v2-watch-"));
  const debugPath = join(data, "watch.jsonl");
  const probe = await electron.launch({
    executablePath: ELECTRON_EXE,
    args: [WATCH_DIR, `--user-data-dir=${data}`],
    env: { ...process.env, SITECOMPAT_WATCH_DEBUG: debugPath },
  });
  try {
    const wins = await probe.windows();
    expect(wins.length, "expected two probe windows").toBe(2);
    for (const w of wins) {
      await w.goto(pdfUrl, { timeout: 60_000, waitUntil: "domcontentloaded" }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 15000));
    const lines = existsSync(debugPath) ? readFileSync(debugPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    console.log(`PDFWATCH_EVIDENCE ${JSON.stringify({ pdfUrl, events: lines })}`);
    const headers = lines.filter((e) => e.event === "headers" && e.url === pdfUrl);
    expect(headers.length, "no onHeadersReceived event for the PDF URL").toBeGreaterThan(0);
  } finally {
    await probe.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});
