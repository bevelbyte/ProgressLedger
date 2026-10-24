// Browser Manager integration paths (CRUD + launch/navigate + cross-profile
// ownership invariant + backup/restore isolation + URL validation).
//
// Uses the CAREERFLOW_E2E_DONUT_STUB seam: metadata CRUD runs against the
// REAL local database and the REAL handler chain, while every Donut-side
// collaborator is an in-main-process fake (profile table, transports,
// recorder). Proves ownership/isolation, ordering, cascade cleanup, lazy
// bfc-<localId> binding (including anti-burst exhaustion) and honest failure
// shapes — without touching ports, processes or the user's browser.

import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

async function launchWithMode(mode) {
  const userDataDir = mkdtempSync(join(tmpdir(), `cf-bm-${mode || "prod"}-`));
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

test("browser profile CRUD lifecycle: add, rename, reorder, shortcuts", async () => {
  const { app, win } = await launchWithMode("donut-ok");
  try {
    const cf = await makeCfProfile(win, "BM Owner");

    const added = await win.evaluate(
      ([cfId]) =>
        Promise.all([
          window.careerflow.browserManager.add(Number(cfId), `bp-e2e-1-${Date.now()}`, "Study Browser"),
          window.careerflow.browserManager.add(Number(cfId), `bp-e2e-2-${Date.now()}`, "Research Browser"),
        ]),
      [cf]
    );
    expect(added.map((p) => p.displayName)).toEqual(["Study Browser", "Research Browser"]);

    let list = await win.evaluate((cfId) => window.careerflow.browserManager.list(Number(cfId)), Number(cf));
    expect(list.map((p) => p.displayName)).toEqual(["Study Browser", "Research Browser"]);

    await win.evaluate(
      ([cfId, localId]) => window.careerflow.browserManager.rename(Number(cfId), localId, "Deep Work"),
      [Number(cf), added[0].localId]
    );
    await win.evaluate(
      ([cfId, ids]) => window.careerflow.browserManager.reorderProfiles(Number(cfId), ids),
      [Number(cf), [added[1].localId, added[0].localId]]
    );
    list = await win.evaluate((cfId) => window.careerflow.browserManager.list(Number(cfId)), Number(cf));
    expect(list.map((p) => p.displayName)).toEqual(["Research Browser", "Deep Work"]);

    const sc1 = await win.evaluate(
      ([cfId, localId]) => window.careerflow.browserManager.addShortcut(Number(cfId), localId, "GitHub", "https://github.com"),
      [Number(cf), added[0].localId]
    );
    const sc2 = await win.evaluate(
      ([cfId, localId]) => window.careerflow.browserManager.addShortcut(Number(cfId), localId, "Docs", "https://docs.example.com"),
      [Number(cf), added[0].localId]
    );
    let shorts = await win.evaluate(
      ([cfId, localId]) => window.careerflow.browserManager.listShortcuts(Number(cfId), localId),
      [Number(cf), added[0].localId]
    );
    expect(shorts.map((s) => s.label)).toEqual(["GitHub", "Docs"]);

    await win.evaluate(
      ([cfId, id, label, url]) => window.careerflow.browserManager.updateShortcut(Number(cfId), id, label, url),
      [Number(cf), sc1.id, "GitHub Pro", "https://github.com/pro"]
    );
    await win.evaluate(
      ([cfId, localId, ids]) => window.careerflow.browserManager.reorderShortcuts(Number(cfId), localId, ids),
      [Number(cf), added[0].localId, [sc2.id, sc1.id]]
    );
    shorts = await win.evaluate(
      ([cfId, localId]) => window.careerflow.browserManager.listShortcuts(Number(cfId), localId),
      [Number(cf), added[0].localId]
    );
    expect(shorts.map((s) => s.label)).toEqual(["Docs", "GitHub Pro"]);
    expect(shorts.find((s) => s.id === sc1.id).url).toBe("https://github.com/pro");

    await win.evaluate(
      ([cfId, id]) => window.careerflow.browserManager.deleteShortcut(Number(cfId), id),
      [Number(cf), sc2.id]
    );
    shorts = await win.evaluate(
      ([cfId, localId]) => window.careerflow.browserManager.listShortcuts(Number(cfId), localId),
      [Number(cf), added[0].localId]
    );
    expect(shorts.map((s) => s.label)).toEqual(["GitHub Pro"]);
  } finally {
    await app.close();
  }
});

test("launch is lazy-bound under bfc-<localId>, reused on second click", async () => {
  const { app, win } = await launchWithMode("donut-ok");
  try {
    const cf = await makeCfProfile(win, "BM Launcher");
    const bp = await win.evaluate(
      ([cfId]) => window.careerflow.browserManager.add(Number(cfId), `bp-launch-${Date.now()}`, "Launch Target"),
      [Number(cf)]
    );

    const r1 = await win.evaluate(
      ([localId, cfId]) => window.careerflow.browserManager.openBrowserProfile(localId, cfId),
      [bp.localId, String(cf)]
    );
    expect(r1).toEqual({ ok: true });

    let calls = await e2eCalls(app);
    expect(calls.donutRuns.length).toBe(1);
    expect(calls.donutProfileCreations).toContain(`bfc-${bp.localId}`);

    const r2 = await win.evaluate(
      ([localId, cfId]) => window.careerflow.browserManager.openBrowserProfile(localId, cfId),
      [bp.localId, String(cf)]
    );
    expect(r2).toEqual({ ok: true });
    calls = await e2eCalls(app);
    expect(calls.donutRuns.length).toBe(2);
    expect(calls.donutProfileCreations.filter((n) => n === `bfc-${bp.localId}`).length).toBe(1);

    const list = await win.evaluate(
      (cfId) => window.careerflow.browserManager.list(Number(cfId)),
      Number(cf)
    );
    expect(list[0].lastUsedAt).toBeTruthy();
  } finally {
    await app.close();
  }
});

test("rapid concurrent launches dedupe startup AND binding creation", async () => {
  const { app, win } = await launchWithMode("dedupe");
  try {
    const cf = await makeCfProfile(win, "BM Racer");
    const bp = await win.evaluate(
      ([cfId]) => window.careerflow.browserManager.add(Number(cfId), `bp-race-${Date.now()}`, "Race Target"),
      [Number(cf)]
    );
    const results = await win.evaluate(
      ([localId, cfId]) =>
        Promise.all([
          window.careerflow.browserManager.openBrowserProfile(localId, cfId),
          window.careerflow.browserManager.openBrowserProfile(localId, cfId),
          window.careerflow.browserManager.openBrowserProfile(localId, cfId),
        ]),
      [bp.localId, String(cf)]
    );
    for (const r of results) expect(r).toEqual({ ok: true });

    const calls = await e2eCalls(app);
    expect(calls.ensureStartedCalls).toBe(1);
    expect(calls.donutRuns.length).toBe(3);
    expect(
      calls.donutProfileCreations.filter((n) => n === `bfc-${bp.localId}`).length
    ).toBe(1);
  } finally {
    await app.close();
  }
});

test("ownership isolation: cross-profile and unknown ids are refused", async () => {
  const { app, win } = await launchWithMode("donut-ok");
  try {
    const cfA = await makeCfProfile(win, "BM Iso A");
    const cfB = await makeCfProfile(win, "BM Iso B");
    const bp = await win.evaluate(
      ([cfId]) => window.careerflow.browserManager.add(Number(cfId), `bp-iso-${Date.now()}`, "A Only"),
      [Number(cfA)]
    );
    // Realise A's binding under bfc-<localId> so the foreign check has a real
    // Donut target to *not* hit.
    await win.evaluate(
      ([localId, cfId]) => window.careerflow.browserManager.openBrowserProfile(localId, cfId),
      [bp.localId, String(cfA)]
    );
    const callsBefore = await e2eCalls(app);
    const runsBefore = callsBefore.donutRuns.length;

    // 1) B's launch attempt on A's browser profile must fail not-owned.
    const rForeign = await win.evaluate(
      ([localId, cfId]) => window.careerflow.browserManager.openBrowserProfile(localId, cfId),
      [bp.localId, String(cfB)]
    );
    expect(rForeign).toEqual({ ok: false, reason: "not-owned" });

    // 2) B's listing of A's browser profile is empty.
    const listB = await win.evaluate(
      (cfId) => window.careerflow.browserManager.list(Number(cfId)),
      Number(cfB)
    );
    expect(listB).toHaveLength(0);

    // 3) Unknown owners are rejected outright.
    const rGhost = await win.evaluate(
      ([localId]) => window.careerflow.browserManager.openBrowserProfile(localId, "999999"),
      [bp.localId]
    );
    expect(rGhost).toEqual({ ok: false, reason: "unknown-cf-profile" });

    // 4) Foreign listing leaks nothing about A's shortcuts either.
    const shortsB = await win.evaluate(
      ([cfId, localId]) => window.careerflow.browserManager.listShortcuts(Number(cfId), localId),
      [Number(cfB), bp.localId]
    );
    expect(shortsB).toHaveLength(0);

    // 5) Every attempt must NOT reach the Donut transport. Only A's own
    //    launch (from above) is the recorded run.
    const calls = await e2eCalls(app);
    expect(calls.donutRuns.length).toBe(runsBefore);
  } finally {
    await app.close();
  }
});

test("cross-profile mutations are rejected without affecting the owner", async () => {
  const { app, win } = await launchWithMode("donut-ok");
  try {
    const cfA = await makeCfProfile(win, "BM XMut A");
    const cfB = await makeCfProfile(win, "BM XMut B");
    const bp = await win.evaluate(
      ([cfId]) => window.careerflow.browserManager.add(Number(cfId), `bp-xm-${Date.now()}`, "Owned By A"),
      [Number(cfA)]
    );
    const sc = await win.evaluate(
      ([cfId, localId]) => window.careerflow.browserManager.addShortcut(Number(cfId), localId, "Portal", "https://portal.example.com"),
      [Number(cfA), bp.localId]
    );

    // Every one of B's attempts must fail. The shape varies (the failure
    // is reported through napi -> ipc -> reject), so we look at .ok / .reason
    // and the on-disk state to prove the call did NOT mutate.
    const results = await win.evaluate(
      async ([cfA, cfB, bp, sc]) => {
        const safe = (p) => p.then(() => ({ ok: true }), (e) => ({ ok: false, code: e?.message }));
        // Await each safe-wrapper so the final object contains resolved values.
        const [rename, setEnabled, remove, addShortcut, updateShortcut, deleteShortcut] = await Promise.all([
          safe(window.careerflow.browserManager.rename(Number(cfB), bp.localId, "Hijack")),
          safe(window.careerflow.browserManager.setEnabled(Number(cfB), bp.localId, false)),
          safe(window.careerflow.browserManager.remove(Number(cfB), bp.localId)),
          safe(window.careerflow.browserManager
            .addShortcut(Number(cfB), bp.localId, "Evil", "https://example.com/evil")),
          safe(window.careerflow.browserManager
            .updateShortcut(Number(cfB), sc.id, "Hijack", "https://example.com/x")),
          safe(window.careerflow.browserManager
            .deleteShortcut(Number(cfB), sc.id)),
        ]);
        return { rename, setEnabled, remove, addShortcut, updateShortcut, deleteShortcut };
      },
      [Number(cfA), Number(cfB), { localId: bp.localId, name: bp.displayName }, { id: sc.id, label: sc.label }]
    );
    expect(results).toMatchObject({
      rename: { ok: false },
      setEnabled: { ok: false },
      remove: { ok: false },
      addShortcut: { ok: false },
      updateShortcut: { ok: false },
      deleteShortcut: { ok: false },
    });

    // Reorder with a foreign id is rejected wholesale; the valid owner's
    // ordering is unchanged.
    const reorderFail = await win.evaluate(
      ([cfB, localId]) => window.careerflow.browserManager
        .reorderProfiles(Number(cfB), [localId])
        .then(() => ({ ok: true }), () => ({ ok: false })),
      [Number(cfB), bp.localId]
    );
    expect(reorderFail).toEqual({ ok: false });

    // A's row is intact: original name still wins, still enabled, still
    // has the original shortcut.
    const aList = await win.evaluate(
      (cfId) => window.careerflow.browserManager.list(Number(cfId)),
      Number(cfA)
    );
    expect(aList[0].displayName).toBe("Owned By A");
    expect(aList[0].enabled).toBe(true);
    const aShorts = await win.evaluate(
      ([cfId, localId]) => window.careerflow.browserManager.listShortcuts(Number(cfId), localId),
      [Number(cfA), bp.localId]
    );
    expect(aShorts.map((s) => s.label)).toEqual(["Portal"]);

    // B's view is empty.
    const bList = await win.evaluate(
      (cfId) => window.careerflow.browserManager.list(Number(cfId)),
      Number(cfB)
    );
    expect(bList).toHaveLength(0);
  } finally {
    await app.close();
  }
});

test("storage-time URL validation rejects dangerous schemes", async () => {
  const { app, win } = await launchWithMode("donut-ok");
  try {
    const cf = await makeCfProfile(win, "BM URL");
    const bp = await win.evaluate(
      ([cfId]) => window.careerflow.browserManager.add(Number(cfId), `bp-url-${Date.now()}`, "URL Browser"),
      [Number(cf)]
    );

    const results = await win.evaluate(
      ([cfId, localId, urls]) =>
        Promise.all(
          urls.map((u) =>
            window.careerflow.browserManager
              .addShortcut(Number(cfId), localId, "Evil", u)
              .then(() => ({ url: u, ok: true }), (e) => ({ url: u, ok: false, code: e?.message }))
          )
        ),
      [Number(cf), bp.localId, [
        "javascript:alert(1)",
        "file:///c/secret",
        "data:text/html,x",
        "vbscript:msgbox(1)",
        "ftp://example.com",
        "not a url",
        "",
        "   ",
      ]]
    );
    for (const r of results) {
      expect(r.ok).toBe(false);
    }

    // A valid URL still works.
    const ok = await win.evaluate(
      ([cfId, localId]) => window.careerflow.browserManager
        .addShortcut(Number(cfId), localId, "Good", "https://github.com")
        .then((s) => ({ ok: true, id: s.id, url: s.url }), (e) => ({ ok: false, code: e?.message })),
      [Number(cf), bp.localId]
    );
    expect(ok.ok).toBe(true);
    expect(ok.url).toBe("https://github.com/");

    // Update is gated the same way.
    const updFail = await win.evaluate(
      ([cfId, id]) => window.careerflow.browserManager
        .updateShortcut(Number(cfId), id, "Bad", "javascript:alert(2)")
        .then(() => ({ ok: true }), () => ({ ok: false })),
      [Number(cf), ok.id]
    );
    expect(updFail).toEqual({ ok: false });

    // The good URL still wins.
    const shorts = await win.evaluate(
      ([cfId, localId]) => window.careerflow.browserManager.listShortcuts(Number(cfId), localId),
      [Number(cf), bp.localId]
    );
    expect(shorts.map((s) => s.url)).toEqual(["https://github.com/"]);
  } finally {
    await app.close();
  }
});

test("disabled profile refuses launch explicitly", async () => {
  const { app, win } = await launchWithMode("donut-ok");
  try {
    const cf = await makeCfProfile(win, "BM Disabled");
    const bp = await win.evaluate(
      ([cfId]) => window.careerflow.browserManager.add(Number(cfId), `bp-off-${Date.now()}`, "Off Target"),
      [Number(cf)]
    );
    await win.evaluate(
      ([cfId, localId, enabled]) => window.careerflow.browserManager.setEnabled(Number(cfId), localId, enabled),
      [Number(cf), bp.localId, false]
    );
    const res = await win.evaluate(
      ([localId, cfId]) => window.careerflow.browserManager.openBrowserProfile(localId, cfId),
      [bp.localId, String(cf)]
    );
    expect(res).toEqual({ ok: false, reason: "disabled" });
    const calls = await e2eCalls(app);
    expect(calls.donutRuns).toHaveLength(0);
    expect(calls.ensureStartedCalls).toBe(0);
  } finally {
    await app.close();
  }
});

test("unavailable backend: launch fails honestly, shortcut degrades to system", async () => {
  const { app, win } = await launchWithMode("unavailable");
  try {
    const cf = await makeCfProfile(win, "BM Down");
    const bp = await win.evaluate(
      ([cfId]) => window.careerflow.browserManager.add(Number(cfId), `bp-down-${Date.now()}`, "Down Target"),
      [Number(cf)]
    );
    const sc = await win.evaluate(
      ([cfId, localId]) => window.careerflow.browserManager.addShortcut(Number(cfId), localId, "Fallback", "https://example.com/fb"),
      [Number(cf), bp.localId]
    );

    const rLaunch = await win.evaluate(
      ([localId, cfId]) => window.careerflow.browserManager.openBrowserProfile(localId, cfId),
      [bp.localId, String(cf)]
    );
    expect(rLaunch).toEqual({ ok: false, reason: "backend-unavailable" });

    const rNav = await win.evaluate(
      ([shortcutId, cfId]) => window.careerflow.browserManager.openShortcutUrl(shortcutId, cfId),
      [sc.id, String(cf)]
    );
    expect(rNav).toEqual({ opened: true, provider: "system" });

    const calls = await e2eCalls(app);
    expect(calls.systemOpens).toContain("https://example.com/fb");
    expect(calls.donutRuns).toHaveLength(0);
    expect(calls.donutOpens).toHaveLength(0);
  } finally {
    await app.close();
  }
});

test("anti-burst guard exhaustion surfaces as a distinct honest failure", async () => {
  const { app, win } = await launchWithMode("anti-burst");
  try {
    const cf = await makeCfProfile(win, "BM Guard");
    const bp = await win.evaluate(
      ([cfId]) => window.careerflow.browserManager.add(Number(cfId), `bp-guard-${Date.now()}`, "Guard Target"),
      [Number(cf)]
    );
    const res = await win.evaluate(
      ([localId, cfId]) => window.careerflow.browserManager.openBrowserProfile(localId, cfId),
      [bp.localId, String(cf)]
    );
    expect(res).toEqual({ ok: false, reason: "anti-burst-budget-exceeded" });
    const calls = await e2eCalls(app);
    expect(calls.donutRuns).toHaveLength(0);
    expect(calls.donutProfileCreations).toHaveLength(0);
  } finally {
    await app.close();
  }
});

test("run refusal reports run-failed without any fallback pretense", async () => {
  const { app, win } = await launchWithMode("run-fail");
  try {
    const cf = await makeCfProfile(win, "BM RunFail");
    const bp = await win.evaluate(
      ([cfId]) => window.careerflow.browserManager.add(Number(cfId), `bp-runfail-${Date.now()}`, "RunFail Target"),
      [Number(cf)]
    );
    const res = await win.evaluate(
      ([localId, cfId]) => window.careerflow.browserManager.openBrowserProfile(localId, cfId),
      [bp.localId, String(cf)]
    );
    expect(res).toEqual({ ok: false, reason: "run-failed" });
    const calls = await e2eCalls(app);
    expect(calls.donutRuns).toHaveLength(1);
    expect(calls.systemOpens).toHaveLength(0);
  } finally {
    await app.close();
  }
});

test("shortcut navigates through Donut on the happy path; deleting the owner cascades", async () => {
  const { app, win } = await launchWithMode("donut-ok");
  try {
    const cf = await makeCfProfile(win, "BM Nav");
    const bp = await win.evaluate(
      ([cfId]) => window.careerflow.browserManager.add(Number(cfId), `bp-nav-${Date.now()}`, "Nav Target"),
      [Number(cf)]
    );
    const sc = await win.evaluate(
      ([cfId, localId]) => window.careerflow.browserManager.addShortcut(Number(cfId), localId, "Portal", "https://portal.example.com/study"),
      [Number(cf), bp.localId]
    );

    const res = await win.evaluate(
      ([shortcutId, cfId]) => window.careerflow.browserManager.openShortcutUrl(shortcutId, cfId),
      [sc.id, String(cf)]
    );
    expect(res).toEqual({
      opened: true,
      provider: "donut",
      url: "https://portal.example.com/study",
    });
    const calls = await e2eCalls(app);
    expect(calls.donutOpens).toContain("https://portal.example.com/study");
    expect(calls.donutProfileCreations).toContain(`bfc-${bp.localId}`);

    // Deleting the owning CF profile cascades its browser profile away.
    await win.evaluate((id) => window.careerflow.profiles.remove(Number(id)), cf);
    const orphanList = await win.evaluate(() => window.careerflow.browserManager.list(-1));
    expect(orphanList).toHaveLength(0);
  } finally {
    await app.close();
  }
});

test("adversarial: restored data does NOT silently reattach to existing Donut bindings", async () => {
  // This is the hardened-isolation regression for backup/restore. It does
  // not exercise the portability zip path (covered by the Rust roundtrip
  // test) — it exercises the binding store: a stale bfc-<localId> entry
  // left over from a prior CareerFlow install must NEVER accept a restored
  // row whose `bfc-<localId>` key happens to collide.
  const { app, win } = await launchWithMode("donut-ok");
  try {
    const cfA = await makeCfProfile(win, "BM Adv A");
    const cfB = await makeCfProfile(win, "BM Adv B");
    const bpA = await win.evaluate(
      ([cfId]) => window.careerflow.browserManager.add(Number(cfId), `bp-adv-${Date.now()}`, "Adv A"),
      [Number(cfA)]
    );
    // Realise A's binding.
    await win.evaluate(
      ([localId, cfId]) => window.careerflow.browserManager.openBrowserProfile(localId, cfId),
      [bpA.localId, String(cfA)]
    );
    const calls = await e2eCalls(app);
    const aDonutId = calls.donutProfileCreations.find((n) => n === `bfc-${bpA.localId}`);
    expect(aDonutId).toBeTruthy();
    const aDonutRun = calls.donutRuns.length;

    // Restore-style: a different CF profile tries to add a browser profile
    // whose local_id was originally a "copy" of A's. The Donut transport
    // records distinct creations for each binding lookup; restoration MUST
    // create a fresh dedicated identity, never piggy-back on A's.
    const ghostLocal = `restored-${Date.now()}`;
    const ghostBp = await win.evaluate(
      ([cfId, localId, name]) => window.careerflow.browserManager
        .add(Number(cfId), localId, name),
      [Number(cfB), ghostLocal, "Restored Copy"]
    );
    await win.evaluate(
      ([localId, cfId]) => window.careerflow.browserManager.openBrowserProfile(localId, cfId),
      [ghostBp.localId, String(cfB)]
    );
    const after = await e2eCalls(app);
    // The new binding was minted under bfc-<ghostLocal>, not under A's key.
    expect(after.donutProfileCreations).toContain(`bfc-${ghostLocal}`);
    expect(after.donutProfileCreations.filter((n) => n === `bfc-${bpA.localId}`).length).toBe(1);
    // Each launch still produced a run, so two more runs than the initial.
    expect(after.donutRuns.length).toBe(aDonutRun + 1);

    // The two profiles are completely independent at the data layer.
    const listA = await win.evaluate(
      (cfId) => window.careerflow.browserManager.list(Number(cfId)),
      Number(cfA)
    );
    const listB = await win.evaluate(
      (cfId) => window.careerflow.browserManager.list(Number(cfId)),
      Number(cfB)
    );
    expect(listA.map((b) => b.localId)).toEqual([bpA.localId]);
    expect(listB.map((b) => b.localId)).toEqual([ghostBp.localId]);
  } finally {
    await app.close();
  }
});
