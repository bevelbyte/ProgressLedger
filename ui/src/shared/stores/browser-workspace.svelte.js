// External-Donut-control state mirror (shared renderer store).
//
// C2 (plan Phase 7, 2026-10-08): the BrowserWorkspaceDock this store once
// drove is RETIRED. The store itself is NOT dock-only and was never only
// dock UI: the Research console's live-workspace and operator-activity
// readouts read this same state, and the backend it fronts is the APPROVED
// external-control surface
// (browser-workspace-tools.js -> browser-workspace.js -> cdp-adapter ->
// Donut Local API + CDP), which C2 must not touch. What remains here is the
// sanitized state mirror (status / tabs / activity / backend facts) plus the
// launch / navigate / tab / screenshot actions, driven from the Research
// console. The renderer NEVER receives ports, tokens, PIDs or paths: the
// IPC layer sanitizes every result.
//
// IPC contract (preload.cjs / shell/src/ipc/browser-workspace.js):
//   launch(profileLocalId, cfProfileId) → { ok, workspace? }
//   state()                             → sanitized snapshot { state, backend,
//                                          profileLocalId, tabs, activeTabId, ... }
//   navigate(profileLocalId, cfProfileId, url) → { ok } | { ok:false, reason }
//   newTab(profileLocalId, cfProfileId)        → { ok, tabId? }
//   closeTab(profileLocalId, cfProfileId, tabId) → { ok } | { ok:false, reason }
//   activateTab(profileLocalId, cfProfileId, tabId) → { ok } | { ok:false, reason }
//   reload(profileLocalId, cfProfileId, tabId) → { ok:false, reason: "feature-not-supported" }
//   screenshot(profileLocalId, cfProfileId, tabId) → { ok, image?: { dataUrl, ... } }
//   stop()                              → { ok }
//   onEvent(cb)                         → unsubscribe fn; events have a `kind`
//                                          field (launched / navigated / ...)
//
// Tabs in snapshots are { id, title, url, active }; the store normalizes
// them to { tabId, title, url, loading, active } for the dock.
//
// Persistence: open + width + active profileLocalId survive route changes
// and reloads via localStorage. The dock stays mounted across currentView
// changes (App.svelte renders it outside the view switch), so this
// module-scoped store is the single source of truth.

import { profileStore } from "../../features/profiles/stores/profile.svelte.js";

const STORAGE_KEY_OPEN = "cf.browserWorkspace.open";
const STORAGE_KEY_WIDTH = "cf.browserWorkspace.width";
const STORAGE_KEY_PROFILE = "cf.browserWorkspace.activeProfileLocalId";

const MIN_WIDTH = 280;
const MAX_WIDTH = 760;
const NARROW = 320;
const MEDIUM = 480;
const WIDE = 640;

/** Read a JSON-encoded localStorage value, falling back to a default. */
function readJson(key, fallback) {
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** Best-effort localStorage write — never throws. */
function writeJson(key, value) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode — ignored */
  }
}

function clampWidth(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return MEDIUM;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(v)));
}

export const browserWorkspace = $state({
  open: readJson(STORAGE_KEY_OPEN, false),
  width: clampWidth(readJson(STORAGE_KEY_WIDTH, MEDIUM)),
  status: "idle", // "idle" | "launching" | "ready" | "error" | "closed"
  tabs: [], // [{ tabId, title, url, loading, active }]
  activeTabId: null,
  lastError: null,
  backendState: null, // sanitized snapshot from browserWorkspace.state()
  activeProfileLocalId: readJson(STORAGE_KEY_PROFILE, null),
  mode: "separate",

  // Capability flags — derived from what the IPC surface actually supports.
  // Honest degradation: back/forward/reload stay disabled until the backend
  // supports them; the screenshot button is enabled once the namespace exists.
  canGoBack: false,
  canGoForward: false,
  canReload: false,
  canScreenshot: true,

  // Latest screenshot data URL (sanitized by IPC) for the preview pane.
  screenshotDataUrl: null,
  screenshotAt: null, // ms epoch when last captured
  screenshotError: null,

  // Bounded, newest-first trace of what actually happened in the browser.
  // Fed only by real pushed events (launched / navigated / new-tab / failures
  // / stopped), never synthesised: if the backend is in polling mode and
  // pushes nothing, the list stays honestly empty.
  activity: [],

  // Subscription bookkeeping — set while the dock is open, cleared when closed.
  _unsubscribe: null,

  // Auto-launch guard: the dock restores the persisted workspace once per
  // open cycle; the user takes over after that (launch / stop buttons).
  _autoLaunchAttempted: false,
});

