import { safeHandle } from "../security/safe-handle.js";
// Donut Browser Manager IPC surface.
//
// Metadata CRUD is pure bookkeeping over the local SQLite database: the
// renderer supplies opaque local ids + display strings, and the machine-local
// Donut UUID NEVER appears on this surface (it lives in the workspace binding
// store and is resolved lazily inside the main process).
//
// Launch/navigate channels validate ownership against the local database
// first (CF-profile membership â†’ browser-profile row â†’ enabled), then hand
// over to the shared manager ops (ctx.donut graph from ./donut.js).

import { ipcMain, shell } from "electron";
import { readRuntimeCredential } from "../services/donut.js";
import { createManagerOps } from "../services/donut-manager.js";
import { getBrowserBinding } from "../services/donut-mapping.js";

const CALL_TIMEOUT_MS = 8000;

export function register(ctx) {
  const { core } = ctx;

  // ------------------------------------------------------------- ownership
  function cfProfileExists(cfProfileId) {
    try {
      return core
        .getProfiles()
        .some((p) => p && String(p.id) === String(cfProfileId));
    } catch {
      return false;
    }
  }

  function assertCfProfile(cfProfileId) {
    if (!cfProfileExists(cfProfileId)) throw new Error("unknown-profile");
  }

  function requireBrowserProfile(localId, cfProfileId) {
    // Read is gated on the owner; foreign ids are invisible. We pass the
    // expected cf_profile_id to the Rust read so the lookup can be done in
    // one trip without leaking other-owners' rows.
    const id = cfProfileId != null ? Number(cfProfileId) : null;
    const row = id != null ? core.getBrowserProfile(id, String(localId)) : null;
    if (!row) throw new Error("unknown-browser-profile");
    return row;
  }

  // ------------------------------------------------------- manager ops ops
  let opsCache = null;

  function bearerPost(path, body) {
    return (async () => {
      const cred = await readRuntimeCredential();
      if (!cred) return { ok: false, status: 0 };
      try {
        const res = await fetch(`http://127.0.0.1:${cred.port}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cred.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body ?? {}),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        return { ok: res.ok, status: res.status };
      } catch {
        return { ok: false, status: 0 };
      }
    })();
  }

  function managerOps() {
    if (opsCache) return opsCache;
    const donut = ctx.donut;
    if (!donut) throw new Error("donut-graph-missing");
    const rec = donut.stub === true ? globalThis.__cfDonutE2E : null;

    opsCache = createManagerOps({
      cfProfileExists,
      getBrowserProfileRow: (localId, cfProfileId) => {
        const row = requireBrowserProfileOrNull(localId, cfProfileId);
        return row ? { cf_profile_id: row.cfProfileId, enabled: row.enabled } : null;
      },
      getShortcutRow: (shortcutId) => {
        const sc = core.getBrowserShortcut(Number(shortcutId));
        if (!sc) return null;
        // BrowserShortcutRecord now carries cf_profile_id via the JOIN; the
        // main-process open pipeline gates on it before calling the Donut
        // transport. Foreign rows are still returned as objects (so the
        // manager-ops layer can report the failure reason deterministically),
        // but the cfProfileId in the returned row is the ground truth.
        return {
          browser_profile_id: sc.browserProfileId,
          url: sc.url,
          cf_profile_id: sc.cfProfileId,
          enabled: core.getBrowserProfile(sc.cfProfileId, sc.browserProfileId)?.enabled ?? false,
        };
      },
      provider: donut.provider,
      probeBrowserLiveness: async (localId, cfProfileId) => {
        const binding = await getBrowserBinding(String(localId));
        if (!binding || String(binding.cfProfileId) !== String(cfProfileId) || !binding.donutProfileId) {
          return { ok: false, running: false };
        }
        const cred = await readRuntimeCredential();
        if (!cred) return { ok: false, running: false };
        try {
          const res = await fetch(`http://127.0.0.1:${cred.port}/v1/profiles/${encodeURIComponent(binding.donutProfileId)}`, {
            headers: { Authorization: `Bearer ${cred.token}` },
            signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
          });
          if (!res.ok) return { ok: false, running: false };
          const payload = await res.json().catch(() => null);
          const profile = payload && payload.profile ? payload.profile : payload;
          return { ok: true, running: profile?.is_running === true };
        } catch {
          return { ok: false, running: false };
        }
      },
      ensureBinding: (localId, cfProfileId) =>
        donut.ensureBinding(String(localId), cfProfileId != null ? Number(cfProfileId) : null),
      transport:
        rec !== null
          ? {
              async run(donutId) {
                rec.donutRuns.push(donutId);
                return { ok: !rec.runFails };
              },
              async openUrl(donutId, url) {
                rec.donutOpens.push(url);
                return { ok: !rec.runFails };
              },
            }
          : {
              run: (donutId) =>
                bearerPost(`/v1/profiles/${encodeURIComponent(donutId)}/run`, {}),
              openUrl: (donutId, url) =>
                bearerPost(`/v1/profiles/${encodeURIComponent(donutId)}/open-url`, { url }),
            },
      systemOpen: async (url) => {
        if (rec !== null) { rec.systemOpens.push(url); return true; }
        try { await shell.openExternal(url); return true; }
        catch { return false; }
      },
      touchBrowserProfile: (localId, cfProfileId) => {
        try { core.touchBrowserProfile(Number(cfProfileId), String(localId)); } catch {}
      },
    });
    return opsCache;
  }

  function requireBrowserProfileOrNull(localId, cfProfileId) {
    try {
      return core.getBrowserProfile(Number(cfProfileId), String(localId)) ?? null;
    } catch {
      return null;
    }
  }

  // ----------------------------------------------------- metadata channels
  safeHandle("bm:list", (_e, cfProfileId) => {
    if (typeof cfProfileId !== "number" || !cfProfileExists(cfProfileId)) return [];
    return core.listBrowserProfiles(cfProfileId);
  });

  safeHandle("bm:add", (_e, p) => {
    assertCfProfile(p && p.profileId);
    return core.addBrowserProfile(
      Number(p.profileId),
      String(p.localId),
      String(p.name)
    );
  });

  safeHandle("bm:rename", (_e, p) => {
    if (!p) throw new Error("missing payload");
    assertCfProfile(p.profileId);
    return core.renameBrowserProfile(
      Number(p.profileId),
      String(p.localId),
      String(p.name)
    );
  });

  safeHandle("bm:set-enabled", (_e, p) => {
    if (!p) throw new Error("missing payload");
    assertCfProfile(p.profileId);
    return core.setBrowserProfileEnabled(
      Number(p.profileId),
      String(p.localId),
      Boolean(p.enabled)
    );
  });

  safeHandle("bm:delete", (_e, p) => {
    if (!p) throw new Error("missing payload");
    assertCfProfile(p.profileId);
    return core.deleteBrowserProfile(Number(p.profileId), String(p.localId));
  });

  safeHandle("bm:reorder-profiles", (_e, p) => {
    if (!p) throw new Error("missing payload");
    assertCfProfile(p.profileId);
    const ids = Array.isArray(p.orderedIds) ? p.orderedIds.map(String) : [];
    return core.reorderBrowserProfiles(Number(p.profileId), ids);
  });

  safeHandle("bm:list-shortcuts", (_e, p) => {
    if (!p) return [];
    assertCfProfile(p.profileId);
    return core.listBrowserShortcuts(Number(p.profileId), String(p.browserProfileId));
  });

  safeHandle("bm:add-shortcut", (_e, p) => {
    if (!p) throw new Error("missing payload");
    assertCfProfile(p.profileId);
    return core.addBrowserShortcut(
      Number(p.profileId),
      String(p.browserProfileId),
      String(p.label),
      String(p.url)
    );
  });

  safeHandle("bm:update-shortcut", (_e, p) => {
    if (!p) throw new Error("missing payload");
    assertCfProfile(p.profileId);
    return core.updateBrowserShortcut(
      Number(p.profileId),
      Number(p.id),
      String(p.label),
      String(p.url)
    );
  });

  safeHandle("bm:delete-shortcut", (_e, p) => {
    if (!p) throw new Error("missing payload");
    assertCfProfile(p.profileId);
    return core.deleteBrowserShortcut(Number(p.profileId), Number(p.id));
  });

  safeHandle("bm:reorder-shortcuts", (_e, p) => {
    if (!p) throw new Error("missing payload");
    assertCfProfile(p.profileId);
    const ids = Array.isArray(p.orderedIds) ? p.orderedIds.map(Number) : [];
    return core.reorderBrowserShortcuts(
      Number(p.profileId),
      String(p.browserProfileId),
      ids
    );
  });

  // Quick Actions: pin state and pinned-only listing. Same cf_profile_id
  // gate as the rest of the bm:* surface â€” the renderer can never target a
  // foreign CareerFlow profile's shortcuts.
  safeHandle("bm:toggle-shortcut-pin", (_e, p) => {
    if (!p) throw new Error("missing payload");
    assertCfProfile(p.profileId);
    return core.toggleBrowserShortcutPin(
      Number(p.profileId),
      Number(p.shortcutId),
      Boolean(p.pinned)
    );
  });

  safeHandle("bm:list-pinned", (_e, cfProfileId) => {
    if (typeof cfProfileId !== "number" || !cfProfileExists(cfProfileId)) return [];
    return core.listPinnedBrowserShortcuts(cfProfileId);
  });

  // ------------------------------------------------------------ open paths
  safeHandle("donut:open-browser-profile", (_e, payload) => {
    if (!payload) return { ok: false, reason: "missing-payload" };
    const localId = String(payload.browserProfileLocalId);
    const cfProfileId = String(payload.profileId);
    return managerOps().openBrowserProfile(localId, cfProfileId);
  });

  safeHandle("donut:open-shortcut-url", (_e, payload) => {
    if (!payload) return { ok: false, reason: "missing-payload" };
    const shortcutId = Number(payload.shortcutId);
    const cfProfileId = String(payload.profileId);
    return managerOps().openShortcutUrl(shortcutId, cfProfileId);
  });
}
