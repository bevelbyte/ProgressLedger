// Site compatibility probe (test-only, not shipped).
// App arms: each site loads in the app's own browser view; the spec
// observes only the live page frame (URL/title/state/lastError) via the
// app's own browser:state channel and the E2E-only main-process snapshot
// (app.evaluate). It never reads page DOM, cookies, or credentials.
// Local cases (camera/mic denial, login form) are observed server-side:
// the probe page itself reports its outcome to the local test server.
// Deep engine checks (YouTube playback, PDF viewer, download) run in a
// bare Electron window with default settings, where Playwright can read
// the page; the app view uses the same engine and partition settings
// family, so those results are labeled "engine" in the evidence.
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


const MEDIA_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Media Probe</title></head>
<body><h1>media probe</h1>
<script>
(async () => {
  let settled = false;
  const report = async (outcome) => {
    if (settled && outcome === "no-callback") return;
    settled = true;
    try { await fetch("/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ case: "media", outcome }) }); } catch {}
  };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    stream.getTracks().forEach((t) => t.stop());
    await report("granted");
  } catch (e) {
    await report("denied:" + (e && e.name ? e.name : "error"));
  }
  setTimeout(() => report("no-callback"), 10000);
})();
</script>
</body></html>
`;

const LOGIN_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Local Login</title></head>
<body><h1>local login form</h1>
<form method="POST" action="/login">
  <label>Username <input name="username" value="test-user"></label>
  <label>Password <input name="password" type="password" value="test-password"></label>
  <button type="submit">Sign in</button>
</form>
</body></html>
`;

async function startServer() {
  const reports = { media: [], logins: [] };
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/report") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const json = JSON.parse(body);
          if (json.case === "media") reports.media.push(json.outcome);
        } catch {}
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      });
      return;
    }
    if (req.method === "POST" && req.url === "/login") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const params = new URLSearchParams(body);
        reports.logins.push({ usernamePresent: params.has("username"), passwordPresent: params.has("password") });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<!doctype html><title>Login received</title><h1>Login received</h1>");
      });
      return;
    }
    if (req.url === "/media") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(MEDIA_HTML);
      return;
    }
    if (req.url === "/login") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(LOGIN_HTML);
      return;
    }
    if (req.url === "/file.txt") {
      res.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="probe.txt"' });
      res.end("site-compat probe download\n");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, reports, close: () => new Promise((resolve) => server.close(resolve)) };
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
    const created = await window.progressLedger.profiles.add("Site Compat", "site-compat");
    const p = created?.profile || created;
    return p?.id ?? p?.profileId ?? null;
  });
  expect(wsId, "workspace profile creation returned no id").not.toBe(null);
  return { app, win, wsId: Number(wsId) };
}

async function appPage(win, app, wsId, url, browserProfileId, timeoutMs = 60_000) {
  const started = Date.now();
  const created = await win.evaluate(
    async ({ wsId: id, url: u, browserProfileId: bp }) => {
      const payload = { profileId: id, url: u };
      if (bp) payload.browserProfileId = bp;
      const res = await window.progressLedger.browser.createPage(payload);
      return { ok: res?.ok === true, reason: res?.reason ?? null, pageId: res?.page?.id ?? null };
    },
    { wsId, url, browserProfileId },
  );
  let live = null;
  let snap = null;
  if (created.pageId) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await win.evaluate(() => window.progressLedger.browser.state());
      live = (state?.pages ?? []).find((p) => p?.id === created.pageId) ?? null;
      if (live && live.url && live.url !== "about:blank" && live.title) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    snap = await app.evaluate(() => {
      try {
        const s = globalThis.__cfBrowserE2E.debugSnapshot();
        return s;
      } catch (e) {
        return { error: String(e?.message ?? e).slice(0, 200) };
      }
    }).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }));
    const snapPage = (snap?.pages ?? []).find((p) => p?.id === created.pageId);
    if (snapPage) live = { ...live, state: snapPage.state, lastError: snapPage.lastError ?? null };
  }
  return {
    url,
    createOk: created.ok,
    createReason: created.reason,
    pageId: created.pageId,
    liveUrl: live?.url ?? null,
    liveTitle: live?.title ?? null,
    state: live?.state ?? null,
    lastError: live?.lastError ?? null,
    loaded: Boolean(live && live.url && live.url !== "about:blank" && live.title),
    elapsedMs: Date.now() - started,
  };
}

