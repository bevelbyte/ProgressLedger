// Project Mode — Memory layer IPC surface.
//
// Channels:
//   memory:project-set       → write a (kind, key, value) entry into project memory
//   memory:project-list      → list project-memory entries (filterable)
//   memory:context-packet    → build a token-overlap-ranked context packet
//                              for the current objective
//   memory:list              → read-only combined view across session_memory,
//                              project_memory, and task_history for the
//                              MemoryViewer panel. Read-only; no writes.
//
// The renderer never sees the sidecar DB path. All persistence happens in
// the main process; the cache lives under <userData>/project-memory/.

import { safeHandle } from "../security/safe-handle.js";
import { authorizeAgentRecord, authorizeProjectRecord } from "../security/project-mode-auth.js";
import {
  projectSet,
  projectList,
  sessionList,
  taskList,
  buildContextPacket,
} from "../services/memory/index.js";

const MAX_RENDERER_TEXT = 8192;
const MAX_RENDERER_ROWS = 600;
function rendererText(value) {
  return typeof value === "string" ? value.slice(0, MAX_RENDERER_TEXT) : value;
}


/**
 * Register the memory IPC channels.
 *
 * ctx = { core, win, notify }
 */
async function assertProjectOwned(ctx, profileId, projectId) {
  if (!Number.isInteger(profileId) || profileId <= 0 || !Number.isInteger(projectId) || projectId <= 0) {
    return { ok: false, error: { code: "invalid-input", message: "profileId and projectId are required" } };
  }
  if (!ctx?.core || typeof ctx.core.pmGetProject !== "function") {
    return { ok: false, error: { code: "core-not-wired", message: "project ownership cannot be verified" } };
  }
  try {
    const project = await Promise.resolve(ctx.core.pmGetProject(profileId, projectId));
    return authorizeProjectRecord(profileId, projectId, project);
  } catch {
    return { ok: false, error: { code: "project-ownership-check-failed", message: "project ownership could not be verified" } };
  }
}

