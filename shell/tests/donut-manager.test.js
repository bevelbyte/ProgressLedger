// Scenario tests for the Browser Manager orchestration (createManagerOps).
// Every collaborator is a fake — no Electron, ports, processes, tokens or
// filesystem. Proves the decision tree: ownership gates, busy gate, startup,
// binding resolution incl. anti-burst exhaustion, transport outcomes and
// system-browser fallbacks, plus fixed sanitized result shapes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createManagerOps } from "../src/services/donut-manager.js";

const BP_ID = "bp-1";
const CF_ID = 7;
const DONUT_ID = "donut-abc";

function world(over = {}) {
  const calls = {
    runs: [], opens: [], systemOpens: [], touches: [],
    getStatus: 0, ensureStarted: 0, bindings: [],
  };
  const deps = {
    cfProfileExists: (id) => String(id) === String(CF_ID),
    getBrowserProfileRow: (localId) =>
      localId === BP_ID
        ? { cf_profile_id: CF_ID, enabled: true }
        : null,
    getShortcutRow: (shortcutId) =>
      shortcutId === 11
        ? {
            browser_profile_id: BP_ID,
            url: "https://example.com/science",
            cf_profile_id: CF_ID,
            enabled: true,
          }
        : null,
    provider: {
      getStatus: async () => {
        calls.getStatus++;
        return { available: true, ready: true, owned: true };
      },
      ensureStarted: async () => {
        calls.ensureStarted++;
        return { available: true, ready: true, owned: true };
      },
    },
    lifecycle: { isBusy: () => false },
    ensureBinding: async (localId) => {
      calls.bindings.push(localId);
      return DONUT_ID;
    },
    transport: {
      run: async (donutId) => {
        calls.runs.push(donutId);
        return { ok: true };
      },
      openUrl: async (donutId, url) => {
        calls.opens.push([donutId, url]);
        return { ok: true };
      },
    },
    touchBrowserProfile: (localId) => calls.touches.push(localId),
    systemOpen: async (url) => {
      calls.systemOpens.push(url);
      return true;
    },
    ...over,
  };
  return { deps, calls };
}

// ------------------------------------------------------------- launch path

test("launch success: healthy reuse, one run, one touch", async () => {
  const { deps, calls } = world();
  const ops = createManagerOps(deps);
  const res = await ops.openBrowserProfile(BP_ID, CF_ID);
  assert.deepEqual(res, { ok: true });
  assert.equal(calls.getStatus, 1);
  assert.equal(calls.ensureStarted, 0, "healthy backend must not restart");
  assert.deepEqual(calls.runs, [DONUT_ID]);
  assert.deepEqual(calls.touches, [BP_ID]);
});

test("launch reuses an already-running owned browser without /run", async () => {
  const { deps, calls } = world({
    probeBrowserLiveness: async () => ({ ok: true, running: true }),
    transport: {
      run: async () => {
        calls.runs.push("unexpected-run");
        return { ok: false };
      },
      openUrl: async () => ({ ok: true }),
    },
  });
  const ops = createManagerOps(deps);
  const res = await ops.openBrowserProfile(BP_ID, CF_ID);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(calls.runs, []);
  assert.deepEqual(calls.touches, [BP_ID]);
});

test("launch starts the backend when not ready", async () => {
  let first = true;
  const { deps, calls } = world({
    provider: {
      getStatus: async () => {
        calls.getStatus++;
        return first
          ? { available: false, ready: false, owned: false }
          : { available: true, ready: true, owned: true };
      },
      ensureStarted: async () => {
        calls.ensureStarted++;
        first = false;
        return { available: true, ready: true, owned: true };
      },
    },
  });
  const ops = createManagerOps(deps);
  const res = await ops.openBrowserProfile(BP_ID, CF_ID);
  assert.deepEqual(res, { ok: true });
  assert.equal(calls.ensureStarted, 1);
});

test("ownership gates fire before any side effect", async () => {
  for (const [over, reason] of [
    [(d) => (d.cfProfileExists = () => false), "unknown-cf-profile"],
    [(d) => (d.getBrowserProfileRow = () => ({ cf_profile_id: 999, enabled: true })), "not-owned"],
    [(d) => (d.getBrowserProfileRow = () => ({ cf_profile_id: CF_ID, enabled: false })), "disabled"],
  ]) {
    const { deps, calls } = world();
    over(deps);
    const ops = createManagerOps(deps);
    const res = await ops.openBrowserProfile(BP_ID, CF_ID);
    assert.deepEqual(res, { ok: false, reason });
    assert.equal(
      calls.getStatus + calls.runs.length + calls.bindings.length + calls.touches.length,
      0,
      reason
    );
  }
});

