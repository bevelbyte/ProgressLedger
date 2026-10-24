// Browser Manager orchestration (main process only).
//
// Every collaborator is injected so the whole decision tree is unit-testable
// without Electron, ports, processes or tokens:
//   renderer -> IPC (ids + strings) -> ops -> Donut transport (bearer)
//
// Guarantees:
//   * CF-profile ownership validated against the local database first
//   * machine-local Donut id resolved through the binding flow (never from
//     the renderer), lazily matched-or-created under bfc-<localId>
//     transition owns the backend; navigations degrade to the system browser
//     instead of racing the transition
//   * any Donut-side failure degrades honestly (fixed sanitized shapes; the
//     bearer credential never appears in a result)

/** Pure HTTP(S)-only URL guard shared with the SubjectLinks pipeline. */
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
 * deps:
 *   cfProfileExists(cfProfileId) -> boolean         – local DB membership
 *   getBrowserProfileRow(localId) -> row|null       – {cf_profile_id, enabled}
 *   getShortcutRow(shortcutId) -> row|null          – {browser_profile_id,
 *                                                      url, cf_profile_id, enabled}
 *   provider                                        – { getStatus, ensureStarted }
     *   probeBrowserLiveness(localId, cfProfileId)      – async {ok,running} (optional)
 *   ensureBinding(localId, cfProfileId) -> donutId  – lazy match-or-create
 *   transport.run(donutId) -> {ok}                  – documented /run
 *   transport.openUrl(donutId, url) -> {ok}         – documented /open-url
 *   touchBrowserProfile(localId)                    – last-used bump (optional)
 *   systemOpen(url) -> Promise<boolean>             – external opener
 */
