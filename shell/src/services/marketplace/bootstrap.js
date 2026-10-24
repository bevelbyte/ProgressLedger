// Marketplace startup lifecycle.
//
// `services/marketplace/index.js` is inert until it is told where its
// containment root lives: every operation answers `no-root` while `_rootDir`
// is null. Before this module existed the ONLY callers of
// `configureMarketplace` were unit tests, so the secured service was
// unreachable from the real application and its centralized path-containment
// policy (./path-security.js) was never actually exercised at runtime.
//
// `shell/src/main.js` calls bootstrapMarketplace() exactly once, right after
// the plugin registry is initialized, because a marketplace item IS a plugin.
// This module is Electron-free so the production startup path can be driven
// directly by a plain `node --test` runner.
//
// The containment policy is neither bypassed nor duplicated here: we only hand
// the service its root and ask it to load.

import { Marketplace } from "./index.js";

/**
 * Configure + start the marketplace registry against a root directory.
 *
 * @param {string} rootDir  the active workspace directory
 * @returns {{ok: boolean, root: string|null, count: number, errors: Array}}
 */
export function bootstrapMarketplace(rootDir) {
  if (typeof rootDir !== "string" || !rootDir) {
    return { ok: false, root: null, count: 0, errors: [{ id: "*", reason: "no-root" }] };
  }
  Marketplace.configureMarketplace({ rootDir });
  const loaded = Marketplace.start();
  return {
    ok: loaded.ok === true,
    root: rootDir,
    count: loaded.count,
    errors: loaded.errors || [],
  };
}

/**
 * Flush the sidecar registry state on shutdown. Idempotent; never throws so
 * it is safe to call from an Electron `will-quit` handler.
 */
export function shutdownMarketplace() {
  try {
    return Marketplace.stop();
  } catch {
    return { ok: false };
  }
}
