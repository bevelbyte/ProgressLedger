// Endpoint authorization for the official per-profile CDP port.
//
// HISTORY: this suite pinned the raw-DevTools port-ownership probe (a Windows
// process-tree check that answered "is the DevTools listener owned by the
// profile process?"). That probe guarded a raw WebSocket that no longer
// exists: the transport is now Playwright connectOverCDP against the official
// `remote_debugging_port`, so the authorization question changed shape.
//
// THE CONTRACT NOW (what this suite pins):
//   1. The ONLY port source is the official contract: the profile payload's
//      remote_debugging_port field (or this process's /run cache). No
//      process-tree scanning, no /json probing.
//   2. A port that cannot be authorized fails CLOSED, before any connect.
//   3. A stale cache never overrides the live profile field.
//   4. Repeated failures stay fail-closed: there is no path that grants a
//      session without an official port.
//
// The socket-level guarantees (loopback-only endpoint, no DevTools URL
// construction, no raw WebSocket) are pinned by shell/tests/cdp-session.test.js
// and scripts/check-cdp-auth-boundary.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createCdpAdapter,
  createCdpPortResolver,
  rememberCdpPort,
  lastCdpResolveFailure,
  _resetCdpResolveDiagnostics,
} from "../src/services/cdp-adapter.js";
import { createCdpSession } from "../src/services/cdp-session.js";

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

const RUNNING_WITH_PORT = {
  "/v1/profiles/": {
    status: 200,
    body: {
      profile: { id: "d1", is_running: true, process_id: 777, remote_debugging_port: 52000 },
    },
  },
};

function resolverWith(fetchImpl) {
  return createCdpPortResolver({
    readRuntimeCredential: async () => CRED,
    fetchImpl,
  });
}

test("an official port authorizes exactly one connect, and never a /json probe", async () => {
  _resetCdpResolveDiagnostics();
  const world = { connects: [] };
  const session = createCdpSession({
    connect: async (endpoint) => {
      world.connects.push(endpoint);
      return {
        contexts: () => [{ pages: () => [], on() {}, async newPage() { throw new Error("no"); } }],
        close: async () => {},
      };
    },
  });
  const fetchImpl = makeFetch(RUNNING_WITH_PORT);
  const adapter = createCdpAdapter({
    resolveOwnedRuntime: async () => ({ ok: true, donutId: "d1" }),
    readRuntimeCredential: async () => CRED,
    fetchImpl: fetchImpl,
    resolveCdpEndpoint: resolverWith(fetchImpl),
    session,
  });
  await adapter.listTabs("bp-1", "7");
  assert.deepEqual(world.connects, ["http://127.0.0.1:52000"]);
  assert.equal(fetchImpl.calls.some((u) => /\/json\//.test(u)), false, "no /json discovery");
});

test("a profile without an official port fails CLOSED — no connect attempt", async () => {
  _resetCdpResolveDiagnostics();
  const world = { connects: [] };
  const session = createCdpSession({
    connect: async (endpoint) => {
      world.connects.push(endpoint);
      throw new Error("must not be reached");
    },
  });
  const fetchImpl = makeFetch({
    "/v1/profiles/": {
      status: 200,
      body: { profile: { id: "d2", is_running: true, process_id: 1 } },
    },
  });
  const adapter = createCdpAdapter({
    resolveOwnedRuntime: async () => ({ ok: true, donutId: "d2" }),
    readRuntimeCredential: async () => CRED,
    fetchImpl: fetchImpl,
    resolveCdpEndpoint: resolverWith(fetchImpl),
    session,
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const r = await adapter.listTabs("bp-1", "7");
    assert.deepEqual(r, { ok: false, reason: "backend-unavailable" });
  }
  assert.deepEqual(world.connects, [], "an unauthorized port must never become a connection");
  assert.equal(lastCdpResolveFailure().stage, "port-unresolved");
});

test("repeated resolution failures never grant access (bounded retries stay fail-closed)", async () => {
  _resetCdpResolveDiagnostics();
  const fetchImpl = makeFetch({ "/v1/profiles/": { status: 503, body: {} } });
  const resolve = resolverWith(fetchImpl);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(await resolve(`d-${i}`), null);
    assert.equal(lastCdpResolveFailure().stage, "profile-fetch");
  }
});

test("a completed determination (profile stopped) fails immediately, without retrying the profile read", async () => {
  _resetCdpResolveDiagnostics();
  const fetchImpl = makeFetch({
    "/v1/profiles/": {
      status: 200,
      body: { profile: { id: "d3", is_running: false, process_id: 1 } },
    },
  });
  assert.equal(await resolverWith(fetchImpl)("d3"), null);
  assert.equal(fetchImpl.calls.length, 1, "a determination must not be re-probed");
  assert.equal(lastCdpResolveFailure().stage, "not-running");
});

test("the live profile port supersedes a stale cached port from a previous run", async () => {
  _resetCdpResolveDiagnostics();
  rememberCdpPort("d4", 9222);
  const fetchImpl = makeFetch({
    "/v1/profiles/": {
      status: 200,
      body: { profile: { id: "d4", is_running: true, process_id: 1, remote_debugging_port: 9333 } },
    },
  });
  const r = await resolverWith(fetchImpl)("d4");
  assert.equal(r?.port, 9333);
});

test("a successful resolution clears the failure record", async () => {
  _resetCdpResolveDiagnostics();
  const failing = makeFetch({ "/v1/profiles/": { status: 500, body: {} } });
  assert.equal(await resolverWith(failing)("d5"), null);
  assert.ok(lastCdpResolveFailure());
  const ok = makeFetch(RUNNING_WITH_PORT);
  const r = await resolverWith(ok)("d5");
  assert.equal(r?.port, 52000);
  assert.equal(lastCdpResolveFailure(), null);
});
