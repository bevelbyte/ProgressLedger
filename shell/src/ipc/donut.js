import { safeHandle } from "../security/safe-handle.js";
// Donut integration IPC surface: sanitized connection status and the
// SubjectLinks open pipeline. Browser Manager CRUD/launch channels live in
// ./browser-manager.js; the shared collaborator graph built here is attached
// to ctx.donut so both registrars consume one source of truth.
//
// Renderer-visible results are fixed-shape and sanitized: bearer tokens,
// PIDs, ports, tokens and filesystem paths never cross.

import { ipcMain, shell } from "electron";
import { donutProvider } from "../services/donut.js";
import {
  createLinkOpener,
  makeDonutOpenViaApi,
  makeResolveProfileIdFromEnv,
} from "../services/donut-open.js";
import {
  createDonutMapper,
  makeDonutProfileApi,
  createBrowserBindingFlow,
  getBrowserBinding,
} from "../services/donut-mapping.js";
// -----------------------------------------------------------------------------
// Provider seam REMOVED (deliberate, during repository recovery).
//
// This module previously imported `createProviderFromContext` from
// `services/browser-provider/registry.js`. That abstraction was a generic
// BrowserEngine/BrowserProvider seam built so that Donut, Brave, Chrome, etc.
// could be swapped as interchangeable engines inside CareerFlow. That direction
// has been explicitly REJECTED:
//
//   * CareerFlow's browser is its OWN embedded Electron browser (WebContentsView).
//     It does not go through a provider interface and is not swappable.
//   * Donut is a separate, externally installed application. CareerFlow talks to
//     it only over its official Local API / officially supported remote
//     interface. It is not a CareerFlow browser engine.
//   * There is no Brave and no "add any browser" feature.
//
// So the registry module was not restored. The five `browser-provider:*` IPC
// channels registered below are kept ONLY so their wire shape does not silently
// change under existing callers. Nothing in the renderer, the preload bridge or
// the UI reads them (verified: zero consumers in preload.cjs and ui/src), so they
// are now served from a fixed connection-state object.
//
// Sibling registrars (cdp.js, browser-workspace.js) build their own adapters
// against `ctx.donut` directly. There is deliberately no `_attachAdapter` /
// `_attachWorkspace` seam any more: what is left of the provider surface is the
// fixed connection-state object below, which answers one question — "is the
// external Donut application reachable right now?" — and nothing else.
//
// NOTHING here changes the legitimate external-Donut functionality below:
// credential handling, authenticated profile listing, /run and /open-url all
// remain exactly as they were.
// -----------------------------------------------------------------------------
/**
 * Fixed connection-state surface replacing the removed provider seam.
 *
 * Deliberately NOT a generic engine interface: there is no registry, no
 * capability negotiation and no pluggable backend. It answers one question —
 * "is the external Donut application reachable right now?" — from the official
 * Local API connection status, and nothing more.
 */
function createExternalConnectionState(getStatus) {
  return {
    name: "donut-external",
    async connect() {
      const s = await getStatus();
      return { ok: true, state: s?.state ?? "unavailable", available: s?.available === true };
    },
    async disconnect() {
      // Connection-state only. disconnect() manages CareerFlow's CLIENT state
      // and MUST NOT stop Donut: an externally installed application is the
      // user's own process and is not CareerFlow's to shut down.
      return { ok: true, disconnected: true };
    },
    async getHealth() {
      const s = await getStatus();
      return { ok: true, available: s?.available === true, ready: s?.ready === true };
    },
    getState() {
      return "disconnected";
    },
    getCapabilities() {
      // Fixed, non-negotiable: external control only. No lifecycle ownership,
      // no integrated/windowed hosting, no engine substitution.
      return Object.freeze({
        externalControl: true,
        lifecycle: false,
        integratedHosting: false,
        providerControl: false,
      });
    },
  };
}

// Controlled E2E seam (same pattern as CAREERFLOW_E2E in main.js): with
// CAREERFLOW_E2E_DONUT_STUB=1 every Donut collaborator is replaced by an
// in-main-process hermetic fake, so Playwright can exercise the real handler
// paths without touching ports, processes or the user's system browser.
const E2E_STUB = process.env.CAREERFLOW_E2E_DONUT_STUB === "1";

const OK_STATUS = { available: true, ready: true, owned: true };
const DOWN_STATUS = { available: false, ready: false, owned: false };

