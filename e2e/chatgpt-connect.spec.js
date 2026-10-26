// ChatGPT "Unable to connect" — diagnostic probe (test-only, not shipped).
// Compares https://chatgpt.com in the app's Default profile, a brand-new
// profile with all defaults, and a temporary profile, against a bare
// Electron window with default settings (same Electron version).
// Evidence is printed as CHATGPT_EVIDENCE JSON lines. No page content,
// cookies, credentials, or message text is ever logged — only URLs,
// statuses, headers names/values the browser itself sends, and which
// UI state was observed (login wall / Unable to connect / response).
import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const TARGET = "https://chatgpt.com";
const BARE_DIR = process.env.CHATGPT_BARE_DIR || "";
const ELECTRON_EXE = join(projectRoot, "node_modules", "electron", "dist", "electron.exe");

test.setTimeout(600_000);


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
    const created = await window.progressLedger.profiles.add("ChatGPT Probe", "chatgpt-probe");
    const p = created?.profile || created;
    return p?.id ?? p?.profileId ?? null;
  });
  expect(wsId, "workspace profile creation returned no id").not.toBe(null);
  return { app, win, wsId: Number(wsId) };
}

async function listProfiles(win, wsId) {
  const res = await win.evaluate((id) => window.progressLedger.browser.listProfiles(id), wsId);
  return res?.ok ? res.profiles : [];
}

async function appArm(win, wsId, label, browserProfileId) {
  const started = Date.now();
  const created = await win.evaluate(
    async ({ wsId: id, url, browserProfileId: bp }) => {
      const payload = { profileId: id, url };
      if (bp) payload.browserProfileId = bp;
      const res = await window.progressLedger.browser.createPage(payload);
      return { ok: res?.ok === true, reason: res?.reason ?? null, pageId: res?.page?.id ?? null };
    },
    { wsId, url: TARGET, browserProfileId },
  );
  let live = null;
  if (created.pageId) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const state = await win.evaluate(() => window.progressLedger.browser.state());
      const page = (state?.pages ?? []).find((p) => p?.id === created.pageId);
      if (page && page.url && page.url.includes("chatgpt.com") && page.title) {
        live = page;
        break;
      }
      live = page ?? null;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return {
    arm: label,
    createOk: created.ok,
    createReason: created.reason,
    pageId: created.pageId,
    url: live?.url ?? null,
    title: live?.title ?? null,
    loaded: Boolean(live && live.url && live.url.includes("chatgpt.com") && live.title),
    elapsedMs: Date.now() - started,
  };
}

