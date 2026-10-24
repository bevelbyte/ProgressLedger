// Tool: fs_read — read a single file from the project root.
// READ permission.

import { readFile, stat } from "node:fs/promises";
import { errorEnvelope } from "./_runtime.js";
import { assertInsideProjectRoot } from "./security.js";
import { getActiveProjectRootFor } from "../../ipc/agent-root-registry.js";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB

export const tool = {
  name: "fs_read",
  description:
    "Read a single file inside the project root. Returns UTF-8 text. Refuses paths outside the project root (including .. traversal).",
  permission: "READ",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute file path inside the project root" },
      maxBytes: { type: "number", description: "Cap on bytes returned (default 2 MiB)" },
    },
    required: ["path"],
  },
  outputSchema: {
    type: "object",
    properties: {
      content: { type: "string" },
      size: { type: "number" },
      truncated: { type: "boolean" },
      encoding: { type: "string" },
    },
  },
  timeoutMs: 5_000,

  async execute(input, ctx) {
    if (!input || typeof input.path !== "string" || !input.path) {
      return errorEnvelope("invalid-input", "path is required");
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

    const maxBytes = typeof input.maxBytes === "number" && input.maxBytes > 0
      ? Math.floor(input.maxBytes)
      : DEFAULT_MAX_BYTES;

    let st;
    try {
      st = await stat(abs);
    } catch (e) {
      return errorEnvelope("not-found", `file not found: ${abs}`);
    }
    if (!st.isFile()) return errorEnvelope("invalid-input", "path is not a file");
    if (st.size > maxBytes) {
      return errorEnvelope("invalid-input", `file too large (${st.size} bytes, max ${maxBytes})`);
    }

    let content;
    try {
      content = await readFile(abs, "utf8");
    } catch (e) {
      if (e && e.code === "EACCES") return errorEnvelope("permission-denied", "permission denied");
      return errorEnvelope("tool-failed", e?.message || "read failed");
    }
    return {
      ok: true,
      result: {
        content,
        size: st.size,
        truncated: false,
        encoding: "utf8",
      },
    };
  },
};