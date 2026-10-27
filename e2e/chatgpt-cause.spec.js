// ChatGPT cause matrix (Task B Part 2, diagnostic — NOT a gate).
// Loads chatgpt.com in four test-instance browser profiles (new, Default,
// temporary, one NAMED "work") and reports each page's state plus the
// host's failed-request instrument (network errors + xhr/fetch >= 400).
// The spec asserts only that the instrument ran (snapshot shape); it
// does NOT pass or fail on ChatGPT's behaviour, because a clean load
// here is itself evidence.
//
// HONEST LIMITS, stated here and in the report:
// - These are ANONYMOUS loads. No login happens (no credentials in a
//   test), so the user's logged-in SEND failure cannot be reproduced:
//   the native view's DOM is not reachable from Playwright, so no spec
//   can type into ChatGPT and press send.
// - A test-instance profile named "work" is NOT the user's real work
//   profile (different userData, cookies, storage). A pass here rules
//   out name-based causes only. The real work profile cannot be tested
//   from a test instance (data guard + single-instance lock + the rule
//   never to touch real data).
import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

test.setTimeout(600_000);

const CHATGPT_URL = "https://chatgpt.com/";
const DWELL_MS = 15_000;

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

async function createBrowserProfile(win, wsId, name, temp = false) {
  const localId = await win.evaluate(async ({ id, n, t }) => {
    const fn = t ? window.progressLedger.browser.createTempProfile : window.progressLedger.browser.createProfile;
    const res = await fn(id, n, null, null, null);
    const p = res?.profile ?? res;
    return p?.localId ?? null;
  }, { id: wsId, n: name, t: temp });
  expect(localId, `browser profile ${name} creation returned no localId`).not.toBe(null);
  return localId;
}

async function pollSettled(win, pageId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const state = await win.evaluate(() => window.progressLedger.browser.state());
    last = (state?.pages ?? []).find((p) => p?.id === pageId) ?? null;
    if (last && (last.state === "ready" || last.state === "failed")) return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
}

test("chatgpt matrix across new, Default, temporary, and work-named profiles", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "pl-v2-chatgpt-"));
  const { app, win } = await launch(userDataDir);
  try {
    const wsId = await createWorkspace(win, "ChatGPT Matrix", "chatgpt-matrix");

    async function runCase(c) {
      const created = await win.evaluate(
        async ({ wsId: id, pageUrl, browserProfileId: bp }) => {
          const opts = { profileId: id, url: pageUrl };
          if (bp !== undefined) opts.browserProfileId = bp;
          const res = await window.progressLedger.browser.createPage(opts);
          return { ok: res?.ok === true, reason: res?.reason ?? null, detail: res?.detail ?? null, pageId: res?.page?.id ?? null };
        },
        { wsId, pageUrl: CHATGPT_URL, browserProfileId: c.browserProfileId },
      );
      expect(created.ok, `createPage for ${c.label} failed: ${created.reason} detail=${created.detail}`).toBe(true);
      const settled = await pollSettled(win, created.pageId);
      expect(settled, `page for ${c.label} never settled`).not.toBe(null);
      await new Promise((r) => setTimeout(r, DWELL_MS));
      const snap = await app.evaluate((e) => globalThis.__cfBrowserE2E.debugSnapshot());
      expect(Array.isArray(snap?.pages)).toBe(true);
      const snapPage = (snap.pages ?? []).find((p) => p?.id === created.pageId);
      expect(snapPage, `snapshot has no entry for ${c.label}`).toBeTruthy();
      expect(Array.isArray(snapPage.failedRequests)).toBe(true);
      const state = await win.evaluate(() => window.progressLedger.browser.state());
      const live = (state?.pages ?? []).find((p) => p?.id === created.pageId);
      console.log(`CHATGPT_EVIDENCE ${JSON.stringify({
        profile: c.label,
        displayName: live?.browserProfile?.displayName ?? null,
        state: live?.state ?? snapPage?.state ?? null,
        url: live?.url ?? null,
        lastError: live?.lastError ?? null,
        failedRequests: snapPage.failedRequests,
      })}`);
      await win.evaluate(async (id) => window.progressLedger.browser.closePage(id), created.pageId);
    }

    // Default FIRST, before any profile is created: the workspace's
    // auto-created default profile, not the first profile promoted by
    // an earlier creation. (In the first matrix run the default case
    // ran after "Matrix New" existed and resolved to it, so it proved
    // nothing distinct.)
    await runCase({ label: "default", browserProfileId: undefined });
    const newLocalId = await createBrowserProfile(win, wsId, "Matrix New");
    const tempLocalId = await createBrowserProfile(win, wsId, "Matrix Temp", true);
    const workLocalId = await createBrowserProfile(win, wsId, "work");
    await runCase({ label: "new", browserProfileId: newLocalId });
    await runCase({ label: "temporary", browserProfileId: tempLocalId });
    await runCase({ label: "work-named", browserProfileId: workLocalId });
  } finally {
    await app.close().catch(() => {});
  }
});
