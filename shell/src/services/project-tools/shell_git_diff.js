// Tool: shell_git_diff — `git diff` (or `git diff --staged`) on the project root.
// READ permission. NOT in APPROVAL_REQUIRED — repo state is informational.

import { safeExecFile, errorEnvelope } from "./_runtime.js";
import { assertInsideProjectRoot } from "./security.js";

const DEFAULT_MAX_BYTES = 1 * 1024 * 1024;

export const tool = {
  name: "shell_git_diff",
  description: "Run `git diff` (or `git diff --staged`) inside the project root. Returns the unified diff.",
  permission: "READ",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute project root (defaults to ctx.projectRoot)" },
      staged: { type: "boolean", description: "Show staged diff (default false)" },
      maxBytes: { type: "number", description: "Cap diff size returned (default 1 MiB)" },
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      diff: { type: "string" },
      truncated: { type: "boolean" },
    },
  },
  timeoutMs: 10_000,

  async execute(input, ctx) {
    const root = (input && typeof input.path === "string" && input.path) || ctx.projectRoot;
    if (!root) return errorEnvelope("invalid-input", "path or ctx.projectRoot is required");
    const inside = assertInsideProjectRoot(root, ctx.projectRoot);
    if (!inside.ok) return inside;
    const absRoot = inside.path;

    const maxBytes = typeof input?.maxBytes === "number" && input.maxBytes > 0
      ? Math.floor(input.maxBytes)
      : DEFAULT_MAX_BYTES;

    const argv = ["-C", absRoot, "diff", "--no-color"];
    if (input?.staged === true) argv.push("--staged");

    const res = await safeExecFile(
      "git",
      argv,
      { cwd: absRoot, timeoutMs: tool.timeoutMs, maxOutputBytes: maxBytes + 1024, cancelSignal: ctx.cancelSignal },
    );
    if (res.timedOut) return errorEnvelope("timeout", "git diff timed out");
    if (res.code !== 0 && res.code !== null) {
      return errorEnvelope("tool-failed", res.errorMessage || "git diff failed");
    }

    let diff = res.stdout || "";
    let truncated = false;
    if (diff.length > maxBytes) {
      diff = diff.slice(0, maxBytes);
      truncated = true;
    }

    return { ok: true, result: { diff, truncated, root: absRoot } };
  },
};
