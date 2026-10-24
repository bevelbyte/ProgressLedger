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

import { existsSync, mkdirSync } from "node:fs";
import { createBrowserHost } from "../services/browser/host.js";
import { REASONS } from "../services/browser/registry.js";
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

  // Tab rows: pageId -> { rowId, profileId, title }. The shell keeps one
  // browser_tabs row per live page so a tab can be restored after a
  // restart (its workspace tab carries the row id, not the dead bp-N).
  // Rows are written on create, updated on navigate, deleted on close.
  // Phase 3: browser_profile_id is the workspace profile id; Phase 3B
  // repoints it at the browser profile. is_active is not tracked yet:
  // restore activates the first restored tab (see the surface).
  const tabRows = new Map();

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
    const profileId = Number(readString(payload, "profileId") ?? NaN);
    if (!Number.isInteger(profileId) || !profileExists(profileId)) {
      return { ok: false, reason: "unknown-profile" };
    }
    const url = readString(payload, "url") ?? "about:blank";
    const restoreId = Number.isInteger(payload?.restoreBrowserTabId)
      ? payload.restoreBrowserTabId
      : null;
    const created = host.createPage({ profileId, url });
    if (!created?.ok || !created.page?.id) return created;
    const pageId = created.page.id;
    // A restore reuses its previous row instead of duplicating it: the
    // tab keeps one row for its whole lifetime, across restarts. A stale
    // id (row deleted since) falls through to a fresh row, never an error.
    if (restoreId !== null) {
      try {
        const rows = ctx.core.listBrowserTabs(profileId);
        const row = (Array.isArray(rows) ? rows : []).find((r) => r && r.id === restoreId);
        if (row) {
          tabRows.set(pageId, { rowId: row.id, profileId, title: created.page.title ?? row.title ?? "" });
          try { ctx.core.updateBrowserTab(row.id, created.page.url ?? url, created.page.title ?? row.title ?? ""); } catch { /* row keeps its stored values; restore still works */ }
          return { ...created, browserTabId: row.id };
        }
      } catch { /* fall through to a fresh row */ }
    }
    try {
      const row = ctx.core.saveBrowserTab(profileId, profileId, tabRows.size, created.page.url ?? url, created.page.title ?? "");
      tabRows.set(pageId, { rowId: row.id, profileId, title: created.page.title ?? "" });
      return { ...created, browserTabId: row.id };
    } catch {
      // Fail closed: a page without its row would silently lose its
      // restore data, so the create fails and the page is torn down.
      try { host.closePage(pageId); } catch { /* already closing */ }
      return { ok: false, reason: "tab-state-failed" };
    }
  });

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

  safeHandle("browser:close-page", (_e, payload) => {
    const pageId = readString(payload, "pageId");
    if (pageId === null) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
    const res = host.closePage(pageId);
    if (res?.ok) {
      const row = tabRows.get(pageId);
      if (row) {
        try { ctx.core.deleteBrowserTab(row.rowId); }
        catch { console.error("browser tab row delete failed for", pageId); }
        tabRows.delete(pageId);
      }
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
