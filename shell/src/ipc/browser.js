import { safeHandle } from "../security/safe-handle.js";
// Progress Ledger embedded-browser IPC — Phase 1 of the approved D2-D6 plan.
//
// SECURITY MODEL. The renderer supplies ONLY an opaque page id (`bp-N`), a URL
// string and integers. There is no IPC parameter for a partition, a path, a
// port, a host, a token, a webContents id or a session object, so the renderer
// has no way to address a browser instance main did not create for it. Every
// channel is registered through `safeHandle`, which enforces the sender-origin
// allow-list (shell/src/security/ipc-auth.js), and the profile id that selects
// the browser partition is verified against the local database owned by the
// native core before any page is created.
//
// The embedded browser depends on NOTHING from the Donut integration: this
// module does not import it, and no channel here consults it. That is the
// mandatory Donut-independence property for Phase 1, and it is asserted by
// e2e/browser-page.spec.js.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { app, net, safeStorage, session } from "electron";
import { createBrowserHost } from "../services/browser/host.js";
import { REASONS } from "../services/browser/registry.js";
import {
  isAllowedUrl,
  partitionForBrowser,
  validateBrowserProfileId,
  validateTempProfileId,
} from "../services/browser/policy.js";
import { resolveDownloadsDir } from "../workspace.js";

/** The host is created lazily, once, against the live window accessor. */
let hostRef = null;

export function getBrowserHost(ctx) {
  if (hostRef) return hostRef;
  const e2eNavigationTimeout = Number(process.env.PROGRESSLEDGER_V2_E2E_BROWSER_NAVIGATION_TIMEOUT_MS);
  const navigationTimeoutMs =
    process.env.PROGRESSLEDGER_V2_E2E === "1" &&
    Number.isInteger(e2eNavigationTimeout) &&
    e2eNavigationTimeout >= 100 &&
    e2eNavigationTimeout <= 60_000
      ? e2eNavigationTimeout
      : undefined;
  hostRef = createBrowserHost({
    getWindow: () => ctx.win?.(),
    emit: (event) => ctx.notify?.("browser:on-event", event),
    // Approved decision D: downloads are managed inside the ACTIVE workspace
    // (`<workspace>/downloads`). Resolved lazily per download, so a workspace
    // switch is honoured without rebuilding the host.
    //
    // `null` here (no active workspace) is a REFUSAL inside the manager, never a
    // fallback to the OS download folder: an uncontrolled write is worse than a
    // download that did not happen.
    getDownloadsDir: () => {
      try {
        return resolveDownloadsDir();
      } catch {
        return null;
      }
    },
    ensureDownloadsDir: (dir) => {
      mkdirSync(dir, { recursive: true });
    },
    downloadsExists: (path) => existsSync(path),
    navigationTimeoutMs,
  });
  return hostRef;
}

/** Test-only reset for the E2E harness (never reachable from the renderer). */
export function _resetBrowserHost() {
  try {
    hostRef?.closeAll();
  } catch {}
  hostRef = null;
}

function readString(payload, key) {
  if (!payload || typeof payload !== "object") return null;
  const value = payload[key];
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  return text.length > 0 ? text : null;
}

