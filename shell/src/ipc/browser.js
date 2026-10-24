import { safeHandle } from "../security/safe-handle.js";
// CareerFlow embedded-browser IPC — Phase 1 of the approved D2-D6 plan.
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
  const e2eNavigationTimeout = Number(process.env.CAREERFLOW_E2E_BROWSER_NAVIGATION_TIMEOUT_MS);
  const navigationTimeoutMs =
    process.env.CAREERFLOW_E2E === "1" &&
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

  // Ownership gate: a browser partition belongs to a real CareerFlow profile.
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
    return host.createPage({ profileId, url });
  });

  safeHandle("browser:navigate", (_e, payload) => {
    const pageId = readString(payload, "pageId");
    if (pageId === null) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
    const url = readString(payload, "url") ?? "";
    return host.navigate(pageId, url);
  });

  safeHandle("browser:reload", (_e, payload) => {
    const pageId = readString(payload, "pageId");
    if (pageId === null) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
    return host.reload(pageId);
  });

  safeHandle("browser:close-page", (_e, payload) => {
    const pageId = readString(payload, "pageId");
    if (pageId === null) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
    return host.closePage(pageId);
  });

  safeHandle("browser:state", () => host.state());

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
  if (process.env.CAREERFLOW_E2E === "1") {
    globalThis.__cfBrowserE2E = host;
  }
}