/** Width presets exposed to the UI. */
export const BROWSER_WORKSPACE_WIDTHS = {
  narrow: NARROW,
  medium: MEDIUM,
  wide: WIDE,
  min: MIN_WIDTH,
  max: MAX_WIDTH,
};

// ---- Persistence helpers ----

function persistOpen(value) {
  writeJson(STORAGE_KEY_OPEN, Boolean(value));
}
function persistWidth(value) {
  writeJson(STORAGE_KEY_WIDTH, clampWidth(value));
}
function persistProfile(value) {
  writeJson(STORAGE_KEY_PROFILE, value ?? null);
}

// ---- Low-level IPC access ----

function ipc() {
  return (typeof window !== "undefined" && window.careerflow) || {};
}

function ipcWorkspace() {
  return ipc().browserWorkspace || null;
}

/** Active CareerFlow profile id (number) or null — used as cfProfileId. */
function activeCfProfileId() {
  if (profileStore.activeProfile != null && profileStore.activeProfile.id != null) {
    return Number(profileStore.activeProfile.id);
  }
  if (profileStore.activeProfileId != null) return Number(profileStore.activeProfileId);
  return null;
}

// ---- Tab normalization (snapshot { id,title,url,active } → dock shape) ----

function normalizeTab(t) {
  return {
    tabId: String(t?.tabId ?? t?.id ?? ""),
    title: String(t?.title ?? t?.url ?? "Tab"),
    url: String(t?.url ?? ""),
    loading: Boolean(t?.loading),
    active: Boolean(t?.active),
  };
}

function applySnapshot(snap) {
  if (!snap || typeof snap !== "object") return;
  browserWorkspace.backendState = snap;
  browserWorkspace.status = mapStatus(snap.state);
  if (Array.isArray(snap.tabs)) {
    browserWorkspace.tabs = snap.tabs.map(normalizeTab);
    const active = browserWorkspace.tabs.find((t) => t.active);
    const stillActive = browserWorkspace.tabs.find((t) => t.tabId === browserWorkspace.activeTabId);
    browserWorkspace.activeTabId = active?.tabId ?? stillActive?.tabId ?? browserWorkspace.tabs[0]?.tabId ?? null;
  }
  if (snap.activeTabId != null) browserWorkspace.activeTabId = String(snap.activeTabId);
  if (snap.profileLocalId != null) {
    browserWorkspace.activeProfileLocalId = String(snap.profileLocalId);
    persistProfile(browserWorkspace.activeProfileLocalId);
  }
  browserWorkspace.lastError = snap.lastError ?? null;
  // Capability flags: honest, derived from the namespace surface.
  const ws = ipcWorkspace();
  browserWorkspace.canScreenshot = !!(ws && typeof ws.screenshot === "function");
  browserWorkspace.canReload = !!(ws && typeof ws.reload === "function" && browserWorkspace.activeTabId);
  browserWorkspace.canGoBack = !!(ws && typeof ws.back === "function" && browserWorkspace.activeTabId);
  browserWorkspace.canGoForward = !!(ws && typeof ws.forward === "function" && browserWorkspace.activeTabId);
}

function mapStatus(s) {
  if (s == null) return "idle";
  const v = String(s);
  if (v === "launching" || v === "starting") return "launching";
  if (v === "ready" || v === "running" || v === "owned-running") return "ready";
  if (v === "closed" || v === "stopped" || v === "owned-not-running") return "closed";
  if (v === "error" || v === "failed") return "error";
  return v;
}

