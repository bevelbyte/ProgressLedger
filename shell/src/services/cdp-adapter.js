// Restricted browser adapter — provider-internal browser control over the
// OFFICIAL Donut integration surface.
//
// HISTORY: this module used to hand-roll the Chromium DevTools transport
// (/json/version + /json/list discovery, raw WebSocket, Target.* / Page.*
// commands). Per the official Donut 0.31.x documentation the supported
// integration is:
//
//   POST /v1/profiles/{id}/run -> remote_debugging_port
//   Playwright chromium.connectOverCDP(`http://127.0.0.1:<port>`)
//   -> normal Playwright Page/BrowserContext APIs
//
// so the transport is now services/cdp-session.js (Playwright), and this
// module keeps only:
//   * the ownership gate (profile row -> binding -> provider profile id)
//   * the REST fallbacks that are part of the official /v1 surface
//     (open-url, /v1/profiles/{id} liveness, /kill)
//   * the agent browser-interaction primitives (page text, extraction,
//     click, type, key, wait) expressed as Playwright page operations
//
// SECURITY INVARIANTS (pinned by scripts/check-cdp-auth-boundary.mjs):
//   - no raw WebSocket construction anywhere in shell/src
//   - no /json/* endpoint discovery
//   - no DevTools URL construction
//   - the renderer supplies only ids/strings; the session's port comes from
//     the main-process resolver and never crosses the IPC boundary
//   - loopback-only: the session builds http://127.0.0.1:<port> from a
//     validated numeric port

import { validateHttpUrl } from "./donut-open.js";
import { sharedCdpSession } from "./cdp-session.js";

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_PAGE_TEXT_CHARS = 16000;
const MAX_EXTRACT_TEXT_CHARS = 16000;
const MAX_SELECTOR_LEN = 256;
const MAX_TYPED_TEXT_CHARS = 4096;
const MAX_WAIT_MS = 10000;
const PORT_CACHE = new Map();

/** Cache the official /run response's remote_debugging_port for a profile. */
export function rememberCdpPort(donutId, port) {
  // Strict: a numeric STRING must not coerce into a cached connection target.
  if (
    typeof port === "number" &&
    Number.isInteger(port) &&
    port > 0 &&
    port <= 65535
  ) {
    PORT_CACHE.set(String(donutId), port);
  }
}

// ---- shared validators ----------------------------------------------------
function validateSelector(selector) {
  if (typeof selector !== "string") return { ok: false, reason: "invalid-selector" };
  const s = selector.trim();
  if (s.length === 0) return { ok: false, reason: "invalid-selector" };
  if (s.length > MAX_SELECTOR_LEN) return { ok: false, reason: "invalid-selector" };
  // A CSS selector is data here, never code: it is embedded into page-side
  // expressions exclusively as a JSON string literal.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s)) return { ok: false, reason: "invalid-selector" };
  return { ok: true, selector: s };
}

function validateTypedText(text) {
  if (typeof text !== "string") return { ok: false, reason: "invalid-text" };
  if (text.length === 0) return { ok: false, reason: "invalid-text" };
  if (text.length > MAX_TYPED_TEXT_CHARS) return { ok: false, reason: "invalid-text" };
  // Reject ALL C0 control characters, including \r and \n: insertText inserts
  // literal text and must never carry line/submit control semantics. Explicit
  // key behavior goes through browser_press_key.
  if (/[\u0000-\u001F]/.test(text)) return { ok: false, reason: "invalid-text" };
  return { ok: true, text };
}

const KEY_DEFS = Object.freeze({
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
});

function resolveKey(keyName) {
  if (typeof keyName !== "string") return { ok: false, reason: "invalid-key" };
  const key = KEY_DEFS[keyName.trim()];
  if (!key) return { ok: false, reason: "invalid-key" };
  return { ok: true, key };
}

const RENDERER_SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "access_token",
  "api_key",
  "apikey",
  "secret",
  "secret_key",
  "password",
  "authorization",
]);

/**
 * Remove URL credentials before any page URL crosses into the renderer. Page
 * metadata is untrusted input even after ownership is established: a page can
 * legitimately contain credentials in userinfo, query parameters, or
 * fragments. Invalid URLs are fail-closed rather than returned verbatim.
 */
