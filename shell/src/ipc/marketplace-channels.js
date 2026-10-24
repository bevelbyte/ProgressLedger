// Marketplace — handler bodies, Electron-free.
//
// The channel-name -> handler-function map lives here so a plain `node --test`
// runner can drive the REAL production handlers end to end, instead of only
// calling the service directly.
//
// The Electron-bound surface in ./marketplace.js registers each entry with a
// LITERAL `safeHandle("<channel>", ...)` call. That literal form is required:
// `scripts/check-ipc.mjs` statically proves that every channel invoked from
// preload.cjs has a sender-authenticated `safeHandle` registration, and it
// only recognises that exact shape. Do not collapse these into a loop — it
// would blind the guard.
//
// SECURITY: Git installs strip the on-disk `install_path` field before
// returning to the renderer. The renderer must never learn the absolute
// location of a cloned marketplace item — that leaks <workspace>/marketplace
// filesystem layout and the user's machine username.

import { basename } from "node:path";
import { Marketplace } from "../services/marketplace/index.js";
import { Audit } from "../services/audit/index.js";

/**
 * Return a sanitized view of a marketplace item for the renderer.
 * For `local` items the path IS shown so the renderer can display
 * "Source: /Users/me/repos/foo". For `git` items the path is hidden.
 */
function sanitizeItem(it) {
  if (!it) return it;
  if (it.source && it.source.kind === "git") {
    return { ...it, source: { kind: "git", url: it.source.url || "", ref: it.source.ref || "" } };
  }
  return it;
}

export const marketplaceHandlers = {
  "marketplace:install-local": (_e, payload) => {
    const path = payload && typeof payload.path === "string" ? payload.path : "";
    if (!path) {
      Audit.log({
        event: "marketplace.install",
        input_summary: "invalid-source",
        result: "error",
        detail: JSON.stringify({ source: "local", reason: "invalid-source" }),
      });
      return { ok: false, reason: "invalid-source" };
    }
    const res = Marketplace.installLocal(path);
    if (!res || !res.ok) {
      Audit.log({
        event: "marketplace.install",
        input_summary: basename(path),
        result: "error",
        detail: JSON.stringify({ source: "local", reason: res?.reason || "unknown-error" }),
      });
      return res;
    }
    const installed = res.id ? Marketplace.get(res.id) : null;
    Audit.log({
      event: "marketplace.install",
      input_summary: res.id || basename(path),
      result: "ok",
      detail: JSON.stringify({ source: "local", id: res.id, version: installed?.version || res.version || null }),
    });
    return res;
  },

  "marketplace:install-git": async (_e, payload) => {
    const url = payload && typeof payload.url === "string" ? payload.url.trim() : "";
    const ref = payload && typeof payload.ref === "string" ? payload.ref.trim() : "";
    if (!url) {
      Audit.log({
        event: "marketplace.install",
        input_summary: "invalid-source",
        result: "error",
        detail: JSON.stringify({ source: "git", reason: "invalid-source" }),
      });
      return { ok: false, reason: "invalid-source" };
    }
    const res = await Marketplace.installGit(url, ref || "HEAD");
    if (!res || !res.ok) {
      Audit.log({
        event: "marketplace.install",
        input_summary: url,
        result: "error",
        detail: JSON.stringify({ source: "git", reason: res?.reason || "unknown-error", ref: ref || "HEAD" }),
      });
      return res || { ok: false, reason: "unknown-error" };
    }
    Audit.log({
      event: "marketplace.install",
      input_summary: res.id,
      result: "ok",
      detail: JSON.stringify({ source: "git", id: res.id, version: res.version, ref: ref || "HEAD" }),
    });
    // Strip install_path; renderer never sees it.
    return { ok: true, id: res.id, name: res.name, version: res.version };
  },

  "marketplace:list": () => {
    const items = Marketplace.list().map(sanitizeItem);
    return { ok: true, items };
  },

  "marketplace:get": (_e, payload) => {
    const id = payload && typeof payload.id === "string" ? payload.id : "";
    if (!id) return { ok: false, reason: "missing-id" };
    const item = Marketplace.get(id);
    if (!item) return { ok: false, reason: "unknown-item" };
    return { ok: true, item: sanitizeItem(item) };
  },

  "marketplace:enable": (_e, payload) => {
    const id = payload && typeof payload.id === "string" ? payload.id : "";
    if (!id) {
      Audit.log({
        event: "marketplace.enable",
        input_summary: "missing-id",
        result: "error",
        detail: JSON.stringify({ reason: "missing-id" }),
      });
      return { ok: false, reason: "missing-id" };
    }
    const res = Marketplace.enable(id);
    if (!res || !res.ok) {
      Audit.log({
        event: "marketplace.enable",
        input_summary: id,
        result: "error",
        detail: JSON.stringify({ id, reason: res?.reason || "unknown-error" }),
      });
      return res;
    }
    Audit.log({
      event: "marketplace.enable",
      input_summary: id,
      result: "ok",
      detail: JSON.stringify({ id }),
    });
    return res;
  },

  "marketplace:disable": (_e, payload) => {
    const id = payload && typeof payload.id === "string" ? payload.id : "";
    if (!id) {
      Audit.log({
        event: "marketplace.disable",
        input_summary: "missing-id",
        result: "error",
        detail: JSON.stringify({ reason: "missing-id" }),
      });
      return { ok: false, reason: "missing-id" };
    }
    const res = Marketplace.disable(id);
    if (!res || !res.ok) {
      Audit.log({
        event: "marketplace.disable",
        input_summary: id,
        result: "error",
        detail: JSON.stringify({ id, reason: res?.reason || "unknown-error" }),
      });
      return res;
    }
    Audit.log({
      event: "marketplace.disable",
      input_summary: id,
      result: "ok",
      detail: JSON.stringify({ id }),
    });
    return res;
  },

  "marketplace:uninstall": (_e, payload) => {
    const id = payload && typeof payload.id === "string" ? payload.id : "";
    if (!id) {
      Audit.log({
        event: "marketplace.uninstall",
        input_summary: "missing-id",
        result: "error",
        detail: JSON.stringify({ reason: "missing-id" }),
      });
      return { ok: false, reason: "missing-id" };
    }
    const res = Marketplace.remove(id);
    if (!res || !res.ok) {
      Audit.log({
        event: "marketplace.uninstall",
        input_summary: id,
        result: "error",
        detail: JSON.stringify({ id, reason: res?.reason || "unknown-error" }),
      });
      return res;
    }
    Audit.log({
      event: "marketplace.uninstall",
      input_summary: id,
      result: "ok",
      detail: JSON.stringify({ id }),
    });
    return res;
  },

  "marketplace:update": (_e, payload) => {
    const id = payload && typeof payload.id === "string" ? payload.id : "";
    if (!id) {
      Audit.log({
        event: "marketplace.update",
        input_summary: "missing-id",
        result: "error",
        detail: JSON.stringify({ reason: "missing-id" }),
      });
      return { ok: false, reason: "missing-id" };
    }
    const res = Marketplace.update(id);
    if (!res || !res.ok) {
      Audit.log({
        event: "marketplace.update",
        input_summary: id,
        result: "error",
        detail: JSON.stringify({ id, reason: res?.reason || "unknown-error" }),
      });
      return res;
    }
    Audit.log({
      event: "marketplace.update",
      input_summary: id,
      result: "ok",
      detail: JSON.stringify({ id, version: res.version }),
    });
    return res;
  },
};