// ---- Subscription wiring ----

function startSubscription() {
  if (browserWorkspace._unsubscribe) return;
  const ws = ipcWorkspace();
  if (!ws || typeof ws.onEvent !== "function") return;
  try {
    const off = ws.onEvent((evt) => handleWorkspaceEvent(evt));
    browserWorkspace._unsubscribe = typeof off === "function" ? off : null;
  } catch (e) {
    // If subscription fails the dock still works in polling mode via refresh().
    console.warn("browserWorkspace subscription failed:", e);
  }
}

function stopSubscription() {
  const off = browserWorkspace._unsubscribe;
  browserWorkspace._unsubscribe = null;
  if (typeof off === "function") {
    try {
      off();
    } catch {
      /* noop */
    }
  }
}

/**
 * Apply a single pushed event to the local store. Events carry a `kind`
 * (launched / launch-failed / navigated / new-tab / close-tab / ...).
 * Mutations re-sync via refresh() so the store never invents tab state.
 */
/** Cap on the retained trace. Enough to explain "what happened", small
 *  enough that it can never be mistaken for an audit log. */
const ACTIVITY_LIMIT = 40;

function recordActivity(kind, detail) {
  browserWorkspace.activity = [
    { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind, detail: detail || "", at: Date.now() },
    ...browserWorkspace.activity,
  ].slice(0, ACTIVITY_LIMIT);
}

function handleWorkspaceEvent(evt) {
  if (!evt || typeof evt !== "object") return;
  recordActivity(evt.kind, evt.url || evt.reason || evt.message || evt.title || "");
  switch (evt.kind) {
    case "launched":
    case "navigated":
    case "new-tab":
    case "close-tab":
    case "activate-tab":
      browserWorkspace.lastError = null;
      void refresh();
      break;
    case "launch-failed":
    case "navigate-failed":
    case "new-tab-failed":
    case "close-tab-failed":
    case "activate-tab-failed":
    case "screenshot-failed":
    case "reload-unsupported":
      browserWorkspace.status = browserWorkspace.status === "ready" ? "ready" : "error";
      browserWorkspace.lastError = String(evt.reason ?? "browser-workspace-error");
      break;
    case "stopped":
      browserWorkspace.status = "closed";
      void refresh();
      break;
    case "status-tick":
      if (evt.backend) browserWorkspace.backendState = { ...(browserWorkspace.backendState || {}), backend: evt.backend };
      break;
    case "error":
      browserWorkspace.lastError = String(evt.message ?? evt.error ?? "Browser error");
      break;
    default:
      // Unknown event kinds are ignored — forward-compat.
      break;
  }
}

// ---- Public actions ----

export function open(autoLaunch = true) {
  if (browserWorkspace.open) {
    startSubscription();
    return;
  }
  browserWorkspace.open = true;
  persistOpen(true);
  startSubscription();
  // Refresh state lazily; if nothing is running, restore the persisted
  // workspace (auto-launch). Failures surface as the dock's error state —
  // the launch button takes over from there.
  void refresh().then((snap) => {
    const status = snap && snap.state != null ? String(snap.state) : browserWorkspace.status;
    if (autoLaunch && status !== "ready" && status !== "launching" && !browserWorkspace._autoLaunchAttempted) {
      browserWorkspace._autoLaunchAttempted = true;
      launch().catch(() => {
        /* dock shows the error state + launch button */
      });
    }
  });
}

export function close() {
  if (!browserWorkspace.open) return;
  browserWorkspace.open = false;
  persistOpen(false);
  stopSubscription();
}

export function toggle() {
  if (browserWorkspace.open) close();
  else open();
}

export function setWidth(value) {
  browserWorkspace.width = clampWidth(value);
  persistWidth(browserWorkspace.width);
}

export function setWidthPreset(name) {
  const w = BROWSER_WORKSPACE_WIDTHS[name];
  if (typeof w === "number") setWidth(w);
}

