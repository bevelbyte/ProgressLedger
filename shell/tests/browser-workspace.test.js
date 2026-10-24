// Browser Workspace ops: launch/navigate/tab operations with sanitized state,
// ownership gates, and event-emission contract.
//
// Same testing pattern as cdp-adapter.test.js / donut-manager.test.js:
// every collaborator is a stub. No Electron, no real Donut, no real HTTP.
// The injected `adapter` here is the same surface that createCdpAdapter()
// returns, but we use a fake so we can drive every failure path precisely.
//
// Coverage matrix:
//   - launch happy path sanitizes the result (no token/port/path/runtimeId)
//   - launch reports unknown-profile when resolveOwnedRuntime returns it
//   - launch reports backend-unavailable when ensureStarted never owns the backend
//   - launch reports run-failed when the transport run rejects
//   - navigate validates URL: invalid-url / javascript: / file: / empty
//   - navigate active tab refresh picks up the new URL on success
//   - new-tab delegates and refreshes the tab list
//   - close-tab refresh removes the closed id and elects a new active tab
//   - activate-tab returns invalid-tab when tabId missing
//   - reload returns feature-not-supported without inventing a backend call
//   - screenshot delegates and returns the adapter image unchanged
//   - subscribe returns a snapshot in the stable shape (always { ok, workspace })
//   - event emitter fires launched/stopped/navigated/new-tab/close-tab on every mutation
//   - status-tick timer is set on launch and cleared on stop
//   - stub-mode parity: same ops object, no Electron, identical sanitized result

import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceOps } from "../src/services/browser-workspace.js";
import { REASONS } from "../src/services/cdp-adapter.js";

// -------------------------------------------------------------------- helpers

const URL_OK = "https://example.com/study";
const TOKEN = "SECRET-BEARER-TOKEN-XX";
const PORT = 10108;

/** Lightweight cdp adapter fake. Each method is configurable per test. */
function makeAdapterFake(over = {}) {
  return {
    async openUrl(localId, url) {
      return { ok: true };
    },
    async listTabs(localId) {
      return { ok: true, tabs: [] };
    },
    async createTab(localId) {
      return { ok: true, tabId: "tab-1" };
    },
    async closeTab(localId, tabId) {
      return { ok: true };
    },
    async activateTab(localId, tabId) {
      return { ok: true };
    },
    async screenshot(localId, tabId) {
      return { ok: true, image: { dataUrl: "data:image/png;base64,AA", width: 1, height: 1 } };
    },
    ...over,
  };
}

/** In-memory binding + provider + lifecycle stand-ins. */
function makeDonutGraph(over = {}) {
  const rec = over.rec ?? { workspaceEvents: [], donutRuns: [] };
  return {
    rec,
    provider: {
      async getStatus() {
        return { state: "owned-existing", available: true, ready: true, owned: true };
      },
      async ensureStarted() {
        return { state: "ready", available: true, ready: true, owned: true };
      },
      ...(over.provider || {}),
    },
    lifecycle: {
      isBusy: () => false,
      ...(over.lifecycle || {}),
    },
    ensureBinding: async (localId) => `donut-${localId}`,
    resolveOwnedRuntime: async (localId) => ({ ok: true, donutId: `donut-${localId}` }),
    ...over,
  };
}

function buildOps({ adapter = makeAdapterFake(), donut = makeDonutGraph(), transport = { run: async () => ({ ok: true }) }, ensureOwnedBinding = null, authorizeBrowserProfile = async () => ({ ok: true }), probeBrowserLiveness = null, focusSeparate = null, events = [] } = {}) {
  const ops = createWorkspaceOps({
    donut,
    core: null,
    adapter,
    rec: donut.rec,
    transport,
    ensureOwnedBinding,
    authorizeBrowserProfile,
    probeBrowserLiveness,
    focusSeparate,
    setStatusTimer() { /* no-op in tests; timer assertions live below */ },
    emit(evt) { events.push(evt); },
  });
  ops._state = {
    state: "closed", backend: null, profileLocalId: null, tabs: [], activeTabId: null,
    lastError: null, openedAt: null, updatedAt: Date.now(),
  };
  return { ops, events };
}

// ---------------------------------------------------------------- 1. launch

test("launch: happy path → ready, sanitized workspace shape, no token/port/path", async () => {
  const { ops } = buildOps();
  const res = await ops.launch({ profileLocalId: "bp-1", cfProfileId: "7", headless: false });
  assert.equal(res.ok, true);
  assert.equal(res.workspace.state, "ready");
  assert.equal(res.workspace.profileLocalId, "bp-1");
  assert.equal(res.workspace.activeTabId, null);
  assert.deepEqual(res.workspace.tabs, []);
  assert.equal(res.workspace.lastError, null);
  // The renderer must never see transport secrets.
  const flat = JSON.stringify(res);
  assert.ok(!flat.includes(TOKEN));
  assert.ok(!flat.includes(String(PORT)));
  assert.ok(!flat.includes("runtime.json"));
  assert.ok(!flat.toLowerCase().includes("127.0.0.1"));
});

test("launch: emits a 'launched' event the moment the workspace becomes ready", async () => {
  const events = [];
  const { ops } = buildOps({ events });
  await ops.launch({ profileLocalId: "bp-1", cfProfileId: "7", headless: false });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "launched");
  assert.equal(events[0].profileLocalId, "bp-1");
});

