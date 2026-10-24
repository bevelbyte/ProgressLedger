// SubjectLinks open-subject-link integration paths.
//
// Uses the explicit CAREERFLOW_E2E_DONUT_STUB seam in shell/src/ipc/donut.js:
// with it set, both the Donut transport and the system opener are hermetic
// in-main-process recorders, so Playwright can prove the success/fallback/
// dedupe paths without touching the real Donut workspace/ports or opening the
// user's browser. Production wiring is exercised only through its honest
// fallback shape in the final case (no backend spawn possible there because
// profile resolution fails before ensureStarted).
import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

async function launchWithMode(mode) {
  const userDataDir = mkdtempSync(join(tmpdir(), `cf-links-${mode || "prod"}-`));
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

test("subject link opens through Donut on the success path (healthy reuse)", async () => {
  const { app, win } = await launchWithMode("donut-ok");
  try {
    const res = await win.evaluate(async () =>
      window.careerflow.donut.openSubjectLink("https://example.com/donut-study")
    );
    expect(res).toEqual({ opened: true, provider: "donut" });

    const calls = await e2eCalls(app);
    expect(calls.ensureStartedCalls).toBe(0); // healthy owned → pure reuse
    expect(calls.donutOpens).toEqual(["https://example.com/donut-study"]);
    expect(calls.systemOpens).toEqual([]);
  } finally {
    await app.close();
  }
});

test("rapid concurrent clicks deduplicate startup to one attempt", async () => {
  const { app, win } = await launchWithMode("dedupe");
  try {
    const results = await win.evaluate(async () =>
      Promise.all([
        window.careerflow.donut.openSubjectLink("https://example.com/d1"),
        window.careerflow.donut.openSubjectLink("https://example.com/d2"),
        window.careerflow.donut.openSubjectLink("https://example.com/d3"),
      ])
    );
    for (const r of results) expect(r).toEqual({ opened: true, provider: "donut" });

    const calls = await e2eCalls(app);
    expect(calls.ensureStartedCalls).toBe(1); // provider-level dedupe
    expect(calls.donutOpens.length).toBe(3);
    expect(calls.systemOpens).toEqual([]);
  } finally {
    await app.close();
  }
});

test("unavailable Donut falls back to the system browser", async () => {
  const { app, win } = await launchWithMode("unavailable");
  try {
    const res = await win.evaluate(async () =>
      window.careerflow.donut.openSubjectLink("https://example.com/fallback")
    );
    expect(res).toEqual({ opened: true, provider: "system" });

    const calls = await e2eCalls(app);
    expect(calls.donutOpens).toEqual([]);
    expect(calls.systemOpens).toEqual(["https://example.com/fallback"]);
  } finally {
    await app.close();
  }
});

test("malformed URL is rejected before any external launch", async () => {
  const { app, win } = await launchWithMode("donut-ok");
  try {
    for (const bad of ["javascript:alert(1)", "file:///C:/x", "not a url"]) {
      const res = await win.evaluate((u) => window.careerflow.donut.openSubjectLink(u), bad);
      expect(res).toEqual({ opened: false, reason: "invalid-url" });
    }
    const calls = await e2eCalls(app);
    expect(calls.donutOpens).toEqual([]);
    expect(calls.systemOpens).toEqual([]);
  } finally {
    await app.close();
  }
});

test("profile mapping lifecycle: A→target, switch B→other target, delete A→fallback (isolation)", async () => {
  // Uses the stub seam end-to-end over the REAL handler path: the CareerFlow
  // profile ids are validated against the real local database, and the
  // resolved Donut targets are recorded per call. Deleting profile A must
  // make subsequent opens fall back instead of reusing A's mapping.
  const { app, win } = await launchWithMode("donut-ok");
  try {
    const ids = await win.evaluate(async () => {
      const a = await window.careerflow.profiles.add("Map A", `map-a-${Date.now()}`);
      const b = await window.careerflow.profiles.add("Map B", `map-b-${Date.now()}`);
      return { a: a.id, b: b.id };
    });

    const rA = await win.evaluate(
      ([u, cf]) => window.careerflow.donut.openSubjectLink(u, cf),
      ["https://example.com/link-a", ids.a]
    );
    expect(rA).toEqual({ opened: true, provider: "donut" });
    let calls = await e2eCalls(app);
    expect(
      { last: calls.cfProfileIds.at(-1), all: calls },
      JSON.stringify(calls)
    ).toMatchObject({ last: String(ids.a) });
    expect(calls.donutTargets.at(-1)).toBe("e2e-donut-profile");

    const rB = await win.evaluate(
      ([u, cf]) => window.careerflow.donut.openSubjectLink(u, cf),
      ["https://example.com/link-b", ids.b]
    );
    expect(rB).toEqual({ opened: true, provider: "donut" });
    calls = await e2eCalls(app);
    expect(calls.cfProfileIds.at(-1)).toBe(String(ids.b));

    // Isolation/anti-forgery: an unknown CF profile id must never reach the
    // Donut transport — it falls back to the system browser instead.
    const rGhost = await win.evaluate(async () =>
      window.careerflow.donut.openSubjectLink("https://example.com/ghost", "no-such-profile")
    );
    expect(rGhost).toEqual({ opened: true, provider: "system" });
    // Delete A; opening with A's id now degrades to system fallback too.
    await win.evaluate((id) => window.careerflow.profiles.remove(id), ids.a);
    const remaining = await win.evaluate(async () =>
      (await window.careerflow.profiles.list()).map((p) => String(p.id))
    );
    const resDeleted = await win.evaluate(
      ([u, cf]) => window.careerflow.donut.openSubjectLink(u, cf),
      ["https://example.com/after-delete", ids.a]
    );
    expect(
      { remaining, provider: resDeleted.provider },
      `remaining=${JSON.stringify(remaining)} res=${JSON.stringify(resDeleted)}`
    ).toEqual({ remaining: [String(ids.b)], provider: "system" });

    // Post-delete open must NOT reach the Donut transport; it goes to system.
    calls = await e2eCalls(app);
    expect(calls.donutOpens).not.toContain("https://example.com/after-delete");
    expect(calls.systemOpens.filter((u) => u === "https://example.com/after-delete").length).toBe(1);
  } finally {
    await app.close();
  }
});