/** Poll the main process for the current sanitized snapshot. */
export async function refresh() {
  const ws = ipcWorkspace();
  if (!ws || typeof ws.state !== "function") return null;
  try {
    const s = await ws.state();
    applySnapshot(s);
    return s;
  } catch (e) {
    browserWorkspace.lastError = String(e?.message ?? e);
    return null;
  }
}

/**
 * Launch a browser profile in the dock. Resolution order:
 *   1. explicit profileLocalId
 *   2. last-used profileLocalId (persisted across reloads)
 *   3. first managed browser profile of the active CareerFlow profile
 * The CareerFlow profile id is always passed as cfProfileId so the main
 * process can enforce ownership — a renderer cannot launch a profile it
 * doesn't own.
 */
export async function launch(profileLocalId = null, cfProfileId = null, mode = "separate") {
  const ws = ipcWorkspace();
  if (!ws || typeof ws.launch !== "function") {
    browserWorkspace.lastError = "Browser workspace IPC not available";
    throw Object.assign(new Error("not-available"), { reason: "not-available" });
  }
  const cfId = cfProfileId ?? activeCfProfileId();
  let id = profileLocalId ?? browserWorkspace.activeProfileLocalId ?? null;
  if (id == null && cfId != null && ipc().browserManager && typeof ipc().browserManager.list === "function") {
    // Auto-pick the first managed browser profile of the active CF profile.
    try {
      const list = await ipc().browserManager.list(cfId);
      if (Array.isArray(list) && list.length > 0 && list[0].localId != null) {
        id = String(list[0].localId);
      }
    } catch {
      /* non-fatal — launch will fail with unknown-profile below */
    }
  }
  browserWorkspace.status = "launching";
  browserWorkspace.lastError = null;
  try {
    const res = mode === "separate" ? await ws.launch(id, cfId) : await ws.launch(id, cfId, mode);
    if (res && res.ok === false) {
      browserWorkspace.status = "error";
      browserWorkspace.lastError = String(res.reason ?? "launch-failed");
      const err = new Error(String(res.reason ?? "launch-failed"));
      err.reason = res.reason ?? "launch-failed";
      throw err;
    }
    if (res?.workspace) {
      applySnapshot(res.workspace);
      browserWorkspace.mode = res.workspace.mode || mode;
    } else {
      browserWorkspace.status = "ready";
    }
    if (id) {
      browserWorkspace.activeProfileLocalId = String(id);
      persistProfile(browserWorkspace.activeProfileLocalId);
    }
    await refresh();
    return res;
  } catch (e) {
    browserWorkspace.lastError = String(e?.message ?? e);
    throw e;
  }
}

/** Stop the workspace (keeps the dock open). */
export async function stop() {
  const ws = ipcWorkspace();
  if (!ws || typeof ws.stop !== "function") return;
  try {
    await ws.stop();
    browserWorkspace.status = "closed";
    browserWorkspace.tabs = [];
    browserWorkspace.activeTabId = null;
  } catch (e) {
    browserWorkspace.lastError = String(e?.message ?? e);
  }
}

export async function navigate(url) {
  const ws = ipcWorkspace();
  if (!ws || typeof ws.navigate !== "function") {
    throw Object.assign(new Error("not-available"), { reason: "not-available" });
  }
  const u = String(url ?? "").trim();
  if (!u) return;
  const profileLocalId = browserWorkspace.activeProfileLocalId;
  if (!profileLocalId) {
    throw Object.assign(new Error("unknown-profile"), { reason: "unknown-profile" });
  }
  // Mark the active tab loading optimistically.
  const tab = browserWorkspace.tabs.find((t) => t.tabId === browserWorkspace.activeTabId);
  if (tab) {
    tab.loading = true;
    tab.url = u;
  }
  try {
    const cfProfileId = activeCfProfileId();
    const res = await ws.navigate(profileLocalId, cfProfileId, u);
    if (res && res.ok === false) {
      throw Object.assign(new Error(String(res.reason ?? "navigate-failed")), { reason: res.reason });
    }
    // Re-read the authoritative snapshot — the service refreshes its tab
    // list after a successful navigation (snapshot tabs have no `loading`
    // field, so the optimistic flag clears here).
    await refresh();
  } catch (e) {
    if (tab) tab.loading = false;
    throw e;
  }
}

