// Tool: fs_write — write (or overwrite) a file inside the project root.
// WRITE permission; APPROVAL_REQUIRED.
//
// Atomic write: write to <path>.cf-tmp-<random>, then rename. On Windows,
// rename is atomic for files on the same volume.
//
// Write-conflict protection: before doing the actual write, the tool
// acquires a reservation on the target path through the sidecar
// `file-reservations` store. A sibling agent that already holds the path
// in flight causes the tool to return `{ ok: false, error: { code:
// 'path-reserved-by-sibling', ... } }` WITHOUT touching the filesystem.
// The reservation is released in a `finally` block regardless of outcome.

import { writeFile, rename, unlink, stat, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { errorEnvelope } from "./_runtime.js";
import { assertInsideProjectRoot } from "./security.js";
import {
  acquireReservation,
  releaseReservation,
  normalizePath,
} from "../file-reservations.js";
import { getActiveProjectRootFor } from "../../ipc/agent-root-registry.js";

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB

export const tool = {
  name: "fs_write",
  description:
    "Write (or overwrite) a file inside the project root. Atomic via temp+rename. Requires user approval.",
  permission: "WRITE",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute file path inside the project root" },
      content: { type: "string", description: "UTF-8 file content" },
      createDirs: { type: "boolean", description: "Create parent directories if missing (default false)" },
    },
    required: ["path", "content"],
  },
  outputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      bytes: { type: "number" },
    },
  },
  timeoutMs: 5_000,

  async execute(input, ctx) {
    if (!input || typeof input.path !== "string" || !input.path) {
      return errorEnvelope("invalid-input", "path is required");
    }
    if (typeof input.content !== "string") {
      return errorEnvelope("invalid-input", "content must be a string");
    }
    if (input.content.length > DEFAULT_MAX_BYTES) {
      return errorEnvelope("invalid-input", `content too large (${input.content.length} bytes, max ${DEFAULT_MAX_BYTES})`);
    }

    const projectRoot = ctx.projectRoot || getActiveProjectRootFor(ctx.profileId, ctx.agentId);
    if (!projectRoot) {
      return {
        ok: false,
        error: {
          code: "project-root-not-set",
          message: "no active project root for this agent; the agent loop must call setActiveProjectRootFor before invoking tools",
        },
      };
    }
    const inside = assertInsideProjectRoot(input.path, projectRoot);
    if (!inside.ok) return inside;
    const abs = inside.path;
    const normalizedAbs = normalizePath(abs);

    // Write-conflict check. We require profileId + projectId + agentId in
    // the context so that two parallel agents can be distinguished.
    // Without those, we cannot look up the reservation tuple and the
    // tool simply refuses — safe-by-default.
    const profileId = ctx && typeof ctx.profileId === "number" ? ctx.profileId : null;
    const projectId = ctx && typeof ctx.projectId === "number" ? ctx.projectId : null;
    const agentId = ctx && typeof ctx.agentId === "number" ? ctx.agentId : null;
    if (profileId === null || projectId === null || agentId === null) {
      return errorEnvelope(
        "invalid-input",
        "fs_write requires ctx.profileId, ctx.projectId, ctx.agentId",
      );
    }

    const acquired = await acquireReservation(profileId, projectId, agentId, normalizedAbs, "write");
    if (!acquired.ok) {
      // If the store is simply not initialized (e.g. in unit tests that
      // never boot the Electron main process), we do NOT block the
      // write. Production wires initReservationsStore in main.js; this
      // branch keeps test fixtures simple without weakening production.
      if (acquired.error && acquired.error.code === "not-initialized") {
        return await writeFileInside(input, abs);
      }
      if (acquired.heldBy) {
        const since = acquired.heldBy.since || "unknown";
        return {
          ok: false,
          error: {
            code: "path-reserved-by-sibling",
            message:
              `path is reserved by sibling agent ${acquired.heldBy.agentId} ` +
              `(mode=${acquired.heldBy.mode}, since=${since}); parent must re-plan`,
          },
        };
      }
      return errorEnvelope(
        "reservation-failed",
        acquired.error ? acquired.error.message : "reservation acquire failed",
      );
    }

    const reservationId = acquired.reservationId;
    try {
      return await writeFileInside(input, abs);
    } finally {
      // Always release. Even on success, release so the path is freed
      // for the next sibling call. The sweeper handles the crash case.
      try { await releaseReservation(reservationId); } catch { /* best effort */ }
    }
  },
};

/**
 * Inner helper that performs the actual write. Kept separate from the
 * reservation bookkeeping so the `finally` in `execute` is unambiguous.
 */
async function writeFileInside(input, abs) {
  if (input.createDirs === true) {
    const parent = path.dirname(abs);
    try {
      await mkdir(parent, { recursive: true });
    } catch (e) {
      if (e && e.code !== "EEXIST") {
        return errorEnvelope("tool-failed", `mkdir failed: ${e.message}`);
      }
    }
  } else {
    // Make sure the parent exists; reject silently otherwise so the
    // caller knows they need to opt in to createDirs.
    try {
      const ps = await stat(path.dirname(abs));
      if (!ps.isDirectory()) {
        return errorEnvelope("not-found", "parent directory does not exist");
      }
    } catch {
      return errorEnvelope("not-found", "parent directory does not exist");
    }
  }

  const tmp = `${abs}.cf-tmp-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(tmp, input.content, "utf8");
    await rename(tmp, abs);
  } catch (e) {
    // Best-effort cleanup.
    try { await unlink(tmp); } catch {}
    if (e && e.code === "EACCES") return errorEnvelope("permission-denied", "permission denied");
    return errorEnvelope("tool-failed", e?.message || "write failed");
  }

  return { ok: true, result: { path: abs, bytes: Buffer.byteLength(input.content, "utf8") } };
}