test("site compatibility probe", async () => {
  test.skip(!process.env.SITECOMPAT_BARE_DIR, "SITECOMPAT_BARE_DIR not set (diagnostic probe)");
  const { origin, reports, close } = await startServer();
  const userDataDir = mkdtempSync(join(tmpdir(), "pl-v2-sitecompat-"));
  const { app, win, wsId } = await launchApp(userDataDir);
  const downloadDir = mkdtempSync(join(tmpdir(), "pl-v2-sitecompat-dl-"));
  try {
    // Probe profile with its download folder inside the test tmpdir, so a
    // download never lands in the user's real Downloads folder.
    const probe = await win.evaluate((id) => window.progressLedger.browser.createProfile(id, "Site Compat Probe", null, null, null), wsId);
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
    console.log(`SITECOMPAT_EVIDENCE ${JSON.stringify({ case: "profile-download-dir", ok: updated?.ok === true, reason: updated?.reason ?? null })}`);

    const appCases = [
      { case: "example", url: "https://example.com" },
      { case: "wikipedia", url: "https://en.wikipedia.org/wiki/Computer" },
      { case: "github", url: "https://github.com" },
      { case: "google-search", url: "https://www.google.com/search?q=progress+ledger" },
      { case: "youtube", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ" },
      { case: "pdf", url: "https://www.w3.org/WAI/ER/tests/xhtml/testsuite/resources/pdf/dummy.pdf" },
      { case: "local-login-page", url: `${origin}/login` },
      { case: "local-media-page", url: `${origin}/media` },
    ];
    for (const c of appCases) {
      const r = await appPage(win, app, wsId, c.url, probeLocalId);
      console.log(`SITECOMPAT_EVIDENCE ${JSON.stringify({ case: c.case, ...r })}`);
    }

    // Camera/mic: the probe page reports its own getUserMedia outcome.
    const mediaDeadline = Date.now() + 30_000;
    while (Date.now() < mediaDeadline && reports.media.length === 0) {
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log(`SITECOMPAT_EVIDENCE ${JSON.stringify({ case: "camera-mic", reports: reports.media.slice(0, 3) })}`);

    // Download in the app view: navigate to the attachment URL, then look
    // for the file in the profile's tmp download folder.
    const dlPage = await appPage(win, app, wsId, `${origin}/file.txt`, probeLocalId, 30_000);
    console.log(`SITECOMPAT_EVIDENCE ${JSON.stringify({ case: "download-page", ...dlPage })}`);
    let downloaded = [];
    const dlDeadline = Date.now() + 30_000;
    while (Date.now() < dlDeadline) {
      downloaded = readdirSync(downloadDir);
      if (downloaded.length > 0) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log(`SITECOMPAT_EVIDENCE ${JSON.stringify({ case: "download-app-view", files: downloaded })}`);
  } finally {
    await app.close().catch(() => {});
  }

  // Bare-engine deep checks.
  expect(BARE_DIR, "SITECOMPAT_BARE_DIR env var is required").not.toBe("");
  expect(existsSync(BARE_DIR), "bare driver dir missing").toBe(true);
  expect(existsSync(ELECTRON_EXE), "electron binary missing").toBe(true);
  const bareData = mkdtempSync(join(tmpdir(), "pl-v2-sitecompat-bare-"));
  const bare = await electron.launch({ executablePath: ELECTRON_EXE, args: [BARE_DIR, `--user-data-dir=${bareData}`] });
  try {
    const page = await bare.firstWindow();
    // YouTube playback: video time advancing, dimensions, audio decoded.
    let yt = { error: null };
    try {
      await page.goto("https://www.youtube.com/watch?v=aqz-KE-bpKQ", { timeout: 60_000, waitUntil: "domcontentloaded" });
      await page.waitForTimeout(5000);
      const video = page.locator("video").first();
      await video.waitFor({ state: "attached", timeout: 30_000 }).catch(() => {});
      const hasVideo = (await video.count()) > 0;
      if (hasVideo) {
        await video.click({ timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(5000);
        yt = await page.evaluate(() => {
          const v = document.querySelector("video");
          if (!v) return { hasVideo: false };
          return {
            hasVideo: true,
            currentTime: v.currentTime,
            videoWidth: v.videoWidth,
            paused: v.paused,
            error: v.error ? { code: v.error.code, message: v.error.message } : null,
            audioDecodedBytes: v.webkitAudioDecodedByteCount ?? null,
            readyState: v.readyState,
          };
        });
        await page.waitForTimeout(5000);
        const later = await page.evaluate(() => {
          const v = document.querySelector("video");
          return v ? { currentTime: v.currentTime, paused: v.paused, audioDecodedBytes: v.webkitAudioDecodedByteCount ?? null } : null;
        });
        yt.later = later;
        yt.advancing = later && later.currentTime > (yt.currentTime ?? 0);
      } else {
        yt = { hasVideo: false, title: await page.title().catch(() => null) };
      }
    } catch (e) {
      yt = { error: String(e?.message ?? e).slice(0, 300) };
    }
    console.log(`SITECOMPAT_EVIDENCE ${JSON.stringify({ case: "youtube-engine", ...yt })}`);

    // PDF viewer in the engine window.
    let pdf = {};
    try {
      await page.goto("https://www.w3.org/WAI/ER/tests/xhtml/testsuite/resources/pdf/dummy.pdf", { timeout: 60_000, waitUntil: "domcontentloaded" });
      await page.waitForTimeout(5000);
      pdf = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        contentType: document.contentType,
        embeds: document.querySelectorAll("embed").length,
        objects: document.querySelectorAll("object").length,
      }));
    } catch (e) {
      pdf = { error: String(e?.message ?? e).slice(0, 300) };
    }
    console.log(`SITECOMPAT_EVIDENCE ${JSON.stringify({ case: "pdf-engine", ...pdf })}`);

    // Download in the engine window (Playwright download event).
    let dl = {};
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30_000 }),
        page.goto(`${origin}/file.txt`, { timeout: 30_000, waitUntil: "domcontentloaded" }).catch(() => {}),
      ]);
      const path = await download.path().catch(() => null);
      dl = { suggestedFilename: download.suggestedFilename(), hasPath: Boolean(path) };
    } catch (e) {
      dl = { error: String(e?.message ?? e).slice(0, 300) };
    }
    console.log(`SITECOMPAT_EVIDENCE ${JSON.stringify({ case: "download-engine", ...dl })}`);

    // Local login form submission in the engine window.
    let login = {};
    try {
      await page.goto(`${origin}/login`, { timeout: 30_000, waitUntil: "domcontentloaded" });
      await page.locator('input[name="username"]').fill("test-user");
      await page.locator('input[name="password"]').fill("test-password");
      await page.locator('button[type="submit"]').click();
      await page.waitForTimeout(3000);
      login = { received: reports.logins.slice(-1), title: await page.title().catch(() => null) };
    } catch (e) {
      login = { error: String(e?.message ?? e).slice(0, 300) };
    }
    console.log(`SITECOMPAT_EVIDENCE ${JSON.stringify({ case: "login-engine", ...login })}`);
  } finally {
    await bare.close().catch(() => {});
  }
  await close();
});