export async function newTab() {
  const ws = ipcWorkspace();
  if (!ws || typeof ws.newTab !== "function") {
    throw Object.assign(new Error("not-available"), { reason: "not-available" });
  }
  const profileLocalId = browserWorkspace.activeProfileLocalId;
  if (!profileLocalId) {
    throw Object.assign(new Error("unknown-profile"), { reason: "unknown-profile" });
  }
  const cfProfileId = activeCfProfileId();
  const res = await ws.newTab(profileLocalId, cfProfileId);
  if (res && res.tabId != null) browserWorkspace.activeTabId = String(res.tabId);
  // Re-read the authoritative tab list — the service re-elects the active
  // tab after creating one.
  await refresh();
  return res;
}

export async function closeTab(tabId) {
  const ws = ipcWorkspace();
  if (!ws || typeof ws.closeTab !== "function") {
    throw Object.assign(new Error("not-available"), { reason: "not-available" });
  }
  const profileLocalId = browserWorkspace.activeProfileLocalId;
  if (!profileLocalId) return;
  const id = String(tabId ?? browserWorkspace.activeTabId ?? "");
  if (!id) return;
  // Optimistic local removal first — the UI closes the tab instantly; the
  // refresh() below reconciles from the authoritative tab list.
  const remaining = browserWorkspace.tabs.filter((t) => t.tabId !== id);
  browserWorkspace.tabs = remaining;
  if (browserWorkspace.activeTabId === id) {
    browserWorkspace.activeTabId = remaining[0]?.tabId ?? null;
  }
  const cfProfileId = activeCfProfileId();
  const res = await ws.closeTab(profileLocalId, cfProfileId, id);
  if (res && res.ok === false) {
    throw Object.assign(new Error(String(res.reason ?? "close-tab-failed")), { reason: res.reason });
  }
  await refresh();
}

export async function activateTab(tabId) {
  const ws = ipcWorkspace();
  const id = String(tabId ?? "");
  if (!id) return;
  const profileLocalId = browserWorkspace.activeProfileLocalId;
  browserWorkspace.activeTabId = id;
  for (const t of browserWorkspace.tabs) t.active = t.tabId === id;
  if (ws && typeof ws.activateTab === "function" && profileLocalId) {
    try {
      const cfProfileId = activeCfProfileId();
      await ws.activateTab(profileLocalId, cfProfileId, id);
      // Re-read the authoritative tab list — the service flips `active`
      // flags itself.
      await refresh();
    } catch (e) {
      browserWorkspace.lastError = String(e?.message ?? e);
    }
  }
}

export async function reload() {
  const ws = ipcWorkspace();
  if (!ws || typeof ws.reload !== "function") return;
  const profileLocalId = browserWorkspace.activeProfileLocalId;
  const tabId = browserWorkspace.activeTabId;
  if (!profileLocalId || !tabId) return;
  try {
    const cfProfileId = activeCfProfileId();
    const res = await ws.reload(profileLocalId, cfProfileId, tabId);
    if (res && res.ok === false) {
      browserWorkspace.lastError = String(res.reason ?? "feature-not-supported");
    }
  } catch (e) {
    browserWorkspace.lastError = String(e?.message ?? e);
  }
}

export async function back() {
  const ws = ipcWorkspace(); const profileLocalId = browserWorkspace.activeProfileLocalId; const tabId = browserWorkspace.activeTabId;
  if (!ws || typeof ws.back !== "function" || !profileLocalId || !tabId) return;
  const cfProfileId = activeCfProfileId();
  try { const res = await ws.back(profileLocalId, cfProfileId, tabId); if (res?.ok) await refresh(); else browserWorkspace.lastError = String(res?.reason ?? "back-failed"); }
  catch (e) { browserWorkspace.lastError = String(e?.message ?? e); }
}