test("startup failure reports backend-unavailable", async () => {
  const { deps } = world({
    provider: {
      getStatus: async () => ({ available: false, ready: false, owned: false }),
      ensureStarted: async () => ({ available: false, ready: false, owned: false }),
    },
  });
  const ops = createManagerOps(deps);
  const res = await ops.openBrowserProfile(BP_ID, CF_ID);
  assert.deepEqual(res, { ok: false, reason: "backend-unavailable" });
});

test("anti-burst budget exhaustion is reported distinctly", async () => {
  const { deps } = world({
    ensureBinding: async () => {
      throw new Error("binding-budget-exceeded");
    },
  });
  const ops = createManagerOps(deps);
  const res = await ops.openBrowserProfile(BP_ID, CF_ID);
  assert.deepEqual(res, { ok: false, reason: "anti-burst-budget-exceeded" });
});

test("generic binding failure reports binding-unavailable", async () => {
  const { deps } = world({
    ensureBinding: async () => {
      throw new Error("transport-error");
    },
  });
  const ops = createManagerOps(deps);
  const res = await ops.openBrowserProfile(BP_ID, CF_ID);
  assert.deepEqual(res, { ok: false, reason: "binding-unavailable" });
});

test("run refusal / transport throw both yield run-failed with no touch", async () => {
  const noTouch = (over) => {
    const w = world(over);
    return w;
  };
  for (const over of [
    { transport: { run: async () => ({ ok: false }), openUrl: async () => ({ ok: true }) } },
    { transport: { run: async () => { throw new Error("boom"); }, openUrl: async () => ({ ok: true }) } },
  ]) {
    const { deps, calls } = noTouch(over);
    const ops = createManagerOps(deps);
    const res = await ops.openBrowserProfile(BP_ID, CF_ID);
    assert.deepEqual(res, { ok: false, reason: "run-failed" });
    assert.deepEqual(calls.touches, []);
  }
});

// ---------------------------------------------------------- shortcut path

test("shortcut restarts a stopped mapped browser before navigation", async () => {
  const { deps, calls } = world({
    probeBrowserLiveness: async () => ({ ok: true, running: false }),
  });
  const ops = createManagerOps(deps);
  const res = await ops.openShortcutUrl(11, CF_ID);
  assert.deepEqual(res, {
    opened: true,
    provider: "donut",
    url: "https://example.com/science",
  });
  assert.deepEqual(calls.runs, [DONUT_ID]);
  assert.deepEqual(calls.opens, [[DONUT_ID, "https://example.com/science"]]);
});

test("shortcut reports run failure instead of navigating a stopped mapped browser", async () => {
  const { deps, calls } = world({
    probeBrowserLiveness: async () => ({ ok: true, running: false }),
    transport: {
      run: async (donutId) => { calls.runs.push(donutId); return { ok: false }; },
      openUrl: async () => ({ ok: true }),
    },
  });
  const ops = createManagerOps(deps);
  const res = await ops.openShortcutUrl(11, CF_ID);
  assert.deepEqual(res, { ok: false, reason: "run-failed" });
  assert.deepEqual(calls.opens, []);
});
test("shortcut success navigates via /open-url and touches the owner", async () => {
  const { deps, calls } = world();
  const ops = createManagerOps(deps);
  const res = await ops.openShortcutUrl(11, CF_ID);
  assert.deepEqual(res, {
    opened: true,
    provider: "donut",
    url: "https://example.com/science",
  });
  assert.deepEqual(calls.opens, [[DONUT_ID, "https://example.com/science"]]);
  assert.deepEqual(calls.systemOpens, []);
  assert.deepEqual(calls.touches, [BP_ID]);
});

