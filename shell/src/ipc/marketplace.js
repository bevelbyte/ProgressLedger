import { safeHandle } from "../security/safe-handle.js";
// Marketplace — Electron-bound IPC surface.
//
// The handler BODIES live in ./marketplace-channels.js so the production wiring
// can be exercised by a plain `node --test` runner. This file registers them.
//
// Each registration below MUST stay a literal `safeHandle("<channel>", ...)`.
// `scripts/check-ipc.mjs` statically proves that every channel invoked from
// preload.cjs has a sender-authenticated safeHandle registration, and it only
// recognises that exact shape. Collapsing these into a loop would blind that
// guard, so it is deliberately explicit.
//
// SECURITY: Git installs strip the on-disk `install_path` field before
// returning to the renderer. The renderer must never learn the absolute
// location of a cloned marketplace item — that leaks <workspace>/marketplace
// filesystem layout and the user's machine username.

import { marketplaceHandlers } from "./marketplace-channels.js";

export function register(_ctx) {
  safeHandle("marketplace:install-local", marketplaceHandlers["marketplace:install-local"]);
  safeHandle("marketplace:install-git", marketplaceHandlers["marketplace:install-git"]);
  safeHandle("marketplace:list", marketplaceHandlers["marketplace:list"]);
  safeHandle("marketplace:get", marketplaceHandlers["marketplace:get"]);
  safeHandle("marketplace:enable", marketplaceHandlers["marketplace:enable"]);
  safeHandle("marketplace:disable", marketplaceHandlers["marketplace:disable"]);
  safeHandle("marketplace:uninstall", marketplaceHandlers["marketplace:uninstall"]);
  safeHandle("marketplace:update", marketplaceHandlers["marketplace:update"]);
}
