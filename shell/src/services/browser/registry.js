// Browser page registry — the main process's record of live CareerFlow browser
// pages. Phase 1 of the approved D2-D6 plan.
//
// WHY A REGISTRY AT ALL. The renderer must never hold a `WebContentsView`, a
// `webContents`, a partition name or a URL it can make main load on command. It
// holds an OPAQUE page id, minted here, and every operation goes through main,
// which validates that id against this table first. That indirection is the
// whole security posture of the embedded browser, so it exists from Phase 1
// even though Phase 1 only ever needs one page.
//
// There is no electron import here on purpose: the view factory is injected, so
// the lifecycle (mint / look up / cap / destroy / sanitize) is unit-testable in
// plain Node — the same split as `workspace/model.js` (pure) vs its store.
//
// SCOPE. Phase 1 deliberately does NOT implement hibernation, LRU eviction,
// per-pane multi-page tabs, session restore or persistence. What it does
// implement is a bounded set of live pages so a bug cannot fork processes
// without limit; the cap is raised in later phases of the plan.

import { partitionFor, sanitizeDisplayUrl, validateProfileId, isAllowedUrl } from "./policy.js";

/** How many live pages this build allows. Raised by a later phase's plan. */
export const MAX_LIVE_PAGES = 4;

export const PAGE_STATES = Object.freeze({
  LOADING: "loading",
  READY: "ready",
  FAILED: "failed",
  CRASHED: "crashed",
});

export const REASONS = Object.freeze({
  INVALID_URL: "invalid-url",
  NO_PROFILE: "no-profile",
  LIVE_CAP: "live-cap-reached",
  UNKNOWN_PAGE: "unknown-page",
  CLOSED: "closed",
});

/**
 * @param {object} deps
 * @param {(spec: {id: string, partition: string}) => any} deps.createView
 *   Builds the real WebContentsView (or a fake in tests). Called exactly once
 *   per page id, before the page is reachable through the registry.
 * @param {(id: string) => void} [deps.destroyView]  Tear a view down.
 * @param {number} [deps.maxLive]
 * @param {() => number} [deps.now]
 */
export function createBrowserRegistry(deps = {}) {
  const {
    createView,
    destroyView = () => {},
    maxLive = MAX_LIVE_PAGES,
    now = () => Date.now(),
  } = deps;
  if (typeof createView !== "function") {
    throw new Error("createBrowserRegistry requires createView");
  }

  /** @type {Map<string, object>} */
  const pages = new Map();
  let seq = 0;

  const mintId = () => `bp-${(seq += 1)}`;

  /** The renderer-visible shape. Nothing transport-, path- or session-shaped. */
  function toPublic(record) {
    return {
      id: record.id,
      url: sanitizeDisplayUrl(record.url),
      title: typeof record.title === "string" ? record.title.slice(0, 512) : "",
      state: record.state,
      loading: record.state === PAGE_STATES.LOADING,
      insecure: typeof record.url === "string" && record.url.startsWith("http://"),
      visible: record.visible === true,
      attached: record.attached === true,
      crashed: record.state === PAGE_STATES.CRASHED,
      lastError: record.lastError ?? null,
      createdAt: record.createdAt,
    };
  }

  return {
    maxLive,
    reasons: REASONS,

    /** Sanitized snapshot of every live page, oldest first. */
    list() {
      return [...pages.values()].map(toPublic);
    },

    /** The public shape of one page, or null. */
    get(pageId) {
      const record = pages.get(String(pageId));
      return record ? toPublic(record) : null;
    },

    /** The INTERNAL record — main-process modules only, never over IPC. */
    record(pageId) {
      return pages.get(String(pageId)) ?? null;
    },

    count() {
      return pages.size;
    },

    /**
     * Mint a page. The profile id decides the partition (approved decision B);
     * an invalid id is refused rather than guessed at, because guessing would
     * silently drop the page into the wrong browser identity.
     */
    create({ profileId, url = "about:blank" } = {}) {
      if (!validateProfileId(profileId)) return { ok: false, reason: REASONS.NO_PROFILE };
      const target = isAllowedUrl(url);
      if (!target.ok) return { ok: false, reason: REASONS.INVALID_URL, detail: target.reason };
      if (pages.size >= maxLive) return { ok: false, reason: REASONS.LIVE_CAP };

      const id = mintId();
      const partition = partitionFor(profileId);
      if (!partition) return { ok: false, reason: REASONS.NO_PROFILE };

      const view = createView({ id, partition });
      const record = {
        id,
        view,
        partition,
        profileId: Number(profileId),
        url: target.url,
        title: "",
        state: PAGE_STATES.LOADING,
        visible: false,
        attached: false,
        bounds: null,
        lastError: null,
        createdAt: now(),
      };
      pages.set(id, record);
      return { ok: true, page: toPublic(record) };
    },

    /** Mutate the record's own bookkeeping. Unknown ids are a no-op. */
    update(pageId, patch = {}) {
      const record = pages.get(String(pageId));
      if (!record) return null;
      Object.assign(record, patch);
      return record;
    },

    /** Forget a page and tear its view down. Idempotent. */
    destroy(pageId) {
      const id = String(pageId);
      const record = pages.get(id);
      if (!record) return false;
      pages.delete(id);
      try {
        destroyView(id, record.view);
      } catch {
        // Teardown must never throw out of the registry: a page that fails to
        // close cleanly still has to leave the table, or the cap fills up with
        // zombies and the browser stops accepting new pages.
      }
      return true;
    },

    /** Tear every page down (window close, app quit, test reset). */
    destroyAll() {
      for (const id of [...pages.keys()]) this.destroy(id);
    },
  };
}
