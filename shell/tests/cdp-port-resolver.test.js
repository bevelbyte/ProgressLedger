// Official port resolution (Donut 0.31.x contract): the per-profile CDP port
// comes from the profile payload's `remote_debugging_port` (the field
// POST /v1/profiles/{id}/run returns and GET /v1/profiles/{id} reports), with
// this process's /run cache as fallback. Nothing else — no /json/* discovery,
// no DevTools metadata, no process-tree command-line scanning.
//
// These tests replace the pre-Playwright ownership-probe suite: the probe
// guarded a raw DevTools socket that no longer exists. The boundary it
// protected (loopback-only, profile-owned endpoint) now lives in
// cdp-session.js (validated numeric port -> http://127.0.0.1:<port>) and in
// the ownership gate below.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createCdpPortResolver,
  rememberCdpPort,
  lastCdpResolveFailure,
  _resetCdpResolveDiagnostics,
} from "../src/services/cdp-adapter.js";

const CRED = { port: 10108, token: "unit-test-token-not-a-secret" };

function makeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    const r = routes[key];
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body ?? {}),
    };
  };
  impl.calls = calls;
  return impl;
}

function resolverWith(fetchImpl, cred = CRED) {
  return createCdpPortResolver({
    readRuntimeCredential: async () => cred,
    fetchImpl,
  });
}

const RUNNING = {
  "/v1/profiles/": {
    status: 200,
    body: {
      profile: {
        id: "d1",
        is_running: true,
        process_id: 777,
        remote_debugging_port: 52000,
      },
    },
  },
};

test("the official remote_debugging_port field resolves the session port", async () => {
  _resetCdpResolveDiagnostics();
  const fetchImpl = makeFetch(RUNNING);
  const r = await resolverWith(fetchImpl)("d1");
  assert.deepEqual(r, { ok: true, port: 52000, donutId: "d1" });
  assert.equal(lastCdpResolveFailure(), null, "success clears the failure record");
  // The ONLY network surface used is the REST profile read.
  assert.ok(fetchImpl.calls.every((u) => u.includes("/v1/profiles/d1")));
  assert.equal(fetchImpl.calls.some((u) => /\/json\//.test(u)), false, "no /json discovery");
});

test("a restarted browser's current port supersedes the /run cache", async () => {
  _resetCdpResolveDiagnostics();
  rememberCdpPort("d-restart", 9222);
  const fetchImpl = makeFetch({
    "/v1/profiles/": {
      status: 200,
      body: { profile: { id: "d-restart", is_running: true, process_id: 1, remote_debugging_port: 9333 } },
    },
  });
  const r = await resolverWith(fetchImpl)("d-restart");
  assert.equal(r?.port, 9333, "the live profile field wins over the stale cache");
});

test("the /run cache serves as fallback when the profile payload omits the port", async () => {
  _resetCdpResolveDiagnostics();
  rememberCdpPort("d-cache", 9444);
  const fetchImpl = makeFetch({
    "/v1/profiles/": {
      status: 200,
      body: { profile: { id: "d-cache", is_running: true, process_id: 1 } },
    },
  });
  const r = await resolverWith(fetchImpl)("d-cache");
  assert.equal(r?.port, 9444);
});

test("stage=credential when the runtime credential is unusable", async () => {
  _resetCdpResolveDiagnostics();
  const r = createCdpPortResolver({ readRuntimeCredential: async () => null });
  assert.equal(await r("d1"), null);
  assert.equal(lastCdpResolveFailure().stage, "credential");
});

test("stage=profile-fetch when the profile read fails", async () => {
  _resetCdpResolveDiagnostics();
  const fetchImpl = makeFetch({ "/v1/profiles/": { status: 404, body: {} } });
  assert.equal(await resolverWith(fetchImpl)("d1"), null);
  const f = lastCdpResolveFailure();
  assert.equal(f.stage, "profile-fetch");
  assert.equal(f.httpStatus, 404);
});

test("stage=not-running when the profile is stopped", async () => {
  _resetCdpResolveDiagnostics();
  const fetchImpl = makeFetch({
    "/v1/profiles/": {
      status: 200,
      body: { profile: { id: "d1", is_running: false, process_id: null } },
    },
  });
  assert.equal(await resolverWith(fetchImpl)("d1"), null);
  assert.equal(lastCdpResolveFailure().stage, "not-running");
});

test("stage=port-unresolved when neither the profile nor the cache has a port", async () => {
  _resetCdpResolveDiagnostics();
  const fetchImpl = makeFetch({
    "/v1/profiles/": {
      status: 200,
      body: { profile: { id: "d-noport", is_running: true, process_id: 0 } },
    },
  });
  assert.equal(await resolverWith(fetchImpl)("d-noport"), null);
  assert.equal(lastCdpResolveFailure().stage, "port-unresolved");
});

test("out-of-range port values are refused", async () => {
  _resetCdpResolveDiagnostics();
  for (const bad of [0, -5, 65536, 1.5, "9222"]) {
    const fetchImpl = makeFetch({
      "/v1/profiles/": {
        status: 200,
        body: { profile: { id: "d1", is_running: true, remote_debugging_port: bad } },
      },
    });
    const r = await resolverWith(fetchImpl)("d1");
    assert.equal(r, null, `port ${String(bad)} must not resolve`);
    assert.equal(lastCdpResolveFailure().stage, "port-unresolved");
  }
});

test("diagnostics never record tokens, headers, or page data", async () => {
  _resetCdpResolveDiagnostics();
  const fetchImpl = makeFetch({ "/v1/profiles/": { status: 500, body: { token: "LEAK" } } });
  await resolverWith(fetchImpl)("d1");
  const f = lastCdpResolveFailure();
  const flat = JSON.stringify(f);
  assert.ok(!flat.includes(CRED.token), "bearer token must never be recorded");
  assert.ok(!flat.includes("LEAK"), "response bodies must never be recorded");
  for (const key of Object.keys(f)) {
    assert.equal(/token|auth|cookie|header/i.test(key), false, `unexpected field ${key}`);
  }
});
