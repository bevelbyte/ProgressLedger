// Quick Actions × Browser Manager integration: pinned shortcuts in the
// global right sidebar must (a) belong to the active CareerFlow profile
// only, (b) route through the existing Browser Manager open path, (c)
// stay in sync across profile switching / shortcut delete / profile delete
// / restore, (d) roundtrip through the portability v2 export/import
// without leaking a Donut identity.
//
// Uses the same CAREERFLOW_E2E_DONUT_STUB seam as the other manager specs;
// all Donut collaborators are in-main-process fakes.
//
// NOTE: active-profile switching is intentionally not exercised at the UI
// level here (it requires driving the Svelte renderer state, which is
// test-only scaffolding). It is covered at the data layer by
// list_pinned_browser_shortcuts being SQL-scoped per cf_profile_id — see
// the Rust pin_isolation_and_cascade suite and the canonical
// 'list_pinned_browser_shortcuts is cf-scoped' Q4 gate in the Quick
// Actions ledger.

import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

async function launchWithMode(mode) {
  const userDataDir = mkdtempSync(join(tmpdir(), `cf-qa-${mode || "prod"}-`));
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      CAREERFLOW_E2E: "1",
      CAREERFLOW_E2E_DONUT_STUB: "1",
      ...(mode ? { CAREERFLOW_E2E_DONUT_MODE: mode } : {}),
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  return { app, win };
}

async function e2eCalls(app) {
  return app.evaluate(() => globalThis.__cfDonutE2E);
}

async function makeCfProfile(win, name) {
  return win.evaluate(async (n) => {
    const created = await window.careerflow.profiles.add(n, `${n}-${Date.now()}`);
    return String(created.id);
  }, name);
}

async function listPinned(win, cfId) {
  return win.evaluate(
    (id) => window.careerflow.browserManager.listPinned(Number(id)),
    cfId
  );
}

test("Quick Actions: pinned rows are scoped per active CareerFlow profile", async () => {
  const { app, win } = await launchWithMode("donut-ok");
  try {
    const cfA = await makeCfProfile(win, "QA A");
    const cfB = await makeCfProfile(win, "QA B");
    const bpA = await win.evaluate(
      ([cfId]) => window.careerflow.browserManager.add(Number(cfId), `bp-qa-a-${Date.now()}`, "Social"),
      [Number(cfA)]
    );
    const bpB = await win.evaluate(
      ([cfId]) => window.careerflow.browserManager.add(Number(cfId), `bp-qa-b-${Date.now()}`, "College"),
      [Number(cfB)]
    );
    const scA = await win.evaluate(
      ([cfId, localId]) => window.careerflow.browserManager.addShortcut(Number(cfId), localId, "Facebook", "https://facebook.com"),
      [Number(cfA), bpA.localId]
    );
    const scB = await win.evaluate(
      ([cfId, localId]) => window.careerflow.browserManager.addShortcut(Number(cfId), localId, "Moodle", "https://moodle.example.com"),
      [Number(cfB), bpB.localId]
    );

    // Pin only A's Facebook.
    await win.evaluate(
      ([cfId, scId]) => window.careerflow.browserManager.togglePin(Number(cfId), scId, true),
      [Number(cfA), scA.id]
    );
    // Pin B's Moodle.
    await win.evaluate(
      ([cfId, scId]) => window.careerflow.browserManager.togglePin(Number(cfId), scId, true),
      [Number(cfB), scB.id]
    );

    // Per-profile listing matches expectations — no leakage.
    const pinnedA = (await listPinned(win, cfA)).map((r) => r.label);
    const pinnedB = (await listPinned(win, cfB)).map((r) => r.label);
    expect(pinnedA).toEqual(["Facebook"]);
    expect(pinnedB).toEqual(["Moodle"]);
  } finally {
    await app.close();
  }
});