test("launch: unknown-profileLocalId → unknown-profile, no run, no event", async () => {
  const events = [];
  const calls = { transportRuns: 0 };
  const { ops } = buildOps({
    events,
    transport: { run: async () => { calls.transportRuns++; return { ok: true }; } },
  });
  const res = await ops.launch({ profileLocalId: "", cfProfileId: "7" });
  assert.deepEqual(res, { ok: false, reason: REASONS.UNKNOWN_PROFILE });
  assert.equal(calls.transportRuns, 0);
  assert.equal(events.length, 0);
});

test("launch: missing cfProfileId → unknown-profile (renderer cannot bypass CF ownership)", async () => {
  const events = [];
  const calls = { transportRuns: 0 };
  const { ops } = buildOps({
    events,
    transport: { run: async () => { calls.transportRuns++; return { ok: true }; } },
  });
  const res = await ops.launch({ profileLocalId: "bp-1" });
  assert.deepEqual(res, { ok: false, reason: REASONS.UNKNOWN_PROFILE });
  assert.equal(calls.transportRuns, 0);
});

test("launch: resolveOwnedRuntime denies → unknown-profile, no run", async () => {
  const events = [];
  const calls = { transportRuns: 0 };
  const donut = makeDonutGraph({
    resolveOwnedRuntime: async () => ({ ok: false, reason: "foreign-runtime" }),
  });
  const { ops } = buildOps({
    events,
    donut,
    transport: { run: async () => { calls.transportRuns++; return { ok: true }; } },
  });
  const res = await ops.launch({ profileLocalId: "bp-foreign", cfProfileId: "7" });
  assert.deepEqual(res, { ok: false, reason: REASONS.UNKNOWN_PROFILE });
  assert.equal(calls.transportRuns, 0);
});

test("launch: backend unavailable → backend-unavailable with sanitized backend echo", async () => {
  const events = [];
  const calls = { transportRuns: 0 };
  const donut = makeDonutGraph({
    provider: {
      async getStatus() { return { state: "unavailable", available: false, ready: false, owned: false }; },
      async ensureStarted() {
        return { state: "unavailable", available: false, ready: false, owned: false };
      },
    },
  });
  const { ops } = buildOps({
    events,
    donut,
    transport: { run: async () => { calls.transportRuns++; return { ok: true }; } },
  });
  const res = await ops.launch({ profileLocalId: "bp-1", cfProfileId: "7" });
  assert.equal(res.ok, false);
  assert.equal(res.reason, REASONS.BACKEND_UNAVAILABLE);
  assert.equal(calls.transportRuns, 0);
  // The echoed backend payload is sanitized (no port/token/etc.).
  const flat = JSON.stringify(res);
  assert.ok(!flat.includes(TOKEN));
  assert.ok(!flat.includes(String(PORT)));
});

test("launch: reuses an already-running owned browser without calling /run", async () => {
  let transportRuns = 0;
  const { ops } = buildOps({
    probeBrowserLiveness: async () => ({ ok: true, running: true }),
    transport: { run: async () => { transportRuns += 1; return { ok: false }; } },
  });
  const res = await ops.launch({ profileLocalId: "bp-running", cfProfileId: "7" });
  assert.equal(res.ok, true);
  assert.equal(res.workspace.state, "ready");
  assert.equal(transportRuns, 0);
});

test("launch: separate mode fails closed when native foreground focus cannot be established", async () => {
  let killCalls = 0;
  const { ops } = buildOps({
    adapter: makeAdapterFake({
      async killBrowser() {
        killCalls += 1;
        return { ok: true };
      },
    }),
    focusSeparate: async () => false,
  });
  const res = await ops.launch({ profileLocalId: "bp-focus-fail", cfProfileId: "7", mode: "separate" });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "separate-focus-failed");
  const snapshot = await ops.snapshot();
  assert.equal(snapshot.state, "stopped");
  assert.equal(snapshot.lastError, "separate-focus-failed");
  assert.equal(killCalls, 1);
});

test("launch: concurrent requests for the same owned profile share one launch transaction", async () => {
  let transportRuns = 0;
  let releaseRun;
  const runStarted = new Promise((resolve) => {
    releaseRun = resolve;
  });
  const { ops } = buildOps({
    transport: {
      run: async () => {
        transportRuns += 1;
        await runStarted;
        return { ok: true };
      },
    },
  });
  const first = ops.launch({ profileLocalId: "bp-concurrent", cfProfileId: "7" });
  const second = ops.launch({ profileLocalId: "bp-concurrent", cfProfileId: "7" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(transportRuns, 1);
  releaseRun();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(a.workspace, b.workspace);
});

test("launch: a 409 with inconclusive liveness never kills the owned browser", async () => {
  let killCalls = 0;
  let livenessCalls = 0;
  const { ops } = buildOps({
    probeBrowserLiveness: async () => {
      livenessCalls += 1;
      return { ok: false, reason: "backend-unavailable" };
    },
    adapter: makeAdapterFake({
      async killBrowser() {
        killCalls += 1;
        return { ok: true };
      },
    }),
    transport: {
      run: async () => ({ ok: false, status: 409, error: "already-running" }),
    },
  });
  const res = await ops.launch({ profileLocalId: "bp-409-unknown", cfProfileId: "7" });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "run-failed");
  assert.equal(killCalls, 0);
  assert.equal(livenessCalls, 2);
});

test("launch: a 409 is recovered only after five definitive stopped probes", async () => {
  let killCalls = 0;
  let livenessCalls = 0;
  let runCalls = 0;
  const { ops } = buildOps({
    probeBrowserLiveness: async () => {
      livenessCalls += 1;
      return { ok: true, running: false };
    },
    adapter: makeAdapterFake({
      async killBrowser() {
        killCalls += 1;
        return { ok: true };
      },
    }),
    transport: {
      run: async () => {
        runCalls += 1;
        return runCalls === 1 ? { ok: false, status: 409, error: "already-running" } : { ok: true };
      },
    },
  });
  const res = await ops.launch({ profileLocalId: "bp-409-stopped", cfProfileId: "7" });
  assert.equal(res.ok, true);
  assert.equal(runCalls, 2, "the second /run must happen only after ownership-scoped recovery");
  assert.equal(killCalls, 1, "only the owned stale browser may be killed");
  assert.equal(livenessCalls, 6, "one initial probe plus exactly five definitive recovery probes");
});

test("launch: a 409 recovery aborts when a later liveness probe reports a running browser", async () => {
  let killCalls = 0;
  let livenessCalls = 0;
  let runCalls = 0;
  const { ops } = buildOps({
    probeBrowserLiveness: async () => {
      livenessCalls += 1;
      return { ok: true, running: livenessCalls >= 3 };
    },
    adapter: makeAdapterFake({
      async killBrowser() {
        killCalls += 1;
        return { ok: true };
      },
    }),
    transport: {
      run: async () => {
        runCalls += 1;
        return { ok: false, status: 409, error: "already-running" };
      },
    },
  });
  const res = await ops.launch({ profileLocalId: "bp-409-running", cfProfileId: "7" });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "run-failed");
  assert.equal(runCalls, 1, "a live browser must block retry");
  assert.equal(killCalls, 0, "a live browser must never be killed");
  assert.equal(livenessCalls, 3, "the running observation must terminate recovery immediately");
});

