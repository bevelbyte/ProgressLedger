// CareerFlow profile ↔ Donut profile mapping.
//
// Contract basis (docs/careerflow-contract.md — READ-ONLY authority):
//   GET  /v1/profiles            deterministic listing (stable UUID ids)
//   GET  /v1/profiles/{id}       existence check (404 = gone)
//   POST /v1/profiles            documented creation
//        ({name,browser:"wayfern",wayfern_config:{}} → profile.id)
//
// Design: a dedicated workspace-scoped JSON store keyed by CareerFlow profile
// id (same pattern as backup-settings.json — NO schema change). The store is
// machine-local on purpose and is NOT part of backup bundles: Donut profile
// ids point into this machine's Donut data dir, so a restored bundle must not
// reference them — restored/imported profiles simply start unmapped and fall
// back to the system browser until remapped.
//
// Creation policy: lazy list-match-or-create using the deterministic name
// `cf-<cfProfileId>`. Creation can hit the Wayfern anti-burst guard
// (400 "temporarily unavailable", multi-minute windows), so attempts are
// bounded by a time budget with backoff and every exhaustion falls back
// honestly upstream. Never kills anything; touches only /v1/* via bearer auth
// whose credential stays inside the request header.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { readRuntimeCredential } from "./donut.js";

export const DONUT_PROFILE_NAME_PREFIX = "cf-";
const CALL_TIMEOUT_MS = 8000;
// Wayfern fingerprint generation is substantially slower than ordinary
// profile reads. A create request is therefore allowed to outlive the
// transport timeout used for GETs. More importantly, creation is not
// idempotent at the HTTP layer: a client timeout can race a backend that has
// already committed the profile. Callers reconcile by exact name before
// retrying so an ambiguous timeout can never create a duplicate identity.
const CREATE_TIMEOUT_MS = 30000;

// ------------------------------------------------------------------ storage
// The workspace module imports Electron, so it is loaded lazily here — unit
// tests inject their own store and never touch this code path.
async function resolveMappingPath() {
  const { resolveDonutMappingPath } = await import("../workspace.js");
  return resolveDonutMappingPath();
}

