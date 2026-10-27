// Open local files, real app, off-screen E2E (test-only).
// The native dialog itself cannot be driven by Playwright, so the spec
// proves everything around it: the address bar refuses a typed file path
// with the Open file message (never the bogus https://file///... URL),
// the bar button and menu item exist, and the viewer + serving work with
// real files through the E2E-only mint (main-process only, never an IPC
// channel, never reachable from the renderer). Opening a file writes
// nothing to the ledger: no capture or save call is made anywhere here.
import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

test.setTimeout(300_000);

const START_HTML = `<!doctype html>\n<html><head><meta charset="utf-8"><title>Local Start</title></head>\n<body><h1>local start page</h1></body></html>\n`;

// Minimal valid PDF, xref offsets computed from the real byte lengths
// (verified standalone before this spec was written: every xref offset
// lands on its "N 0 obj" header and /Length equals the stream bytes).
function makeMinimalPdf() {
  const stream = "BT /F1 24 Tf 100 700 Td (Hello) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

// 1x1 transparent PNG (signature + IHDR 1x1 verified standalone).
const PNG_1X1 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02,
  0x00, 0x01, 0xe2, 0x27, 0xc7, 0x7d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
]);

async function launch(userDataDir) {
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1", PROGRESSLEDGER_V2_E2E_USER_DATA: userDataDir },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.evaluate(() => localStorage.setItem("progressledger_v2_onboarding_complete", "true"));
  await win.reload();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible({ timeout: 60_000 });
  return { app, win };
}

async function createWorkspace(win, name, slug) {
  const wsId = await win.evaluate(async ({ name: n, slug: s }) => {
    const created = await window.progressLedger.profiles.add(n, s);
    const p = created?.profile || created;
    return p?.id ?? p?.profileId ?? null;
  }, { name, slug });
  expect(wsId, "workspace profile creation returned no id").not.toBe(null);
  return Number(wsId);
}

// The E2E-only mint: main-process seam, never an IPC channel. The spec
// reaches it through app.evaluate (main process), never through the
// renderer bridge, so no preload channel exists for it.
// NOTE: app.evaluate calls the function as fn(electronModule, arg) —
// the Electron module is the FIRST parameter (proven by probe-eval),
// the value passed is the second. A single-parameter fn receives the
// module, not the path.
async function mint(app, filePath) {
  return app.evaluate(
    (electron, p) => globalThis.__cfBrowserE2E.openLocalFileForTest(p),
    filePath,
  );
}

// Serve proof through Electron's net (default session): the renderer
// cannot fetch these URLs (its CSP is connect-src 'self' for the app
// origin), but main-process net.fetch routes through the protocol
// handler that shares the mint store. Bytes come back as a plain
// number array — no Buffer, no require in this context.
async function fetchViaMain(app, fileUrl) {
  return app.evaluate(async (electron, url) => {
    const res = await electron.net.fetch(url);
    const bytes = Array.from(new Uint8Array(await res.arrayBuffer()));
    return { status: res.status, contentType: res.headers.get("content-type"), bytes };
  }, fileUrl);
}

async function createPage(win, wsId, url) {
  const created = await win.evaluate(
    async ({ wsId: id, pageUrl }) => {
      const res = await window.progressLedger.browser.createPage({ profileId: id, url: pageUrl });
      return { ok: res?.ok === true, reason: res?.reason ?? null, detail: res?.detail ?? null, pageId: res?.page?.id ?? null };
    },
    { wsId, pageUrl: url },
  );
  expect(created.ok, `createPage for ${url} failed: ${created.reason} detail=${created.detail}`).toBe(true);
  return created.pageId;
}

async function pollPage(win, pageId, predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const state = await win.evaluate(() => window.progressLedger.browser.state());
    last = (state?.pages ?? []).find((p) => p?.id === pageId) ?? null;
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${label}; last page state: ${JSON.stringify(last)}`);
}

test("address bar refuses a typed file path, and Open file is offered", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(START_HTML);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const startUrl = `http://127.0.0.1:${port}/`;
  const userDataDir = mkdtempSync(join(tmpdir(), "pl-v2-localfile-"));
  const { app, win } = await launch(userDataDir);
  try {
    const wsId = await createWorkspace(win, "Local File", "local-file");
    await win.reload();
    await win.waitForLoadState("domcontentloaded");
    await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible({ timeout: 60_000 });
    await win.getByRole("button", { name: "Profiles", exact: true }).first().click();
    const card = win.locator("button.profile-main").first();
    await card.waitFor({ state: "visible", timeout: 10_000 });
    await card.click();
    await expect
      .poll(
        async () =>
          win.evaluate(() => {
            const el = document.querySelector(".ctx-chip-wrap.active .ctx-chip");
            return el ? el.textContent.replace(/\s+/g, " ").trim() : null;
          }),
        { timeout: 15_000 },
      )
      .toBe("Study");
    await win.evaluate(() => window.dispatchEvent(new CustomEvent("cf:navigate", { detail: { view: "browser-profiles" } })));
    await expect(win.getByTestId("browser-profiles")).toBeVisible({ timeout: 30_000 });
    await win.getByTestId("browser-profiles-new").click();
    await win.getByTestId("browser-profile-name").fill("LocalFile");
    await win.getByTestId("browser-profile-start-pages").fill(startUrl);
    await win.getByText("Create profile").click();
    const row = win.locator('[data-testid^="browser-profile-row-"]', { hasText: "LocalFile" });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.dblclick();
    const bar = win.locator('form[role="search"] input').first();
    await expect(bar).toBeVisible({ timeout: 30_000 });

    // The bar button and the menu item are both offered.
    await expect(win.getByTestId("browser-open-file")).toBeVisible({ timeout: 10_000 });
    await win.getByTestId("browser-profile-switcher").click();
    await expect(win.getByTestId("browser-profile-menu-open-file")).toBeVisible({ timeout: 10_000 });
    await win.keyboard.press("Escape");

    // The exact shape the user pasted: typed, never loaded as file:,
    // never rewritten to the bogus https://file///... URL.
    await bar.fill("file///C:/Users/Asus/Downloads/Diploma_Document_30-Jul-2026_04_33.pdf");
    await bar.press("Enter");
    const notice = win.getByTestId("browser-notice");
    await expect(notice).toBeVisible({ timeout: 10_000 });
    await expect(notice).toContainText("Use Open file");
    const state = await win.evaluate(() => window.progressLedger.browser.state());
    const bogus = (state?.pages ?? []).find((p) => typeof p?.url === "string" && p.url.startsWith("https://file"));
    expect(bogus, "a page navigated to the bogus https://file URL").toBe(undefined);
    console.log(`LOCALFILE_EVIDENCE ${JSON.stringify({ case: "bar-refusal", notice: true, bogus: false })}`);
  } finally {
    await app.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});

