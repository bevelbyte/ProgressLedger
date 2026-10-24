import { safeHandle } from "../security/safe-handle.js";
import { getBrowserHost } from "./browser.js";

function positiveId(value, field) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
}

export function register(ctx) {
  const host = getBrowserHost(ctx);
  safeHandle("research:list-sources", (_event, payload) => {
    const profileId = positiveId(payload?.profileId, "profileId");
    return ctx.core.listResearchSources(profileId);
  });
  safeHandle("research:list-captures", (_event, payload) => {
    const profileId = positiveId(payload?.profileId, "profileId");
    return ctx.core.listResearchCaptures(profileId);
  });
  safeHandle("research:save-source", (_event, payload) => {
    const profileId = positiveId(payload?.profileId, "profileId");
    if (typeof payload?.pageId !== "string" || payload.pageId.length > 80) throw new Error("Invalid browser page identity");
    const owned = host.researchPage(payload.pageId, profileId);
    if (!owned.ok) return owned;
    return ctx.core.saveResearchSource(profileId, owned.page.url, String(owned.page.title || owned.page.url).slice(0, 200));
  });
  safeHandle("research:capture", (_event, payload) => {
    const profileId = positiveId(payload?.profileId, "profileId");
    if (typeof payload?.pageId !== "string" || payload.pageId.length > 80) throw new Error("Invalid browser page identity");
    if (typeof payload?.text !== "string" || payload.text.length > 8000 || !payload.text.trim()) throw new Error("Passage must contain 1–8000 characters");
    if (!['clip', 'highlight', 'extraction'].includes(payload?.kind)) throw new Error("Unsupported capture kind");
    const owned = host.researchPage(payload.pageId, profileId);
    if (!owned.ok) return owned;
    return ctx.core.captureResearchPassage(profileId, owned.page.url, String(owned.page.title || owned.page.url).slice(0, 200), owned.page.id, payload.kind, payload.text);
  });
  safeHandle("research:kept-count", (_event, payload) => {
    const profileId = positiveId(payload?.profileId, "profileId");
    if (typeof payload?.pageId !== "string" || payload.pageId.length > 80) throw new Error("Invalid browser page identity");
    const owned = host.researchPage(payload.pageId, profileId);
    if (!owned.ok) return owned;
    return { ok: true, count: ctx.core.countKeptResearchPassages(profileId, owned.page.url) };
  });
}