export function sanitizeRendererUrl(value) {
  if (typeof value !== "string" || !value) return "";
  const hadExplicitRootPath = /^https?:\/\/[^/?#]+\/(?:[?#]|$)/i.test(value);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return "";
  }
  parsed.username = "";
  parsed.password = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (RENDERER_SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
      parsed.searchParams.delete(key);
    }
  }
  parsed.hash = "";
  const serialized = parsed.toString();
  if (parsed.pathname === "/" && !parsed.search && !hadExplicitRootPath) {
    return serialized.slice(0, -1).slice(0, 4096);
  }
  return serialized.slice(0, 4096);
}

// ---------------------------------------------------------------------------
// PORT RESOLUTION (official surface only)
// ---------------------------------------------------------------------------
// Resolves the per-profile CDP port EXACTLY the way the official Donut
// documentation prescribes: from the profile's `remote_debugging_port` field
// (returned by POST /v1/profiles/{id}/run and reported by GET /v1/profiles/{id}).
// No /json/* discovery, no DevTools metadata, no process-tree command-line
// scanning. The port cache is a fallback for builds whose profile payload omits
// the field while a /run response supplied it in this process.

const RESOLVE_STAGES = Object.freeze([
  "credential",
  "profile-fetch",
  "profile-json",
  "not-running",
  "port-unresolved",
]);

let LAST_RESOLVE_FAILURE = null;
let RESOLVE_SEQUENCE = 0;

/** The most recent port-resolution rejection, for diagnostics and tests. */
export function lastCdpResolveFailure() {
  return LAST_RESOLVE_FAILURE ? { ...LAST_RESOLVE_FAILURE } : null;
}

/** Test hook. */
export function _resetCdpResolveDiagnostics() {
  LAST_RESOLVE_FAILURE = null;
  RESOLVE_SEQUENCE = 0;
}

function recordResolveFailure(stage, donutId, detail = {}) {
  LAST_RESOLVE_FAILURE = {
    seq: (RESOLVE_SEQUENCE += 1),
    stage,
    donutId: String(donutId),
    at: new Date().toISOString(),
    port: detail.port ?? null,
    httpStatus: detail.httpStatus ?? null,
    reason: detail.reason ?? null,
  };
  return null;
}

/**
 * Resolve the official per-profile CDP port. Returns { ok, port } or null.
 * `readRuntimeCredential` supplies the loopback API credential (main-process
 * only); `fetchImpl` is injectable for tests.
 */
export function createCdpPortResolver({
  readRuntimeCredential,
  fetchImpl = (...a) => fetch(...a),
} = {}) {
  const readCredential =
    typeof readRuntimeCredential === "function"
      ? readRuntimeCredential
      : async () => null;
  return async (donutId) => {
    const cred = await readCredential().catch(() => null);
    if (!cred || typeof cred.port !== "number" || typeof cred.token !== "string") {
      return recordResolveFailure("credential", donutId, { reason: "missing-or-malformed" });
    }
    const base = `http://127.0.0.1:${cred.port}`;
    const headers = { Authorization: `Bearer ${cred.token}` };
    const profileRes = await fetchImpl(
      `${base}/v1/profiles/${encodeURIComponent(donutId)}`,
      { headers, signal: AbortSignal.timeout(5000) },
    ).catch(() => null);
    if (!profileRes?.ok) {
      return recordResolveFailure("profile-fetch", donutId, {
        httpStatus: profileRes ? profileRes.status : null,
        reason: "not-ok",
      });
    }
    const payload = await profileRes.json().catch(() => null);
    const profile = payload && payload.profile ? payload.profile : payload;
    if (!profile) {
      return recordResolveFailure("profile-json", donutId, { reason: "unparseable" });
    }
    if (profile.is_running !== true) {
      return recordResolveFailure("not-running", donutId, {
        reason: "is_running-not-true",
      });
    }
    const rawPort = profile.remote_debugging_port ?? profile.remoteDebuggingPort;
    const cached = PORT_CACHE.get(String(donutId));
    // Strict: only a genuine number may become a connection target. A numeric
    // STRING would coerce through Number() and let crafted input reach the
    // endpoint construction, so the type is checked before the range.
    const resolved =
      typeof rawPort === "number" && Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535
        ? rawPort
        : typeof cached === "number" && Number.isInteger(cached) && cached >= 1 && cached <= 65535
          ? cached
          : null;
    if (resolved === null) {
      return recordResolveFailure("port-unresolved", donutId, {
        reason: "no-port-from-profile-or-run-cache",
      });
    }
    LAST_RESOLVE_FAILURE = null;
    return { ok: true, port: resolved, donutId: String(donutId) };
  };
}