export async function readMappingStore() {
  try {
    const parsed = JSON.parse(await readFile(await resolveMappingPath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeMappingStore(store) {
  const file = await resolveMappingPath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(store, null, 2), "utf8");
}

// ---------------------------------------------------------------- transport
/** Bearer-authenticated thin client over the documented /v1/profiles surface. */
export function makeDonutProfileApi(
  fetchImpl = (...a) => fetch(...a),
  readCredential = readRuntimeCredential
) {
  async function call(method, path, body) {
    const cred = await readCredential();
    if (!cred)
      throw Object.assign(new Error("no-runtime-credential"), { status: 0 });
    try {
      const res = await fetchImpl(`http://127.0.0.1:${cred.port}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${cred.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(method === "POST" ? CREATE_TIMEOUT_MS : CALL_TIMEOUT_MS),
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(text.slice(0, 200) || `HTTP ${res.status}`);
        err.status = res.status;
        err.body = text.slice(0, 200);
        throw err;
      }
      try {
        return JSON.parse(text);
      } catch {
        return {};
      }
    } catch (e) {
      if (e && typeof e.status === "number") throw e;
      throw Object.assign(new Error("transport-error"), { status: 0 });
    }
  }
  return {
    async listProfiles() {
      const json = await call("GET", "/v1/profiles");
      return Array.isArray(json.profiles) ? json.profiles : Array.isArray(json) ? json : [];
    },
    async getProfile(id) {
      try {
        return await call("GET", `/v1/profiles/${encodeURIComponent(id)}`);
      } catch (e) {
        if (e && e.status === 404) return null;
        throw e;
      }
    },
    async createProfile(name) {
      return call("POST", "/v1/profiles", {
        name,
        browser: "wayfern",
        wayfern_config: {},
      });
    },
  };
}

// -------------------------------------------------------------------- mapper
/**
 * deps (all injectable for hermetic tests): api {listProfiles,getProfile,
 * createProfile}, readStore/writeStore, now/sleep/budgetMs/backoffMs/log.
 */
export function createDonutMapper(deps = {}) {
  const api = deps.api ?? makeDonutProfileApi();
  const readStore = deps.readStore ?? readMappingStore;
  const writeStore = deps.writeStore ?? writeMappingStore;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const budgetMs = deps.budgetMs ?? 90_000;
  const backoffMs = deps.backoffMs ?? [5_000, 30_000];
  const log = deps.log ?? ((msg) => console.info(msg));

  const inflight = new Map();
  const expectedName = (cfProfileId) => DONUT_PROFILE_NAME_PREFIX + cfProfileId;

  async function dropEntry(store, cfProfileId) {
    const next = { ...store };
    delete next[cfProfileId];
    await writeStore(next);
    return next;
  }

  /**
   * Same-promise single-flight per CareerFlow profile. Resolution order:
   *   1. persisted mapping, revalidated against GET /v1/profiles/{id}
   *   2. exact-name match in GET /v1/profiles
   *   3. bounded POST /v1/profiles creation with anti-burst backoff
   */
  function ensureMapping(cfProfileId) {
    if (typeof cfProfileId !== "string" || !cfProfileId.trim())
      return Promise.reject(new Error("invalid-cf-profile-id"));
    if (inflight.has(cfProfileId)) return inflight.get(cfProfileId);

    const attempt = (async () => {
      let store = await readStore();
      const entry = store[cfProfileId];
      if (entry && entry.donutProfileId) {
        const fresh = await api.getProfile(entry.donutProfileId);
        if (fresh && fresh.id === entry.donutProfileId) return entry.donutProfileId;
        log("stale Donut profile mapping dropped; remapping");
        store = await dropEntry(store, cfProfileId);
      }

      const listed = await api.listProfiles();
      const match = (listed || []).find((p) => p && p.name === expectedName(cfProfileId));
      if (match && match.id) {
        const s2 = await readStore();
        s2[cfProfileId] = { donutProfileId: match.id, mappedAt: new Date().toISOString() };
        await writeStore(s2);
        return match.id;
      }

      const deadline = now() + budgetMs;
      let attemptNo = 0;
      for (;;) {
        if (now() >= deadline) throw new Error("mapping-budget-exceeded");
        try {
          const created = await api.createProfile(expectedName(cfProfileId));
          const id =
            (created && created.profile && created.profile.id) ||
            (created && created.id) ||
            null;
          if (!id) throw new Error("create-response-missing-id");
          const s3 = await readStore();
          s3[cfProfileId] = { donutProfileId: id, mappedAt: new Date().toISOString() };
          await writeStore(s3);
          return id;
        } catch (e) {
          const msg = String((e && (e.message || e.body)) || e || "");
          // POST /v1/profiles is not client-side idempotent. The backend may
          // have completed a slow fingerprint generation after our request
          // timed out. Reconcile against the authoritative profile list
          // before retrying or surfacing an error, otherwise a retry can
          // create a second profile with the same logical CareerFlow owner.
          try {
            const reconciled = await api.listProfiles();
            const existing = (reconciled || []).find(
              (p) => p && p.name === expectedName(cfProfileId)
            );
            if (existing && existing.id) {
              const s4 = await readStore();
              s4[cfProfileId] = { donutProfileId: existing.id, mappedAt: new Date().toISOString() };
              await writeStore(s4);
              return existing.id;
            }
          } catch {
            // Preserve the original creation error below; reconciliation is
            // a safety net, not a reason to hide a genuine API failure.
          }
          if (!/(temporarily unavailable|too many profiles|too many.*fingerprint)/i.test(msg))
            throw new Error("create-failed: " + msg);
          const wait = backoffMs[Math.min(attemptNo, backoffMs.length - 1)];
          attemptNo++;
          if (now() + wait >= deadline) throw new Error("mapping-budget-exceeded");
          log(
            "Wayfern anti-burst guard active; backing off " +
              Math.round(wait / 1000) +
              "s before remap attempt " +
              attemptNo
          );
          await sleep(wait);
        }
      }
    })();

    inflight.set(cfProfileId, attempt);
    const settle = () => {
      if (inflight.get(cfProfileId) === attempt) inflight.delete(cfProfileId);
    };
    attempt.then(settle, settle);
    return attempt;
  }

  /** Lifecycle hook: deleting the CareerFlow profile removes its mapping. */
  async function clearMapping(cfProfileId) {
    const store = await readStore();
    if (!(cfProfileId in store)) return false;
    const next = { ...store };
    delete next[cfProfileId];
    await writeStore(next);
    return true;
  }

  async function getStoredMapping(cfProfileId) {
    const store = await readStore();
    return (store[cfProfileId] && store[cfProfileId].donutProfileId) || null;
  }

  return { ensureMapping, clearMapping, getStoredMapping, expectedName };
}

// Process-wide instance. No IO happens until a method is called.
export const donutMapper = createDonutMapper();

// ============================================================
// Browser-profile bindings (managed browser profile -> Donut UUID)
// ============================================================
//
// Separate namespace from the cf-<profileId> mapping above: one CareerFlow
// profile may own SEVERAL managed browser profiles, each bound to its own
// isolated Donut identity. Bindings live in their own workspace file
// (donut-bindings.json) so they are machine-local by construction and never
// exported with backups.

async function bindingsPath() {
  const mod = await import("../workspace.js");
  return mod.resolveDonutBindingsPath();
}

export async function readBrowserBindingStore() {
  try {
    const parsed = JSON.parse(await readFile(await bindingsPath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeBrowserBindingStore(store) {
  const file = await bindingsPath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(store, null, 2), "utf8");
}

export async function getBrowserBinding(localId) {
  const store = await readBrowserBindingStore();
  return store[localId] ?? null;
}

export async function clearBrowserBindingEntry(localId) {
  const store = await readBrowserBindingStore();
  if (!(localId in store)) return false;
  const next = { ...store };
  delete next[localId];
  await writeBrowserBindingStore(next);
  return true;
}

/**
 * Bounded three-step resolution for a managed browser profile's Donut UUID,
 * mirroring the proven cf-<profileId> mapper: cached->validated, exact-name
 * match (bfc-<localId>), then bounded creation. Single-flight per localId.
 */
export function createBrowserBindingFlow(deps = {}) {
  const api = deps.api;
  if (!api) throw new Error("createBrowserBindingFlow requires api");
  const readStore = deps.readStore ?? readBrowserBindingStore;
  const writeStore = deps.writeStore ?? writeBrowserBindingStore;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const budgetMs = deps.budgetMs ?? 90_000;
  const backoffMs = deps.backoffMs ?? [5_000, 30_000];
  const log = deps.log ?? (() => {});
  const inflight = new Map();

  function ensureBrowserBinding(localId, cfProfileId) {
    if (typeof localId !== "string" || !localId.trim())
      return Promise.reject(new Error("invalid-browser-profile-local-id"));
    if (inflight.has(localId)) return inflight.get(localId);

    const attempt = (async () => {
      // 1) cached binding, revalidated against the live backend
      const store = await readStore();
      const entry = store[localId];
      if (entry && entry.donutProfileId) {
        // A backend restart can report a transient 404 while its persistent
        // profile store is still being reopened. Do not destroy a durable
        // CareerFlow binding (and create a second identity) on that first
        // observation. Revalidate the exact UUID through the same API before
        // declaring the mapping stale.
        const validationDelays = [250, 500, 1000, 2000];
        for (let attempt = 0; attempt <= validationDelays.length; attempt++) {
          const fresh = await api.getProfile(entry.donutProfileId);
          if (fresh && fresh.id === entry.donutProfileId) return entry.donutProfileId;
          if (attempt < validationDelays.length) await sleep(validationDelays[attempt]);
        }
        log("stale browser binding dropped (Donut profile gone); rebinding");
        const next = { ...store };
        delete next[localId];
        await writeStore(next);
      }

      // 2) Preserve legacy managed-browser identities whose CareerFlow
      // browser-profile local id is itself the Donut profile UUID.
      const direct = await api.getProfile(localId);
      if (direct && direct.id === localId) {
        const s2 = await readStore();
        s2[localId] = {
          donutProfileId: localId,
          cfProfileId: cfProfileId != null ? String(cfProfileId) : null,
          mappedAt: new Date().toISOString(),
        };
        await writeStore(s2);
        return localId;
      }

      // 3) exact-name match among existing Donut profiles
      const expected = BROWSER_BINDING_PREFIX + localId;
      const listed = await api.listProfiles();
      const match = (listed || []).find((p) => p && p.name === expected);
      if (match && match.id) {
        const s2 = await readStore();
        s2[localId] = {
          donutProfileId: match.id,
          cfProfileId: cfProfileId != null ? String(cfProfileId) : null,
          mappedAt: new Date().toISOString(),
        };
        await writeStore(s2);
        return match.id;
      }

      // 4) bounded creation of a dedicated profile
      const deadline = now() + budgetMs;
      let attemptNo = 0;
      for (;;) {
        if (now() >= deadline) throw new Error("binding-budget-exceeded");
        try {
          const created = await api.createProfile(expected);
          const id =
            (created && created.profile && created.profile.id) ||
            (created && created.id) ||
            null;
          if (!id) throw new Error("create-response-missing-id");
          const s3 = await readStore();
          s3[localId] = {
            donutProfileId: String(id),
            cfProfileId: cfProfileId != null ? String(cfProfileId) : null,
            mappedAt: new Date().toISOString(),
          };
          await writeStore(s3);
          return String(id);
        } catch (e) {
          const msg = String((e && (e.message || e.body)) || e || "");
          // Profile creation is an ambiguous operation when the client
          // times out: Wayfern may finish fingerprint generation and commit
          // the profile after the HTTP request has already failed locally.
          // Re-list by the deterministic binding name before retrying so a
          // retry cannot manufacture a duplicate browser identity.
          try {
            const reconciled = await api.listProfiles();
            const existing = (reconciled || []).find((p) => p && p.name === expected);
            if (existing && existing.id) {
              const s4 = await readStore();
              s4[localId] = {
                donutProfileId: String(existing.id),
                cfProfileId: cfProfileId != null ? String(cfProfileId) : null,
                mappedAt: new Date().toISOString(),
              };
              await writeStore(s4);
              return String(existing.id);
            }
          } catch {
            // Keep the original creation error if reconciliation is unavailable.
          }
          if (!/(temporarily unavailable|too many profiles|too many.*fingerprint)/i.test(msg))
            throw new Error("create-failed: " + msg);
          const wait = backoffMs[Math.min(attemptNo, backoffMs.length - 1)];
          attemptNo++;
          if (now() + wait >= deadline) throw new Error("binding-budget-exceeded");
          log("anti-burst guard active; backing off " + Math.round(wait / 1000) + "s");
          await sleep(wait);
        }
      }
    })();
    void cfProfileId;

    inflight.set(localId, attempt);
    const settle = () => {
      if (inflight.get(localId) === attempt) inflight.delete(localId);
    };
    attempt.then(settle, settle);
    return attempt;
  }

  async function clearBrowserBinding(localId) {
    const store = await readStore();
    if (!(localId in store)) return false;
    const next = { ...store };
    delete next[localId];
    await writeStore(next);
    return true;
  }

  /** Remove every binding belonging to one CareerFlow profile. */
  async function clearBrowserBindingsForCfProfile(cfProfileId) {
    const store = await readStore();
    const doomed = Object.entries(store)
      .filter(([, v]) => v && String(v.cfProfileId) === String(cfProfileId))
      .map(([k]) => k);
    const next = { ...store };
    for (const k of doomed) delete next[k];
    await writeStore(next);
    return doomed.length;
  }

  return { ensureBrowserBinding, clearBrowserBinding, clearBrowserBindingsForCfProfile };
}

/**
 * Singleton helper: drop every browser binding whose cached owner matches
 * the supplied CareerFlow profile id. Called from the profile-delete hook
 * in ipc/profiles.js.
 */
export async function clearBrowserBindingsForCfProfile(cfProfileId) {
  const store = await readBrowserBindingStore();
  const target = String(cfProfileId);
  const doomed = Object.entries(store)
    .filter(([, v]) => v && v.cfProfileId != null && String(v.cfProfileId) === target)
    .map(([k]) => k);
  if (doomed.length === 0) return 0;
  const next = { ...store };
  for (const k of doomed) delete next[k];
  await writeBrowserBindingStore(next);
  return doomed.length;
}

export const BROWSER_BINDING_PREFIX = "bfc-";