export function register(ctx) {
  safeHandle("memory:project-set", async (_e, payload) => {
    const profileId = payload && typeof payload.profileId === "number" ? payload.profileId : 0;
    const projectId = payload && typeof payload.projectId === "number" ? payload.projectId : 0;
    const kind = payload && typeof payload.kind === "string" ? payload.kind : "";
    const key = payload && typeof payload.key === "string" ? payload.key : "";
    const value = payload && typeof payload.value === "string" ? payload.value : "";
    const confidence = payload && typeof payload.confidence === "number" ? payload.confidence : 1.0;
    if (!profileId || !projectId) return { ok: false, error: { code: "invalid-input", message: "profileId and projectId are required" } };
    const ownership = await assertProjectOwned(ctx, profileId, projectId);
    if (!ownership.ok) return ownership;
    return projectSet(projectId, kind, key, value, confidence);
  });

  safeHandle("memory:project-list", async (_e, payload) => {
    const profileId = payload && typeof payload.profileId === "number" ? payload.profileId : 0;
    const projectId = payload && typeof payload.projectId === "number" ? payload.projectId : 0;
    if (!profileId || !projectId) return { ok: false, error: { code: "invalid-input", message: "profileId and projectId are required" } };
    const ownership = await assertProjectOwned(ctx, profileId, projectId);
    if (!ownership.ok) return ownership;
    const opts = {};
    if (payload && typeof payload.kind === "string") opts.kind = payload.kind;
    if (payload && typeof payload.keyPrefix === "string") opts.keyPrefix = payload.keyPrefix;
    if (payload && typeof payload.limit === "number") opts.limit = Math.min(Math.max(Math.floor(payload.limit), 1), MAX_RENDERER_ROWS);
    else opts.limit = MAX_RENDERER_ROWS;
    const result = await projectList(projectId, opts);
    if (result?.ok && Array.isArray(result.result)) result.result = result.result.map((r) => ({ ...r, key: rendererText(r.key), value: rendererText(r.value) }));
    return result;
  });

  safeHandle("memory:context-packet", async (_e, payload) => {
    const profileId = payload && typeof payload.profileId === "number" ? payload.profileId : 0;
    const projectId = payload && typeof payload.projectId === "number" ? payload.projectId : 0;
    const objective = payload && typeof payload.objective === "string" ? payload.objective : "";
    const maxTokens = payload && typeof payload.maxTokens === "number" ? Math.min(Math.max(Math.floor(payload.maxTokens), 1), 8000) : 2000;
    if (!profileId || !projectId) return { ok: false, error: { code: "invalid-input", message: "profileId and projectId are required" } };
    const ownership = await assertProjectOwned(ctx, profileId, projectId);
    if (!ownership.ok) return ownership;
    return buildContextPacket(projectId, objective, maxTokens);
  });

  // memory:list — combined read-only view for the MemoryViewer panel.
  //
  // Returns one flat list with a stable `scope` field per row:
  //   "project"   — project_memory row (the kind/key/value contextPacket source)
  //   "session"   — session_memory row (per-agent transient, requires agentId)
  //   "task"      — task_history row (append-only run summaries)
  //
  // When agentId is omitted, session entries are skipped. The renderer
  // also passes an optional `scopes` array to narrow the view.
  safeHandle("memory:list", async (_e, payload) => {
    const profileId = payload && typeof payload.profileId === "number" ? payload.profileId : 0;
    const projectId = payload && typeof payload.projectId === "number" ? payload.projectId : 0;
    const agentId = payload && typeof payload.agentId === "string" ? payload.agentId : null;
    if (!profileId || !projectId) return { ok: false, error: { code: "invalid-input", message: "profileId and projectId are required" } };
    const ownership = await assertProjectOwned(ctx, profileId, projectId);
    if (!ownership.ok) return ownership;

    const scopes = payload && Array.isArray(payload.scopes)
      ? new Set(payload.scopes.filter((s) => typeof s === "string"))
      : new Set(["project", "session", "task"]);

    const out = [];
    if (scopes.has("project")) {
      const res = await projectList(projectId, { limit: MAX_RENDERER_ROWS });
      if (res && res.ok && Array.isArray(res.result)) {
        for (const r of res.result) {
          if (out.length >= MAX_RENDERER_ROWS) break;
          out.push({
            id: `project:${r.kind}:${r.key}`,
            scope: "project",
            kind: r.kind,
            key: rendererText(r.key),
            value: rendererText(r.value),
            confidence: r.confidence,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
          });
        }
      }
    }
    if (scopes.has("session") && agentId) {
      const numericAgentId = Number(agentId);
      if (!Number.isInteger(numericAgentId) || numericAgentId <= 0) return { ok: false, error: { code: "invalid-input", message: "agentId must be a valid agent id" } };
      let agent = null;
      try { agent = ctx?.core && typeof ctx.core.pmGetAgent === "function" ? await Promise.resolve(ctx.core.pmGetAgent(profileId, numericAgentId)) : null; } catch { agent = null; }
      const agentOwnership = authorizeAgentRecord(profileId, numericAgentId, agent);
      if (!agentOwnership.ok) return agentOwnership;
      const res = await sessionList(projectId, agentId);
      if (res && res.ok && Array.isArray(res.result)) {
        for (const r of res.result) {
          if (out.length >= MAX_RENDERER_ROWS) break;
          out.push({
            id: `session:${agentId}:${r.key}`,
            scope: "session",
            kind: "session",
            key: rendererText(r.key),
            value: rendererText(r.value),
            agentId,
            createdAt: r.createdAt,
          });
        }
      }
    }
    if (scopes.has("task")) {
      const res = await taskList(projectId, { limit: 200 });
      if (res && res.ok && Array.isArray(res.result)) {
        for (const r of res.result) {
          if (out.length >= MAX_RENDERER_ROWS) break;
          out.push({
            id: `task:${r.id}`,
            scope: "task",
            kind: "task",
            key: `run-${r.id}`,
            value: rendererText(r.summary),
            agentId: r.agentId,
            success: r.success,
            createdAt: r.createdAt,
          });
        }
      }
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return { ok: true, result: out };
  });
}