export function register(ctx) {
  let opener;
  let mapper;
  let bindingFlow;
  let provider;
  let rec = null;

  if (E2E_STUB) {
    const mode = process.env.CAREERFLOW_E2E_DONUT_MODE || "donut-ok";
    const world = {
      // dedupe/unavailable boot with the backend down; everything else boots
      // healthy so the "healthy reuse" path sees zero start attempts.
      phase: ["dedupe", "unavailable"].includes(mode) ? "down" : "running",
      profiles: [], // {id, name} â€” stub backend profile table
      creations: 0,
    };
    rec = {
      donutOpens: [],
      donutTargets: [],
      systemOpens: [],
      donutRuns: [],
      cfProfileIds: [],
      donutProfileCreations: [],
      ensureStartedCalls: 0,
      stopCalls: 0,
      restartCalls: 0,
      runFails: mode === "run-fail",
      antiBurst: mode === "anti-burst",
      mode,
      // Browser Workspace (browser-workspace.js) writes its push-event log here
      // so Playwright can assert on the dock lifecycle without subscribing to
      // Electron webContents.send. Mirrors the production notify() channel.
      workspaceEvents: [],
      setPhase(p) { world.phase = p; },
      seedProfile(id, name) { world.profiles.push({ id, name }); },
      // Browser-workspace E2E helper: ensureBinding called from the workspace
      // layer reads the binding store via getBrowserBinding. The stub
      // recorder can be probed here to validate a localId was attempted.
      seededProfile(id, name) {
        world.profiles.push({ id, name });
        rec.donutProfileCreations.push(name);
      },
    };
    globalThis.__cfDonutE2E = rec;

    // ---- stub provider ----------------------------------------------------
    let starting = null;
    provider = {
      getStatus: async () => (world.phase === "running" ? OK_STATUS : DOWN_STATUS),
      ensureStarted: async () => {
        // Counted per REAL transition attempt (single-flight leader), not
        // per consultation â€” racing callers share one counted startup.
        if (world.phase === "running") return { ...OK_STATUS, state: "ready" };
        if (mode === "unavailable") {
          rec.ensureStartedCalls++;
          return { ...DOWN_STATUS, state: "unavailable" };
        }
        if (!starting) {
          rec.ensureStartedCalls++;
          starting = new Promise((resolve) =>
            setTimeout(() => {
              starting = null;
              world.phase = "running";
              resolve({ ...OK_STATUS, state: "ready" });
            }, 25)
          );
        }
        return starting;
      },
    };

    // ---- stub profile API (drives the REAL mapper/binding-flow logic) -----
    const downError = () => Object.assign(new Error("backend-down"), { status: 0 });
    const guardError = () =>
      Object.assign(
        new Error("Wayfern fingerprint generation temporarily unavailable"),
        { status: 400, body: "temporarily unavailable" }
      );
    const stubApi = {
      async listProfiles() {
        if (world.phase !== "running") throw downError();
        return world.profiles.map((p) => ({ ...p }));
      },
      async getProfile(id) {
        if (world.phase !== "running") throw downError();
        const found = world.profiles.find((p) => p.id === id);
        return found ? { ...found } : null; // 404 â†’ null
      },
      async createProfile(name) {
        if (world.phase !== "running") throw downError();
        if (rec.antiBurst) throw guardError();
        // All cf-<cfProfileId> aliases collapse onto one fixed e2e target;
        // managed browser bindings each get their own minted identity.
        const id = name.startsWith("cf-")
          ? "e2e-donut-profile"
          : `donut-${++world.creations}`;
        const existing = world.profiles.find((p) => p.id === id);
        if (existing) existing.name = name;
        else world.profiles.push({ id, name });
        rec.donutProfileCreations.push(name);
        return { profile: { id, name } };
      },
    };

    const fast = {
      budgetMs: 400,
      backoffMs: [20],
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 25))),
    };

    // In-memory mapping store so scenario state dies with the app instance.
    let memStore = {};
    mapper = createDonutMapper({
      api: stubApi,
      readStore: async () => ({ ...memStore }),
      writeStore: async (s) => { memStore = s; },
      ...fast,
    });
    bindingFlow = createBrowserBindingFlow({ api: stubApi, ...fast });

    opener = createLinkOpener({
      provider,
      resolveProfileId: () => ({ ok: true, id: "e2e-donut-profile" }),
      donutOpen: async ({ url }) => { rec.donutOpens.push(url); return { ok: true }; },
      systemOpen: async (url) => { rec.systemOpens.push(url); return true; },
    });
  } else {
    provider = donutProvider;
    const api = makeDonutProfileApi();
    mapper = createDonutMapper({ api });
    bindingFlow = createBrowserBindingFlow({ api });
    // No lifecycle: the official Donut app is the USER's process. CareerFlow
    // only connects to it — it never starts it, stops it, or classifies it as
    // owned/foreign/stale (the DBI-era ownership model is gone).
    opener = createLinkOpener({
      provider: donutProvider,
        resolveProfileId: makeResolveProfileIdFromEnv(process.env),
      donutOpen: makeDonutOpenViaApi(),
      systemOpen: async (url) => {
        try { await shell.openExternal(url); return true; }
        catch { return false; }
      },
    });
  }

  // Shared graph for sibling registrars (browser-manager.js, cdp.js).
  // browserProvider is the provider seam (Phase A/B): a DonutProvider built
  // by the registry from the SAME collaborators below. cdp.js and
  // browser-workspace.js attach their CDP adapter and workspace ops to it
  // after constructing them. The legacy surfaces stay authoritative for
  // existing IPC during this migration phase.
  ctx.donut = {
    provider,
    mapper,
    bindingFlow,
    // Forward cfProfileId so the binding store records ownership; the
    // profile-delete purge relies on this to drop only the bindings that
    // belong to the removed CF profile.
    ensureBinding: (localId, cfProfileId) =>
      bindingFlow.ensureBrowserBinding(localId, cfProfileId),
    // CDP adapter ownership gate: resolves a managed browser profile's
    // localId to the machine-local Donut profile UUID via the durable
    // binding store. Renderer-facing cdp:* channels are unusable without
    // this â€” every call fell back to "foreign-runtime" before it was wired.
    resolveOwnedRuntime: async (localId) => {
      const entry = await getBrowserBinding(String(localId ?? ""));
      if (!entry || typeof entry.donutProfileId !== "string") {
        return { ok: false, reason: "unknown-profile" };
      }
      return { ok: true, donutId: entry.donutProfileId };
    },
    stub: E2E_STUB,
    rec,
  };

  // Connection-state surface for the five `browser-provider:*` channels below.
  // Replaces the removed generic provider seam; see the note at the top of this
  // file. It is built directly from the official Donut Local API status
  // (`provider.getStatus`) and grants no lifecycle or hosting capability.
  const browserProvider = createExternalConnectionState(() => provider.getStatus());
  ctx.donut.browserProvider = browserProvider;

  safeHandle("donut:get-status", () => provider.getStatus());
  safeHandle("donut:ensure-started", () => provider.ensureStarted());

  // Provider connection model. connect()/disconnect() manage CareerFlow's
  // CLIENT connection only: disconnect() never stops a provider runtime and
  // never calls a shutdown endpoint — an externally running provider is not
  // CareerFlow's process to manage.
  safeHandle("browser-provider:connect", () => browserProvider.connect());
  safeHandle("browser-provider:disconnect", () => browserProvider.disconnect());
  safeHandle("browser-provider:health", () => browserProvider.getHealth());
  safeHandle("browser-provider:state", () => ({
    ok: true,
    state: browserProvider.getState(),
    provider: browserProvider.name,
  }));
  safeHandle("browser-provider:capabilities", () => ({
    ok: true,
    capabilities: browserProvider.getCapabilities(),
  }));

  // SubjectLinks â†’ Donut open-subject-link â†’ honest system fallback.
  safeHandle("donut:open-subject-link", async (_e, payload) => {
    const url = payload && typeof payload.url === "string" ? payload.url : "";
    const cfProfileId =
      payload && payload.profileId !== null && payload.profileId !== undefined
        ? String(payload.profileId)
        : null;


    // Without an explicit CareerFlow profile the opener resolves the target
    // itself (env-configured mapping); with one, ownership + mapping apply.
    if (cfProfileId === null) {
      return opener.openSubjectLink(url);
    }

    // Ownership gate against the real local database.
    let cfProfileExists = false;
    try {
      const list = await ctx.core.getProfiles();
      cfProfileExists = (Array.isArray(list) ? list : []).some(
        (p) => p && String(p.id) === cfProfileId
      );
    } catch {
      cfProfileExists = false;
    }
    if (!cfProfileExists) {
      return opener.openSubjectLink(url, { forceSystem: true });
    }

    let donutProfileId = null;
    try {
      donutProfileId = await mapper.ensureMapping(cfProfileId);
    } catch (e) {
      console.info("donut mapping unavailable:", e?.message ?? String(e));
      donutProfileId = null;
    }

    const res = await opener.openSubjectLink(
      url,
      donutProfileId ? { donutProfileId } : { forceSystem: true }
    );

    // E2E observation only: attribute the served open to its CareerFlow owner.
    if (E2E_STUB && res && res.opened === true && res.provider === "donut") {
      rec.cfProfileIds.push(cfProfileId);
      rec.donutTargets.push(donutProfileId);
    }
    return res;
  });
}
