// Per-agent project-root registry.
//
// The agent loop registers the root it is working on at run-start and
// drops it at run-end; tools resolve the root from this Map at execute
// time, scoped by the (profileId, agentId) tuple. Multi-session support
// is built in because each tuple has its own entry; there is no global
// "active" root.
//
// This module is intentionally Electron-free so unit tests can import it
// from a plain `node --test` runner. The IPC layer in
// `shell/src/ipc/project-tools.js` re-exports these helpers and exposes
// them through `ctx.projectTools`.

const activeProjectRoots = new Map(); // key -> rootPath

function rootKey(profileId, agentId) {
  return `${profileId}:${agentId}`;
}

export function setActiveProjectRootFor(profileId, agentId, rootPath) {
  if (typeof profileId !== "number" || typeof agentId !== "number") return;
  if (typeof rootPath !== "string" || rootPath.length === 0) return;
  activeProjectRoots.set(rootKey(profileId, agentId), rootPath);
}

export function getActiveProjectRootFor(profileId, agentId) {
  if (typeof profileId !== "number" || typeof agentId !== "number") return null;
  return activeProjectRoots.get(rootKey(profileId, agentId)) || null;
}

export function clearActiveProjectRootFor(profileId, agentId) {
  if (typeof profileId !== "number" || typeof agentId !== "number") return;
  activeProjectRoots.delete(rootKey(profileId, agentId));
}

/** Test helper: drop every per-agent project root. */
export function _resetActiveProjectRoots() {
  activeProjectRoots.clear();
}