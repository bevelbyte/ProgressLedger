// Official Donut connection provider (contract v0.31.x).
//
// HISTORY: this suite pinned the DBI-era owned-backend provider: launcher
// spawn dedupe, startup locks, PID/image ownership proofs, runtime.json
// parsing and /health readiness. All of that died with the ownership layer —
// the official Donut app is the USER's process and CareerFlow only connects.
//
// WHAT THIS SUITE PINS NOW:
//   1. connect/probe semantics against the official authenticated REST surface
//   2. provider-neutral status shapes (no pid/port/token/ownership fields)
//   3. ensureStarted NEVER spawns or kills anything (it is connect-only)
//   4. honest unavailable reporting when the Local API is off or unreachable
//   5. racing connects stay bounded and never touch a process

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDonutProvider,
  makeHealthProbe,
  sanitizeStatus,
  PUBLIC_STATUS_KEYS,
  STATES,
} from "../src/services/donut.js";

const CRED = { port: 10108, token: "unit-test-token-not-a-secret" };

function makeWorld({ cred = CRED, fetchSeq = [], fetchDefault } = {}) {
  const calls = { fetches: [] };
  const take = (queue, fallback) => async (url, init) => {
    calls.fetches.push({ url: String(url), init });
    const next = queue.shift();
    if (next) return typeof next === "function" ? next(url, init) : next;
    return fallback(url, init);
  };
  const deps = {
    probe: makeHealthProbe(
      take(fetchSeq, fetchDefault ?? (() => ({ ok: true, status: 200 }))),
      async () => cred,
    ),
    readRuntimeCredential: async () => cred,
  };
  return { deps, calls };
}

const okJson = { ok: true, status: 200 };
const serverError = { ok: false, status: 500 };

// ----------------------------------------------------------- connect semantics
test("connect reports ready when the authenticated probe succeeds", async () => {
  const { deps } = makeWorld({ fetchSeq: [okJson] });
  const provider = createDonutProvider(deps);
  const status = await provider.ensureStarted();
  assert.equal(status.state, STATES.READY);
  assert.equal(status.available, true);
  assert.equal(status.ready, true);
});

test("ensureStarted is CONNECT-ONLY: no spawn, no kill surface exists", async () => {
  const { deps } = makeWorld({ fetchSeq: [okJson] });
  const provider = createDonutProvider(deps);
  for (const forbidden of ["spawn", "kill", "stop", "shutdown", "terminate", "ensureStartedProcess"]) {
    assert.equal(forbidden in provider, false, `provider must not expose ${forbidden}`);
  }
  await provider.ensureStarted();
});

test("a disabled or credential-less Local API reports unavailable honestly", async () => {
  const { deps } = makeWorld({ cred: null, fetchSeq: [] });
  const provider = createDonutProvider(deps);
  const status = await provider.getStatus();
  assert.equal(status.state, STATES.UNAVAILABLE);
  assert.equal(status.available, false);
  assert.equal(status.ready, false);
  assert.equal(status.detail, "local-api-unavailable");
});

test("a reachable API that answers non-200 reports api-not-ready", async () => {
  const { deps } = makeWorld({ fetchSeq: [serverError] });
  const provider = createDonutProvider(deps);
  const status = await provider.getStatus();
  assert.equal(status.state, STATES.UNAVAILABLE);
  assert.equal(status.detail, "api-not-ready");
});

test("an unreachable API reports api-unreachable", async () => {
  const { deps } = makeWorld({
    fetchSeq: [async () => { throw new Error("ECONNREFUSED"); }],
  });
  const provider = createDonutProvider(deps);
  const status = await provider.getStatus();
  assert.equal(status.state, STATES.UNAVAILABLE);
  assert.equal(status.detail, "api-unreachable");
});

test("the probe uses the AUTHENTICATED REST surface — never /health", async () => {
  const { deps, calls } = makeWorld({ fetchSeq: [okJson] });
  const provider = createDonutProvider(deps);
  await provider.getStatus();
  assert.equal(calls.fetches.length, 1);
  const req = calls.fetches[0];
  assert.ok(req.url.includes("/v1/profiles"), "liveness is a bearer-authenticated REST read");
  assert.equal(req.url.includes("/health"), false, "/health does not exist on the official app server");
  // Compare presence/shape ONLY — never assertEquals the header value, or a
  // mismatch would print a real token into the assertion diff.
  const auth = String(req.init.headers.Authorization ?? "");
  assert.equal(auth.startsWith("Bearer "), true, "probe must send a bearer");
  assert.equal(auth, `Bearer ${CRED.token}`, "probe must use the injected credential");
});

// ----------------------------------------------------------- status privacy
test("status shapes are provider-neutral and never leak secrets", async () => {
  const { deps } = makeWorld({ fetchSeq: [okJson] });
  const provider = createDonutProvider(deps);
  const status = await provider.getStatus();
  const flat = JSON.stringify(status);
  for (const forbidden of ["pid", "launcherPid", "api_token", "mcp_token", "port", "data_dir", "owned", "foreign", "stale"]) {
    assert.equal(PUBLIC_STATUS_KEYS.includes(forbidden), false, `${forbidden} must not be renderer-reachable`);
    assert.equal(Object.prototype.hasOwnProperty.call(status, forbidden), false, `status leaked ${forbidden}`);
    assert.equal(flat.includes(forbidden), false, `serialized status leaked ${forbidden}`);
  }
  assert.ok(!flat.includes(CRED.token), "token must never reach a status payload");
});

test("sanitizeStatus keeps the whitelist and strips everything else", () => {
  const out = sanitizeStatus({
    state: "ready",
    available: true,
    ready: true,
    detail: "ok",
    pid: 4242,
    port: 10108,
    api_token: "D-leak",
    owned: true,
  });
  assert.deepEqual(out, { state: "ready", available: true, ready: true, detail: "ok" });
});

// ----------------------------------------------------------- concurrency
test("racing connects stay bounded and never touch a process", async () => {
  const { deps, calls } = makeWorld({ fetchSeq: [okJson] });
  const provider = createDonutProvider(deps);
  const results = await Promise.all([
    provider.ensureStarted(),
    provider.ensureStarted(),
    provider.getStatus(),
  ]);
  for (const s of results) assert.equal(s.ready, true);
  assert.ok(calls.fetches.length >= 1 && calls.fetches.length <= 3);
  for (const req of calls.fetches) {
    assert.ok(req.url.startsWith("http://127.0.0.1:"), "loopback only");
  }
});

// ----------------------------------------------------------- status vocabulary
test("STATES stays provider-neutral (no ownership vocabulary)", () => {
  const values = Object.values(STATES);
  assert.ok(values.includes("ready"));
  assert.ok(values.includes("unavailable"));
  for (const v of values) {
    assert.equal(/owned|foreign|stale|launcher/.test(v), false, `state ${v} reintroduces ownership vocabulary`);
  }
});
