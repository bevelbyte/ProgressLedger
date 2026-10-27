// PDF viewer root-cause probe v2 (test-only, not shipped).
//
// The v1 probe's test PDF was malformed: its content stream declared
// /Length 44 but held 42 bytes, so the "viewer never renders" result was
// tainted — a strict reader fails on the overrun stream. This probe
// serves a CORRECT minimal PDF (Length 42, xref offsets verified) and
// separates the three questions v1 conflated:
//   (a) bare engine: is the viewer component even present
//       (navigator.pdfViewerEnabled), and does it render?
//   (b) app view: does the navigation commit to the PDF document, or
//       does the browser download it into the profile's download folder?
//   (c) capture: what does research.capturePage save for a PDF page?
// The app view is observed only through browser:state, the E2E-only
// main-process snapshot, the profile's tmp download folder, and the
// research ledger's listCaptures (field names and lengths only, never
// captured content).
import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const BARE_DIR = process.env.SITECOMPAT_BARE_DIR || "";
const ELECTRON_EXE = join(projectRoot, "node_modules", "electron", "dist", "electron.exe");

test.setTimeout(600_000);

// Minimal one-page PDF. Stream content is exactly 42 bytes:
// "BT /F1 24 Tf 100 700 Td (Hello PDF) Tj ET\n" — declared /Length 42.
function buildPdf() {
  const parts = [];
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

async function launchApp(userDataDir) {
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
  const wsId = await win.evaluate(async () => {
    const created = await window.progressLedger.profiles.add("PDF Viewer 2", "pdf-viewer-2");
    const p = created?.profile || created;
    return p?.id ?? p?.profileId ?? null;
  });
  expect(wsId, "workspace profile creation returned no id").not.toBe(null);
  return { app, win, wsId: Number(wsId) };
}

test("pdf viewer root-cause probe v2", async () => {
  test.skip(!process.env.SITECOMPAT_BARE_DIR, "SITECOMPAT_BARE_DIR not set (diagnostic probe)");
  const pdf = buildPdf();
  const { origin, close } = await startServer(pdf);
  const pdfUrl = `${origin}/local.pdf`;

  // ---- Part A: bare engine, full DOM access ----
  expect(BARE_DIR, "SITECOMPAT_BARE_DIR required").not.toBe("");
  expect(existsSync(BARE_DIR), "bare driver dir missing").toBe(true);
  const bareData = mkdtempSync(join(tmpdir(), "pl-v2-pdf2-bare-"));
  const bare = await electron.launch({ executablePath: ELECTRON_EXE, args: [BARE_DIR, `--user-data-dir=${bareData}`] });
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
    console.log(`PDF2_EVIDENCE ${JSON.stringify({ case: "pdf-bare", ...info, console: consoleLines.slice(0, 10), pageErrors: pageErrors.slice(0, 5), shot })}`);
  } finally {
    await bare.close().catch(() => {});
  }

  // ---- Part B: app view — commit vs download, plus capture ----
  const userDataDir = mkdtempSync(join(tmpdir(), "pl-v2-pdf2-"));
  const downloadDir = mkdtempSync(join(tmpdir(), "pl-v2-pdf2-dl-"));
  const { app, win, wsId } = await launchApp(userDataDir);
  try {
    const probe = await win.evaluate((id) => window.progressLedger.browser.createProfile(id, "PDF2 Probe", null, null, null), wsId);
    const probeLocalId = probe?.profile?.localId ?? probe?.localId ?? null;
    expect(probeLocalId, "probe profile creation returned no localId").not.toBe(null);
    const rows = await win.evaluate((id) => window.progressLedger.browser.listProfiles(id), wsId);
    const row = (rows?.profiles ?? []).find((p) => p.localId === probeLocalId);
    expect(row, "probe profile row missing").toBeTruthy();
    const updated = await win.evaluate(
      ({ wsId: id, localId, row: r, downloadDir: dl }) =>
        window.progressLedger.browser.updateProfile(id, localId, {
          displayName: r.displayName,
          color: r.color ?? null,
          icon: r.icon ?? null,
          notes: r.notes ?? "",
          proxyMode: r.proxyMode,
          proxyHost: r.proxyHost ?? null,
          proxyPort: r.proxyPort ?? null,
          proxyUsername: r.proxyUsername ?? null,
          proxyPassword: null,
          proxyBypass: r.proxyBypass ?? "<local>",
          language: r.language ?? null,
          userAgentPreset: r.userAgentPreset ?? null,
          webrtcPolicy: r.webrtcPolicy,
          permissionsAllow: r.permissionsAllow ?? "[]",
          gpc: r.gpc,
          dnt: r.dnt,
          blockThirdPartyCookies: r.blockThirdPartyCookies,
          clearOnClose: r.clearOnClose,
          downloadDir: dl,
          startPages: r.startPages ?? "",
        }),
      { wsId, localId: probeLocalId, row, downloadDir },
    );
    expect(updated?.ok, "probe profile downloadDir update failed").toBe(true);

    const created = await win.evaluate(
      async ({ wsId: id, url, browserProfileId: bp }) => {
        const res = await window.progressLedger.browser.createPage({ profileId: id, url, browserProfileId: bp });
        return { ok: res?.ok === true, reason: res?.reason ?? null, pageId: res?.page?.id ?? null };
      },
      { wsId, url: pdfUrl, browserProfileId: probeLocalId },
    );
    let live = null;
    let snapPage = null;
    if (created.pageId) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const state = await win.evaluate(() => window.progressLedger.browser.state());
        live = (state?.pages ?? []).find((p) => p?.id === created.pageId) ?? null;
        if (live && live.url === pdfUrl) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      const snap = await app.evaluate(() => {
        try {
          return globalThis.__cfBrowserE2E.debugSnapshot();
        } catch (e) {
          return { error: String(e?.message ?? e).slice(0, 200) };
        }
      }).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }));
      snapPage = (snap?.pages ?? []).find((p) => p?.id === created.pageId) ?? null;
    }
    // Let any download finish, then look in the profile's tmp folder.
    await new Promise((r) => setTimeout(r, 5000));
    const downloaded = readdirSync(downloadDir);
    // RE-READ after the wait: the poll above breaks as soon as the
    // record's (creation) URL equals the PDF URL, so `live`/`snapPage`
    // are from ~1s after creation -- before the wrapper chain runs.
    // The wrapper replaces the live URL, so only a fresh read proves
    // whether it loaded.
    if (created.pageId) {
      const state2 = await win.evaluate(() => window.progressLedger.browser.state());
      const live2 = (state2?.pages ?? []).find((p) => p?.id === created.pageId) ?? null;
      if (live2) live = live2;
      const snap2 = await app.evaluate(() => {
        try {
          return globalThis.__cfBrowserE2E.debugSnapshot();
        } catch (e) {
          return { error: String(e?.message ?? e).slice(0, 200) };
        }
      }).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }));
      const snapPage2 = (snap2?.pages ?? []).find((p) => p?.id === created.pageId) ?? null;
      if (snapPage2) snapPage = snapPage2;
    }
    // Ground truth beyond the record: the WebContents' ACTUAL current
    // URL (the record's url is the creation URL and may never update)
    // plus a screenshot of the app window itself.
    let appShot = null;
    try {
      const buf = await win.screenshot({ timeout: 30_000 });
      appShot = { bytes: buf.length };
    } catch (e) {
      appShot = { bytes: 0, error: String(e?.message ?? e).slice(0, 120) };
    }
    console.log(
      `PDF2_EVIDENCE ${JSON.stringify({ case: "pdf-app-view", createOk: created.ok, createReason: created.reason, liveUrl: live?.url ?? null, snapLiveUrl: snapPage?.liveUrl ?? null, liveTitle: live?.title ?? null, state: snapPage?.state ?? live?.state ?? null, lastError: snapPage?.lastError ?? live?.lastError ?? null, attached: snapPage?.attached ?? null, visible: snapPage?.visible ?? null, downloaded, appShot })}`,
    );

    // Capture page: what does research.capturePage save for a PDF page?
    let capture = null;
    let captures = null;
    if (created.pageId) {
      capture = await win.evaluate(
        async ({ wsId: id, pageId }) => {
          try {
            const res = await window.progressLedger.research.capturePage(Number(id), pageId);
            return { ok: res?.ok === true, reason: res?.reason ?? null, keys: res ? Object.keys(res).slice(0, 12) : [] };
          } catch (e) {
            return { ok: false, reason: "threw", detail: String(e?.message ?? e).slice(0, 200) };
          }
        },
        { wsId, pageId: created.pageId },
      );
      captures = await win.evaluate(async (id) => {
        try {
          const res = await window.progressLedger.research.listCaptures(Number(id));
          const list = res?.captures ?? res ?? [];
          const arr = Array.isArray(list) ? list : [];
          return arr.slice(-3).map((c) => ({
            keys: Object.keys(c ?? {}).slice(0, 12),
            kind: c?.kind ?? c?.type ?? null,
            title: typeof c?.title === "string" ? c.title.slice(0, 80) : null,
            url: typeof c?.url === "string" ? c.url.slice(0, 80) : null,
            textLength: typeof c?.text === "string" ? c.text.length : typeof c?.content === "string" ? c.content.length : null,
          }));
        } catch (e) {
          return { error: String(e?.message ?? e).slice(0, 200) };
        }
      }, wsId);
    }
    console.log(`PDF2_EVIDENCE ${JSON.stringify({ case: "pdf-capture", capture, captures })}`);
  } finally {
    await app.close().catch(() => {});
  }
  await close();
});