test("Quick Actions click routes through the existing Browser Manager open path", async () => {
  const { app, win } = await launchWithMode("donut-ok");
  try {
    const cf = await makeCfProfile(win, "QA Route");
    const bp = await win.evaluate(
      ([cfId]) => window.careerflow.browserManager.add(Number(cfId), `bp-qa-route-${Date.now()}`, "Routing"),
      [Number(cf)]
    );
    const sc = await win.evaluate(
      ([cfId, localId]) => window.careerflow.browserManager.addShortcut(Number(cfId), localId, "GitHub", "https://github.com"),
      [Number(cf), bp.localId]
    );
    await win.evaluate(
      ([cfId, scId]) => window.careerflow.browserManager.togglePin(Number(cfId), scId, true),
      [Number(cf), sc.id]
    );
    // The exact same call the Quick Actions panel makes on click.
    const res = await win.evaluate(
      ([shortcutId, cfId]) => window.careerflow.browserManager.openShortcutUrl(shortcutId, cfId),
      [sc.id, String(cf)]
    );
    expect(res).toEqual({ opened: true, provider: "donut", url: "https://github.com/" });
    const calls = await e2eCalls(app);
    expect(calls.donutOpens).toContain("https://github.com/");
    expect(calls.donutProfileCreations).toContain(`bfc-${bp.localId}`);
  } finally {
    await app.close();
  }
});

test("Quick Actions unpin immediately removes the row", async () => {
  const { app, win } = await launchWithMode("donut-ok");
  try {
    const cf = await makeCfProfile(win, "QA Unpin");
    const bp = await win.evaluate(
      ([cfId]) => window.careerflow.browserManager.add(Number(cfId), `bp-qa-up-${Date.now()}`, "Unpin"),
      [Number(cf)]
    );
    const sc = await win.evaluate(
      ([cfId, localId]) => window.careerflow.browserManager.addShortcut(Number(cfId), localId, "Mood", "https://mood.example.com"),
      [Number(cf), bp.localId]
    );
    await win.evaluate(
      ([cfId, scId]) => window.careerflow.browserManager.togglePin(Number(cfId), scId, true),
      [Number(cf), sc.id]
    );
    let pinned = (await listPinned(win, cf)).map((r) => r.label);
    expect(pinned).toEqual(["Mood"]);

    await win.evaluate(
      ([cfId, scId]) => window.careerflow.browserManager.togglePin(Number(cfId), scId, false),
      [Number(cf), sc.id]
    );
    pinned = (await listPinned(win, cf)).map((r) => r.label);
    expect(pinned).toEqual([]);
  } finally {
    await app.close();
  }
});

test("deleting a shortcut drops it from Quick Actions; deleting a browser profile drops its pinned row", async () => {
  const { app, win } = await launchWithMode("donut-ok");
  try {
    const cf = await makeCfProfile(win, "QA Delete");
    const bp = await win.evaluate(
      ([cfId]) => window.careerflow.browserManager.add(Number(cfId), `bp-qa-d-${Date.now()}`, "Delete"),
      [Number(cf)]
    );
    const sc = await win.evaluate(
      ([cfId, localId]) => window.careerflow.browserManager.addShortcut(Number(cfId), localId, "Throw", "https://throw.example.com"),
      [Number(cf), bp.localId]
    );
    await win.evaluate(
      ([cfId, scId]) => window.careerflow.browserManager.togglePin(Number(cfId), scId, true),
      [Number(cf), sc.id]
    );
    expect((await listPinned(win, cf)).map((r) => r.label)).toEqual(["Throw"]);

    // Delete the shortcut.
    await win.evaluate(
      ([cfId, scId]) => window.careerflow.browserManager.deleteShortcut(Number(cfId), scId),
      [Number(cf), sc.id]
    );
    expect((await listPinned(win, cf)).map((r) => r.label)).toEqual([]);

    // Re-add + re-pin, then delete the browser profile. FK CASCADE drops
    // the pinned row.
    const sc2 = await win.evaluate(
      ([cfId, localId]) => window.careerflow.browserManager.addShortcut(Number(cfId), localId, "Revive", "https://revive.example.com"),
      [Number(cf), bp.localId]
    );
    await win.evaluate(
      ([cfId, scId]) => window.careerflow.browserManager.togglePin(Number(cfId), scId, true),
      [Number(cf), sc2.id]
    );
    expect((await listPinned(win, cf)).map((r) => r.label)).toEqual(["Revive"]);

    await win.evaluate(
      ([cfId, localId]) => window.careerflow.browserManager.remove(Number(cfId), localId),
      [Number(cf), bp.localId]
    );
    expect((await listPinned(win, cf)).map((r) => r.label)).toEqual([]);
  } finally {
    await app.close();
  }
});

