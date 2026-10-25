// Browser page registry — the main process's record of live Progress Ledger browser
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
// SCOPE. Phase 3 ADDS hibernation and LRU eviction (below); per-pane
// multi-page tabs, session restore and persistence remain later work. What it does
// implement is a bounded set of live pages so a bug cannot fork processes
// without limit; the cap is raised in later phases of the plan.

import { partitionFor, partitionForBrowser, sanitizeDisplayUrl, validateProfileId, validateBrowserProfileId, validateTempProfileId, isAllowedUrl } from "./policy.js";

/** How many live pages this build allows. Phase 3 raises it to 5 and adds LRU hibernation, so background pages sleep instead of refusing new ones. */
export const MAX_LIVE_PAGES = 5;

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
      hibernated: record.hibernated === true,
      browserProfile: record.browserProfile
        ? {
            localId: record.browserProfile.localId ?? null,
            displayName: record.browserProfile.displayName ?? "",
            color: record.browserProfile.color ?? null,
            isDefault: record.browserProfile.isDefault === true,
            temporary: record.browserProfile.temporary === true,
          }
        : null,
      attached: record.attached === true,
      crashed: record.state === PAGE_STATES.CRASHED,
      lastError: record.lastError ?? null,
      createdAt: record.createdAt,
    };
  }

  const api = {
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
    create({ profileId, browserProfile = null, liveCap = maxLive, url = "about:blank" } = {}) {
      if (!validateProfileId(profileId)) return { ok: false, reason: REASONS.NO_PROFILE };
      const target = isAllowedUrl(url);
      if (!target.ok) return { ok: false, reason: REASONS.INVALID_URL, detail: target.reason };
      // Phase 3B: the live cap is per WORKSPACE and shared across that
      // workspace's browser profiles (not per profile, not global). A
      // workspace never evicts another workspace's pages.
      const cap = Math.min(20, Math.max(1, Math.floor(Number(liveCap)) || maxLive));
      const ws = Number(profileId);
      if ([...pages.values()].filter((r) => r.view && r.profileId === ws).length >= cap) {
        const victim = [...pages.values()]
          .filter((r) => r.view && r.profileId === ws && r.visible !== true)
          .sort((a, b) => (a.lastUsed ?? a.createdAt) - (b.lastUsed ?? b.createdAt))[0];
        if (!victim) return { ok: false, reason: REASONS.LIVE_CAP };
        api.hibernate(victim.id);
      }

      // A browser profile, when given, must be well-formed; a malformed
      // one is refused rather than silently falling back to the legacy
      // partition (which would put the page in the wrong identity).
      let profile = null;
      if (browserProfile !== null && browserProfile !== undefined) {
        const shapeOk =
          (browserProfile.temporary === true && validateTempProfileId(browserProfile.localId)) ||
          (browserProfile.temporary !== true && validateBrowserProfileId(browserProfile.localId));
        if (!shapeOk) return { ok: false, reason: REASONS.NO_PROFILE };
        profile = {
          localId: browserProfile.localId,
          displayName: typeof browserProfile.displayName === "string" ? browserProfile.displayName : "",
          color: browserProfile.color ?? null,
          isDefault: browserProfile.isDefault === true,
          temporary: browserProfile.temporary === true,
        };
      }
      const id = mintId();
      const partition = partitionForBrowser(profileId, profile);
      if (!partition) return { ok: false, reason: REASONS.NO_PROFILE };

      // The full browser profile (when given) is forwarded to the view
      // factory, which is main-only: wirePage needs the policy fields
      // (WebRTC, proxy, headers) that the record's safe shape omits.
      const view = createView({ id, partition, browserProfile });
      const record = {
        id,
        view,
        partition,
        profileId: ws,
        browserProfile: profile,
        url: target.url,
        title: "",
        state: PAGE_STATES.LOADING,
        visible: false,
        attached: false,
        bounds: null,
        lastError: null,
        createdAt: now(),
        lastUsed: now(),
        hibernated: false,
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
      if (!record.view) return true;
      try {
        destroyView(id, record.view);
      } catch {
        // Teardown must never throw out of the registry: a page that fails to
        // close cleanly still has to leave the table, or the cap fills up with
        // zombies and the browser stops accepting new pages.
      }
      return true;
    },

    /**
     * Sleep a background page: tear its view down but keep the record, so
     * the tab survives and can wake at the same URL. Visible pages are
     * never slept (that would blank the screen); already-sleeping and
     * unknown pages report false. Returns true only when a view was torn down.
     */
    hibernate(pageId) {
      const record = pages.get(String(pageId));
      if (!record || !record.view || record.visible === true) return false;
      try {
        destroyView(record.id, record.view);
      } catch {
        // Teardown must never block the sleep: the record still leaves the
        // live set either way.
      }
      record.view = null;
      record.attached = false;
      record.visible = false;
      record.hibernated = true;
      record.hibernatedAt = now();
      return true;
    },

    /**
     * Wake a sleeping page: build a fresh view for the SAME id and
     * partition (the UI tab keeps pointing at it) and mark it loading.
     * The caller loads the stored URL; this only rebuilds the view.
     * A live page is a no-op returning its public shape.
     */
    wake(pageId, browserProfile = null) {
      const record = pages.get(String(pageId));
      if (!record) return { ok: false, reason: REASONS.UNKNOWN_PAGE };
      if (!record.hibernated) return { ok: true, page: toPublic(record) };
      // Prefer the full profile the caller supplies (the host passes its
      // stored copy); fall back to the record's safe shape so a wake
      // without one still wires the page to its identity.
      record.view = createView({ id: record.id, partition: record.partition, browserProfile: browserProfile ?? record.browserProfile });
      record.hibernated = false;
      record.hibernatedAt = null;
      record.state = PAGE_STATES.LOADING;
      record.lastUsed = now();
      return { ok: true, page: toPublic(record) };
    },

    /** Tear every page down (window close, app quit, test reset). */
    destroyAll() {
      for (const id of [...pages.keys()]) this.destroy(id);
    },
  };
  return api;
}
