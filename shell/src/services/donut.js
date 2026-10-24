// Official Donut runtime connection (contract v0.31.x).
//
// HISTORY: this module used to OWN a DBI-era backend: it discovered a
// DonutBrowser-Integration workspace, spawned CareerFlow-Start-Donut.bat,
// proved process ownership of DonutBrowser-Unlocked.exe, read a
// backend-written runtime.json, probed an unauthenticated /health endpoint and
// shut the backend down via POST /v1/shutdown. None of that exists in the
// official application:
//
//   - official Donut is an independently installed app the USER runs;
//   - its Local API is configured in app_settings.json (api_enabled/api_port);
//   - the bearer token lives in the encrypted api_token.dat store
//     (see services/donut-credential.js);
//   - the documented liveness surface is an authenticated REST read
//     (GET /v1/profiles) — there is no /health endpoint;
//   - there is no shutdown endpoint and CareerFlow must never stop Donut.
//
// So this module is now a CONNECTION layer: it locates the official Local API
// and reports provider-neutral connection state. It never spawns, never kills,
// never classifies a process as owned/foreign/stale.

import {
  readLocalApiCredential,
  describeLocalApi,
} from "./donut-credential.js";

// Renderer privacy whitelist: the ONLY backend status keys the renderer may
// ever see. No PIDs, ports, tokens, paths or ownership flags.
export const PUBLIC_STATUS_KEYS = ["state", "available", "ready", "detail"];

export function sanitizeStatus(input) {
  const out = {};
  for (const key of PUBLIC_STATUS_KEYS) {
    if (key in input) out[key] = input[key];
  }
  return out;
}

// Provider-neutral connection states (no ownership vocabulary).
export const STATES = Object.freeze({
  READY: "ready",
  UNAVAILABLE: "unavailable",
});

const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/**
 * Main-process-only credential reader. Returns { port, token } or null.
 * The token must stay inside the calling scope (request header) — never
 * returned to the renderer, logs, or disk.
 */
export async function readRuntimeCredential() {
  const cred = await readLocalApiCredential();
  if (!cred.ok) return null;
  const token = cred.authHeaders?.Authorization?.slice("Bearer ".length) ?? null;
  return token ? { port: cred.port, token } : null;
}

/**
 * Authenticated liveness probe: GET /v1/profiles with the bearer. This is the
 * official connection check — /health does not exist in the app server.
 * Returns { reachable, ready, status } and never surfaces transport detail.
 */
export function makeHealthProbe(
  fetchImpl = (...a) => fetch(...a),
  readCredential = readRuntimeCredential,
) {
  return async function probeConnection(timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
    const cred = await readCredential();
    if (!cred) return { reachable: false, ready: false };
    try {
      const res = await fetchImpl(`http://127.0.0.1:${cred.port}/v1/profiles`, {
        headers: { Authorization: `Bearer ${cred.token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return {
        reachable: true,
        ready: res.ok === true,
        status: res.status,
      };
    } catch {
      return { reachable: false, ready: false };
    }
  };
}

/**
 * The official runtime "provider": connection status for the legacy status
 * surface (`{ state, available, ready, detail }`).
 *
 * `ensureStarted()` is retained for API compatibility with existing callers
 * (manager/open paths) but is now a pure connect/probe — it NEVER launches a
 * process. A down provider simply reports unavailable and callers fall back
 * to the system browser.
 */
export function createDonutProvider(deps = {}) {
  const probe = deps.probe ?? makeHealthProbe(deps.fetchImpl);
  const readCredential = deps.readRuntimeCredential ?? readRuntimeCredential;

  function publicStatus(state, extra = {}) {
    return sanitizeStatus({ state, ...extra });
  }

  async function connectNow() {
    const [health, cred] = await Promise.all([
      probe(),
      readCredential().catch(() => null),
    ]);
    if (!cred) {
      return publicStatus(STATES.UNAVAILABLE, {
        available: false,
        ready: false,
        detail: "local-api-unavailable",
      });
    }
    if (health.ready === true) {
      return publicStatus(STATES.READY, { available: true, ready: true });
    }
    return publicStatus(STATES.UNAVAILABLE, {
      available: false,
      ready: false,
      detail: health.reachable === true ? "api-not-ready" : "api-unreachable",
    });
  }

  return {
    getStatus: connectNow,
    /** Connect/probe only. Never spawns a process. */
    ensureStarted: connectNow,
    describe: describeLocalApi,
  };
}

export const donutProvider = createDonutProvider();
