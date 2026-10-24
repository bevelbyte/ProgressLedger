// Main-process-owned browser lifecycle and tab operations. Renderer-visible
// snapshots are sanitized: runtime credentials, ports, PIDs and filesystem
// paths never cross the IPC boundary.
//
// SCOPE. This is the Donut EXTERNAL-CONTROL surface: it launches and drives the
// user's separately installed Donut browser over the official Local API and the
// documented CDP path, and it owns no lifecycle of its own.
//
// `integrated` MODE IS RETIRED (approved decision C, 2026-10-07). That mode
// reparented a foreign Donut/Wayfern window into the CareerFlow window through
// the native `core.hostWindow` / `resizeHostedWindow` / `focusHostedWindow`
// hosting path - a foreign browser rendered as CareerFlow content, i.e. Donut as
// the CareerFlow browser engine. The CareerFlow browser is now its own
// WebContentsView (services/browser/host.js) and Donut is external control only.
// Launching with `mode: "integrated"` is REFUSED with `feature-not-supported`
// rather than silently downgraded, so a stale caller is told the truth instead
// of being handed a different surface than it asked for.
import { validateHttpUrl } from "./donut-manager.js";
import { sanitizeStatus } from "./donut.js";
export const E2E_STUB = process.env.CAREERFLOW_E2E_DONUT_STUB === "1";
const STATUS_REFRESH_MS = 2000;
const TAB_DISCOVERY_TIMEOUT_MS = 10000;
const TAB_DISCOVERY_POLL_MS = 100;
export const REASONS = Object.freeze({
  UNKNOWN_PROFILE: "unknown-profile",
  NOT_OWNED: "not-owned",
  DISABLED: "disabled",
  BACKEND_UNAVAILABLE: "backend-unavailable",
  INVALID_TAB: "invalid-tab",
  INVALID_URL: "invalid-url",
  BUSY: "busy",
  FEATURE_NOT_SUPPORTED: "feature-not-supported",
  CLOSED: "closed",
  RATE_LIMITED: "rate-limited",
});
export function readPayloadString(payload, key) {
  if (!payload || typeof payload !== "object") return null;
  const v = payload[key];
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v);
  return s.length > 0 ? s : null;
}
function sanitizeRendererUrl(value) {
  if (typeof value !== "string" || !value) return "";
  const hadExplicitRootPath = /^https?:\/\/[^/?#]+\/(?:[?#]|$)/i.test(value);
  try {
    const u = new URL(value);
    u.username = "";
    u.password = "";
    for (const key of [...u.searchParams.keys()]) {
      if (["token", "access_token", "api_key", "apikey", "secret", "secret_key", "password", "authorization"].includes(key.toLowerCase())) {
        u.searchParams.delete(key);
      }
    }
    u.hash = "";
    const serialized = u.toString();
    if (u.pathname === "/" && !u.search && !hadExplicitRootPath) {
      return serialized.slice(0, -1).slice(0, 4096);
    }
    return serialized.slice(0, 4096);
  } catch {
    return "";
  }
}
function fail(reason, extra) {
  return { ok: false, reason, ...(extra || {}) };
}
function tabInfo(t) {
  return {
    id: String(t?.id ?? ""),
    title: typeof t?.title === "string" ? t.title.slice(0, 4096) : "",
    url: sanitizeRendererUrl(t?.url),
    active: t?.active === true,
  };
}
function buildTabInfoFromList(tabs) {
  return Array.isArray(tabs) ? tabs.filter(Boolean).map(tabInfo) : [];
}
function pickFirstActiveTabId(tabs) {
  const active = (tabs || []).find((t) => t?.active === true);
  return active?.id ?? tabs?.[0]?.id ?? null;
}
function newWorkspaceState(now) {
  return {
    state: "closed",
    backend: null,
    profileLocalId: null,
    cfProfileId: null,
    mode: "separate",
    tabs: [],
    activeTabId: null,
    lastError: null,
    openedAt: null,
    updatedAt: now(),
  };
}
function buildSnapshot(state, now) {
  const st = state || newWorkspaceState(now);
  return {
    state: st.state || "closed",
    backend: st.backend || null,
    profileLocalId: st.profileLocalId || null,
    tabs: buildTabInfoFromList(st.tabs),
    activeTabId: st.activeTabId || null,
    lastError: st.lastError || null,
    openedAt: st.openedAt || null,
    updatedAt: st.updatedAt || null,
    mode: st.mode || "separate",
  };
}
export function createWorkspaceOps(deps) {
  const {
    donut,
    core,
    adapter,
    rec,
    transport,
    ensureOwnedBinding = null,
    authorizeBrowserProfile = null,
    probeBrowserLiveness = null,
    now = () => Date.now(),
    emit = () => {},
    setStatusTimer = () => {},
    focusSeparate = null,
  } = deps || {};
  if (!donut) throw new Error("createWorkspaceOps requires donut graph");
  if (!adapter || typeof adapter.openUrl !== "function")
    throw new Error("createWorkspaceOps requires cdp adapter");
  async function authorize(localId, cfId) {
    if (typeof authorizeBrowserProfile !== "function") return { ok: true };
    try {
      return (
        (await authorizeBrowserProfile(cfId, localId)) || {
          ok: false,
          reason: REASONS.NOT_OWNED,
        }
      );
    } catch {
      return { ok: false, reason: REASONS.NOT_OWNED };
    }
  }
  async function readTabsUntil(
    localId,
    cfId,
    waitForTarget = typeof probeBrowserLiveness === "function",
    desiredTabId = null,
  ) {
    let attempts = 0;
    const deadline = Date.now() + TAB_DISCOVERY_TIMEOUT_MS;
    for (;;) {
      attempts += 1;
      try {
        const result = await adapter.listTabs(localId, cfId);
        if (result?.ok) {
          const tabs = buildTabInfoFromList(result.tabs).map((tab) => ({
            ...tab,
            active: tab.active || (desiredTabId != null && String(tab.id) === String(desiredTabId)),
          }));
          const desiredFound =
            desiredTabId == null ||
            tabs.some((tab) => String(tab.id) === String(desiredTabId));
          if (
            desiredFound &&
            (tabs.length > 0 || Date.now() >= deadline)
          )
            return tabs;
          // Stub/unit transports may legitimately report an empty list or a
          // tab identifier that is not represented by their synthetic list.
          // Bound those calls after two observations; real transports pass
          // waitForTarget=true, so exact target identity is still mandatory.
          if (!waitForTarget && attempts >= 2) return tabs;
        } else if (!waitForTarget || Date.now() >= deadline) return [];
      } catch {
        if (!waitForTarget || Date.now() >= deadline) return [];
      }
      await new Promise((resolve) =>
        setTimeout(resolve, TAB_DISCOVERY_POLL_MS),
      );
    }
  }
  async function backendStatus() {
    try {
      return sanitizeStatus(await donut.provider.getStatus());
    } catch {
      return sanitizeStatus({
        state: "unavailable",
        available: false,
        ready: false,
        owned: false,
      });
    }
  }
  const launchInflight = new Map();
  const ops = {
    reasons: REASONS,
    async snapshot({ state } = {}) {
      if (state) this._state = state;
      return buildSnapshot(this._state, now);
    },
    async launchInternal({
      profileLocalId,
      cfProfileId,
      headless = false,
      mode = "separate",
    } = {}) {
      const localId = readPayloadString({ profileLocalId }, "profileLocalId");
      const cfId = readPayloadString({ cfProfileId }, "cfProfileId");
      if (localId === null || cfId === null)
        return fail(REASONS.UNKNOWN_PROFILE);
      // Retired before any collaborator is consulted: the refusal must not
      // create a binding, probe liveness or start a backend on its way out.
      if (String(mode) === "integrated")
        return fail(REASONS.FEATURE_NOT_SUPPORTED, { mode: "integrated" });
      let donutId = null;
      try {
        if (typeof ensureOwnedBinding === "function") {
          const r = await ensureOwnedBinding(localId, cfId);
          if (!r?.ok)
            return fail(
              r?.reason === "foreign-runtime"
                ? REASONS.UNKNOWN_PROFILE
                : r?.reason || REASONS.UNKNOWN_PROFILE,
            );
          donutId = r.donutId;
        } else if (typeof donut.resolveOwnedRuntime === "function") {
          const r = await donut.resolveOwnedRuntime(localId, cfId);
          if (!r?.ok)
            return fail(
              r?.reason === "foreign-runtime"
                ? REASONS.UNKNOWN_PROFILE
                : r?.reason || REASONS.UNKNOWN_PROFILE,
            );
          donutId = r.donutId;
        } else if (typeof donut.ensureBinding === "function")
          donutId = await donut.ensureBinding(localId, cfId);
      } catch {
        return fail(REASONS.BACKEND_UNAVAILABLE);
      }
      if (!donutId) return fail(REASONS.UNKNOWN_PROFILE);
      // Official connection gate: the provider runtime is the USER's Donut
      // app. ensureStarted() is a connect/probe — it never spawns — and the
      // sanitized status carries no ownership flags (the DBI owned/foreign
      // model is gone; availability + readiness are the contract).
      let backend;
      try {
        backend = donut.provider?.ensureStarted
          ? await donut.provider.ensureStarted()
          : await backendStatus();
      } catch {
        return fail(REASONS.BACKEND_UNAVAILABLE);
      }
      backend = sanitizeStatus(backend);
      if (!(backend?.available && backend?.ready))
        return fail(REASONS.BACKEND_UNAVAILABLE, { backend });
      // Only the two surviving modes are accepted; anything else falls back to
      // `separate`, which is what an unspecified launch has always meant.
      const effectiveMode = ["headless", "separate"].includes(String(mode))
        ? String(mode)
        : headless
          ? "headless"
          : "separate";
      const effectiveHeadless = effectiveMode === "headless";
      this._state = {
        ...newWorkspaceState(now),
        state: "launching",
        profileLocalId: localId,
        cfProfileId: cfId,
        mode: effectiveMode,
        backend,
        openedAt: now(),
        updatedAt: now(),
      };
      let alreadyRunning = false;
      if (typeof probeBrowserLiveness === "function") {
        try {
          const live = await probeBrowserLiveness(localId, cfId);
          alreadyRunning = live?.ok === true && live.running === true;
        } catch {}
      }
      let runOk = alreadyRunning;
      let runFailure = null;
      if (!alreadyRunning) {
        try {
          const r = await transport.run(donutId, {
            headless: effectiveHeadless,
          });
          runFailure = { status: Number(r?.status) || 0, error: typeof r?.error === "string" ? r.error : null };
          runOk =
            r?.ok === true ||
            (Number.isInteger(r?.status) && r.status >= 200 && r.status < 300);

          // Donut can retain a stale "already running" reservation briefly
          // after its Wayfern process has died. We already proved the mapped
          // browser is not live, so reconcile that exact owned profile rather
          // than reporting a permanent run failure. Never do this for a live
          // browser: a second liveness probe must remain false before the
          // ownership-scoped kill is attempted.
          if (!runOk && Number(r?.status) === 409 && typeof adapter.killBrowser === "function") {
            let confirmedStopped = true;
            let definitiveProbes = 0;
            for (let attempt = 0; attempt < 5; attempt += 1) {
              try {
                const live = await probeBrowserLiveness?.(localId, cfId);
                if (live?.ok !== true) {
                  confirmedStopped = false;
                  break;
                }
                if (live.running === true) {
                  confirmedStopped = false;
                  break;
                }
                definitiveProbes += 1;
              } catch {
                confirmedStopped = false;
                break;
              }
              if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 500));
            }
            if (confirmedStopped && definitiveProbes === 5) {
              const killed = typeof transport.kill === "function"
                ? await transport.kill(donutId).catch(() => ({ ok: false }))
                : await adapter.killBrowser(localId, cfId).catch(() => ({ ok: false }));
              if (killed?.ok === true) {
                const retry = await transport.run(donutId, { headless: effectiveHeadless });
                runFailure = { status: Number(retry?.status) || 0, error: typeof retry?.error === "string" ? retry.error : null };
                runOk = retry?.ok === true || (Number.isInteger(retry?.status) && retry.status >= 200 && retry.status < 300);
              } else {
                console.error("careerflow stale browser recovery kill failed", {
                  profileLocalId: localId,
                  cfProfileId: cfId,
                  status: Number(killed?.status) || 0,
                  error: typeof killed?.error === "string" ? killed.error : null,
                });
              }
            } else if (!confirmedStopped) {
              // A failed/unknown liveness probe is not evidence that the
              // browser is stopped. Fail closed rather than risking an
              // ownership-scoped kill of a live browser.
              console.error("careerflow stale browser recovery liveness inconclusive", {
                profileLocalId: localId,
                cfProfileId: cfId,
              });
            }
          }
        } catch {
          runOk = false;
        }
      }
      if (!runOk) {
        // A failed /run can still have left a live browser behind — but ONLY in
        // one specific, provable case.
        //
        // `/run` is an HTTP request to Donut. When CareerFlow's transport budget
        // expires the request is ABORTED CLIENT-SIDE, and aborting an HTTP
        // request does not undo work the server has already done: Donut may
        // already have launched Wayfern and still be finishing fingerprint
        // setup, CDP-socket binding and profile bookkeeping. Measured on the
        // real-Donut matrix: orphaned Donut backends and Wayfern processes then
        // accumulated until a later run could not obtain an owned backend at
        // all (`backend-unavailable` with `"backend": null`).
        //
        // THE SCOPE IS DELIBERATELY NARROW, and two existing security tests
        // define its edge. When Donut answers with a real HTTP status, there is
        // no unknown server-side work to clean up, and — critically — the 409
        // path deliberately REFUSES to kill whenever liveness is inconclusive
        // or reports a live browser, precisely so a live browser is never killed
        // on a guess. An unconditional teardown here would silently overturn
        // that fail-closed rule; the suite caught exactly that.
        //
        // So the teardown fires only for a genuinely INDETERMINATE transport
        // failure: no HTTP status was ever received, and the reason is a
        // transport error. That is the one case where the client provably
        // cannot know what the server did.
        //
        // SAFETY
        //   * Unreachable when `alreadyRunning` — `runOk` is initialised from it.
        //   * `killBrowser` resolves through the same ownership gate
        //     (`resolveOrReject`) as every other CDP operation, so it fails
        //     closed with NOT_OWNED and can only ever target the browser
        //     CareerFlow owns for this exact (cfProfileId, localId) pair.
        //   * Best-effort, like its sibling paths: a backend that is already
        //     down makes this a no-op rather than a second failure.
        const indeterminateTransportFailure =
          !alreadyRunning &&
          Number(runFailure?.status) === 0 &&
          typeof runFailure?.error === "string" &&
          runFailure.error.startsWith("transport:");
        if (indeterminateTransportFailure) {
          await adapter.killBrowser?.(localId, cfId).catch(() => {});
        }
        this._state = {
          ...this._state,
          state: "closed",
          lastError: "run-failed",
          updatedAt: now(),
        };
        if (rec)
          rec.workspaceEvents = (rec.workspaceEvents || []).concat([
            { kind: "launch-failed", profileLocalId: localId, at: now() },
          ]);
        emit({ kind: "launch-failed", profileLocalId: localId });
        return fail("run-failed", { backend, runFailure });
      }
      const tabs = await readTabsUntil(
        localId,
        cfId,
        !alreadyRunning && typeof probeBrowserLiveness === "function",
      );
      if (
        effectiveMode === "separate" &&
        !alreadyRunning &&
        typeof focusSeparate === "function"
      ) {
        const focused = await focusSeparate(localId, cfId).catch(() => false);
        if (focused !== true) {
          await adapter.killBrowser?.(localId, cfId).catch(() => {});
          this._state = {
            ...this._state,
            state: "stopped",
            lastError: "separate-focus-failed",
            updatedAt: now(),
          };
          return fail("separate-focus-failed");
        }
      }
      this._state = {
        ...this._state,
        state: "ready",
        tabs,
        activeTabId: pickFirstActiveTabId(tabs),
        lastError: null,
        updatedAt: now(),
      };
      if (rec)
        rec.workspaceEvents = (rec.workspaceEvents || []).concat([
          {
            kind: "launched",
            profileLocalId: localId,
            headless: effectiveHeadless,
            mode: effectiveMode,
            at: now(),
          },
        ]);
      setStatusTimer(STATUS_REFRESH_MS);
      emit({ kind: "launched", profileLocalId: localId });
      return { ok: true, workspace: buildSnapshot(this._state, now) };
    },
    async launch(args = {}) {
      const localId = readPayloadString(args, "profileLocalId");
      const cfId = readPayloadString(args, "cfProfileId");
      if (localId === null || cfId === null) return this.launchInternal(args);
      const key = `${cfId}\u0000${localId}`;
      const existing = launchInflight.get(key);
      if (existing) return existing;
      const pending = this.launchInternal(args);
      launchInflight.set(key, pending);
      try {
        return await pending;
      } finally {
        if (launchInflight.get(key) === pending) launchInflight.delete(key);
      }
    },
    async stop({ profileLocalId, cfProfileId } = {}) {
      const st = this._state || newWorkspaceState(now);
      setStatusTimer(null);
      const stopLocalId = profileLocalId || st.profileLocalId;
      const stopCfId = cfProfileId || st.cfProfileId;
      if (stopLocalId) {
        const killed = typeof adapter.killBrowser === "function"
          ? await adapter.killBrowser(stopLocalId, stopCfId).catch(() => ({ ok: false, reason: "kill-failed" }))
          : { ok: true };
        if (killed?.ok !== true) {
          this._state = {
            ...st,
            state: "stopped",
            tabs: [],
            activeTabId: null,
            lastError: killed?.reason || "kill-failed",
            updatedAt: now(),
          };
          return fail(killed?.reason || "kill-failed");
        }
        if (typeof probeBrowserLiveness === "function") {
          const deadline = Date.now() + 15_000;
          for (;;) {
            let live = null;
            try { live = await probeBrowserLiveness(stopLocalId, stopCfId); } catch {}
            if (live?.ok === true && live.running !== true) break;
            if (live?.ok !== true && Date.now() >= deadline) {
              this._state = {
                ...st,
                state: "ready",
                lastError: "browser-stop-unverified",
                updatedAt: now(),
              };
              return fail("browser-stop-unverified");
            }
            if (Date.now() >= deadline) {
              this._state = {
                ...st,
                state: "ready",
                lastError: "browser-stop-timeout",
                updatedAt: now(),
              };
              return fail("browser-stop-timeout");
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      }
      this._state = {
        ...st,
        state: "stopped",
        tabs: [],
        activeTabId: null,
        updatedAt: now(),
      };
      if (rec)
        rec.workspaceEvents = (rec.workspaceEvents || []).concat([
          { kind: "stopped", at: now() },
        ]);
      emit({ kind: "stopped" });
      return { ok: true };
    },
    async reconcile() {
      const st = this._state || newWorkspaceState(now);
      if (st.state !== "ready" || !st.profileLocalId)
        return { changed: false, workspace: buildSnapshot(st, now) };
      let live = true;
      if (typeof probeBrowserLiveness === "function") {
        try {
          const r = await probeBrowserLiveness(
            st.profileLocalId,
            st.cfProfileId,
          );
          live = r?.ok === true && r.running === true;
        } catch {
          live = false;
        }
      }
      if (!live) {
        this._state = {
          ...st,
          state: "stopped",
          lastError: "browser-closed",
          updatedAt: now(),
        };
        setStatusTimer(null);
        emit({ kind: "browser-closed" });
        return { changed: true, workspace: buildSnapshot(this._state, now) };
      }
      const tabs = await readTabsUntil(st.profileLocalId, st.cfProfileId);
      const active = pickFirstActiveTabId(tabs);
      this._state = {
        ...st,
        tabs,
        activeTabId: active || st.activeTabId,
        updatedAt: now(),
      };
      return { changed: true, workspace: buildSnapshot(this._state, now) };
    },
    async navigate({ profileLocalId, cfProfileId, url } = {}) {
      const localId = readPayloadString({ profileLocalId }, "profileLocalId");
      const cfId = readPayloadString({ cfProfileId }, "cfProfileId");
      if (!localId || !cfId) return fail(REASONS.UNKNOWN_PROFILE);
      if (!validateHttpUrl(url)) return fail(REASONS.INVALID_URL);
      const auth = await authorize(localId, cfId);
      if (!auth.ok) return fail(auth.reason || REASONS.NOT_OWNED);
      const res = await adapter.openUrl(localId, cfId, url);
      if (!res?.ok) {
        emit({ kind: "navigate-failed", reason: res?.reason });
        return res;
      }
      if (
        this._state?.mode === "separate" &&
        typeof focusSeparate === "function"
      ) {
        const focused = await focusSeparate(localId, cfId).catch(() => false);
        if (focused !== true) return fail("focus-failed");
      }
      const tabs = await readTabsUntil(localId, cfId, typeof probeBrowserLiveness === "function", res.tabId);
      this._state = {
        ...(this._state || newWorkspaceState(now)),
        tabs,
        activeTabId: pickFirstActiveTabId(tabs),
        updatedAt: now(),
      };
      emit({ kind: "navigated", profileLocalId: localId, url: sanitizeRendererUrl(url) });
      return { ok: true };
    },
    async newTab({ profileLocalId, cfProfileId } = {}) {
      const localId = readPayloadString({ profileLocalId }, "profileLocalId");
      const cfId = readPayloadString({ cfProfileId }, "cfProfileId");
      if (!localId || !cfId) return fail(REASONS.UNKNOWN_PROFILE);
      const auth = await authorize(localId, cfId);
      if (!auth.ok) return fail(auth.reason || REASONS.NOT_OWNED);
      const res = await adapter.createTab(localId, cfId);
      if (!res?.ok) return res;
      const tabs = await readTabsUntil(localId, cfId, typeof probeBrowserLiveness === "function", res.tabId);
      this._state = {
        ...(this._state || newWorkspaceState(now)),
        tabs,
        activeTabId: pickFirstActiveTabId(tabs),
        updatedAt: now(),
      };
      emit({ kind: "new-tab", tabId: res.tabId });
      return { ok: true, tabId: res.tabId };
    },
    async closeTab({ profileLocalId, cfProfileId, tabId } = {}) {
      const localId = readPayloadString({ profileLocalId }, "profileLocalId");
      const cfId = readPayloadString({ cfProfileId }, "cfProfileId");
      const tId = readPayloadString({ tabId }, "tabId");
      if (!localId || !cfId) return fail(REASONS.UNKNOWN_PROFILE);
      if (!tId) return fail(REASONS.INVALID_TAB);
      const auth = await authorize(localId, cfId);
      if (!auth.ok) return fail(auth.reason || REASONS.NOT_OWNED);
      const res = await adapter.closeTab(localId, cfId, tId);
      if (!res?.ok) return res;
      const tabs = await readTabsUntil(localId, cfId, typeof probeBrowserLiveness === "function", res.tabId);
      this._state = {
        ...(this._state || newWorkspaceState(now)),
        tabs,
        activeTabId: pickFirstActiveTabId(tabs),
        updatedAt: now(),
      };
      emit({ kind: "close-tab", tabId: tId });
      return { ok: true };
    },
    async activateTab({ profileLocalId, cfProfileId, tabId } = {}) {
      const localId = readPayloadString({ profileLocalId }, "profileLocalId");
      const cfId = readPayloadString({ cfProfileId }, "cfProfileId");
      const tId = readPayloadString({ tabId }, "tabId");
      if (!localId || !cfId) return fail(REASONS.UNKNOWN_PROFILE);
      if (!tId) return fail(REASONS.INVALID_TAB);
      const auth = await authorize(localId, cfId);
      if (!auth.ok) return fail(auth.reason || REASONS.NOT_OWNED);
      const res = await adapter.activateTab(localId, cfId, tId);
      if (!res?.ok) return res;
      const tabs = await readTabsUntil(localId, cfId, typeof probeBrowserLiveness === "function", res.tabId);
      this._state = {
        ...(this._state || newWorkspaceState(now)),
        tabs: tabs.length
          ? tabs
          : (this._state?.tabs || []).map((t) => ({
              ...t,
              active: t.id === tId,
            })),
        activeTabId: tId,
        updatedAt: now(),
      };
      emit({ kind: "activate-tab", tabId: tId });
      return { ok: true };
    },
    async reload({ profileLocalId, cfProfileId, tabId } = {}) {
      const localId = readPayloadString({ profileLocalId }, "profileLocalId");
      const cfId = readPayloadString({ cfProfileId }, "cfProfileId");
      const tId = readPayloadString({ tabId }, "tabId");
      if (!localId || !cfId) return fail(REASONS.UNKNOWN_PROFILE);
      if (!tId) return fail(REASONS.INVALID_TAB);
      const auth = await authorize(localId, cfId);
      if (!auth.ok) return fail(auth.reason || REASONS.NOT_OWNED);
      if (typeof adapter.reload !== "function")
        return fail(REASONS.FEATURE_NOT_SUPPORTED);
      const res = await adapter.reload(localId, cfId, tId);
      if (!res?.ok) return res;
      const tabs = await readTabsUntil(localId, cfId, typeof probeBrowserLiveness === "function", tId);
      this._state = {
        ...(this._state || newWorkspaceState(now)),
        tabs,
        activeTabId: pickFirstActiveTabId(tabs) || this._state?.activeTabId || tId,
        updatedAt: now(),
      };
      emit({ kind: "reloaded", tabId: tId });
      return { ok: true };
    },
    async back({ profileLocalId, cfProfileId, tabId } = {}) {
      return this._historyOp("back", profileLocalId, cfProfileId, tabId);
    },
    async forward({ profileLocalId, cfProfileId, tabId } = {}) {
      return this._historyOp("forward", profileLocalId, cfProfileId, tabId);
    },
    async screenshot({ profileLocalId, cfProfileId, tabId } = {}) {
      const localId = readPayloadString({ profileLocalId }, "profileLocalId");
      const cfId = readPayloadString({ cfProfileId }, "cfProfileId");
      const tId = readPayloadString({ tabId }, "tabId");
      if (!localId || !cfId) return fail(REASONS.UNKNOWN_PROFILE);
      if (!tId) return fail(REASONS.INVALID_TAB);
      const auth = await authorize(localId, cfId);
      if (!auth.ok) return fail(auth.reason || REASONS.NOT_OWNED);
      const res = await adapter.screenshot(localId, cfId, tId);
      if (!res?.ok) return res;
      return { ok: true, image: res.image };
    },

    // ---- Agent browser-interaction passthroughs ---------------------------
    // Thin main-process wrappers around the adapter's page primitives.
    // Every call re-verifies profile ownership (authorize) and passes the
    // run's cancellation signal through so waits/evals abort with the run.
    // Arguments are validated inside the adapter; no renderer-visible state
    // is produced here (tool results go back through the agent loop only).

    async getPageText({ profileLocalId, cfProfileId, tabId, signal } = {}) {
      const localId = readPayloadString({ profileLocalId }, "profileLocalId");
      const cfId = readPayloadString({ cfProfileId }, "cfProfileId");
      const tId = readPayloadString({ tabId }, "tabId");
      if (!localId || !cfId) return fail(REASONS.UNKNOWN_PROFILE);
      if (!tId) return fail(REASONS.INVALID_TAB);
      const auth = await authorize(localId, cfId);
      if (!auth.ok) return fail(auth.reason || REASONS.NOT_OWNED);
      return adapter.browserGetPageText(localId, cfId, tId, { signal });
    },

    async extractText({ profileLocalId, cfProfileId, tabId, selector, signal } = {}) {
      const localId = readPayloadString({ profileLocalId }, "profileLocalId");
      const cfId = readPayloadString({ cfProfileId }, "cfProfileId");
      const tId = readPayloadString({ tabId }, "tabId");
      if (!localId || !cfId) return fail(REASONS.UNKNOWN_PROFILE);
      if (!tId) return fail(REASONS.INVALID_TAB);
      const auth = await authorize(localId, cfId);
      if (!auth.ok) return fail(auth.reason || REASONS.NOT_OWNED);
      return adapter.browserExtractText(localId, cfId, tId, selector, { signal });
    },

    async click({ profileLocalId, cfProfileId, tabId, selector, signal } = {}) {
      const localId = readPayloadString({ profileLocalId }, "profileLocalId");
      const cfId = readPayloadString({ cfProfileId }, "cfProfileId");
      const tId = readPayloadString({ tabId }, "tabId");
      if (!localId || !cfId) return fail(REASONS.UNKNOWN_PROFILE);
      if (!tId) return fail(REASONS.INVALID_TAB);
      const auth = await authorize(localId, cfId);
      if (!auth.ok) return fail(auth.reason || REASONS.NOT_OWNED);
      return adapter.browserClick(localId, cfId, tId, selector, { signal });
    },

    async typeText({ profileLocalId, cfProfileId, tabId, selector, text, signal } = {}) {
      const localId = readPayloadString({ profileLocalId }, "profileLocalId");
      const cfId = readPayloadString({ cfProfileId }, "cfProfileId");
      const tId = readPayloadString({ tabId }, "tabId");
      if (!localId || !cfId) return fail(REASONS.UNKNOWN_PROFILE);
      if (!tId) return fail(REASONS.INVALID_TAB);
      const auth = await authorize(localId, cfId);
      if (!auth.ok) return fail(auth.reason || REASONS.NOT_OWNED);
      return adapter.browserType(localId, cfId, tId, selector, text, { signal });
    },

    async pressKey({ profileLocalId, cfProfileId, tabId, key, signal } = {}) {
      const localId = readPayloadString({ profileLocalId }, "profileLocalId");
      const cfId = readPayloadString({ cfProfileId }, "cfProfileId");
      const tId = readPayloadString({ tabId }, "tabId");
      if (!localId || !cfId) return fail(REASONS.UNKNOWN_PROFILE);
      if (!tId) return fail(REASONS.INVALID_TAB);
      const auth = await authorize(localId, cfId);
      if (!auth.ok) return fail(auth.reason || REASONS.NOT_OWNED);
      return adapter.browserPressKey(localId, cfId, tId, key, { signal });
    },

    async waitFor({ profileLocalId, cfProfileId, tabId, selector, ms, signal } = {}) {
      const localId = readPayloadString({ profileLocalId }, "profileLocalId");
      const cfId = readPayloadString({ cfProfileId }, "cfProfileId");
      const tId = readPayloadString({ tabId }, "tabId");
      if (!localId || !cfId) return fail(REASONS.UNKNOWN_PROFILE);
      if (!tId) return fail(REASONS.INVALID_TAB);
      const auth = await authorize(localId, cfId);
      if (!auth.ok) return fail(auth.reason || REASONS.NOT_OWNED);
      return adapter.browserWaitForSelector(localId, cfId, tId, selector, ms, { signal });
    },
    async subscribe() {
      return {
        ok: true,
        workspace: buildSnapshot(this._state || newWorkspaceState(now), now),
      };
    },
  };
  ops._historyOp = async function (kind, localId0, cfId0, tabId0) {
    const localId = readPayloadString(
      { profileLocalId: localId0 },
      "profileLocalId",
    );
    const cfId = readPayloadString({ cfProfileId: cfId0 }, "cfProfileId");
    const tId = readPayloadString({ tabId: tabId0 }, "tabId");
    if (!localId || !cfId) return fail(REASONS.UNKNOWN_PROFILE);
    if (!tId) return fail(REASONS.INVALID_TAB);
    const auth = await authorize(localId, cfId);
    if (!auth.ok) return fail(auth.reason || REASONS.NOT_OWNED);
    if (typeof adapter[kind] !== "function")
      return fail(REASONS.FEATURE_NOT_SUPPORTED);
    const res = await adapter[kind](localId, cfId, tId);
    if (!res?.ok) return res;
    const tabs = await readTabsUntil(localId, cfId, typeof probeBrowserLiveness === "function", tId);
    this._state = {
      ...(this._state || newWorkspaceState(now)),
      tabs,
      activeTabId: pickFirstActiveTabId(tabs) || this._state?.activeTabId || tId,
      updatedAt: now(),
    };
    emit({ kind: `history-${kind}`, tabId: tId });
    return { ok: true };
  };
  ops._state = newWorkspaceState(now);
  return ops;
}