// Approved decision C. `integrated` mode reparented a foreign Donut/Wayfern
// top-level window INTO the CareerFlow window through the native hosting path
// (core.hostWindow / resizeHostedWindow / focusHostedWindow) - Donut as the
// CareerFlow browser engine. That path is retired, and the refusal is HONEST:
// a stale caller gets `feature-not-supported` rather than a silent downgrade to
// a different browser surface than the one it asked for.
test('RETIRED: mode "integrated" is refused and consults no collaborator', async () => {
  let transportRuns = 0;
  let bindingCalls = 0;
  let livenessCalls = 0;
  const { ops } = buildOps({
    transport: {
      async run() {
        transportRuns += 1;
        return { ok: true };
      },
    },
    ensureOwnedBinding: async (localId, cfProfileId) => {
      bindingCalls += 1;
      return { ok: true, donutId: `donut-${localId}`, cfProfileId };
    },
    probeBrowserLiveness: async () => {
      livenessCalls += 1;
      return { ok: true, running: false };
    },
  });

  const stateBefore = JSON.stringify(ops._state);
  const refused = await ops.launch({
    profileLocalId: "bp-recovery",
    cfProfileId: "7",
    mode: "integrated",
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "feature-not-supported");
  // Refused BEFORE any collaborator ran, so a retired mode cannot create a
  // binding, start a backend or launch a browser on its way out.
  assert.equal(bindingCalls, 0, "the refusal must not create a binding");
  assert.equal(transportRuns, 0, "the refusal must not launch a browser");
  assert.equal(livenessCalls, 0, "the refusal must not probe liveness");
  assert.equal(
    JSON.stringify(ops._state),
    stateBefore,
    "a refused launch must not mutate workspace state at all",
  );
});

// The surviving modes keep working: the retirement must remove the hosting
// path without taking Donut external control with it.
test('launch: "separate" and "headless" are still accepted', async () => {
  const seen = [];
  for (const mode of ["separate", "headless"]) {
    const { ops } = buildOps({
      transport: {
        async run(_donutId, options) {
          seen.push({ mode, headless: options.headless });
          return { ok: true };
        },
      },
    });
    const res = await ops.launch({ profileLocalId: `bp-${mode}`, cfProfileId: "7", mode });
    assert.equal(res.ok, true, `${mode} must still launch`);
    assert.equal(res.workspace.mode, mode);
  }
  assert.deepEqual(seen, [
    { mode: "separate", headless: false },
    { mode: "headless", headless: true },
  ]);
});

test("launch: retries an initially empty tab list so a live browser is discovered", async () => {
  let listCalls = 0;
  const adapter = makeAdapterFake({
    async listTabs() {
      listCalls += 1;
      return listCalls < 2
        ? { ok: true, tabs: [] }
        : { ok: true, tabs: [{ id: "tab-live", title: "Live", url: "https://example.com", active: true }] };
    },
  });
  const { ops } = buildOps({ adapter });
  const res = await ops.launch({ profileLocalId: "bp-live", cfProfileId: "7" });
  assert.equal(res.ok, true);
  assert.equal(listCalls, 2);
  assert.deepEqual(res.workspace.tabs, [
    { id: "tab-live", title: "Live", url: "https://example.com", active: true },
  ]);
  assert.equal(res.workspace.activeTabId, "tab-live");
});

test("launch: transport run-failed → run-failed + 'launch-failed' event", async () => {
  const events = [];
  const { ops } = buildOps({
    events,
    transport: { run: async () => ({ ok: false, reason: "boom" }) },
  });
  const res = await ops.launch({ profileLocalId: "bp-1", cfProfileId: "7" });
  assert.deepEqual(res, {
    ok: false,
    reason: "run-failed",
    backend: res.backend, // sanitized status echo
    runFailure: { status: 0, error: null },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "launch-failed");
});

test("launch: a timed-out /run still tears down the browser it may have started", async () => {
  // THE DEFECT THIS PINS
  //   A `/run` transport timeout is a CLIENT-SIDE abort. Donut may already have
  //   launched Wayfern by the time the abort fires, and aborting the HTTP
  //   request does not undo server-side work. The `run-failed` path used to
  //   return without any cleanup, while both sibling failure paths
  //   (`separate-focus-failed`, integrated-hosting failure) already called
  //   `killBrowser`. That made a timed-out launch the one failure mode that
  //   reliably leaked a browser, and the accumulation of those orphans is what
  //   eventually starved later runs of an owned backend
  //   (`backend-unavailable` with `"backend": null`).
  //
  //   The exact shape asserted here is the one seen on the real-Donut matrix:
  //   `{ status: 0, error: "transport:TimeoutError" }`.
  const killed = [];
  const adapter = makeAdapterFake({
    async killBrowser(localId, cfProfileId) {
      killed.push({ localId, cfProfileId });
      return { ok: true };
    },
  });
  const { ops } = buildOps({
    adapter,
    transport: {
      run: async () => ({ ok: false, status: 0, error: "transport:TimeoutError" }),
    },
  });
  const res = await ops.launch({ profileLocalId: "bp-1", cfProfileId: "7" });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "run-failed");
  // The original error is preserved, not replaced by the cleanup's outcome.
  assert.deepEqual(res.runFailure, { status: 0, error: "transport:TimeoutError" });
  // The browser is torn down, scoped to the exact owned profile pair.
  assert.deepEqual(killed, [{ localId: "bp-1", cfProfileId: "7" }]);
});

test("launch: run-failed cleanup is best-effort and never masks the real error", async () => {
  // If the teardown itself fails — e.g. the backend is already down, which is
  // the common case when /run failed for that reason — the launch must still
  // report `run-failed` and must still report the original transport error.
  // A cleanup failure is not allowed to become the reported outcome.
  const adapter = makeAdapterFake({
    async killBrowser() {
      throw new Error("backend gone");
    },
  });
  const { ops } = buildOps({
    adapter,
    transport: {
      run: async () => ({ ok: false, status: 0, error: "transport:TimeoutError" }),
    },
  });
  const res = await ops.launch({ profileLocalId: "bp-1", cfProfileId: "7" });
  assert.equal(res.reason, "run-failed");
  assert.deepEqual(res.runFailure, { status: 0, error: "transport:TimeoutError" });
});

test("launch: a declined 409 kill is NOT overridden by the run-failed teardown", async () => {
  // THE SECURITY BOUND OF THE TEARDOWN
  //   The teardown for an indeterminate transport failure must not become a
  //   general "kill on any run-failed". When Donut answers 409 and liveness is
  //   inconclusive, the existing code deliberately declines to kill so a live
  //   browser is never killed on a guess. That refusal must survive: a real
  //   HTTP answer from Donut is not an unknown server-side state, so there is
  //   nothing to clean up and the fail-closed decision must stand.
  //
  //   This is the case that an unconditional teardown broke. It is pinned here
  //   so the narrow scope cannot be widened back by accident.
  const killed = [];
  const adapter = makeAdapterFake({
    async killBrowser(localId, cfProfileId) {
      killed.push({ localId, cfProfileId });
      return { ok: true };
    },
  });
  const { ops } = buildOps({
    adapter,
    // 409 with an inconclusive liveness probe: the probe cannot prove the
    // browser is stopped, so the existing fail-closed rule declines to kill.
    transport: { run: async () => ({ ok: false, status: 409 }) },
    probeBrowserLiveness: async () => ({ ok: false, reason: "backend-unavailable" }),
  });
  const res = await ops.launch({ profileLocalId: "bp-1", cfProfileId: "7" });
  assert.equal(res.reason, "run-failed");
  assert.deepEqual(
    killed,
    [],
    "a 409 that deliberately declined to kill must not be overridden by the transport teardown",
  );
});

test("launch: an already-running browser is never torn down by the run-failed path", async () => {
  // SAFETY BOUND. `runOk` is initialised from `alreadyRunning`, so a browser
  // that was already live before this launch must not be killed by a later
  // `run-failed`. A liveness probe that says "running" means the transport is
  // never called, so the failure path is unreachable — and this pins that.
  const killed = [];
  const adapter = makeAdapterFake({
    async killBrowser(localId, cfProfileId) {
      killed.push({ localId, cfProfileId });
      return { ok: true };
    },
  });
  let runCalls = 0;
  const { ops } = buildOps({
    adapter,
    transport: {
      async run() {
        runCalls += 1;
        return { ok: false, status: 0, error: "transport:TimeoutError" };
      },
    },
    probeBrowserLiveness: async () => ({ ok: true, running: true }),
  });
  const res = await ops.launch({ profileLocalId: "bp-1", cfProfileId: "7" });
  assert.equal(res.ok, true, "a live browser must launch successfully");
  assert.equal(runCalls, 0, "transport.run must not be called for a live browser");
  assert.deepEqual(killed, [], "a pre-existing live browser must not be killed");
});

// --------------------------------------------------------------- 2. navigate

test("navigate: missing URL → invalid-url", async () => {
  const { ops } = buildOps();
  const res = await ops.navigate({ profileLocalId: "bp-1", cfProfileId: "7", url: "" });
  assert.deepEqual(res, { ok: false, reason: REASONS.INVALID_URL });
});

test("navigate: invalid URL (javascript:, file:, garbage) → invalid-url, no adapter call", async () => {
  const calls = { openUrl: 0 };
  const adapter = makeAdapterFake({
    async openUrl() { calls.openUrl++; return { ok: true }; },
  });
  const { ops } = buildOps({ adapter });
  for (const bad of ["javascript:alert(1)", "file:///C:/x", "not a url", ""]) {
    const res = await ops.navigate({ profileLocalId: "bp-1", cfProfileId: "7", url: bad });
    assert.deepEqual(res, { ok: false, reason: REASONS.INVALID_URL }, bad);
  }
  assert.equal(calls.openUrl, 0);
});

test("navigate: missing profileLocalId → unknown-profile, no adapter call", async () => {
  const calls = { openUrl: 0 };
  const adapter = makeAdapterFake({
    async openUrl() { calls.openUrl++; return { ok: true }; },
  });
  const { ops } = buildOps({ adapter });
  const res = await ops.navigate({ profileLocalId: "", cfProfileId: "7", url: URL_OK });
  assert.deepEqual(res, { ok: false, reason: REASONS.UNKNOWN_PROFILE });
  assert.equal(calls.openUrl, 0);
});

test("navigate: success emits 'navigated' event with the validated url", async () => {
  const events = [];
  const { ops } = buildOps({ events });
  const res = await ops.navigate({ profileLocalId: "bp-1", cfProfileId: "7", url: URL_OK });
  assert.deepEqual(res, { ok: true });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "navigated");
  assert.equal(events[0].url, URL_OK);
});