// legacy alias kept so the ownership tests and ipc wiring keep compiling
// while the resolver name changes.
export const createCdpEndpointResolver = createCdpPortResolver;

export const REASONS = Object.freeze({
  UNKNOWN_PROFILE: "unknown-profile",
  NOT_OWNED: "not-owned",
  DISABLED: "disabled",
  FOREIGN_RUNTIME: "foreign-runtime",
  BACKEND_UNAVAILABLE: "backend-unavailable",
  INVALID_TAB: "invalid-tab",
  FEATURE_NOT_SUPPORTED: "feature-not-supported",
  INVALID_URL: "invalid-url",
  BUSY: "busy",
  RATE_LIMITED: "rate-limited",
  INVALID_SELECTOR: "invalid-selector",
  SELECTOR_NOT_FOUND: "selector-not-found",
  ELEMENT_NOT_VISIBLE: "element-not-visible",
  ELEMENT_NOT_READY: "element-not-ready",
  INVALID_KEY: "invalid-key",
  INVALID_TEXT: "invalid-text",
  INVALID_WAIT: "invalid-wait",
  WAIT_TIMEOUT: "wait-timeout",
  CANCELLED: "cancelled",
  EVALUATE_FAILED: "evaluate-failed",
});

/** Ownership gate: CF profile row -> binding -> provider profile id. */
export function createOwnedRuntimeResolver({ core, resolveOwnedRuntime }) {
  const resolver =
    typeof resolveOwnedRuntime === "function"
      ? resolveOwnedRuntime
      : async () => ({ ok: false, reason: "foreign-runtime" });
  return async (profileLocalId, cfProfileId) => {
    if (
      (typeof cfProfileId !== "string" && typeof cfProfileId !== "number") ||
      String(cfProfileId).trim() === ""
    ) {
      return { ok: false, reason: REASONS.UNKNOWN_PROFILE };
    }
    let row = null;
    try {
      row = await Promise.resolve(
        core?.getBrowserProfile?.(Number(cfProfileId), String(profileLocalId)),
      );
    } catch {
      row = null;
    }
    if (!row) return { ok: false, reason: REASONS.UNKNOWN_PROFILE };
    if (String(row.cfProfileId ?? row.cf_profile_id) !== String(cfProfileId)) {
      return { ok: false, reason: REASONS.NOT_OWNED };
    }
    if (row.enabled === false) return { ok: false, reason: REASONS.DISABLED };
    return resolver(profileLocalId, String(cfProfileId));
  };
}

function isUnknownEndpoint(status, body) {
  if (status === 404) return true;
  if (status !== 400 && status !== 501) return false;
  if (typeof body !== "string") return false;
  const lower = body.toLowerCase();
  return (
    lower.includes("endpoint unknown") ||
    lower.includes("not implemented") ||
    lower.includes("unknown route")
  );
}

async function readJsonOrText(res) {
  const text = await res.text().catch(() => "");
  if (!text) return { body: "", json: null };
  try {
    return { body: text, json: JSON.parse(text) };
  } catch {
    return { body: text, json: null };
  }
}

function reasonFromResolve(res) {
  if (!res || res.ok !== true) {
    const r =
      res && typeof res.reason === "string" ? res.reason : "unknown-profile";
    if (
      r === "unknown-profile" ||
      r === "not-owned" ||
      r === "disabled" ||
      r === "foreign-runtime"
    ) {
      return r;
    }
    return "unknown-profile";
  }
  if (typeof res.donutId !== "string" || !res.donutId) return "unknown-profile";
  return null;
}