export function register(ctx) {
  const host = getBrowserHost(ctx);

  // V2-39 pending partition deletes: remove folders recorded by a
  // delete that could not remove its folder while running. Runs at
  // startup, before any page can be created in a deleted partition
  // (resolveProfile rejects deleted ids, so no new view can recreate
  // a pending folder before this cleanup runs). A folder that still
  // cannot be removed stays recorded for the next start; startup is
  // never blocked by a pending removal.
  const cleanupPendingDeletes = async () => {
    let pending = [];
    try {
      pending = ctx.core?.listPendingBrowserProfileDeletes?.() ?? [];
    } catch {
      return;
    }
    for (const entry of Array.isArray(pending) ? pending : []) {
      // NAPI objects are camelCase in JS (localId, partitionName),
      // not the Rust snake_case column names. Reading snake_case
      // here silently skipped every pending entry (group3 run 1:
      // folder + row both survived a restart with no error).
      const name = entry?.partitionName ?? entry?.partition_name;
      const localId = entry?.localId ?? entry?.local_id;
      if (typeof name !== "string" || !/^[A-Za-z0-9-]+$/.test(name)) continue;
      if (typeof localId !== "string" || !validateBrowserProfileId(localId)) continue;
      const dir = join(app.getPath("userData"), "Partitions", name);
      const removed = await removeDirWithRetry(dir, 10000);
      if (removed) {
        try {
          ctx.core?.removePendingBrowserProfileDelete?.(localId);
        } catch {}
      }
    }
  };
  void cleanupPendingDeletes();
  // Quit, if possible: same cleanup, synchronously, best effort.
  // A failure here keeps the row for the next start, it never blocks quit.
  if (!register._quitCleanupRegistered) {
    register._quitCleanupRegistered = true;
    try {
      app.on("before-quit", () => {
        let pending = [];
        try {
          pending = ctx.core?.listPendingBrowserProfileDeletes?.() ?? [];
        } catch {
          return;
        }
        for (const entry of Array.isArray(pending) ? pending : []) {
          const name = entry?.partitionName ?? entry?.partition_name;
          const localId = entry?.localId ?? entry?.local_id;
          if (typeof name !== "string" || !/^[A-Za-z0-9-]+$/.test(name)) continue;
          if (typeof localId !== "string" || !validateBrowserProfileId(localId)) continue;
          const dir = join(app.getPath("userData"), "Partitions", name);
          try { rmSync(dir, { recursive: true, force: true }); } catch {}
          if (existsSync(dir)) {
            try { rmSync(dir, { recursive: true, force: true }); } catch {}
          }
          if (!existsSync(dir)) {
            try {
              ctx.core?.removePendingBrowserProfileDelete?.(localId);
            } catch {}
          }
        }
      });
    } catch {}
  }

  // Tab rows: pageId -> { rowId, profileId, title }. The shell keeps one
  // browser_tabs row per live page so a tab can be restored after a
  // restart (its workspace tab carries the row id, not the dead bp-N).
  // Rows are written on create, updated on navigate, deleted on close.
  // Phase 3: browser_profile_id is the workspace profile id; Phase 3B
  // repoints it at the browser profile. is_active is not tracked yet:
  // restore activates the first restored tab (see the surface).
  const tabRows = new Map();

  // Phase 3B: temporary profiles live ONLY here (in-memory, never in
  // Rust, never on disk). Each entry is { workspaceId, profile } where
  // profile is the full shape the host needs (defaults throughout, no
  // proxy, so nothing secret ever lives in one). A restart empties
  // this map, and the in-memory partitions evaporate with it.
  const tempProfiles = new Map();

  // Strip anything a renderer must never see: the safeStorage blob
  // (decryptable only in main) and any decrypted password the IPC
  // attached for the host. The renderer gets mode/host/port/username,
  // never the password in either form.
  function stripProfile(profile) {
    if (!profile || typeof profile !== "object") return profile;
    const { proxyPasswordEncrypted: _blob, proxyPassword: _plain, ...rest } = profile;
    return rest;
  }

  function decryptPassword(blob) {
    if (!blob || typeof blob !== "string") return null;
    try {
      if (typeof safeStorage?.decryptString !== "function") return null;
      return safeStorage.decryptString(Buffer.from(blob, "base64"));
    } catch {
      return null;
    }
  }

  function encryptPassword(plaintext) {
    if (typeof safeStorage?.isEncryptionAvailable === "function" && !safeStorage.isEncryptionAvailable()) {
      throw new Error("encryption-unavailable");
    }
    if (typeof safeStorage?.encryptString !== "function") {
      throw new Error("encryption-unavailable");
    }
    return safeStorage.encryptString(plaintext).toString("base64");
  }

  function rustProfiles(profileId) {
    try {
      const list = ctx.core?.listBrowserProfiles?.(profileId);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  // Resolve a browser profile id to the FULL profile the host needs
  // (with the proxy password decrypted, in memory only). A null id
  // means "the workspace default" (created on demand). Returns
  // { ok: false, reason } when the id is malformed or unknown, so a
  // renderer can never steer a page into a profile it did not name
  // through a valid id.
  function resolveProfile(profileId, browserProfileId) {
    if (browserProfileId === null || browserProfileId === undefined) {
      try {
        const def = ctx.core.ensureDefaultBrowserProfile(profileId, `bp-${randomUUID()}`);
        if (!def) return { ok: false, reason: "unknown-browser-profile" };
        return { ok: true, full: { ...def, proxyPassword: decryptPassword(def.proxyPasswordEncrypted) }, temporary: false };
      } catch {
        return { ok: false, reason: "unknown-browser-profile" };
      }
    }
    if (typeof browserProfileId === "string" && validateTempProfileId(browserProfileId)) {
      const entry = tempProfiles.get(browserProfileId);
      if (!entry || entry.workspaceId !== profileId) {
        return { ok: false, reason: "unknown-browser-profile" };
      }
      return { ok: true, full: entry.profile, temporary: true };
    }
    if (typeof browserProfileId !== "string" || !validateBrowserProfileId(browserProfileId)) {
      return { ok: false, reason: "unknown-browser-profile" };
    }
    const row = rustProfiles(profileId).find((r) => r && r.localId === browserProfileId);
    if (!row) return { ok: false, reason: "unknown-browser-profile" };
    return { ok: true, full: { ...row, proxyPassword: decryptPassword(row.proxyPasswordEncrypted) }, temporary: false };
  }

  // Diag16 root cause (do not regress): rm MUST come from
  // node:fs/promises. The node:fs callback rm, awaited without a
  // callback, returns immediately without deleting and then throws an
  // uncaught "callback is not a function" from inside rimraf, which
  // kills main right after window creation -- before cleanup can
  // remove the pending row -- and leaves orphan renderer processes.
  // That single wrong import explained every pre-seeded-launch
  // firstWindow timeout (Diag5-16) and every surviving pending row:
  // fresh launches never call this path (empty pending list).
  // Windows delayed deletion (Diag11/Diag12): even with the correct
  // promise rm, a folder can still be visible to existsSync briefly
  // after rm resolves, because the directory entry is removed only
  // when the last handle closes (antivirus scan, Chromium session,
  // etc.). So removal polls up to maxMs
  // (startup cleanup: 10 s, where the cleanup runs in the background
  // and the wait costs nothing user-visible; delete path: 1 s default,
  // so a truly locked folder still becomes a pending row promptly).
  // A folder that is still visible after the full poll stays pending
  // for the next start, and a gone folder's row is removed then.
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  async function removeDirWithRetry(dir, maxMs = 1000) {
    try { await rm(dir, { recursive: true, force: true }); } catch {}
    const steps = Math.max(1, Math.floor(maxMs / 500));
    for (let i = 0; i < steps; i++) {
      await sleepMs(500);
      if (!existsSync(dir)) return true;
      if (i > 0 && i % 4 === 3) {
        try { await rm(dir, { recursive: true, force: true }); } catch {}
      }
    }
    return !existsSync(dir);
  }

  // Close every live view of a profile, wipe its session storage, and
  // remove its partition directory. Throws on failure so a delete
  // aborts instead of leaving a half-deleted profile (row gone, data
  // present, or data gone, row present). Temp profiles never reach
  // here (they have no row and no disk data).
  async function clearProfileData(profileId, profile, allowPending = false) {
    // V2-39 delete fix: close views first, then clear storage, cache,
    // auth cache and host resolver cache, then flush, then try to
    // remove the folder. Electron keeps a partition folder locked
    // while the app runs, and a session that outlives its views can
    // recreate the folder after a delete (Diag3/Diag4: rm succeeded,
    // dir back with cache files). So a delete that cannot remove the
    // folder while running records a pending delete instead of
    // claiming success: the folder is removed at the next app start
    // (and at quit if possible), and the pending row is removed only
    // after the folder is gone. Pending is ONLY for delete, never for
    // clear-data on a profile that still exists (removing its folder
    // at next start would wipe data browsed after the clear).
    // Returns { pendingDelete: boolean }.
    const pages = [];
    try {
      const state = host.state?.();
      const list = Array.isArray(state?.pages) ? state.pages : [];
      for (const page of list) {
        if (page?.browserProfile?.localId === profile.localId && page?.id) pages.push(page.id);
      }
    } catch {}
    for (const pageId of pages) {
      try {
        const res = host.closePage(pageId);
        if (res?.clearPromise) await res.clearPromise.catch(() => {});
      } catch {}
    }
    const partition = partitionForBrowser(profileId, profile);
    if (!partition) throw new Error("bad-partition");
    const sess = session.fromPartition(partition);
    // User data first: a failure here aborts the delete (fail-closed),
    // so a row is never deleted while cookies/localStorage/IndexedDB
    // are still readable in the session.
    await sess.clearStorageData();
    // Caches next, best effort: a cache failure does not abort, because
    // the pending folder removal (or a successful rm) removes the
    // on-disk cache anyway, and no user data rides on these calls.
    try { if (typeof sess.clearCache === "function") await sess.clearCache(); } catch {}
    try { if (typeof sess.clearAuthCache === "function") await sess.clearAuthCache(); } catch {}
    try { if (typeof sess.clearHostResolverCache === "function") await sess.clearHostResolverCache(); } catch {}
    try { if (typeof sess.flushStorageData === "function") await sess.flushStorageData(); } catch {}
    if (partition.startsWith("persist:")) {
      const name = partition.slice("persist:".length);
      if (!/^[A-Za-z0-9-]+$/.test(name)) throw new Error("bad-partition");
      const dir = join(app.getPath("userData"), "Partitions", name);
      const removed = await removeDirWithRetry(dir);
      if (!removed) {
        if (!allowPending) throw new Error("partition-remove-failed");
        // Folder still there (locked, or recreated by the session):
        // record it for next-start removal, and fail closed if even
        // the record cannot be written (otherwise the folder would
        // linger with no record to remove it later).
        try {
          ctx.core?.addPendingBrowserProfileDelete?.(profileId, profile.localId, name);
        } catch {
          throw new Error("pending-delete-record-failed");
        }
        return { pendingDelete: true };
      }
      return { pendingDelete: false };
    }
    return { pendingDelete: false };
  }

  // Ownership gate: a browser partition belongs to a real Progress Ledger profile.
  // The partition is derived from the id (services/browser/policy.js) AFTER this
  // check, so an unknown id can never mint a partition.
  function profileExists(profileId) {
    try {
      const list = ctx.core?.getProfiles?.();
      return (Array.isArray(list) ? list : []).some(
        (p) => p && String(p.id) === String(profileId),
      );
    } catch {
      return false;
    }
  }

  safeHandle("browser:create-page", (_e, payload) => {
    // ONE options object, validated here in main (the trust boundary):
    // exactly { profileId, url, restoreId, browserProfileId }, no
    // unknown keys, strict types. A positional call or a swapped field
    // cannot reach the host: it is rejected, not reinterpreted.
    const ALLOWED_CREATE_PAGE_KEYS = ["profileId", "url", "restoreId", "browserProfileId"];
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { ok: false, reason: "invalid-create-page" };
    }
    for (const key of Object.keys(payload)) {
      if (!ALLOWED_CREATE_PAGE_KEYS.includes(key)) {
        return { ok: false, reason: "invalid-create-page" };
      }
    }
    const profileId = payload.profileId;
    if (!Number.isInteger(profileId) || !profileExists(profileId)) {
      return { ok: false, reason: Number.isInteger(profileId) ? "unknown-profile" : "invalid-create-page" };
    }
    const url = payload.url;
    if (typeof url !== "string" || url.length === 0) {
      return { ok: false, reason: "invalid-create-page" };
    }
    const restoreId = payload.restoreId === undefined ? null : payload.restoreId;
    if (restoreId !== null && !Number.isInteger(restoreId)) {
      return { ok: false, reason: "invalid-create-page" };
    }
    const requestedBrowserProfileId = payload.browserProfileId === undefined ? null : payload.browserProfileId;
    if (requestedBrowserProfileId !== null && typeof requestedBrowserProfileId !== "string") {
      return { ok: false, reason: "invalid-create-page" };
    }
    // A restore reopens in its ORIGINAL profile: the row is the truth,
    // not the request. A row whose profile is gone (deleted since) is
    // stale, so it falls through to a fresh row in the requested
    // profile instead of failing the tab.
    let requestedProfileId = requestedBrowserProfileId;
    let restoreRow = null;
    if (restoreId !== null) {
      try {
        const rows = ctx.core.listBrowserTabs(profileId);
        restoreRow = (Array.isArray(rows) ? rows : []).find((r) => r && r.id === restoreId) ?? null;
      } catch { restoreRow = null; }
      if (restoreRow && typeof restoreRow.browserProfileId === "string") {
        requestedProfileId = restoreRow.browserProfileId;
      }
    }
    const resolved = resolveProfile(profileId, requestedProfileId);
    if (!resolved.ok) {
      // A stale restore (profile deleted) reopens fresh instead of failing.
      if (restoreRow && requestedProfileId !== requestedBrowserProfileId) {
        const fallback = resolveProfile(profileId, requestedBrowserProfileId);
        if (!fallback.ok) return { ok: false, reason: "unknown-browser-profile" };
        return createPageWithProfile(profileId, fallback, url, null);
      }
      return { ok: false, reason: resolved.reason };
    }
    return createPageWithProfile(profileId, resolved, url, restoreRow);
  });

  // Shared by the create-page channel (and its stale-restore fallback):
  // create the page in the resolved profile, then record its tab row
  // (temporary profiles get no row: they evaporate, so there is nothing
  // to restore).
  function createPageWithProfile(profileId, resolved, url, restoreRow) {
    let liveCap = undefined;
    try {
      liveCap = ctx.core.getBrowserLiveCap(profileId);
    } catch { liveCap = undefined; }
    const created = host.createPage({
      profileId,
      browserProfile: resolved.full,
      liveCap,
      url,
    });
    if (!created?.ok || !created.page?.id) return created;
    const pageId = created.page.id;
    if (resolved.temporary) return created;
    if (restoreRow) {
      tabRows.set(pageId, { rowId: restoreRow.id, profileId, title: created.page.title ?? restoreRow.title ?? "" });
      try { ctx.core.updateBrowserTab(restoreRow.id, created.page.url ?? url, created.page.title ?? restoreRow.title ?? ""); } catch { /* row keeps its stored values; restore still works */ }
      return { ...created, browserTabId: restoreRow.id };
    }
    try {
      const row = ctx.core.saveBrowserTab(profileId, resolved.full.localId, tabRows.size, created.page.url ?? url, created.page.title ?? "", true);
      tabRows.set(pageId, { rowId: row.id, profileId, title: created.page.title ?? "" });
      return { ...created, browserTabId: row.id };
    } catch (err) {
      // Fail closed: a page without its row would silently lose its
      // restore data, so the create fails and the page is torn down.
      // The underlying reason is carried as detail (surface shows it),
      // so a row-write failure is diagnosable instead of generic.
      try { host.closePage(pageId); } catch { /* already closing */ }
      return { ok: false, reason: "tab-state-failed", detail: err?.message ?? String(err) };
    }
  }

  safeHandle("browser:navigate", (_e, payload) => {
    const pageId = readString(payload, "pageId");
    if (pageId === null) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
    const url = readString(payload, "url") ?? "";
    const res = host.navigate(pageId, url);
    if (res?.ok) {
      const row = tabRows.get(pageId);
      if (row) {
        try { ctx.core.updateBrowserTab(row.rowId, url, row.title); }
        catch { console.error("browser tab row update failed for", pageId); }
      }
    }
    return res;
  });

  safeHandle("browser:reload", (_e, payload) => {
    const pageId = readString(payload, "pageId");
    if (pageId === null) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
    return host.reload(pageId);
  });

  safeHandle("browser:go-back", (_e, payload) => {
    const pageId = readString(payload, "pageId");
    if (pageId === null) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
    return host.goBack(pageId);
  });

  safeHandle("browser:go-forward", (_e, payload) => {
    const pageId = readString(payload, "pageId");
    if (pageId === null) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
    return host.goForward(pageId);
  });

  safeHandle("browser:navigation", (_e, payload) => {
    const pageId = readString(payload, "pageId");
    if (pageId === null) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
    return host.navigationState(pageId);
  });

  safeHandle("browser:close-page", async (_e, payload) => {
    const pageId = readString(payload, "pageId");
    if (pageId === null) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
    const res = host.closePage(pageId);
    // Clear-on-close completes before the close returns, so a reopen
    // cannot race the wipe.
    if (res?.clearPromise) await res.clearPromise.catch(() => {});
    if (res?.ok) {
      const row = tabRows.get(pageId);
      if (row) {
        try { ctx.core.deleteBrowserTab(row.rowId); }
        catch { console.error("browser tab row delete failed for", pageId); }
        tabRows.delete(pageId);
      }
    }
    if (res && "clearPromise" in res) {
      const { clearPromise: _cp, ...rest } = res;
      return rest;
    }
    return res;
  });

  safeHandle("browser:state", () => host.state());

  // Tab rows for a profile, in restore order (position, id). The
  // renderer matches its own tab's row id against this list; it never
  // sees another profile's rows because the profile gate runs first.
  safeHandle("browser:list-tabs", (_e, payload) => {
    const profileId = Number(readString(payload, "profileId") ?? NaN);
    if (!Number.isInteger(profileId) || !profileExists(profileId)) {
      return { ok: false, reason: "unknown-profile" };
    }
    return ctx.core.listBrowserTabs(profileId);
  });

  // Phase 3B browser profiles. Every channel gates on the workspace
  // profile first (a workspace cannot touch another's profiles), and
  // every returned profile is stripped of its password blob (see
  // stripProfile): the renderer never sees a password in either form.
  safeHandle("browser:list-profiles", (_e, payload) => {
    const profileId = Number(readString(payload, "profileId") ?? NaN);
    if (!Number.isInteger(profileId) || !profileExists(profileId)) {
      return { ok: false, reason: "unknown-profile" };
    }
    const rows = rustProfiles(profileId).map(stripProfile);
    const temps = [...tempProfiles.values()]
      .filter((e) => e.workspaceId === profileId)
      .map((e) => stripProfile(e.profile));
    return { ok: true, profiles: [...rows, ...temps] };
  });

  safeHandle("browser:create-temp-profile", (_e, payload) => {
    const profileId = Number(readString(payload, "profileId") ?? NaN);
    if (!Number.isInteger(profileId) || !profileExists(profileId)) {
      return { ok: false, reason: "unknown-profile" };
    }
    const displayName = readString(payload, "displayName") ?? "Temporary";
    const color = readString(payload, "color");
    const localId = `temp-${randomUUID()}`;
    const profile = {
      localId,
      profileId,
      displayName,
      position: 0,
      enabled: true,
      color: color ?? null,
      icon: null,
      notes: "",
      profileType: "temporary",
      isDefault: false,
      temporary: true,
      proxyMode: "none",
      proxyHost: null,
      proxyPort: null,
      proxyUsername: null,
      proxyPasswordEncrypted: null,
      proxyBypass: "<local>",
      language: null,
      userAgentPreset: null,
      webrtcPolicy: "default_public_interface_only",
      permissionsAllow: '["clipboard-sanitized-write","fullscreen"]',
      gpc: false,
      dnt: false,
      blockThirdPartyCookies: false,
      clearOnClose: false,
      downloadDir: null,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    tempProfiles.set(localId, { workspaceId: profileId, profile });
    return { ok: true, profile: stripProfile(profile) };
  });

  safeHandle("browser:create-profile", (_e, payload) => {
    const profileId = Number(readString(payload, "profileId") ?? NaN);
    if (!Number.isInteger(profileId) || !profileExists(profileId)) {
      return { ok: false, reason: "unknown-profile" };
    }
    const displayName = readString(payload, "displayName");
    if (!displayName) return { ok: false, reason: "missing-name" };
    try {
      const row = ctx.core.createBrowserProfile(
        profileId,
        `bp-${randomUUID()}`,
        displayName,
        readString(payload, "color"),
        readString(payload, "icon"),
        readString(payload, "notes") ?? "",
      );
      return { ok: true, profile: stripProfile(row) };
    } catch (err) {
      return { ok: false, reason: "create-failed", detail: String(err?.message ?? err).slice(0, 200) };
    }
  });

  safeHandle("browser:update-profile", (_e, payload) => {
    const profileId = Number(readString(payload, "profileId") ?? NaN);
    if (!Number.isInteger(profileId) || !profileExists(profileId)) {
      return { ok: false, reason: "unknown-profile" };
    }
    const localId = readString(payload, "localId");
    if (!localId || !validateBrowserProfileId(localId)) {
      return { ok: false, reason: "unknown-browser-profile" };
    }
    const row = rustProfiles(profileId).find((r) => r && r.localId === localId);
    if (!row) return { ok: false, reason: "unknown-browser-profile" };
    const s = payload?.settings ?? {};
    // Password semantics: a string encrypts (new password), null keeps
    // the existing blob, "" clears it. Encryption failure refuses the
    // whole update rather than storing plain text.
    let blob = row.proxyPasswordEncrypted ?? null;
    try {
      if (typeof s.proxyPassword === "string" && s.proxyPassword.length > 0) {
        blob = encryptPassword(s.proxyPassword);
      } else if (s.proxyPassword === "") {
        blob = null;
      }
    } catch {
      return { ok: false, reason: "encryption-unavailable" };
    }
    try {
      const updated = ctx.core.updateBrowserProfile(
        localId,
        readString(s, "displayName") ?? row.displayName,
        readString(s, "color") ?? null,
        readString(s, "icon") ?? null,
        readString(s, "notes") ?? "",
        readString(s, "proxyMode") ?? "none",
        readString(s, "proxyHost"),
        Number.isInteger(s.proxyPort) ? s.proxyPort : null,
        readString(s, "proxyUsername"),
        blob,
        readString(s, "proxyBypass") ?? "<local>",
        readString(s, "language"),
        readString(s, "userAgentPreset"),
        readString(s, "webrtcPolicy") ?? "default_public_interface_only",
        readString(s, "permissionsAllow") ?? "[]",
        s.gpc === true,
        s.dnt === true,
        s.blockThirdPartyCookies === true,
        s.clearOnClose === true,
        readString(s, "downloadDir"),
      );
      const full = { ...updated, proxyPassword: decryptPassword(updated.proxyPasswordEncrypted) };
      try { host.reconfigureProfile(localId, full); } catch {}
      return { ok: true, profile: stripProfile(updated) };
    } catch (err) {
      return { ok: false, reason: "update-failed", detail: String(err?.message ?? err).slice(0, 200) };
    }
  });

  safeHandle("browser:delete-profile", async (_e, payload) => {
    const profileId = Number(readString(payload, "profileId") ?? NaN);
    if (!Number.isInteger(profileId) || !profileExists(profileId)) {
      return { ok: false, reason: "unknown-profile" };
    }
    const localId = readString(payload, "localId");
    if (!localId || !validateBrowserProfileId(localId)) {
      return { ok: false, reason: "unknown-browser-profile" };
    }
    const row = rustProfiles(profileId).find((r) => r && r.localId === localId);
    if (!row) return { ok: false, reason: "unknown-browser-profile" };
    let deletedLedger = 0;
    if (payload?.deleteLedger === true) {
      try {
        deletedLedger = ctx.core.deleteLedgerByBrowserProfile(profileId, localId);
      } catch {
        return { ok: false, reason: "ledger-delete-failed" };
      }
    }
    // Clear first, delete the row last (the spec's order). A clear
    // failure aborts the delete: no half-deleted profile.
    let clearResult = null;
    try {
      clearResult = await clearProfileData(profileId, row, true);
    } catch {
      return { ok: false, reason: "clear-failed" };
    }
    try {
      ctx.core.deleteBrowserProfile(localId);
    } catch {
      return { ok: false, reason: "delete-failed" };
    }
    return { ok: true, deletedLedger, pendingDelete: clearResult?.pendingDelete === true };
  });

  safeHandle("browser:duplicate-profile", (_e, payload) => {
    const profileId = Number(readString(payload, "profileId") ?? NaN);
    if (!Number.isInteger(profileId) || !profileExists(profileId)) {
      return { ok: false, reason: "unknown-profile" };
    }
    const localId = readString(payload, "localId");
    if (!localId || !validateBrowserProfileId(localId)) {
      return { ok: false, reason: "unknown-browser-profile" };
    }
    const src = rustProfiles(profileId).find((r) => r && r.localId === localId);
    if (!src) return { ok: false, reason: "unknown-browser-profile" };
    let copy = null;
    try {
      copy = ctx.core.createBrowserProfile(
        profileId,
        `bp-${randomUUID()}`,
        `${src.displayName} (copy)`,
        src.color ?? null,
        src.icon ?? null,
        src.notes ?? "",
      );
      const updated = ctx.core.updateBrowserProfile(
        copy.localId,
        copy.displayName,
        src.color ?? null,
        src.icon ?? null,
        src.notes ?? "",
        src.proxyMode ?? "none",
        src.proxyHost ?? null,
        src.proxyPort ?? null,
        src.proxyUsername ?? null,
        // The blob is copied verbatim (same machine, same safeStorage
        // key, so it still decrypts). Settings duplicate; data does not.
        src.proxyPasswordEncrypted ?? null,
        src.proxyBypass ?? "<local>",
        src.language ?? null,
        src.userAgentPreset ?? null,
        src.webrtcPolicy ?? "default_public_interface_only",
        src.permissionsAllow ?? "[]",
        src.gpc === true,
        src.dnt === true,
        src.blockThirdPartyCookies === true,
        src.clearOnClose === true,
        src.downloadDir ?? null,
      );
      return { ok: true, profile: stripProfile(updated) };
    } catch (err) {
      // Roll back a half-duplicated copy rather than leaving it behind.
      try { if (copy) ctx.core.deleteBrowserProfile(copy.localId); } catch {}
      return { ok: false, reason: "duplicate-failed", detail: String(err?.message ?? err).slice(0, 200) };
    }
  });

  safeHandle("browser:clear-profile-data", async (_e, payload) => {
    const profileId = Number(readString(payload, "profileId") ?? NaN);
    if (!Number.isInteger(profileId) || !profileExists(profileId)) {
      return { ok: false, reason: "unknown-profile" };
    }
    const localId = readString(payload, "localId");
    if (!localId || !validateBrowserProfileId(localId)) {
      return { ok: false, reason: "unknown-browser-profile" };
    }
    const row = rustProfiles(profileId).find((r) => r && r.localId === localId);
    if (!row) return { ok: false, reason: "unknown-browser-profile" };
    try {
      await clearProfileData(profileId, row);
    } catch {
      return { ok: false, reason: "clear-failed" };
    }
    return { ok: true };
  });

  safeHandle("browser:test-proxy", async (_e, payload) => {
    const profileId = Number(readString(payload, "profileId") ?? NaN);
    if (!Number.isInteger(profileId) || !profileExists(profileId)) {
      return { ok: false, reason: "unknown-profile" };
    }
    const localId = readString(payload, "localId");
    if (!localId || !validateBrowserProfileId(localId)) {
      return { ok: false, reason: "unknown-browser-profile" };
    }
    const row = rustProfiles(profileId).find((r) => r && r.localId === localId);
    if (!row) return { ok: false, reason: "unknown-browser-profile" };
    if (!row.proxyMode || row.proxyMode === "none") {
      return { ok: false, reason: "no-proxy" };
    }
    const url = readString(payload, "url") ?? "";
    const verdict = isAllowedUrl(url);
    if (!verdict.ok) return { ok: false, reason: "invalid-url" };
    // The proxy must already be applied to this session for the test
    // to mean anything: apply it here (a test-only session use), then
    // fetch. A failure to apply, or a failed fetch, is a failed test —
    // never a silent direct connection.
    try {
      const partition = partitionForBrowser(profileId, row);
      if (!partition) return { ok: false, reason: "unknown-browser-profile" };
      const sess = session.fromPartition(partition);
      const rules =
        row.proxyMode === "socks5"
          ? `socks5://${row.proxyHost}:${row.proxyPort}`
          : `${row.proxyMode}=${row.proxyHost}:${row.proxyPort}`;
      await sess.setProxy({ proxyRules: rules, proxyBypassRules: row.proxyBypass ?? "<local>" });
      const status = await new Promise((resolve, reject) => {
        const req = net.request({ session: sess, url: verdict.url });
        const timer = setTimeout(() => {
          try { req.abort(); } catch {}
          reject(new Error("proxy test timed out"));
        }, 10_000);
        req.on("response", (res) => {
          clearTimeout(timer);
          try { res.resume?.(); } catch {}
          resolve(res.statusCode);
        });
        req.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        try { req.end(); } catch (err) { clearTimeout(timer); reject(err); }
      });
      return { ok: true, status };
    } catch (err) {
      return { ok: false, reason: "proxy-failed", detail: String(err?.message ?? err).slice(0, 200) };
    }
  });

  safeHandle("browser:set-live-cap", (_e, payload) => {
    const profileId = Number(readString(payload, "profileId") ?? NaN);
    if (!Number.isInteger(profileId) || !profileExists(profileId)) {
      return { ok: false, reason: "unknown-profile" };
    }
    const cap = Number(payload?.cap);
    if (!Number.isInteger(cap)) return { ok: false, reason: "invalid-cap" };
    try {
      return { ok: true, cap: ctx.core.setBrowserLiveCap(profileId, cap) };
    } catch {
      return { ok: false, reason: "invalid-cap" };
    }
  });

  safeHandle("browser:live-cap", (_e, payload) => {
    const profileId = Number(readString(payload, "profileId") ?? NaN);
    if (!Number.isInteger(profileId) || !profileExists(profileId)) {
      return { ok: false, reason: "unknown-profile" };
    }
    try {
      return { ok: true, cap: ctx.core.getBrowserLiveCap(profileId) };
    } catch {
      return { ok: false, reason: "unknown-profile" };
    }
  });

  safeHandle("browser:ledger-count-for-profile", (_e, payload) => {
    const profileId = Number(readString(payload, "profileId") ?? NaN);
    if (!Number.isInteger(profileId) || !profileExists(profileId)) {
      return { ok: false, reason: "unknown-profile" };
    }
    const localId = readString(payload, "localId");
    if (!localId || !validateBrowserProfileId(localId)) {
      return { ok: false, reason: "unknown-browser-profile" };
    }
    try {
      return { ok: true, count: ctx.core.countLedgerByBrowserProfile(profileId, localId) };
    } catch {
      return { ok: false, reason: "unknown-browser-profile" };
    }
  });

  // Managed downloads (approved decision D). The renderer gets opaque ids and
  // safe base names only; there is no channel that accepts or returns a path,
  // and no channel that opens a downloaded file.
  safeHandle("browser:downloads", () => host.downloads());

  safeHandle("browser:cancel-download", (_e, payload) => {
    const downloadId = readString(payload, "downloadId");
    if (downloadId === null) return { ok: false, reason: "unknown-download" };
    return host.cancelDownload(downloadId);
  });

  safeHandle("browser:set-bounds", (_e, payload) => {
    const pageId = readString(payload, "pageId");
    if (pageId === null) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
    return host.setBounds(pageId, payload?.rect);
  });

  safeHandle("browser:set-visible", (_e, payload) => {
    const pageId = readString(payload, "pageId");
    if (pageId === null) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
    return host.setVisible(pageId, payload?.visible === true);
  });

  safeHandle("browser:set-occluded", (_e, payload) =>
    host.setOccluded(payload?.occluded === true),
  );

  // Windows closing takes every page with it; app quit must not leave a
  // WebContentsView behind holding a process open.
  try {
    ctx.app?.on?.("will-quit", () => host.closeAll());
  } catch {}

  // Real-Electron test seam, same pattern as the Donut E2E recorder: the
  // snapshot is main-process-only and is never exposed to the preload bridge.
  if (process.env.PROGRESSLEDGER_V2_E2E === "1") {
    globalThis.__cfBrowserE2E = host;
  }
}
