// Mapping-service matrix — every collaborator (Donut API, store, clock,
// backoff) is injected, so nothing here touches the real workspace, ports,
// processes, or tokens.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDonutMapper,
  createBrowserBindingFlow,
  DONUT_PROFILE_NAME_PREFIX,
  BROWSER_BINDING_PREFIX,
} from "../src/services/donut-mapping.js";

function makeWorld({
  initialStore = {},
  list = [],
  getMap = {},        // id -> profile | undefined (404)
  failCreates = 0,    // how many creates answer with the anti-burst guard
  createSeq = [],     // ids returned by successful creates, in order
} = {}) {
  const store = structuredClone(initialStore);
  const createdNames = [];
  let createCalls = 0;
  const api = {
    async listProfiles() {
      return [
        ...list,
        ...createdNames.map((name, i) => ({ id: `created-${i + 1}`, name })),
      ];
    },
    async getProfile(id) {
      if (id in getMap) return getMap[id];
      return null; // 404
    },
    async createProfile(name) {
      createCalls++;
      if (createCalls <= failCreates) {
        const e = new Error("temporarily unavailable");
        e.status = 400;
        e.body = "temporarily unavailable";
        throw e;
      }
      createdNames.push(name);
      return { profile: { id: `created-${createdNames.length}`, name } };
    },
  };
  let t = 1_000_000;
  const deps = {
    api,
    readStore: async () => structuredClone(store),
    writeStore: async (s) => { Object.keys(store).forEach((k) => delete store[k]); Object.assign(store, s); },
    now: () => t,
    sleep: async (ms) => { t += ms; },
    budgetMs: 120_000,
    backoffMs: [5_000, 30_000],
    log: () => {},
  };
  const advance = (ms) => { t += ms; };
  return { deps, store, advance, createdNames, getCreateCalls: () => createCalls };
}

const CF_A = "11111111-aaaa-4111-8111-111111111111";
const CF_B = "22222222-bbbb-4222-8222-222222222222";
const DONUT_X = "donut-x";
const DONUT_Y = "donut-y";

test("cached valid mapping is reused without listing or creating", async () => {
  const w = makeWorld({
    initialStore: { [CF_A]: { donutProfileId: DONUT_X, mappedAt: "earlier" } },
    getMap: { [DONUT_X]: { id: DONUT_X } },
  });
  const m = createDonutMapper(w.deps);
  const id = await m.ensureMapping(CF_A);
  assert.equal(id, DONUT_X);
  assert.deepEqual(w.createdNames, []);
});

test("stale mapping (404 on Donut side) is dropped and remapped via exact-name match", async () => {
  const w = makeWorld({
    initialStore: { [CF_A]: { donutProfileId: DONUT_X, mappedAt: "earlier" } },
    list: [{ id: "existing-1", name: DONUT_PROFILE_NAME_PREFIX + CF_A }],
    getMap: {}, // DONUT_X gone -> 404
  });
  const m = createDonutMapper(w.deps);
  const id = await m.ensureMapping(CF_A);
  assert.equal(id, "existing-1");
  assert.equal(w.store[CF_A].donutProfileId, "existing-1");
  assert.deepEqual(w.createdNames, [], "must reuse by name, not create a duplicate");
});

test("switch semantics: A→X and B→Y stay distinct", async () => {
  const w = makeWorld({
    list: [
      { id: DONUT_X, name: DONUT_PROFILE_NAME_PREFIX + CF_A },
      { id: DONUT_Y, name: DONUT_PROFILE_NAME_PREFIX + CF_B },
    ],
  });
  const m = createDonutMapper(w.deps);
  assert.equal(await m.ensureMapping(CF_A), DONUT_X);
  assert.equal(await m.ensureMapping(CF_B), DONUT_Y);
  assert.equal(await m.getStoredMapping(CF_A), DONUT_X);
  assert.equal(await m.getStoredMapping(CF_B), DONUT_Y);
});

test("creates a new Donut profile when nothing matches, persisting the mapping", async () => {
  const w = makeWorld({});
  const m = createDonutMapper(w.deps);
  const id = await m.ensureMapping(CF_A);
  assert.equal(id, "created-1");
  assert.equal(w.createdNames[0], DONUT_PROFILE_NAME_PREFIX + CF_A);
  assert.equal(w.store[CF_A].donutProfileId, "created-1");
});