export function createCdpAdapter({
  resolveOwnedRuntime,
  readRuntimeCredential,
  fetchImpl = (...a) => fetch(...a),
  resolveCdpEndpoint = null,
  session = null,
} = {}) {
  if (typeof resolveOwnedRuntime !== "function") {
    throw new TypeError("createCdpAdapter: resolveOwnedRuntime is required");
  }
  if (typeof readRuntimeCredential !== "function") {
    throw new TypeError("createCdpAdapter: readRuntimeCredential is required");
  }
  const sess = session ?? sharedCdpSession();

  async function resolveOrReject(profileLocalId, cfProfileId) {
    if (typeof profileLocalId !== "string" || !profileLocalId) {
      return { ok: false, reason: REASONS.UNKNOWN_PROFILE };
    }
    if (
      (typeof cfProfileId !== "string" && typeof cfProfileId !== "number") ||
      String(cfProfileId).trim() === ""
    ) {
      return { ok: false, reason: REASONS.UNKNOWN_PROFILE };
    }
    let resolved;
    try {
      resolved = await resolveOwnedRuntime(profileLocalId, String(cfProfileId));
    } catch {
      return { ok: false, reason: REASONS.UNKNOWN_PROFILE };
    }
    const denyReason = reasonFromResolve(resolved);
    if (denyReason) return { ok: false, reason: denyReason };
    return { ok: true, donutId: resolved.donutId };
  }

  async function withCred(path, method, body) {
    let cred;
    try {
      cred = await readRuntimeCredential();
    } catch {
      return { ok: false, reason: REASONS.BACKEND_UNAVAILABLE };
    }
    if (!cred || typeof cred.port !== "number" || typeof cred.token !== "string") {
      return { ok: false, reason: REASONS.BACKEND_UNAVAILABLE };
    }
    const url = `http://127.0.0.1:${cred.port}${path}`;
    const headers = {
      Authorization: `Bearer ${cred.token}`,
      "Content-Type": "application/json",
    };
    const init = {
      method,
      headers,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch {
      return { ok: false, reason: REASONS.BACKEND_UNAVAILABLE };
    }
    const { body: rawBody, json } = await readJsonOrText(res);
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: REASONS.BACKEND_UNAVAILABLE };
    }
    if (res.status === 429) {
      return { ok: false, reason: REASONS.RATE_LIMITED };
    }
    if (isUnknownEndpoint(res.status, rawBody)) {
      return { ok: false, reason: REASONS.FEATURE_NOT_SUPPORTED };
    }
    if (!res.ok) {
      return { ok: false, reason: REASONS.BACKEND_UNAVAILABLE };
    }
    return { ok: true, json };
  }

  /**
   * Ensure a live Playwright session for the profile, using the OFFICIAL port:
   * resolved from GET /v1/profiles/{id}.remote_debugging_port (or the /run
   * cache). Re-connects when the session dropped (browser restart).
   */
  async function ensureSession(resolved) {
    let endpoint = null;
    if (typeof resolveCdpEndpoint === "function") {
      try {
        endpoint = await resolveCdpEndpoint(resolved.donutId);
      } catch {
        endpoint = null;
      }
    }
    const port = Number(endpoint?.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, reason: REASONS.BACKEND_UNAVAILABLE };
    }
    if (sess.isOpen(resolved.donutId) && sess.portOf(resolved.donutId) === port) {
      return { ok: true, port };
    }
    const opened = await sess.open(resolved.donutId, port);
    return opened.ok ? { ok: true, port } : { ok: false, reason: REASONS.BACKEND_UNAVAILABLE };
  }

  function ensureTabId(tabId) {
    if (typeof tabId !== "string" && typeof tabId !== "number") return false;
    return String(tabId).trim().length > 0;
  }

  async function withPage(resolved, tabId, fn) {
    const ready = await ensureSession(resolved);
    if (!ready.ok) return { ok: false, reason: ready.reason };
    // Session results pass through verbatim: their reason codes already match
    // the renderer-facing vocabulary (invalid-tab for unknown tab ids).
    return fn(resolved.donutId, String(tabId));
  }

  async function listTabsInternal(resolved) {
    const ready = await ensureSession(resolved);
    if (!ready.ok) return { ok: false, reason: ready.reason };
    const r = await sess.tabs(resolved.donutId);
    if (!r.ok) return r;
    return {
      ok: true,
      tabs: (r.tabs || []).map((t) => ({
        id: String(t.id),
        title: typeof t.title === "string" ? t.title.slice(0, 4096) : "",
        url: sanitizeRendererUrl(t.url),
        active: t.active === true,
      })),
    };
  }

  async function browserLiveness(profileLocalId, cfProfileId) {
    const resolved = await resolveOrReject(profileLocalId, cfProfileId);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    const status = await withCred(
      `/v1/profiles/${encodeURIComponent(resolved.donutId)}`,
      "GET",
    );
    if (!status.ok) return status;
    const profile = status.json?.profile ?? status.json;
    if (!profile || typeof profile.is_running !== "boolean") {
      return { ok: false, reason: REASONS.BACKEND_UNAVAILABLE };
    }
    if (profile.is_running !== true) return { ok: true, running: false };
    // Preserved semantics from the pre-Playwright adapter: a running profile
    // whose official CDP port cannot be resolved is INCONCLUSIVE (ok:false),
    // never "running". The port comes from the profile payload's
    // remote_debugging_port (or this process's /run cache) — no /json probing.
    let endpoint = null;
    if (typeof resolveCdpEndpoint === "function") {
      try {
        endpoint = await resolveCdpEndpoint(resolved.donutId);
      } catch {
        endpoint = null;
      }
    }
    const port = Number(endpoint?.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, reason: REASONS.BACKEND_UNAVAILABLE };
    }
    return { ok: true, running: true };
  }

  return {
    reasons: REASONS,
    browserLiveness,
    async killBrowser(profileLocalId, cfProfileId) {
      const resolved = await resolveOrReject(profileLocalId, cfProfileId);
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      const res = await withCred(
        `/v1/profiles/${encodeURIComponent(resolved.donutId)}/kill`,
        "POST",
        {},
      );
      if (res.ok) sess.drop(resolved.donutId);
      return res.ok ? { ok: true } : { ok: false, reason: res.reason };
    },

    /**
     * Open a URL in a tab. Preferred: a live session page (Playwright
     * context.newPage + goto). Fallback: the official REST open-url endpoint
     * when no session can be established (e.g. Pro-gated CDP unavailable).
     */
    async openUrl(profileLocalId, cfProfileId, url) {
      const resolved = await resolveOrReject(profileLocalId, cfProfileId);
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      const safeUrl = validateHttpUrl(url);
      if (!safeUrl) return { ok: false, reason: REASONS.INVALID_URL };
      const ready = await ensureSession(resolved);
      if (ready.ok) {
        const r = await sess.openUrl(resolved.donutId, safeUrl);
        if (r.ok) return { ok: true, tabId: r.tabId };
      }
      const res = await withCred(
        `/v1/profiles/${encodeURIComponent(resolved.donutId)}/open-url`,
        "POST",
        { url: safeUrl },
      );
      return res.ok ? { ok: true } : { ok: false, reason: res.reason };
    },

    listTabs: async (profileLocalId, cfProfileId) => {
      // Ownership gate first — the internal method takes a RESOLVED identity
      // and must never be reachable with raw renderer-supplied ids.
      const resolved = await resolveOrReject(profileLocalId, cfProfileId);
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      return listTabsInternal(resolved);
    },

    async createTab(profileLocalId, cfProfileId) {
      const resolved = await resolveOrReject(profileLocalId, cfProfileId);
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      const ready = await ensureSession(resolved);
      if (!ready.ok) return { ok: false, reason: ready.reason };
      return sess.newTab(resolved.donutId);
    },

    async closeTab(profileLocalId, cfProfileId, tabId) {
      const resolved = await resolveOrReject(profileLocalId, cfProfileId);
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      if (!ensureTabId(tabId)) return { ok: false, reason: REASONS.INVALID_TAB };
      return withPage(resolved, tabId, (id, t) => sess.closeTab(id, t));
    },

    async activateTab(profileLocalId, cfProfileId, tabId) {
      const resolved = await resolveOrReject(profileLocalId, cfProfileId);
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      if (!ensureTabId(tabId)) return { ok: false, reason: REASONS.INVALID_TAB };
      return withPage(resolved, tabId, (id, t) => sess.activateTab(id, t));
    },

    async reload(profileLocalId, cfProfileId, tabId) {
      const resolved = await resolveOrReject(profileLocalId, cfProfileId);
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      if (!ensureTabId(tabId)) return { ok: false, reason: REASONS.INVALID_TAB };
      return withPage(resolved, tabId, (id, t) => sess.reload(id, t));
    },

    async back(profileLocalId, cfProfileId, tabId) {
      const resolved = await resolveOrReject(profileLocalId, cfProfileId);
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      if (!ensureTabId(tabId)) return { ok: false, reason: REASONS.INVALID_TAB };
      return withPage(resolved, tabId, (id, t) => sess.back(id, t));
    },

    async forward(profileLocalId, cfProfileId, tabId) {
      const resolved = await resolveOrReject(profileLocalId, cfProfileId);
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      if (!ensureTabId(tabId)) return { ok: false, reason: REASONS.INVALID_TAB };
      return withPage(resolved, tabId, (id, t) => sess.forward(id, t));
    },

    async getPageInfo(profileLocalId, cfProfileId, tabId) {
      const resolved = await resolveOrReject(profileLocalId, cfProfileId);
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      if (!ensureTabId(tabId)) return { ok: false, reason: REASONS.INVALID_TAB };
      return withPage(resolved, tabId, async (id, t) => {
        const r = await sess.pageInfo(id, t);
        if (!r.ok) return r;
        return {
          ok: true,
          info: {
            title: typeof r.title === "string" ? r.title.slice(0, 4096) : "",
            url: sanitizeRendererUrl(r.url),
          },
        };
      });
    },

    async screenshot(profileLocalId, cfProfileId, tabId) {
      const resolved = await resolveOrReject(profileLocalId, cfProfileId);
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      if (!ensureTabId(tabId)) return { ok: false, reason: REASONS.INVALID_TAB };
      return withPage(resolved, tabId, async (id, t) => {
        const r = await sess.screenshot(id, t);
        if (!r.ok) return r;
        return { ok: true, image: { dataUrl: r.dataUrl, width: 0, height: 0 } };
      });
    },

    // ---- Agent browser-interaction primitives ---------------------------
    // Same Playwright-owned session as every other adapter method: ownership
    // gate -> session -> page operation. Page-origin data stays bounded and
    // typed results never echo typed values.

    async browserGetPageText(profileLocalId, cfProfileId, tabId, opts = {}) {
      const resolved = await resolveOrReject(profileLocalId, cfProfileId);
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      if (!ensureTabId(tabId)) return { ok: false, reason: REASONS.INVALID_TAB };
      return withPage(resolved, tabId, async (id, t) => {
        if (opts.signal?.aborted) return { ok: false, reason: REASONS.CANCELLED };
        const expr =
          `(() => { const t = document.title || ''; const u = location.href || ''; ` +
          `const b = document.body; let s = b ? ((b.innerText || b.textContent || '') + '') : ''; ` +
          `if (s.length > ${MAX_PAGE_TEXT_CHARS}) s = s.slice(0, ${MAX_PAGE_TEXT_CHARS}); ` +
          `return { title: (t + '').slice(0, 512), url: u, text: s }; })()`;
        const r = await sess.evaluate(id, t, expr);
        if (!r.ok) return r.reason === "evaluate-failed" ? r : { ok: false, reason: r.reason };
        const v = r.value || {};
        return {
          ok: true,
          info: {
            title: typeof v.title === "string" ? v.title.slice(0, 512) : "",
            url: sanitizeRendererUrl(typeof v.url === "string" ? v.url : ""),
            text: typeof v.text === "string" ? v.text.slice(0, MAX_PAGE_TEXT_CHARS) : "",
          },
        };
      });
    },

    async browserExtractText(profileLocalId, cfProfileId, tabId, selector, opts = {}) {
      const resolved = await resolveOrReject(profileLocalId, cfProfileId);
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      if (!ensureTabId(tabId)) return { ok: false, reason: REASONS.INVALID_TAB };
      const sel = validateSelector(selector);
      if (!sel.ok) return { ok: false, reason: sel.reason };
      return withPage(resolved, tabId, async (id, t) => {
        if (opts.signal?.aborted) return { ok: false, reason: REASONS.CANCELLED };
        const expr =
          `(() => { const el = document.querySelector(${JSON.stringify(sel.selector)}); ` +
          `if (!el) return { found: false }; ` +
          `let s = ((el.innerText || el.textContent || '') + ''); ` +
          `if (s.length > ${MAX_EXTRACT_TEXT_CHARS}) s = s.slice(0, ${MAX_EXTRACT_TEXT_CHARS}); ` +
          `return { found: true, text: s, tag: (el.tagName || '').toLowerCase() }; })()`;
        const r = await sess.evaluate(id, t, expr);
        if (!r.ok) return r;
        const v = r.value || {};
        if (v.found !== true) return { ok: false, reason: REASONS.SELECTOR_NOT_FOUND };
        return {
          ok: true,
          result: {
            text: typeof v.text === "string" ? v.text.slice(0, MAX_EXTRACT_TEXT_CHARS) : "",
            tag: typeof v.tag === "string" ? v.tag : "",
          },
        };
      });
    },

    async browserClick(profileLocalId, cfProfileId, tabId, selector, opts = {}) {
      const resolved = await resolveOrReject(profileLocalId, cfProfileId);
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      if (!ensureTabId(tabId)) return { ok: false, reason: REASONS.INVALID_TAB };
      const sel = validateSelector(selector);
      if (!sel.ok) return { ok: false, reason: sel.reason };
      return withPage(resolved, tabId, async (id, t) => {
        if (opts.signal?.aborted) return { ok: false, reason: REASONS.CANCELLED };
        const probe =
          `(() => { const el = document.querySelector(${JSON.stringify(sel.selector)}); ` +
          `if (!el) return { state: 'not-found' }; ` +
          `const st = getComputedStyle(el); ` +
          `if (st.display === 'none' || st.visibility === 'hidden' || st.pointerEvents === 'none') return { state: 'not-visible' }; ` +
          `const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return { state: 'not-visible' }; ` +
          `if (el.disabled === true) return { state: 'not-ready' }; ` +
          `el.scrollIntoView({ block: 'center', inline: 'center' }); ` +
          `const r2 = el.getBoundingClientRect(); ` +
          `return { state: 'ok', x: r2.left + r2.width / 2, y: r2.top + r2.height / 2, tag: (el.tagName || '').toLowerCase() }; })()`;
        const p = await sess.evaluate(id, t, probe);
        if (!p.ok) return p;
        const v = p.value || {};
        if (v.state === "not-found") return { ok: false, reason: REASONS.SELECTOR_NOT_FOUND };
        if (v.state === "not-visible") return { ok: false, reason: REASONS.ELEMENT_NOT_VISIBLE };
        if (v.state === "not-ready") return { ok: false, reason: REASONS.ELEMENT_NOT_READY };
        if (v.state !== "ok" || !Number.isFinite(v.x) || !Number.isFinite(v.y)) {
          return { ok: false, reason: REASONS.EVALUATE_FAILED };
        }
        const x = Math.round(v.x);
        const y = Math.round(v.y);
        const r = await sess.mouseClick(id, t, x, y);
        if (!r.ok) return r;
        return {
          ok: true,
          result: { clicked: true, tag: typeof v.tag === "string" ? v.tag : "", x, y },
        };
      });
    },

    async browserType(profileLocalId, cfProfileId, tabId, selector, text, opts = {}) {
      const resolved = await resolveOrReject(profileLocalId, cfProfileId);
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      if (!ensureTabId(tabId)) return { ok: false, reason: REASONS.INVALID_TAB };
      const sel = validateSelector(selector);
      if (!sel.ok) return { ok: false, reason: sel.reason };
      const t = validateTypedText(text);
      if (!t.ok) return { ok: false, reason: t.reason };
      return withPage(resolved, tabId, async (id, tab) => {
        if (opts.signal?.aborted) return { ok: false, reason: REASONS.CANCELLED };
        // Focus + interactability probe. No DOM value assignment: insertion
        // goes through keyboard.insertText on the focused element.
        const probe =
          `(() => { const el = document.querySelector(${JSON.stringify(sel.selector)}); ` +
          `if (!el) return { state: 'not-found' }; ` +
          `const st = getComputedStyle(el); ` +
          `if (st.display === 'none' || st.visibility === 'hidden') return { state: 'not-visible' }; ` +
          `if (el.disabled === true || el.readOnly === true) return { state: 'not-ready' }; ` +
          `el.scrollIntoView({ block: 'center', inline: 'center' }); ` +
          `el.focus(); ` +
          `if (document.activeElement !== el) return { state: 'not-focusable' }; ` +
          `return { state: 'ok', tag: (el.tagName || '').toLowerCase() }; })()`;
        const p = await sess.evaluate(id, tab, probe);
        if (!p.ok) return p;
        const v = p.value || {};
        if (v.state === "not-found") return { ok: false, reason: REASONS.SELECTOR_NOT_FOUND };
        if (v.state === "not-visible") return { ok: false, reason: REASONS.ELEMENT_NOT_VISIBLE };
        if (v.state === "not-ready" || v.state === "not-focusable") {
          return { ok: false, reason: REASONS.ELEMENT_NOT_READY };
        }
        if (v.state !== "ok") return { ok: false, reason: REASONS.BACKEND_UNAVAILABLE };
        const r = await sess.insertText(id, tab, t.text);
        if (!r.ok) return r;
        // The typed value itself must never be echoed into results/events;
        // only its length and the target tag are returned.
        return {
          ok: true,
          result: {
            typed: true,
            tag: typeof v.tag === "string" ? v.tag : "",
            length: t.text.length,
          },
        };
      });
    },

    async browserPressKey(profileLocalId, cfProfileId, tabId, keyName, opts = {}) {
      const resolved = await resolveOrReject(profileLocalId, cfProfileId);
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      if (!ensureTabId(tabId)) return { ok: false, reason: REASONS.INVALID_TAB };
      const k = resolveKey(keyName);
      if (!k.ok) return { ok: false, reason: k.reason };
      return withPage(resolved, tabId, async (id, t) => {
        if (opts.signal?.aborted) return { ok: false, reason: REASONS.CANCELLED };
        const r = await sess.pressKey(id, t, k.key);
        if (!r.ok) return r;
        return { ok: true, result: { sent: true, key: k.key } };
      });
    },

    async browserWaitForSelector(profileLocalId, cfProfileId, tabId, selector, ms, opts = {}) {
      const resolved = await resolveOrReject(profileLocalId, cfProfileId);
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      if (!ensureTabId(tabId)) return { ok: false, reason: REASONS.INVALID_TAB };
      const hasSelector = typeof selector === "string" && selector.trim().length > 0;
      let sel = null;
      if (hasSelector) {
        const s = validateSelector(selector);
        if (!s.ok) return { ok: false, reason: s.reason };
        sel = s.selector;
      }
      // Strict: a numeric STRING must not coerce into a wait budget.
      const waitMs = ms === undefined || ms === null ? 5000 : ms;
      if (
        typeof waitMs !== "number" ||
        !Number.isInteger(waitMs) ||
        waitMs < 1 ||
        waitMs > MAX_WAIT_MS
      ) {
        return { ok: false, reason: REASONS.INVALID_WAIT };
      }
      return withPage(resolved, tabId, async (id, t) => {
        const deadline = Date.now() + waitMs;
        if (!hasSelector) {
          while (Date.now() < deadline) {
            if (opts.signal?.aborted) return { ok: false, reason: REASONS.CANCELLED };
            await new Promise((r) =>
              setTimeout(r, Math.min(250, deadline - Date.now())),
            );
          }
          return { ok: true, result: { waitedMs: waitMs, found: null } };
        }
        const expr = `(() => { return document.querySelector(${JSON.stringify(sel)}) !== null; })()`;
        for (;;) {
          if (opts.signal?.aborted) return { ok: false, reason: REASONS.CANCELLED };
          const r = await sess.evaluate(id, t, expr);
          if (r.ok && r.value === true) {
            return {
              ok: true,
              result: { found: true, waitedMs: waitMs - Math.max(0, deadline - Date.now()) },
            };
          }
          if (Date.now() >= deadline) {
            return { ok: true, result: { found: false, waitedMs: waitMs } };
          }
          await new Promise((res) =>
            setTimeout(res, Math.min(250, Math.max(1, deadline - Date.now()))),
          );
        }
      });
    },
  };
}