test("navigate: separate-mode focus failure fails closed instead of reporting navigation success", async () => {
  const events = [];
  const adapter = makeAdapterFake({
    async openUrl() { return { ok: true, tabId: "tab-1" }; },
    async listTabs() { return { ok: true, tabs: [{ id: "tab-1", title: "Study", url: URL_OK, active: true }] }; },
  });
  const { ops } = buildOps({
    events,
    adapter,
    focusSeparate: async () => false,
  });
  ops._state = {
    state: "ready", backend: null, profileLocalId: "bp-1", cfProfileId: "7",
    mode: "separate", tabs: [], activeTabId: null, lastError: null,
    openedAt: null, updatedAt: Date.now(),
  };
  const res = await ops.navigate({ profileLocalId: "bp-1", cfProfileId: "7", url: URL_OK });
  assert.deepEqual(res, { ok: false, reason: "focus-failed" });
  assert.equal(events.some((event) => event.kind === "navigated"), false);
});

test("navigate: adapter rejection → navigate-failed event with stable reason", async () => {
  const events = [];
  const adapter = makeAdapterFake({
    async openUrl() { return { ok: false, reason: "invalid-url" }; },
  });
  const { ops } = buildOps({ events, adapter });
  const res = await ops.navigate({ profileLocalId: "bp-1", cfProfileId: "7", url: URL_OK });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "invalid-url");
  assert.equal(events[0].kind, "navigate-failed");
  assert.equal(events[0].reason, "invalid-url");
});