export async function forward() {
  const ws = ipcWorkspace(); const profileLocalId = browserWorkspace.activeProfileLocalId; const tabId = browserWorkspace.activeTabId;
  if (!ws || typeof ws.forward !== "function" || !profileLocalId || !tabId) return;
  const cfProfileId = activeCfProfileId();
  try { const res = await ws.forward(profileLocalId, cfProfileId, tabId); if (res?.ok) await refresh(); else browserWorkspace.lastError = String(res?.reason ?? "forward-failed"); }
  catch (e) { browserWorkspace.lastError = String(e?.message ?? e); }
}

/**
 * Capture a real screenshot via the browserWorkspace IPC channel. Stores the
 * data URL (or sets `screenshotError`) so the dock's preview pane renders it.
 */
export async function screenshot() {
  const ws = ipcWorkspace();
  browserWorkspace.screenshotError = null;
  const profileLocalId = browserWorkspace.activeProfileLocalId;
  const tabId = browserWorkspace.activeTabId;
  if (!tabId) {
    browserWorkspace.screenshotError = "No active tab to capture.";
    return null;
  }
  if (!ws || typeof ws.screenshot !== "function") {
    browserWorkspace.screenshotError = "Screenshots are not available right now.";
    return null;
  }
  try {
    const cfProfileId = activeCfProfileId();
    const res = await ws.screenshot(profileLocalId, cfProfileId, tabId);
    const image = res && res.image ? res.image : res;
    if (image && image.dataUrl) {
      browserWorkspace.screenshotDataUrl = String(image.dataUrl);
      browserWorkspace.screenshotAt = Date.now();
      return res;
    }
    browserWorkspace.screenshotError = "Empty screenshot response.";
    return null;
  } catch (e) {
    browserWorkspace.screenshotError = String(e?.message ?? e);
    return null;
  }
}

/**
 * Keep the operator-activity feed live without any dock.
 *
 * The activity trace is fed by the pushed-event subscription, which used to
 * be established only while the dock was open. With the dock retired, the
 * Research console takes over that responsibility: it opens the subscription
 * when the console view mounts and closes it on unmount. The snapshot used
 * by the live-workspace readout is polled by `refresh()` on demand and does
 * not need the subscription; only the event trace does.
 */
export function connectActivityFeed() {
  startSubscription();
}

export function disconnectActivityFeed() {
  stopSubscription();
}

/**
 * Launch a managed Donut profile EXPLICITLY, from the Research console.
 *
 * `open()` carried the dock's auto-launch behaviour (restore the persisted
 * workspace on mount); an external control surface must never start a
 * browser as a side effect of being looked at. The console calls this on
 * the user's click, and the console's own "Open in Donut" naming makes the
 * window's ownership honest.
 */
export async function openInDonut(profileLocalId = null, mode = "separate") {
  return launch(profileLocalId, null, mode);
}

/** Test-only: clear all stored state and the active subscription. */
export function __resetForTests() {
  stopSubscription();
  browserWorkspace.open = false;
  browserWorkspace.width = MEDIUM;
  browserWorkspace.status = "idle";
  browserWorkspace.tabs = [];
  browserWorkspace.activeTabId = null;
  browserWorkspace.lastError = null;
  browserWorkspace.backendState = null;
  browserWorkspace.activeProfileLocalId = null;
  browserWorkspace.canGoBack = false;
  browserWorkspace.canGoForward = false;
  browserWorkspace.canReload = false;
  browserWorkspace.canScreenshot = true;
  browserWorkspace.screenshotDataUrl = null;
  browserWorkspace.screenshotAt = null;
  browserWorkspace.screenshotError = null;
  browserWorkspace.activity = [];
  browserWorkspace._autoLaunchAttempted = false;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_KEY_OPEN);
      localStorage.removeItem(STORAGE_KEY_WIDTH);
      localStorage.removeItem(STORAGE_KEY_PROFILE);
    }
  } catch {
    /* noop */
  }
}
