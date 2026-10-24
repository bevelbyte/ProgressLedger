// SubjectLinks → Donut open-url → system-browser fallback.
//
// One high-level operation (openSubjectLink) so the renderer never learns
// anything about Donut infrastructure. Authoritative URL validation happens
// HERE in the main process, regardless of what the UI checks. The Donut leg
// speaks ONLY the documented contract endpoint
// (POST /v1/profiles/{id}/open-url, bearer-authenticated) and the system
// fallback is an injected main-process opener (the IPC layer wires Electron's
// external-URL opener).

import { readRuntimeCredential } from "./donut.js";

const OPEN_TIMEOUT_MS = 8000;

/**
 * Pure HTTP(S)-only URL validator. Returns the normalized absolute URL href,
 * or null when the input is not acceptable. Rejects every non-http(s)
 * scheme (javascript:, data:, file:, vbscript:, about:, chrome:,
 * chrome-extension:, devtools:, ftp:, …), empty/whitespace strings and
 * values that do not parse as absolute URLs.
 */
export function validateHttpUrl(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  return parsed.href;
}

/**
 * Profile-id resolution for the Donut open-url contract endpoint.
 *
 * The contract requires a target profile id, and profile CREATION is a heavy
 * product decision (Wayfern fingerprint generation carries a multi-minute
 * anti-burst guard), so this foundation does not auto-create profiles.
 * An explicit id may be supplied via CAREERFLOW_DONUT_PROFILE_ID; without it
 * the caller falls back to the system browser honestly.
 */
export function makeResolveProfileIdFromEnv(env = process.env) {
  return function resolveProfileId() {
    const id = (env.CAREERFLOW_DONUT_PROFILE_ID || "").trim();
    return id ? { ok: true, id } : { ok: false, reason: "profile-not-configured" };
  };
}

/**
 * Contract transport: authenticated POST /v1/profiles/{id}/open-url.
 * The bearer token is read fresh from the official Local API credential store and
 * confined to this header construction — it is never returned, logged or
 * stored. Any failure collapses to { ok: false }.
 */
export function makeDonutOpenViaApi(fetchImpl = (...a) => fetch(...a)) {
  return async function donutOpenViaApi({ profileId, url }) {
    const cred = await readRuntimeCredential();
    if (!cred) return { ok: false, reason: "no-runtime-credential" };
    try {
      const res = await fetchImpl(
        `http://127.0.0.1:${cred.port}/v1/profiles/${encodeURIComponent(profileId)}/open-url`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cred.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ url }),
          signal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
        }
      );
      return { ok: res.ok };
    } catch {
      return { ok: false, reason: "transport-error" };
    }
  };
}

/**
 * Orchestrator. Fixed-shape sanitized results only:
 *   { opened: true,  provider: "donut" | "system" }
 *   { opened: false, reason: "invalid-url" | "open-failed" }
 */
export function createLinkOpener(deps) {
  const {
    provider,
    resolveProfileId,
    donutOpen,
    systemOpen,
    validate = validateHttpUrl,
  } = deps;

  async function systemFallback(url) {
    // Test-safety gate (matches donut-manager.js). In E2E runs, never
    // silently open the system browser — return a typed reason instead.
    // The harness sets CAREERFLOW_E2E_DISABLE_SYSTEM_FALLBACK=1; in
    // production the env var is unset and the system opener runs.
    if (process.env.CAREERFLOW_E2E_DISABLE_SYSTEM_FALLBACK === "1") {
      return { opened: false, reason: "e2e-no-fallback" };
    }
    try {
      const ok = await systemOpen(url);
      return ok === true
        ? { opened: true, provider: "system" }
        : { opened: false, reason: "open-failed" };
    } catch {
      return { opened: false, reason: "open-failed" };
    }
  }

  return {
    async openSubjectLink(rawUrl, opts = {}) {
      const url = validate(rawUrl);
      if (!url) return { opened: false, reason: "invalid-url" };
      // Main-process callers may force the fallback (e.g. unknown CareerFlow
      // profile) or hand over an already-resolved Donut profile id.
      if (opts.forceSystem === true) return systemFallback(url);

      let status = null;
      try {
        status = await provider.getStatus();
      } catch {
        status = { ready: false };
      }
      const connected = status && status.ready === true;

      if (!connected) {
        // Unavailable: one bounded, deduplicated connect attempt. The
        // provider runtime is the user's Donut app — connecting never spawns
        // or starts a process; a down app simply falls back honestly.
        let started = null;
        try {
          started = await provider.ensureStarted();
        } catch {
          started = null;
        }
        if (!(started && started.ready === true)) {
          return systemFallback(url);
        }
      }

      let profile;
      if (typeof opts.donutProfileId === "string" && opts.donutProfileId) {
        profile = { ok: true, id: opts.donutProfileId };
      } else {
        try {
          profile = resolveProfileId();
        } catch {
          profile = { ok: false };
        }
      }
      if (!profile || profile.ok !== true || typeof profile.id !== "string" || !profile.id) {
        // Contract gap (no configured profile mapping): honest system fallback.
        return systemFallback(url);
      }

      let outcome;
      try {
        outcome = await donutOpen({ profileId: profile.id, url });
      } catch {
        outcome = { ok: false };
      }
      if (!(outcome && outcome.ok === true)) {
        return systemFallback(url);
      }
      return { opened: true, provider: "donut" };
    },
  };
}