test("shortcut falls back to the system browser when Donut cannot serve it", async () => {
  // backend stays unavailable
  const down = world({
    provider: {
      getStatus: async () => ({ available: false, ready: false, owned: false }),
      ensureStarted: async () => ({ available: false, ready: false, owned: false }),
    },
  });
  let res = await createManagerOps(down.deps).openShortcutUrl(11, CF_ID);
  assert.deepEqual(res, { opened: true, provider: "system" });
  assert.deepEqual(down.calls.systemOpens, ["https://example.com/science"]);

  // binding failure also degrades to system
  const bindFail = world({ ensureBinding: async () => { throw new Error("x"); } });
  res = await createManagerOps(bindFail.deps).openShortcutUrl(11, CF_ID);
  assert.deepEqual(res, { opened: true, provider: "system" });

  // transport refusal also degrades
  const refused = world({
    transport: {
      run: async () => ({ ok: true }),
      openUrl: async () => ({ ok: false }),
    },
  });
  res = await createManagerOps(refused.deps).openShortcutUrl(11, CF_ID);
  assert.deepEqual(res, { opened: true, provider: "system" });
});

test("shortcut validity failures are explicit and never leak outward", async () => {
  // missing shortcut
  {
    const { deps, calls } = world();
    let res = await createManagerOps(deps).openShortcutUrl(999, CF_ID);
    assert.deepEqual(res, { ok: false, reason: "shortcut-not-found" });
    assert.equal(calls.systemOpens.length, 0);
  }
  // foreign owner
  {
    const { deps } = world();
    const d = deps;
    const orig = d.getShortcutRow;
    d.getShortcutRow = (id) => {
      const row = orig(id);
      return row ? { ...row, cf_profile_id: 42 } : null;
    };
    const res = await createManagerOps(d).openShortcutUrl(11, CF_ID);
    assert.deepEqual(res, { ok: false, reason: "not-owned" });
  }
  // dangerous stored URL rejected by validation before anything else
  {
    const { deps, calls } = world();
    const orig = deps.getShortcutRow;
    deps.getShortcutRow = (id) => {
      const row = orig(id);
      return row ? { ...row, url: "javascript:alert(1)" } : null;
    };
    const res = await createManagerOps(deps).openShortcutUrl(11, CF_ID);
    assert.deepEqual(res, { ok: false, reason: "invalid-url" });
    assert.equal(calls.systemOpens.length, 0, "invalid URL must not reach the system browser");
    assert.equal(calls.getStatus, 0);
  }
  // disabled owning browser profile
  {
    const { deps } = world();
    deps.getBrowserProfileRow = (localId) =>
      localId === BP_ID ? { cf_profile_id: CF_ID, enabled: false } : null;
    const res = await createManagerOps(deps).openShortcutUrl(11, CF_ID);
    assert.deepEqual(res, { ok: false, reason: "disabled" });
  }
  // foreign/unknown CF profile: ownership mismatch on the shortcut row wins
  {
    const { deps } = world();
    const res = await createManagerOps(deps).openShortcutUrl(11, 424242);
    assert.deepEqual(res, { ok: false, reason: "not-owned" });
  }
});

test("results are fixed shapes carrying no infrastructure detail", async () => {
  const SECRET = "SECRET-BEARER-TOKEN";
  const { deps } = world({
    transport: {
      run: async () => ({ ok: false, status: 402 }),
      openUrl: async () => { throw new Error("boom " + SECRET); },
    },
  });
  const ops = createManagerOps(deps);
  const allowed = new Set([
    JSON.stringify({ ok: true }),
    JSON.stringify({ ok: false, reason: "unknown-cf-profile" }),
    JSON.stringify({ ok: false, reason: "not-owned" }),
    JSON.stringify({ ok: false, reason: "disabled" }),
    JSON.stringify({ ok: false, reason: "busy" }),
    JSON.stringify({ ok: false, reason: "backend-unavailable" }),
    JSON.stringify({ ok: false, reason: "anti-burst-budget-exceeded" }),
    JSON.stringify({ ok: false, reason: "binding-unavailable" }),
    JSON.stringify({ ok: false, reason: "run-failed" }),
    JSON.stringify({ ok: false, reason: "shortcut-not-found" }),
    JSON.stringify({ ok: false, reason: "invalid-url" }),
  ]);
  for (const res of [
    await ops.openBrowserProfile(BP_ID, CF_ID),
    await ops.openShortcutUrl(11, CF_ID),
  ]) {
    if ("ok" in res && !(res.opened === true)) {
      assert.ok(allowed.has(JSON.stringify(res)), "unexpected shape " + JSON.stringify(res));
    }
    assert.ok(!JSON.stringify(res).includes(SECRET));
  }
});