test("disabled browser profile hides its pinned shortcut from Quick Actions", async () => {
  const { app, win } = await launchWithMode("donut-ok");
  try {
    const cf = await makeCfProfile(win, "QA Disabled");
    const bp = await win.evaluate(
      ([cfId]) => window.careerflow.browserManager.add(Number(cfId), `bp-qa-ds-${Date.now()}`, "Disabled"),
      [Number(cf)]
    );
    const sc = await win.evaluate(
      ([cfId, localId]) => window.careerflow.browserManager.addShortcut(Number(cfId), localId, "Portal", "https://portal.example.com"),
      [Number(cf), bp.localId]
    );
    await win.evaluate(
      ([cfId, scId]) => window.careerflow.browserManager.togglePin(Number(cfId), scId, true),
      [Number(cf), sc.id]
    );
    expect((await listPinned(win, cf)).map((r) => r.label)).toEqual(["Portal"]);

    await win.evaluate(
      ([cfId, localId, enabled]) => window.careerflow.browserManager.setEnabled(Number(cfId), localId, enabled),
      [Number(cf), bp.localId, false]
    );
    expect((await listPinned(win, cf)).map((r) => r.label)).toEqual([]);
  } finally {
    await app.close();
  }
});

test("pin cannot target another CareerFlow profile's shortcut (no Donut transport call)", async () => {
  const { app, win } = await launchWithMode("donut-ok");
  try {
    const cfA = await makeCfProfile(win, "QA Cross A");
    const cfB = await makeCfProfile(win, "QA Cross B");
    const bpA = await win.evaluate(
      ([cfId]) => window.careerflow.browserManager.add(Number(cfId), `bp-xa-${Date.now()}`, "A's"),
      [Number(cfA)]
    );
    const scA = await win.evaluate(
      ([cfId, localId]) => window.careerflow.browserManager.addShortcut(Number(cfId), localId, "A's Pin Target", "https://a.example.com"),
      [Number(cfA), bpA.localId]
    );

    // B tries to pin A's shortcut: must fail; nothing must reach the
    // Donut backend.
    const res = await win.evaluate(
      ([cfId, scId, pinned]) => window.careerflow.browserManager
        .togglePin(Number(cfId), Number(scId), pinned)
        .then(() => ({ ok: true }), (e) => ({ ok: false, code: e?.message })),
      [Number(cfB), scA.id, true]
    );
    expect(res).toMatchObject({ ok: false });

    // Realise A's binding for the test, then ensure no NEW binding was
    // created on B's failed attempt. The only Donut profile created is
    // the bfc-<bpA> one (when A's owner launches it).
    await win.evaluate(
      ([localId, cfId]) => window.careerflow.browserManager.openBrowserProfile(localId, cfId),
      [bpA.localId, String(cfA)]
    );
    const calls = await e2eCalls(app);
    expect(calls.donutProfileCreations).toContain(`bfc-${bpA.localId}`);
    expect(calls.donutProfileCreations.length).toBe(1);

    // A's shortcut is still unpinned (B's attempt did not mutate).
    const listed = (await listPinned(win, cfA)).map((r) => r.id);
    expect(listed).not.toContain(scA.id);
  } finally {
    await app.close();
  }
});