test("local files open in the viewer and serve with fixed mimes", async () => {
  const filesDir = mkdtempSync(join(tmpdir(), "pl-v2-localfile-files-"));
  const pdfPath = join(filesDir, "hello.pdf");
  const txtPath = join(filesDir, "notes.txt");
  const pngPath = join(filesDir, "dot.png");
  const pdfBytes = makeMinimalPdf();
  const txtBytes = Buffer.from("hello local file\nsecond line\n", "utf-8");
  writeFileSync(pdfPath, pdfBytes);
  writeFileSync(txtPath, txtBytes);
  writeFileSync(pngPath, PNG_1X1);

  const userDataDir = mkdtempSync(join(tmpdir(), "pl-v2-localfile-view-"));
  const { app, win } = await launch(userDataDir);
  try {
    const wsId = await createWorkspace(win, "Local File View", "local-file-view");

    const cases = [
      { path: pdfPath, title: "hello.pdf", mime: "application/pdf", bytes: pdfBytes, direct: false },
      { path: txtPath, title: "notes.txt", mime: "text/plain", bytes: txtBytes, direct: true },
      { path: pngPath, title: "dot.png", mime: "image/png", bytes: PNG_1X1, direct: true },
    ];
    for (const c of cases) {
      const minted = await mint(app, c.path);
      expect(minted?.ok, `mint for ${c.title} failed: ${JSON.stringify(minted)}`).toBe(true);
      expect(minted.viewerUrl).toMatch(/^progressledger-v2:\/\/local\/[0-9a-f-]{36}$/);
      expect(minted.fileUrl).toBe(`${minted.viewerUrl}/file`);
      expect(minted.title).toBe(c.title);
      // No path leaks into any URL the app shows.
      expect(minted.viewerUrl).not.toContain("pl-v2-localfile-files");
      expect(minted.fileUrl).not.toContain("pl-v2-localfile-files");

      // The viewer page loads with the file's name as its title.
      const pageId = await createPage(win, wsId, minted.viewerUrl);
      const page = await pollPage(
        win,
        pageId,
        (p) => p.state === "ready" && p.title === c.title && p.url === minted.viewerUrl,
        `viewer ready for ${c.title}`,
      );
      expect(page.url).toBe(minted.viewerUrl);

      // The file branch serves the exact bytes with the fixed mime.
      const served = await fetchViaMain(app, minted.fileUrl);
      expect(served.status).toBe(200);
      expect(served.contentType).toBe(c.mime);
      expect(Buffer.from(served.bytes).toString("base64")).toBe(c.bytes.toString("base64"));

      // For text and images, the file URL itself loads directly in a
      // page: that proves the partition session's file branch too, not
      // just the default session's. (PDF is skipped here on purpose:
      // top-level PDF navigation never attaches the viewer in this
      // Electron build — that is the known Task B behaviour, and the
      // PDF viewer page above is the supported path.)
      if (c.direct) {
        const directId = await createPage(win, wsId, minted.fileUrl);
        const direct = await pollPage(
          win,
          directId,
          (p) => p.state === "ready" && p.url === minted.fileUrl,
          `direct file load for ${c.title}`,
        );
        expect(direct.url).toBe(minted.fileUrl);
      }
      console.log(`LOCALFILE_EVIDENCE ${JSON.stringify({ case: "viewer", title: c.title, mime: c.mime, served: true, direct: c.direct })}`);
    }
  } finally {
    await app.close().catch(() => {});
  }
});

test("mint refuses executables and directories", async () => {
  const filesDir = mkdtempSync(join(tmpdir(), "pl-v2-localfile-refuse-"));
  const exePath = join(filesDir, "payload.exe");
  writeFileSync(exePath, "MZ");
  const userDataDir = mkdtempSync(join(tmpdir(), "pl-v2-localfile-refuse-app-"));
  const { app, win } = await launch(userDataDir);
  try {
    await createWorkspace(win, "Local File Refuse", "local-file-refuse");
    const exe = await mint(app, exePath);
    expect(exe).toEqual({ ok: false, reason: "blocked-type", detail: "Only PDF, text, and image files can be opened here." });
    const dir = await mint(app, filesDir);
    expect(dir).toEqual({ ok: false, reason: "not-a-file" });
    const missing = await mint(app, join(filesDir, "gone.pdf"));
    expect(missing).toEqual({ ok: false, reason: "not-a-file" });
    console.log(`LOCALFILE_EVIDENCE ${JSON.stringify({ case: "mint-refusals", exe: exe.reason, dir: dir.reason, missing: missing.reason })}`);
  } finally {
    await app.close().catch(() => {});
  }
});