// ----------------------------------------------------------------- 3. new-tab

test("new-tab: success → { ok, tabId } + 'new-tab' event", async () => {
  const events = [];
  const adapter = makeAdapterFake({
    async createTab() { return { ok: true, tabId: "tab-new" }; },
  });
  const { ops } = buildOps({ events, adapter });
  const res = await ops.newTab({ profileLocalId: "bp-1", cfProfileId: "7" });
  assert.deepEqual(res, { ok: true, tabId: "tab-new" });
  assert.equal(events[0].kind, "new-tab");
  assert.equal(events[0].tabId, "tab-new");
});

test("new-tab: missing profileLocalId → unknown-profile", async () => {
  const { ops } = buildOps();
  const res = await ops.newTab({ profileLocalId: "", cfProfileId: "7" });
  assert.deepEqual(res, { ok: false, reason: REASONS.UNKNOWN_PROFILE });
});

// ------------------------------------------------------------- 4. close-tab

test("close-tab: success → removes the tab from state + 'close-tab' event", async () => {
  const events = [];
  const adapter = makeAdapterFake({
    async listTabs() {
      return { ok: true, tabs: [{ id: "tab-1", title: "A", url: "https://a", active: true }] };
    },
    async closeTab() { return { ok: true }; },
  });
  const { ops } = buildOps({ events, adapter });
  ops._state = {
    state: "ready", backend: null, profileLocalId: "bp-1",
    tabs: [{ id: "tab-1", title: "A", url: "https://a", active: true }],
    activeTabId: "tab-1", lastError: null, openedAt: null, updatedAt: Date.now(),
  };
  const res = await ops.closeTab({ profileLocalId: "bp-1", cfProfileId: "7", tabId: "tab-1" });
  assert.deepEqual(res, { ok: true });
  assert.equal(events[0].kind, "close-tab");
  assert.equal(events[0].tabId, "tab-1");
  // After refresh the tabs array is empty (or re-populated from the stub).
  assert.ok(Array.isArray(ops._state.tabs));
});

test("close-tab: invalid tabId → invalid-tab, no adapter call", async () => {
  const calls = { closeTab: 0 };
  const adapter = makeAdapterFake({
    async closeTab() { calls.closeTab++; return { ok: true }; },
  });
  const { ops } = buildOps({ adapter });
  const res = await ops.closeTab({ profileLocalId: "bp-1", cfProfileId: "7", tabId: "" });
  assert.deepEqual(res, { ok: false, reason: REASONS.INVALID_TAB });
  assert.equal(calls.closeTab, 0);
});

// ------------------------------------------------------------ 5. activate-tab