test("chatgpt connect probe", async () => {
  test.skip(!process.env.CHATGPT_BARE_DIR, "CHATGPT_BARE_DIR not set (diagnostic probe)");
  const userDataDir = mkdtempSync(join(tmpdir(), "pl-v2-chatgpt-"));
  const { app, win, wsId } = await launchApp(userDataDir);
  const evidence = [];
  try {
    // Arm 1: Default profile (no browserProfileId resolves to it).
    const def = await appArm(win, wsId, "app-default", null);
    const profilesAfterDef = await listProfiles(win, wsId);
    const defaultProfile = profilesAfterDef.find((p) => p.isDefault) ?? null;
    def.profileSettings = defaultProfile
      ? {
          blockThirdPartyCookies: defaultProfile.blockThirdPartyCookies ?? null,
          proxyMode: defaultProfile.proxyMode ?? null,
          userAgentPreset: defaultProfile.userAgentPreset ?? null,
          webrtcPolicy: defaultProfile.webrtcPolicy ?? null,
          language: defaultProfile.language ?? null,
          permissionsAllow: defaultProfile.permissionsAllow ?? null,
        }
      : null;
    evidence.push(def);
    console.log(`CHATGPT_EVIDENCE ${JSON.stringify(def)}`);

    // Arm 2: brand-new profile with all defaults.
    const brandNew = await win.evaluate((id) => window.progressLedger.browser.createProfile(id, "ChatGPT BrandNew", null, null, null), wsId);
    const brandNewLocalId = brandNew?.profile?.localId ?? brandNew?.localId ?? null;
    expect(brandNewLocalId, "brand-new profile creation returned no localId").not.toBe(null);
    const bn = await appArm(win, wsId, "app-brand-new", brandNewLocalId);
    const profilesAfterBn = await listProfiles(win, wsId);
    const bnProfile = profilesAfterBn.find((p) => p.localId === brandNewLocalId) ?? null;
    bn.profileSettings = bnProfile
      ? {
          blockThirdPartyCookies: bnProfile.blockThirdPartyCookies ?? null,
          proxyMode: bnProfile.proxyMode ?? null,
          userAgentPreset: bnProfile.userAgentPreset ?? null,
          webrtcPolicy: bnProfile.webrtcPolicy ?? null,
          language: bnProfile.language ?? null,
          permissionsAllow: bnProfile.permissionsAllow ?? null,
        }
      : null;
    evidence.push(bn);
    console.log(`CHATGPT_EVIDENCE ${JSON.stringify(bn)}`);

    // Arm 3: temporary profile (ephemeral partition, no tab row).
    const temp = await win.evaluate((id) => window.progressLedger.browser.createTempProfile(id, "ChatGPT Temp", null), wsId);
    const tempLocalId = temp?.profile?.localId ?? temp?.localId ?? null;
    expect(tempLocalId, "temp profile creation returned no localId").not.toBe(null);
    const tp = await appArm(win, wsId, "app-temp", tempLocalId);
    tp.temporary = true;
    evidence.push(tp);
    console.log(`CHATGPT_EVIDENCE ${JSON.stringify(tp)}`);
  } finally {
    await app.close().catch(() => {});
  }

  // Arm 4: bare Electron window, default settings, same Electron version.
  expect(BARE_DIR, "CHATGPT_BARE_DIR env var is required").not.toBe("");
  expect(existsSync(BARE_DIR), "bare driver dir missing").toBe(true);
  expect(existsSync(ELECTRON_EXE), "electron binary missing").toBe(true);
  const bareData = mkdtempSync(join(tmpdir(), "pl-v2-chatgpt-bare-"));
  const bare = await electron.launch({
    executablePath: ELECTRON_EXE,
    args: [BARE_DIR, `--user-data-dir=${bareData}`],
  });
  try {
    const page = await bare.firstWindow();
    const failed = [];
    const responses = [];
    const consoles = [];
    const pageErrors = [];
    const websockets = [];
    let docRequest = null;
    let docResponse = null;
    page.on("requestfailed", (req) => {
      failed.push({ url: req.url(), error: req.failure()?.errorText ?? null, resourceType: req.resourceType() });
    });
    page.on("response", (res) => {
      try {
        const url = res.url();
        if (url.includes("chatgpt.com") || url.includes("openai.com") || url.includes("oaistatic.com")) {
          responses.push({ url: url.slice(0, 200), status: res.status(), via: res.headers()["content-type"] ?? null });
        }
        if (res.request().resourceType() === "document" && url.includes("chatgpt.com")) {
          docResponse = { status: res.status(), csp: res.headers()["content-security-policy"] ? "present" : "absent" };
        }
      } catch {}
    });
    page.on("request", (req) => {
      if (req.resourceType() === "document" && req.url().includes("chatgpt.com") && !docRequest) {
        const h = req.headers();
        docRequest = { acceptLanguage: h["accept-language"] ?? null, userAgent: h["user-agent"] ?? null };
      }
    });
    page.on("console", (msg) => {
      const text = msg.text();
      if (/error|fail|blocked|denied|unable/i.test(text)) consoles.push({ type: msg.type(), text: text.slice(0, 300) });
    });
    page.on("pageerror", (err) => pageErrors.push(String(err?.message ?? err).slice(0, 300)));
    page.on("websocket", (ws) => {
      websockets.push({ url: ws.url().slice(0, 200) });
      ws.on("close", () => websockets.push({ url: ws.url().slice(0, 200), event: "close" }));
      ws.on("socketerror", () => websockets.push({ url: ws.url().slice(0, 200), event: "socketerror" }));
    });
    await page.goto(TARGET, { timeout: 90_000, waitUntil: "domcontentloaded" }).catch((e) => {
      failed.push({ url: TARGET, error: `goto: ${String(e?.message ?? e).slice(0, 200)}`, resourceType: "document" });
    });
    await page.waitForTimeout(8000);
    const client = await page.evaluate(async () => {
      const sw = await navigator.serviceWorker.getRegistrations().catch(() => []);
      const resources = performance.getEntriesByType("resource").map((r) => r.nextHopProtocol).filter(Boolean);
      const protocols = [...new Set(resources)];
      const cookieCount = document.cookie ? document.cookie.split(";").length : 0;
      return {
        userAgent: navigator.userAgent,
        brands: navigator.userAgentData?.brands?.map((b) => `${b.brand}/${b.version}`) ?? null,
        languages: navigator.languages,
        serviceWorkers: sw.length,
        nextHopProtocols: protocols,
        cookiePresent: cookieCount > 0,
        cookieCount,
        title: document.title,
        url: location.href,
      };
    }).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }));

    // Send attempt (anonymous): only if a composer is present.
    let composer = null;
    for (const sel of ["#prompt-textarea", 'div[contenteditable="true"]', "textarea"]) {
      const loc = page.locator(sel).first();
      if (await loc.count().then((n) => n > 0).catch(() => false)) {
        composer = sel;
        break;
      }
    }
    let send = { composer, attempted: false, observed: "no-composer" };
    if (composer) {
      try {
        await page.locator(composer).first().click({ timeout: 10_000 });
        await page.keyboard.type("Hello", { delay: 30 });
        await page.keyboard.press("Enter");
        send.attempted = true;
        await page.waitForTimeout(25_000);
        const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 4000)).catch(() => "");
        if (/Unable to connect/i.test(bodyText)) send.observed = "unable-to-connect";
        else if (/Log in|Sign up/i.test(bodyText) && /Welcome to ChatGPT|Log in to continue/i.test(bodyText)) send.observed = "login-wall";
        else if (/Hello/i.test(bodyText) && bodyText.length > 500) send.observed = "response-or-echo";
        else send.observed = "no-change";
        send.bodySnippet = bodyText.replace(/\s+/g, " ").slice(0, 500);
      } catch (e) {
        send.observed = "send-error";
        send.error = String(e?.message ?? e).slice(0, 200);
      }
    }
    const backendStatuses = responses.filter((r) => r.url.includes("backend-api") || r.url.includes("/conversation"));
    const bareEvidence = {
      arm: "bare-electron",
      electron: process.env.npm_package_version ?? null,
      docRequest,
      docResponse,
      client,
      failed: failed.slice(0, 20),
      failedCount: failed.length,
      backendStatuses: backendStatuses.slice(0, 20),
      responseCount: responses.length,
      consoles: consoles.slice(0, 20),
      pageErrors: pageErrors.slice(0, 10),
      websockets: websockets.slice(0, 20),
      send,
    };
    evidence.push(bareEvidence);
    console.log(`CHATGPT_EVIDENCE ${JSON.stringify(bareEvidence)}`);
  } finally {
    await bare.close().catch(() => {});
  }

  expect(evidence.length).toBe(4);
  for (const arm of evidence.slice(0, 3)) expect(arm.pageId, `${arm.arm} created no page`).not.toBe(null);
});