test("anti-burst guard: backs off deterministically and succeeds within budget", async () => {
  const w = makeWorld({ failCreates: 2 });
  const m = createDonutMapper(w.deps);
  const id = await m.ensureMapping(CF_A);
  assert.equal(id, "created-1");
  assert.ok(w.getCreateCalls() >= 3, "retried after guarded attempts");
});

test("anti-burst guard exceeding the budget fails honestly with mapping-budget-exceeded", async () => {
  const w = makeWorld({ failCreates: 999 });
  const m = createDonutMapper(w.deps);
  await assert.rejects(m.ensureMapping(CF_A), /mapping-budget-exceeded/);
  assert.equal(w.store[CF_A], undefined, "no mapping persisted on failure");
});

test("non-anti-burst creation errors fail fast with create-failed", async () => {
  const w = makeWorld({});
  // break the API after construction to force a hard error
  w.deps.api.createProfile = async () => {
    const e = new Error("HTTP 500");
    e.status = 500;
    throw e;
  };
  const m = createDonutMapper(w.deps);
  await assert.rejects(m.ensureMapping(CF_A), /create-failed/);
});

test("ambiguous create failure reconciles an already-committed exact-name profile without retrying", async () => {
  const w = makeWorld({});
  let createAttempts = 0;
  w.deps.api.createProfile = async (name) => {
    createAttempts++;
    // Simulate the client losing the response after the backend committed.
    w.createdNames.push(name);
    throw new Error("transport-error");
  };
  const m = createDonutMapper(w.deps);
  const id = await m.ensureMapping(CF_A);
  assert.equal(id, "created-1");
  assert.equal(createAttempts, 1, "must not retry an ambiguous committed create");
  assert.equal(w.store[CF_A].donutProfileId, "created-1");
});

test("delete/clear removes the mapping entry for exactly one profile", async () => {
  const w = makeWorld({
    initialStore: {
      [CF_A]: { donutProfileId: DONUT_X, mappedAt: "t" },
      [CF_B]: { donutProfileId: DONUT_Y, mappedAt: "t" },
    },
  });
  const m = createDonutMapper(w.deps);
  assert.equal(await m.clearMapping(CF_A), true);
  assert.equal(await m.getStoredMapping(CF_A), null);
  assert.equal(await m.getStoredMapping(CF_B), DONUT_Y, "sibling mapping untouched");
  assert.equal(await m.clearMapping(CF_A), false, "second clear reports no-op");
});

test("duplicate mappings are impossible: one key per CareerFlow profile", async () => {
  const w = makeWorld({});
  const m = createDonutMapper(w.deps);
  const first = await m.ensureMapping(CF_A);
  const second = await m.ensureMapping(CF_A); // cached path
  assert.equal(first, second);
  const keys = Object.keys(w.store).filter((k) => k === CF_A);
  assert.equal(keys.length, 1);
});

test("fresh/imported profile id starts unmapped", async () => {
  const w = makeWorld({}); // empty store = restored world
  const m = createDonutMapper(w.deps);
  assert.equal(await m.getStoredMapping("brand-new-cf-id"), null);
});

test("foreign Donut profiles are never attached: only exact expected names match", async () => {
  const w = makeWorld({
    list: [
      { id: "foreign-1", name: DONUT_PROFILE_NAME_PREFIX + CF_A + "-evil" },
      { id: "foreign-2", name: "cf-" },
      { id: "foreign-3", name: "CareerFlow something" },
    ],
  });
  const m = createDonutMapper(w.deps);
  const id = await m.ensureMapping(CF_A);
  assert.equal(id, "created-1", "no foreign profile matched; a dedicated one was created");
  assert.ok(!String(id).startsWith("foreign"));
});

test("invalid CareerFlow profile id input is rejected", async () => {
  const w = makeWorld({});
  const m = createDonutMapper(w.deps);
  await assert.rejects(m.ensureMapping(""), /invalid-cf-profile-id/);
  await assert.rejects(m.ensureMapping(null), /invalid-cf-profile-id/);
});