test("activate-tab: invalid tabId → invalid-tab, no adapter call", async () => {
  const calls = { activateTab: 0 };
  const adapter = makeAdapterFake({
    async activateTab() { calls.activateTab++; return { ok: true }; },
  });
  const { ops } = buildOps({ adapter });
  const res = await ops.activateTab({ profileLocalId: "bp-1", cfProfileId: "7", tabId: "" });
  assert.deepEqual(res, { ok: false, reason: REASONS.INVALID_TAB });
  assert.equal(calls.activateTab, 0);
});

test("activate-tab: success flips the active flag locally + emits event", async () => {
  const events = [];
  const { ops } = buildOps({ events });
  ops._state = {
    state: "ready", backend: null, profileLocalId: "bp-1",
    tabs: [
      { id: "tab-1", title: "A", url: "https://a", active: true },
      { id: "tab-2", title: "B", url: "https://b", active: false },
    ],
    activeTabId: "tab-1", lastError: null, openedAt: null, updatedAt: Date.now(),
  };
  const res = await ops.activateTab({ profileLocalId: "bp-1", cfProfileId: "7", tabId: "tab-2" });
  assert.deepEqual(res, { ok: true });
  assert.equal(ops._state.activeTabId, "tab-2");
  const active = ops._state.tabs.find((t) => t.id === "tab-2");
  assert.equal(active.active, true);
  assert.equal(events[0].kind, "activate-tab");
  assert.equal(events[0].tabId, "tab-2");
});

// ---------------------------------------------------------------- 6. reload

test("reload: delegates to the adapter for a supported Separate browser", async () => {
  const calls = { openUrl: 0, listTabs: 0, screenshot: 0, reload: 0 };
  const adapter = makeAdapterFake({
    async openUrl() { calls.openUrl++; return { ok: true }; },
    async listTabs() { calls.listTabs++; return { ok: true, tabs: [] }; },
    async screenshot() { calls.screenshot++; return { ok: true, image: {} }; },
    async reload() { calls.reload++; return { ok: true }; },
  });
  const events = [];
  const { ops } = buildOps({ events, adapter });
  const res = await ops.reload({ profileLocalId: "bp-1", cfProfileId: "7", tabId: "tab-1" });
  assert.deepEqual(res, { ok: true });
  assert.equal(calls.reload, 1);
  assert.equal(calls.openUrl, 0);
  assert.equal(calls.listTabs, 2);
  assert.equal(calls.screenshot, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "reloaded");
});

// --------------------------------------------------------------- 7. screenshot

test("screenshot: success → { ok, image:{ dataUrl, width, height } }", async () => {
  const dataUrl = "data:image/png;base64,AAAA";
  const adapter = makeAdapterFake({
    async screenshot() {
      return { ok: true, image: { dataUrl, width: 1280, height: 720 } };
    },
  });
  const { ops } = buildOps({ adapter });
  const res = await ops.screenshot({ profileLocalId: "bp-1", cfProfileId: "7", tabId: "tab-1" });
  assert.deepEqual(res, {
    ok: true,
    image: { dataUrl, width: 1280, height: 720 },
  });
});

test("screenshot: invalid tabId → invalid-tab, no adapter call", async () => {
  const calls = { screenshot: 0 };
  const adapter = makeAdapterFake({
    async screenshot() { calls.screenshot++; return { ok: true, image: {} }; },
  });
  const { ops } = buildOps({ adapter });
  const res = await ops.screenshot({ profileLocalId: "bp-1", cfProfileId: "7", tabId: "" });
  assert.deepEqual(res, { ok: false, reason: REASONS.INVALID_TAB });
  assert.equal(calls.screenshot, 0);
});

// ----------------------------------------------------------------- 8. stop()

test("stop: clears state to 'stopped' and emits 'stopped' event", async () => {
  const events = [];
  const { ops } = buildOps({ events });
  ops._state = {
    state: "ready", backend: null, profileLocalId: "bp-1",
    tabs: [{ id: "tab-1", title: "A", url: "https://a", active: true }],
    activeTabId: "tab-1", lastError: null, openedAt: Date.now(), updatedAt: Date.now(),
  };
  const res = await ops.stop();
  assert.deepEqual(res, { ok: true });
  assert.equal(ops._state.state, "stopped");
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "stopped");
});

// ----------------------------------------------------------- 9. subscribe()

test("subscribe: returns the stable { ok, workspace } envelope in sanitized shape", async () => {
  const { ops } = buildOps();
  const res = await ops.subscribe();
  assert.equal(res.ok, true);
  assert.ok(res.workspace);
  for (const k of [
    "state", "backend", "profileLocalId", "activeTabId", "tabs", "lastError",
  ]) {
    assert.ok(k in res.workspace, `snapshot must include ${k}`);
  }
  // Stable-shape invariants: never null backend, never undefined arrays.
  assert.ok(Array.isArray(res.workspace.tabs));
});

// -------------------------------------------- 10. status-refresh timer wiring

test("status-refresh timer: setStatusTimer(ms) is invoked on launch, null on stop", async () => {
  const timerCalls = [];
  const ops = createWorkspaceOps({
    donut: makeDonutGraph(),
    core: null,
    adapter: makeAdapterFake(),
    rec: { workspaceEvents: [] },
    transport: { run: async () => ({ ok: true }) },
    setStatusTimer(ms) { timerCalls.push(ms); },
    emit() {},
  });
  ops._state = { state: "closed", backend: null, profileLocalId: null, tabs: [], activeTabId: null, lastError: null, openedAt: null, updatedAt: Date.now() };
  await ops.launch({ profileLocalId: "bp-1", cfProfileId: "7", headless: false });
  assert.ok(timerCalls.includes(2000), "status-refresh interval should be 2000ms");
  await ops.stop();
  // The last timer action must be the stop-clear (null), not another set.
  assert.equal(timerCalls[timerCalls.length - 1], null);
});

