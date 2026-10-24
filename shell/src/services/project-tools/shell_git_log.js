// Tool: shell_git_log — formatted `git log` on the project root.
// READ permission.

import { safeExecFile, errorEnvelope } from "./_runtime.js";
import { assertInsideProjectRoot } from "./security.js";

export const tool = {
  name: "shell_git_log",
  description: "Run `git log` inside the project root (formatted, one-line, capped).",
  permission: "READ",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute project root (defaults to ctx.projectRoot)" },
      maxCount: { type: "number", description: "Number of commits (default 20, max 200)" },
      format: { type: "string", description: "'oneline' (default) or 'full'" },
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      commits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            sha: { type: "string" },
            subject: { type: "string" },
            author: { type: "string" },
            date: { type: "string" },
          },
        },
      },
    },
  },
  timeoutMs: 5_000,

  async execute(input, ctx) {
    const root = (input && typeof input.path === "string" && input.path) || ctx.projectRoot;
    if (!root) return errorEnvelope("invalid-input", "path or ctx.projectRoot is required");
    const inside = assertInsideProjectRoot(root, ctx.projectRoot);
    if (!inside.ok) return inside;
    const absRoot = inside.path;

    const maxCount = typeof input?.maxCount === "number" && input.maxCount > 0
      ? Math.min(Math.floor(input.maxCount), 200)
      : 20;
    const format = input?.format === "full" ? "full" : "oneline";

    const pretty = format === "full"
      ? "%H%x09%an%x09%ad%x09%s"
      : "%H%x09%s";

    const res = await safeExecFile(
      "git",
      ["-C", absRoot, "log", `--pretty=format:${pretty}`, "--date=iso-strict", `-n`, String(maxCount)],
      { cwd: absRoot, timeoutMs: tool.timeoutMs, cancelSignal: ctx.cancelSignal },
    );
    if (res.timedOut) return errorEnvelope("timeout", "git log timed out");
    if (res.code !== 0 && res.code !== null) {
      return errorEnvelope("tool-failed", res.errorMessage || "git log failed");
    }

    const commits = (res.stdout || "")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\t");
        if (format === "full" && parts.length >= 4) {
          return { sha: parts[0], author: parts[1], date: parts[2], subject: parts.slice(3).join("\t") };
        }
        return { sha: parts[0] || "", subject: parts.slice(1).join("\t") || "" };
      });

    return { ok: true, result: { commits, root: absRoot, count: commits.length } };
  },
};
