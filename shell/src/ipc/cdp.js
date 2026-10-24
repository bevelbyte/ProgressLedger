import { safeHandle } from "../security/safe-handle.js";
// Restricted CDP IPC surface.
//
// Renderer-visible channels: cdp:open-url, cdp:list-tabs, cdp:create-tab,
// cdp:close-tab, cdp:activate-tab, cdp:get-page-info, cdp:screenshot.
//
// SECURITY MODEL
// --------------
// The renderer supplies ONLY { profileLocalId, tabId?, url? } on every
// channel. There is no IPC parameter for a CDP port, host, PID, runtime id
// or token â€” the renderer has no way to select an arbitrary CDP endpoint.
// The adapter (services/cdp-adapter.js) reads the port, the host (always
// 127.0.0.1) and the bearer token from the main-process-owned closures
// injected at construction time.
//
// The adapter instance is built lazily once, against the shared ctx.donut
// graph (if present) or a fresh closures-only construction (tests). The
// ownership check is at the ADAPTER level (resolveOwnedRuntime) â€” not at
// the IPC channel level â€” so a single missing-CF-profile check does not
// have to run for every renderer call.

import { ipcMain } from "electron";
import {
  createCdpAdapter,
  createCdpEndpointResolver,
  createOwnedRuntimeResolver,
  REASONS,
} from "../services/cdp-adapter.js";
import { readRuntimeCredential } from "../services/donut.js";

/**
 * Build the adapter that backs this IPC surface. The closures close over
 * the shared Donut graph (ctx.donut) so a missing graph does not turn into
 * a runtime crash; instead, every call reports "backend-unavailable" (the
 * IPC layer sees no `donutId` to call against).
 */
function buildAdapter(ctx) {
  const donut = ctx && ctx.donut;
  const core = ctx && ctx.core;

  const credentialReader =
    ctx && typeof ctx.readRuntimeCredential === "function"
      ? ctx.readRuntimeCredential
      : readRuntimeCredential;
  return createCdpAdapter({
    resolveOwnedRuntime: createOwnedRuntimeResolver({
      core,
      resolveOwnedRuntime: donut && donut.resolveOwnedRuntime,
    }),
    readRuntimeCredential: credentialReader,
    resolveCdpEndpoint: createCdpEndpointResolver({
      readRuntimeCredential: credentialReader,
    }),
  });
}

function readPayloadString(payload, key) {
  if (!payload || typeof payload !== "object") return null;
  const v = payload[key];
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v);
  return s.length > 0 ? s : null;
}

export function register(ctx) {
  const adapter = buildAdapter(ctx);

  // The renderer hands a { profileLocalId, ... } envelope on every channel.
  // The IPC layer pulls just the fields it needs and forwards them to the
  // adapter, which then enforces the renderer-supplies-no-endpoint rule.
  safeHandle("cdp:open-url", async (_e, payload) => {
    const profileLocalId = readPayloadString(payload, "profileLocalId");
    const cfProfileId = readPayloadString(payload, "cfProfileId");
    const url = readPayloadString(payload, "url");
    if (profileLocalId === null)
      return { ok: false, reason: "unknown-profile" };
    return adapter.openUrl(profileLocalId, cfProfileId, url);
  });

  safeHandle("cdp:list-tabs", async (_e, payload) => {
    const profileLocalId = readPayloadString(payload, "profileLocalId");
    const cfProfileId = readPayloadString(payload, "cfProfileId");
    if (profileLocalId === null)
      return { ok: false, reason: "unknown-profile" };
    return adapter.listTabs(profileLocalId, cfProfileId);
  });

  safeHandle("cdp:create-tab", async (_e, payload) => {
    const profileLocalId = readPayloadString(payload, "profileLocalId");
    const cfProfileId = readPayloadString(payload, "cfProfileId");
    if (profileLocalId === null)
      return { ok: false, reason: "unknown-profile" };
    return adapter.createTab(profileLocalId, cfProfileId);
  });

  safeHandle("cdp:close-tab", async (_e, payload) => {
    const profileLocalId = readPayloadString(payload, "profileLocalId");
    const cfProfileId = readPayloadString(payload, "cfProfileId");
    const tabId = readPayloadString(payload, "tabId");
    if (profileLocalId === null)
      return { ok: false, reason: "unknown-profile" };
    if (tabId === null) return { ok: false, reason: "invalid-tab" };
    return adapter.closeTab(profileLocalId, cfProfileId, tabId);
  });

  safeHandle("cdp:activate-tab", async (_e, payload) => {
    const profileLocalId = readPayloadString(payload, "profileLocalId");
    const cfProfileId = readPayloadString(payload, "cfProfileId");
    const tabId = readPayloadString(payload, "tabId");
    if (profileLocalId === null)
      return { ok: false, reason: "unknown-profile" };
    if (tabId === null) return { ok: false, reason: "invalid-tab" };
    return adapter.activateTab(profileLocalId, cfProfileId, tabId);
  });

  safeHandle("cdp:get-page-info", async (_e, payload) => {
    const profileLocalId = readPayloadString(payload, "profileLocalId");
    const cfProfileId = readPayloadString(payload, "cfProfileId");
    const tabId = readPayloadString(payload, "tabId");
    if (profileLocalId === null)
      return { ok: false, reason: "unknown-profile" };
    if (tabId === null) return { ok: false, reason: "invalid-tab" };
    return adapter.getPageInfo(profileLocalId, cfProfileId, tabId);
  });

  safeHandle("cdp:screenshot", async (_e, payload) => {
    const profileLocalId = readPayloadString(payload, "profileLocalId");
    const cfProfileId = readPayloadString(payload, "cfProfileId");
    const tabId = readPayloadString(payload, "tabId");
    if (profileLocalId === null)
      return { ok: false, reason: "unknown-profile" };
    if (tabId === null) return { ok: false, reason: "invalid-tab" };
    return adapter.screenshot(profileLocalId, cfProfileId, tabId);
  });
}