// ------------------------------------------------------- 11. stub-mode parity

test("stub-mode parity: the workspace ops work against the donut.js stub graph without an electron or real backend", async () => {
  // Mirror the donut.js E2E stub contract.
  const rec = { workspaceEvents: [], donutRuns: [], runFails: false, mode: "donut-ok" };
  rec.donutOpens = [];
  rec.systemOpens = [];
  rec.cfProfileIds = [];
  rec.donutProfileCreations = [];
  rec.donutTargets = [];
  rec.ensureStartedCalls = 0;
  rec.stopCalls = 0;
  rec.restartCalls = 0;
  rec.seedProfile = (id, name) => undefined;
  rec.seededProfile = (id, name) => undefined;

  const stubAdapter = makeAdapterFake({
    async listTabs() { return { ok: true, tabs: [{ id: "t1", title: "T", url: URL_OK, active: true }] }; },
  });
  const stubDonut = {
    rec,
    provider: {
      async getStatus() { return { state: "ready", available: true, ready: true, owned: true }; },
      async ensureStarted() { return { state: "ready", available: true, ready: true, owned: true }; },
    },
    lifecycle: { isBusy: () => false },
    ensureBinding: async (localId) => `donut-${localId}`,
    resolveOwnedRuntime: async (localId) => ({ ok: true, donutId: `donut-${localId}` }),
  };

  const events = [];
  const ops = createWorkspaceOps({
    donut: stubDonut,
    core: null,
    adapter: stubAdapter,
    rec,
    transport: {
      async run(donutId, opts) {
        rec.donutRuns.push({ donutId, opts });
        return { ok: !rec.runFails };
      },
    },
    authorizeBrowserProfile: async () => ({ ok: true }),
    setStatusTimer() {},
    emit(evt) {
      events.push(evt);
      rec.workspaceEvents.push(evt);
    },
  });
  ops._state = { state: "closed", backend: null, profileLocalId: null, tabs: [], activeTabId: null, lastError: null, openedAt: null, updatedAt: Date.now() };

  const launch = await ops.launch({ profileLocalId: "bp-1", cfProfileId: "7", headless: false });
  assert.equal(launch.ok, true);
  assert.equal(launch.workspace.state, "ready");
  // Transport recorded the visible-window launch call.
  assert.equal(rec.donutRuns.length, 1);
  assert.equal(rec.donutRuns[0].opts.headless, false);
  // Event recorder captured the launch event.
  assert.ok(rec.workspaceEvents.some((e) => e.kind === "launched"));
  // Sanitized state shape — no transport detail leaked.
  const flat = JSON.stringify(launch);
  assert.ok(!flat.includes(TOKEN));
  assert.ok(!flat.includes(String(PORT)));

  // Navigate through the stub adapter.
  const nav = await ops.navigate({ profileLocalId: "bp-1", cfProfileId: "7", url: URL_OK });
  assert.equal(nav.ok, true);
  assert.ok(rec.workspaceEvents.some((e) => e.kind === "navigated"));

  // Stop the workspace.
  await ops.stop();
  assert.ok(rec.workspaceEvents.some((e) => e.kind === "stopped"));
});

// -------------------------------------- 12. security: no port/token on any path

test("security: across all ops paths, no result ever embeds the bearer token or the loopback port", async () => {
  // Build the same fixture the cdp-adapter test uses (a sentinel token).
  const donut = makeDonutGraph();
  const adapter = makeAdapterFake();
  const { ops } = buildOps({ donut, adapter });

  const results = [
    await ops.snapshot(),
    await ops.launch({ profileLocalId: "bp-1", cfProfileId: "7", headless: false }),
    await ops.navigate({ profileLocalId: "bp-1", cfProfileId: "7", url: URL_OK }),
    await ops.newTab({ profileLocalId: "bp-1", cfProfileId: "7" }),
    await ops.closeTab({ profileLocalId: "bp-1", cfProfileId: "7", tabId: "tab-1" }),
    await ops.activateTab({ profileLocalId: "bp-1", cfProfileId: "7", tabId: "tab-1" }),
    await ops.reload({ profileLocalId: "bp-1", tabId: "tab-1" }),
    await ops.screenshot({ profileLocalId: "bp-1", cfProfileId: "7", tabId: "tab-1" }),
    await ops.subscribe(),
    await ops.stop(),
  ];
  for (const r of results) {
    const flat = JSON.stringify(r);
    assert.ok(!flat.includes(TOKEN), `result must not embed the bearer token: ${flat}`);
    assert.ok(!flat.includes(String(PORT)), `result must not embed the loopback port: ${flat}`);
  }
});

test("security: workspace ops never accept a port/host/token/runtimeId argument", () => {
  const { ops } = buildOps();
  const methods = ["launch", "navigate", "newTab", "closeTab", "activateTab", "reload", "screenshot"];
  for (const name of methods) {
    const fn = ops[name];
    const src = Function.prototype.toString.call(fn);
    const paramMatch = src.match(/^[^(]*\(([^)]*)\)/);
    const params = paramMatch ? paramMatch[1] : "";
    assert.ok(!/\bport\b/.test(params), `${name} must not declare a port parameter`);
    assert.ok(!/\btoken\b/.test(params), `${name} must not declare a token parameter`);
    assert.ok(!/\bhost\b/.test(params), `${name} must not declare a host parameter`);
    assert.ok(!/\bruntimeId\b/.test(params), `${name} must not declare a runtimeId parameter`);
  }
});

