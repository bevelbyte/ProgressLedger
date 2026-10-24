// Tool: shell_git_status — `git status --porcelain` on the project root.
// READ permission. Pins the repo with `git -C <root>` so the renderer
// cannot influence which repo is queried.

import { safeExecFile, errorEnvelope } from "./_runtime.js";
import { assertInsideProjectRoot } from "./security.js";

export const tool = {
  name: "shell_git_status",
  description: "Run `git status --porcelain` inside the project root.",
  permission: "READ",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute project root (defaults to ctx.projectRoot)" },
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            code: { type: "string" },
            path: { type: "string" },
          },
        },
      },
      branch: { type: "string" },
      clean: { type: "boolean" },
    },
  },
  timeoutMs: 5_000,

  async execute(input, ctx) {
    const root = (input && typeof input.path === "string" && input.path) || ctx.projectRoot;
    if (!root) return errorEnvelope("invalid-input", "path or ctx.projectRoot is required");
    const inside = assertInsideProjectRoot(root, ctx.projectRoot);
    if (!inside.ok) return inside;
    const absRoot = inside.path;

    const statusRes = await safeExecFile(
      "git",
      ["-C", absRoot, "status", "--porcelain"],
      { cwd: absRoot, timeoutMs: tool.timeoutMs, cancelSignal: ctx.cancelSignal },
    );
    if (statusRes.timedOut) return errorEnvelope("timeout", "git status timed out");
    if (statusRes.code !== 0 && statusRes.code !== null) {
      return errorEnvelope("tool-failed", statusRes.errorMessage || "git status failed");
    }

    const branchRes = await safeExecFile(
      "git",
      ["-C", absRoot, "rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: absRoot, timeoutMs: tool.timeoutMs, cancelSignal: ctx.cancelSignal },
    );

    const entries = (statusRes.stdout || "")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const code = line.slice(0, 2).trim();
        const filePath = line.slice(3).trim();
        return { code: code || "?", path: filePath };
      });

    return {
      ok: true,
      result: {
        entries,
        branch: branchRes.code === 0 ? (branchRes.stdout || "").trim() : null,
        clean: entries.length === 0,
        root: absRoot,
      },
    };
  },
};
