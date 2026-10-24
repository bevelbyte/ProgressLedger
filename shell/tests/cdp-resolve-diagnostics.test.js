// Endpoint-resolution diagnostics for the official port resolver.
//
// HISTORY: this suite pinned the raw-transport resolver's dozen rejection
// stages (/json/version probe, WebSocket URL validation, ownership probe).
// Those stages died with the raw DevTools transport. What survives — and what
// this file pins on the Playwright architecture — is the diagnostic contract
// that made real-Donut failures debuggable:
//
//   1. Every rejection path records its own declared stage and stays
//      fail-closed.
//   2. A successful resolution clears the failure record.
//   3. EVERY recorded stage is one of the module's declared stages.
//   4. NOTHING SENSITIVE is recorded: no token, no Authorization header, no
//      cookie, no page content, no response body.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createCdpAdapter,
  createCdpPortResolver,
  lastCdpResolveFailure,
  _resetCdpResolveDiagnostics,
} from "../src/services/cdp-adapter.js";

const CRED = { port: 10108, token: "s3cr3t-token-value" };

function makeFetch(routes) {
  return async (url) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    const r = routes[key];
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body ?? {}),
    };
  };
}

const RUNNING_PROFILE = {
  profile: {
    id: "d1",
    is_running: true,
    process_id: 4242,
    remote_debugging_port: 51234,
  },
};

function resolverFor({ routes, cred = CRED }) {
  return createCdpPortResolver({
    readRuntimeCredential: async () => cred,
    fetchImpl: makeFetch(routes),
  });
}

test("a successful resolution clears any prior failure record", async () => {
  _resetCdpResolveDiagnostics();
  const r = await resolverFor({
    routes: { "/v1/profiles/": { status: 200, body: RUNNING_PROFILE } },
  })("d1");
  assert.ok(r, "resolution should succeed");
  assert.equal(r.port, 51234);
  assert.equal(lastCdpResolveFailure(), null);
});

test("stage=credential when the runtime credential is unusable", async () => {
  _resetCdpResolveDiagnostics();
  const r = createCdpPortResolver({ readRuntimeCredential: async () => null });
  assert.equal(await r("d1"), null);
  const f = lastCdpResolveFailure();
  assert.equal(f.stage, "credential");
  assert.equal(f.donutId, "d1");
});

test("stage=profile-fetch when the profile read fails", async () => {
  _resetCdpResolveDiagnostics();
  assert.equal(
    await resolverFor({ routes: { "/v1/profiles/": { status: 404, body: {} } } })("d1"),
    null,
  );
  const f = lastCdpResolveFailure();
  assert.equal(f.stage, "profile-fetch");
  assert.equal(f.httpStatus, 404);
});

test("stage=profile-json when the profile body is unparseable", async () => {
  _resetCdpResolveDiagnostics();
  assert.equal(
    await resolverFor({
      routes: { "/v1/profiles/": { status: 200, body: null } },
    })("d1"),
    null,
  );
  assert.equal(lastCdpResolveFailure().stage, "profile-json");
});

test("stage=not-running when the profile is stopped", async () => {
  _resetCdpResolveDiagnostics();
  assert.equal(
    await resolverFor({
      routes: {
        "/v1/profiles/": {
          status: 200,
          body: { profile: { id: "d1", is_running: false, process_id: 1 } },
        },
      },
    })("d1"),
    null,
  );
  assert.equal(lastCdpResolveFailure().stage, "not-running");
});

test("stage=port-unresolved when neither profile nor cache holds a port", async () => {
  _resetCdpResolveDiagnostics();
  assert.equal(
    await resolverFor({
      routes: {
        "/v1/profiles/": {
          status: 200,
          body: { profile: { id: "d-noport", is_running: true, process_id: 0 } },
        },
      },
    })("d-noport"),
    null,
  );
  assert.equal(lastCdpResolveFailure().stage, "port-unresolved");
});

test("every recorded stage is one of the declared stages", async () => {
  const declared = ["credential", "profile-fetch", "profile-json", "not-running", "port-unresolved"];
  const scenarios = [
    { routes: {}, cred: null },
    { routes: { "/v1/profiles/": { status: 500, body: {} } } },
    { routes: { "/v1/profiles/": { status: 200, body: null } } },
    {
      routes: {
        "/v1/profiles/": { status: 200, body: { profile: { id: "x", is_running: false } } },
      },
    },
    {
      routes: {
        "/v1/profiles/": { status: 200, body: { profile: { id: "x", is_running: true } } },
      },
    },
  ];
  for (const s of scenarios) {
    _resetCdpResolveDiagnostics();
    await resolverFor(s)("dx");
    const f = lastCdpResolveFailure();
    assert.ok(f, "each failure must be recorded");
    assert.ok(declared.includes(f.stage), `unexpected stage ${f.stage}`);
  }
});

test("nothing sensitive is ever recorded: no token, headers, cookies, or bodies", async () => {
  _resetCdpResolveDiagnostics();
  await resolverFor({
    routes: {
      "/v1/profiles/": {
        status: 500,
        body: { secret: "LEAKED-BODY", set_cookie: "session=abc" },
      },
    },
  })("d1");
  const f = lastCdpResolveFailure();
  const flat = JSON.stringify(f);
  assert.ok(!flat.includes(CRED.token), "bearer token must never be recorded");
  assert.ok(!flat.includes("LEAKED-BODY"), "response bodies must never be recorded");
  assert.ok(!flat.includes("session=abc"), "cookies must never be recorded");
  for (const key of Object.keys(f)) {
    assert.equal(/token|auth|cookie|header|body/i.test(key), false, `unexpected field ${key}`);
  }
});

test("adapter-side failures keep the same fail-closed, no-leak contract", async () => {
  _resetCdpResolveDiagnostics();
  const adapter = createCdpAdapter({
    resolveOwnedRuntime: async () => ({ ok: true, donutId: "d1" }),
    readRuntimeCredential: async () => CRED,
    fetchImpl: makeFetch({
      "/v1/profiles/": {
        status: 500,
        body: { secret: "LEAKED-BODY-ADAPTER" },
      },
    }),
    resolveCdpEndpoint: createCdpPortResolver({
      readRuntimeCredential: async () => CRED,
      fetchImpl: makeFetch({
        "/v1/profiles/": {
          status: 500,
          body: { secret: "LEAKED-BODY-ADAPTER" },
        },
      }),
    }),
    session: null,
  });
  const r = await adapter.listTabs("bp-1", "7");
  assert.deepEqual(r, { ok: false, reason: "backend-unavailable" });
  assert.ok(!JSON.stringify(r).includes("LEAKED-BODY-ADAPTER"));
  assert.ok(!JSON.stringify(lastCdpResolveFailure()).includes("LEAKED-BODY-ADAPTER"));
});