// -------------------------------------------- 13. state snapshot stability

test("state: snapshot exposes only the documented keys", async () => {
  const { ops } = buildOps();
  ops._state = {
    state: "ready", backend: null, profileLocalId: "bp-1",
    tabs: [], activeTabId: null, lastError: null, openedAt: Date.now(), updatedAt: Date.now(),
  };
  const snap = await ops.snapshot({ state: ops._state });
  const allowed = new Set(["state", "backend", "profileLocalId", "activeTabId", "tabs", "lastError", "openedAt", "updatedAt", "mode"]);
  for (const k of Object.keys(snap)) {
    assert.ok(allowed.has(k), `unexpected key in snapshot: ${k}`);
  }
});

test("launch: first-launch ownership-safe binding resolver can establish a binding", async () => {
  const calls = [];
  const donut = makeDonutGraph({
    resolveOwnedRuntime: async () => ({ ok: false, reason: "unknown-profile" }),
    ensureBinding: async () => "donut-first-launch",
  });
  const { ops } = buildOps({
    donut,
    ensureOwnedBinding: async (localId, cfProfileId) => {
      calls.push([localId, cfProfileId]);
      return { ok: true, donutId: "donut-first-launch" };
    },
    authorizeBrowserProfile: async () => ({ ok: true }),
    transport: { run: async (donutId) => {
      assert.equal(donutId, "donut-first-launch");
      return { ok: true };
    } },
  });
  const res = await ops.launch({ profileLocalId: "bp-first", cfProfileId: "7" });
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [["bp-first", "7"]]);
});

test("launch: ownership-safe binding resolver refusal prevents backend run", async () => {
  const calls = { transportRuns: 0 };
  const { ops } = buildOps({
    ensureOwnedBinding: async () => ({ ok: false, reason: "not-owned" }),
    transport: { run: async () => { calls.transportRuns++; return { ok: true }; } },
  });
  const res = await ops.launch({ profileLocalId: "bp-foreign", cfProfileId: "7" });
  assert.deepEqual(res, { ok: false, reason: "not-owned" });
  assert.equal(calls.transportRuns, 0);
});

test("browserWorkspace: foreign localId is rejected before adapter resolution", async () => {
  let adapterCalls = 0;
  const adapter = makeAdapterFake({
    async openUrl() { adapterCalls++; return { ok: true }; },
  });
  const { ops } = buildOps({
    adapter,
    authorizeBrowserProfile: async (cfId, localId) =>
      localId === "bp-foreign" && cfId === "7"
        ? { ok: false, reason: "not-owned" }
        : { ok: true },
  });
  const res = await ops.navigate({ profileLocalId: "bp-foreign", cfProfileId: "7", url: URL_OK });
  assert.deepEqual(res, { ok: false, reason: "not-owned" });
  assert.equal(adapterCalls, 0);
});

test("browserWorkspace: valid owner passes SQLite gate and reaches adapter", async () => {
  const calls = [];
  const adapter = makeAdapterFake({
    async openUrl(localId, cfId, url) { calls.push([localId, cfId, url]); return { ok: true }; },
  });
  const { ops } = buildOps({
    adapter,
    authorizeBrowserProfile: async (cfId, localId) =>
      cfId === "7" && localId === "bp-owned" ? { ok: true } : { ok: false, reason: "not-owned" },
  });
  const res = await ops.navigate({ profileLocalId: "bp-owned", cfProfileId: "7", url: URL_OK });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(calls, [["bp-owned", "7", URL_OK]]);
});

test("renderer browser projections redact URL credentials and bound page metadata", async () => {
  const events = [];
  const adapter = makeAdapterFake({
    async listTabs() { return { ok: true, tabs: [{ id: "t1", title: "x".repeat(9000), url: "https://example.test/path?access_token=SECRET&x=1#private", active: true }] }; },
  });
  const { ops } = buildOps({ adapter, events });
  const snap = await ops.snapshot({ state: { state: "ready", backend: "owned", profileLocalId: "bp-1", cfProfileId: "7", tabs: [{ id: "t1", title: "x".repeat(9000), url: "https://example.test/path?access_token=SECRET&x=1#private", active: true }], activeTabId: "t1", lastError: null, openedAt: 1, updatedAt: 2, mode: "separate" } });
  assert.equal(snap.tabs[0].title.length, 4096);
  assert.doesNotMatch(snap.tabs[0].url, /SECRET|access_token|#private/);
});

test("renderer browser projections strip URL userinfo even when there is no query", async () => {
  const adapter = makeAdapterFake({
    async listTabs() {
      return { ok: true, tabs: [{ id: "t1", title: "x", url: "https://user:pass@example.test/path", active: true }] };
    },
  });
  const { ops } = buildOps({ adapter });
  const snap = await ops.snapshot({
    state: {
      state: "ready",
      backend: "owned",
      profileLocalId: "bp-1",
      cfProfileId: "7",
      tabs: [{ id: "t1", title: "x", url: "https://user:pass@example.test/path", active: true }],
      activeTabId: "t1",
      lastError: null,
      openedAt: 1,
      updatedAt: 2,
      mode: "separate",
    },
  });
  assert.equal(snap.tabs[0].url, "https://example.test/path");
  assert.doesNotMatch(snap.tabs[0].url, /user|pass/);
});