export function createManagerOps(deps) {
  const {
    cfProfileExists,
    getBrowserProfileRow,
    getShortcutRow,
    provider,
    probeBrowserLiveness,
    ensureBinding,
    transport,
    systemOpen,
    touchBrowserProfile,
    validate = validateHttpUrl,
  } = deps;

  function fail(reason) {
    return { ok: false, reason };
  }

  async function connectedReady() {
    try {
      const s = await provider.getStatus();
      return Boolean(s && s.ready === true);
    } catch {
      return false;
    }
  }

  /** Connected now, or one bounded deduplicated connect attempt. */
  async function readyOrStart() {
    if (await connectedReady()) return true;
    try {
      const s = await provider.ensureStarted();
      return Boolean(s && s.ready === true);
    } catch {
      return false;
    }
  }

  async function systemFallback(url) {
    // Test-safety gate: in E2E runs, never silently open the system browser.
    // The harness sets CAREERFLOW_E2E_DISABLE_SYSTEM_FALLBACK=1 so a failed
    // A failed Donut binding surfaces as a typed reason rather
    // than launching the user's default browser. Production runs are
    // unaffected (the env var is not set).
    if (process.env.CAREERFLOW_E2E_DISABLE_SYSTEM_FALLBACK === "1") {
      return { ok: false, reason: "e2e-no-fallback", url };
    }
    try {
      const ok = await systemOpen(url);
      return ok === true
        ? { opened: true, provider: "system" }
        : { ok: false, reason: "open-failed" };
    } catch {
      return { ok: false, reason: "open-failed" };
    }
  }

  function bindingFailure(e) {
    const msg = e && e.message;
    return fail(
      msg === "binding-budget-exceeded" || msg === "mapping-budget-exceeded"
        ? "anti-burst-budget-exceeded"
        : "binding-unavailable"
    );
  }

  function touchIfOwned(localId, cfProfileId) {
    if (typeof touchBrowserProfile === "function") {
      try { touchBrowserProfile(localId, cfProfileId); } catch {}
    }
  }

  /**
   * Shared ownership gate for both ops: the CareerFlow profile must exist and
   * the managed browser profile must belong to it and be enabled.
   */
  function ownedRow(localId, cfProfileId) {
    if (!cfProfileExists(cfProfileId)) return { error: "unknown-cf-profile" };
    const row = getBrowserProfileRow(localId, cfProfileId);
    if (!row || String(row.cf_profile_id) !== String(cfProfileId))
      return { error: "not-owned" };
    if (!row.enabled) return { error: "disabled" };
    return { row };
  }

  async function resolveBinding(localId, cfProfileId) {
    try {
      return { donutId: await ensureBinding(localId, cfProfileId) };
    } catch (e) {
      const err = bindingFailure(e).reason;
      if (process.env.CAREERFLOW_E2E_DISABLE_SYSTEM_FALLBACK === "1") {
        return { error: `${err}:${(e && e.message) || e}` };
      }
      return { error: err };
    }
  }

  return {
    /** Launch-or-reuse a managed browser profile (no navigation).
     * Result: { ok: true } | { ok: false, reason }. */
    async openBrowserProfile(browserProfileLocalId, cfProfileId) {
      const gate = ownedRow(browserProfileLocalId, cfProfileId);
      if (gate.error) return fail(gate.error);

      if (!(await readyOrStart())) return fail("backend-unavailable");

      const bound = await resolveBinding(browserProfileLocalId, cfProfileId);
      if (bound.error) return fail(bound.error);

      let alreadyRunning = false;
      if (typeof probeBrowserLiveness === "function") {
        try {
          const live = await probeBrowserLiveness(browserProfileLocalId, cfProfileId);
          alreadyRunning = live?.ok === true && live.running === true;
        } catch {
          // A failed liveness probe is not proof of a running browser.
        }
      }
      if (!alreadyRunning) {
        try {
          const r = await transport.run(bound.donutId);
          if (!(r && r.ok === true)) return fail("run-failed");
        } catch {
          return fail("run-failed");
        }
      }
      touchIfOwned(browserProfileLocalId, cfProfileId);
      return { ok: true };
    },

    /** Navigate a shortcut's profile to its stored URL via /open-url
     * (launch-or-reuse). Falls back to the system browser whenever Donut
     * cannot serve the navigation.
     * Result: { opened: true, provider } | { ok: false, reason }. */
    async openShortcutUrl(shortcutId, cfProfileId) {
      const row = getShortcutRow(shortcutId);
      if (!row) return fail("shortcut-not-found");
      if (String(row.cf_profile_id) !== String(cfProfileId)) return fail("not-owned");

      const url = validate(row.url);
      if (!url) return fail("invalid-url");

      // Ownership/validity problems are explicit failures — silently pushing
      // a foreign or disabled profile's URL to the system browser would hide
      // the misconfiguration. Only Donut-side unavailability falls back.
      const gate = ownedRow(row.browser_profile_id, cfProfileId);
      if (gate.error) return fail(gate.error);

      const ready = await readyOrStart();
      if (!ready) {
        if (process.env.CAREERFLOW_E2E_DISABLE_SYSTEM_FALLBACK === "1") {
          return { ok: false, reason: "e2e-not-ready" };
        }
        return systemFallback(url);
      }

      const bound = await resolveBinding(row.browser_profile_id, cfProfileId);
      if (bound.error) {
        if (process.env.CAREERFLOW_E2E_DISABLE_SYSTEM_FALLBACK === "1") {
          return { ok: false, reason: `e2e-binding:${bound.error}` };
        }
        return systemFallback(url);
      }

      // /open-url is a navigation operation, not a browser-process launcher on
      // every DBI build. After an app/backend restart the mapped profile may
      // still exist while its Wayfern process is gone. Reconcile liveness and
      // start the exact mapped profile before issuing navigation; this closes
      // the restart race without creating a second Donut identity.
      if (typeof probeBrowserLiveness === "function") {
        try {
          const live = await probeBrowserLiveness(row.browser_profile_id, cfProfileId);
          if (!(live?.ok === true && live.running === true)) {
            const started = await transport.run(bound.donutId);
            if (!(started && started.ok === true)) return fail("run-failed");
          }
        } catch {
          return fail("run-failed");
        }
      }

      try {
        const r = await transport.openUrl(bound.donutId, url);
        if (r && r.ok === true) {
          touchIfOwned(row.browser_profile_id, cfProfileId);
          return { opened: true, provider: "donut", url };
        }
      } catch (e) {
        if (process.env.CAREERFLOW_E2E_DISABLE_SYSTEM_FALLBACK === "1") {
          return { ok: false, reason: `e2e-openurl-throw:${e?.message || e}` };
        }
      }
      return systemFallback(url);
    },
  };
}