test("concurrent ensureMapping for the same profile shares one in-flight attempt", async () => {
  const w = makeWorld({ failCreates: 1 }); // forces a backoff window so calls overlap
  const m = createDonutMapper(w.deps);
  const [a, b, c] = await Promise.all([
    m.ensureMapping(CF_A),
    m.ensureMapping(CF_A),
    m.ensureMapping(CF_A),
  ]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(a, "created-1");
  assert.equal(w.getCreateCalls(), 2, "one guarded attempt + one successful create total");
});

test("profile isolation: mapping store never embeds subject/link data", async () => {
  const w = makeWorld({});
  const m = createDonutMapper(w.deps);
  await m.ensureMapping(CF_A);
  const serialized = JSON.stringify(w.store);
  assert.match(serialized, new RegExp(CF_A));
  assert.doesNotMatch(serialized, /subject|link|url|token/i);
});

test("browser binding reconciles an ambiguous committed create without duplicating the identity", async () => {
  const store = {};
  const createdNames = [];
  let createCalls = 0;
  const localId = "browser-local-1";
  const cfProfileId = 7;
  const expected = BROWSER_BINDING_PREFIX + localId;
  const api = {
    async getProfile() { return null; },
    async listProfiles() {
      return createdNames.map((name) => ({ id: "donut-1", name }));
    },
    async createProfile(name) {
      createCalls++;
      createdNames.push(name);
      throw new Error("transport-error");
    },
  };
  const flow = createBrowserBindingFlow({
    api,
    readStore: async () => structuredClone(store),
    writeStore: async (next) => {
      Object.keys(store).forEach((k) => delete store[k]);
      Object.assign(store, next);
    },
    now: () => 1_000_000,
    sleep: async () => {},
  });
  const id = await flow.ensureBrowserBinding(localId, cfProfileId);
  assert.equal(id, "donut-1");
  assert.equal(createCalls, 1);
  assert.deepEqual(store[localId], {
    donutProfileId: "donut-1",
    cfProfileId: "7",
    mappedAt: store[localId].mappedAt,
  });
  assert.equal(expected, createdNames[0]);
});

test("browser binding preserves a cached identity across transient post-restart 404s", async () => {
  const store = {
    ["browser-restart"]: {
      donutProfileId: "donut-restart",
      cfProfileId: "7",
      mappedAt: "earlier",
    },
  };
  let lookups = 0;
  let createCalls = 0;
  const api = {
    async getProfile(id) {
      lookups++;
      return lookups < 3 ? null : { id, name: "bfc-browser-restart" };
    },
    async listProfiles() {
      throw new Error("exact cached UUID should be revalidated before listing");
    },
    async createProfile() {
      createCalls++;
      throw new Error("creation must never be reached");
    },
  };
  const flow = createBrowserBindingFlow({
    api,
    readStore: async () => structuredClone(store),
    writeStore: async (next) => {
      Object.keys(store).forEach((k) => delete store[k]);
      Object.assign(store, next);
    },
    sleep: async () => {},
  });

  const id = await flow.ensureBrowserBinding("browser-restart", 7);
  assert.equal(id, "donut-restart");
  assert.equal(lookups, 3);
  assert.equal(createCalls, 0);
  assert.equal(store["browser-restart"].donutProfileId, "donut-restart");
});
test("browser binding reuses a preserved Donut profile whose UUID is the local id", async () => {
  const store = {};
  const localId = "preserved-donut-uuid";
  let createCalls = 0;
  const api = {
    async getProfile(id) {
      return id === localId ? { id: localId, name: "tersdy" } : null;
    },
    async listProfiles() {
      throw new Error("list must not be needed");
    },
    async createProfile() {
      createCalls++;
      throw new Error("creation must never be reached");
    },
  };
  const flow = createBrowserBindingFlow({
    api,
    readStore: async () => structuredClone(store),
    writeStore: async (next) => {
      Object.keys(store).forEach((k) => delete store[k]);
      Object.assign(store, next);
    },
  });

  const id = await flow.ensureBrowserBinding(localId, 76);
  assert.equal(id, localId);
  assert.equal(createCalls, 0);
  assert.equal(store[localId].donutProfileId, localId);
  assert.equal(store[localId].cfProfileId, "76");
});
