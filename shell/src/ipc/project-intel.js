import { safeHandle } from "../security/safe-handle.js";
// Project Intelligence Layer â€” IPC surface.
//
// Channels:
//   project:intel:index        â†’ (re)build the index for a project
//   project:intel:files        â†’ list files (optionally filtered)
//   project:intel:neighbors    â†’ BFS neighbors of a file in the import graph
//   project:intel:relevant     â†’ token-overlap relevant files for a query
//   project:intel:stats        â†’ aggregate stats
//
// The renderer never sees the path to the sidecar DB. All file-walks
// happen in the main process; the cache survives across runs because
// it lives under the user-data directory.

import { ipcMain } from "electron";
import { resolveProjectIntelContext } from "../security/project-intel-auth.js";
import {
  indexProject,
  reindexDelta,
  getFileList,
  getNeighbors,
  relevantFiles,
  getStats,
} from "../services/project-intel/index.js";

/**
 * Register the project-intel IPC channels.
 *
 * ctx = { core, win, notify }
 */
export function register(ctx) {
  async function authorized(payload) {
    return resolveProjectIntelContext(ctx && ctx.core, payload);
  }

  safeHandle("project:intel:index", async (_e, payload) => {
    const context = await authorized(payload);
    if (!context.ok) return context;
    const mode = payload && payload.mode === "delta" ? "delta" : "full";
    if (mode === "delta") {
      return reindexDelta(context.profileId, context.projectId, context.rootPath);
    }
    return indexProject(context.profileId, context.projectId, context.rootPath);
  });

  safeHandle("project:intel:files", async (_e, payload) => {
    const context = await authorized(payload);
    if (!context.ok) return context;
    const opts = {};
    if (payload && typeof payload.max === "number") opts.max = payload.max;
    if (payload && typeof payload.ext === "string") opts.ext = payload.ext;
    if (payload && typeof payload.glob === "string") opts.glob = payload.glob;
    return getFileList(context.profileId, context.projectId, opts, context.rootPath);
  });

  safeHandle("project:intel:neighbors", async (_e, payload) => {
    const context = await authorized(payload);
    if (!context.ok) return context;
    const filePath = payload && typeof payload.filePath === "string" ? payload.filePath : "";
    const depth = payload && typeof payload.depth === "number" ? payload.depth : 1;
    return getNeighbors(context.profileId, context.projectId, filePath, depth, context.rootPath);
  });

  safeHandle("project:intel:relevant", async (_e, payload) => {
    const context = await authorized(payload);
    if (!context.ok) return context;
    const query = payload && typeof payload.query === "string" ? payload.query : "";
    const max = payload && typeof payload.max === "number" ? payload.max : 20;
    return relevantFiles(context.profileId, context.projectId, query, max, context.rootPath);
  });

  safeHandle("project:intel:stats", async (_e, payload) => {
    const context = await authorized(payload);
    if (!context.ok) return context;
    return getStats(context.profileId, context.projectId, context.rootPath);
  });
}
