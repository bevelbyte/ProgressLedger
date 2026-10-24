// Tool: build_run — run the project's build command.
// EXECUTE permission; NOT approval-required. Same shape as test_run —
// the agent supplies command + argv. Always cwd = projectRoot; never a
// shell.

import { safeExecFile, errorEnvelope } from "./_runtime.js";
import { assertInsideProjectRoot, validateProjectCommand } from "./security.js";
import { resolveApprovedProjectCommand } from "./command-resolution.js";
import { getActiveProjectRootFor } from "../../ipc/agent-root-registry.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export const tool = {
  name: "build_run",
  description:
    "Run the project's build command inside the project root. Uses execFile — no shell. No approval required (Project Mode opt-in).",
  permission: "EXECUTE",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute project root (defaults to ctx.projectRoot)" },
      command: { type: "string", description: "Executable name or absolute path" },
      argv: {
        type: "array",
        items: { type: "string" },
        description: "Arguments to pass",
      },
      timeoutMs: { type: "number", description: "Cap on execution time (default 10 min)" },
    },
    required: ["command"],
  },
  outputSchema: {
    type: "object",
    properties: {
      stdout: { type: "string" },
      stderr: { type: "string" },
      code: { type: "number" },
      signal: { type: "string" },
      timedOut: { type: "boolean" },
    },
  },
  timeoutMs: 10 * 60 * 1000,

  async execute(input, ctx) {
    if (!input || typeof input.command !== "string" || input.command.length === 0) {
      return errorEnvelope("invalid-input", "command is required");
    }
    if (input.argv && !Array.isArray(input.argv)) {
      return errorEnvelope("invalid-input", "argv must be an array of strings");
    }
    const argv = Array.isArray(input.argv) ? input.argv : [];

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
    const requestedRoot = (input && typeof input.path === "string" && input.path) || projectRoot;
    const inside = assertInsideProjectRoot(requestedRoot, projectRoot);
    if (!inside.ok) return inside;
    const absRoot = inside.path;

    const commandCheck = validateProjectCommand(input.command);
    if (!commandCheck.ok) return commandCheck;

    const timeoutMs = typeof input.timeoutMs === "number" && input.timeoutMs > 0
      ? Math.floor(input.timeoutMs)
      : DEFAULT_TIMEOUT_MS;

    const resolved = resolveApprovedProjectCommand(input.command, argv);
    if (resolved.error) return { ok: false, error: resolved.error };

    const res = await safeExecFile(resolved.command, resolved.argv, {
      cwd: absRoot,
      timeoutMs,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      cancelSignal: ctx.cancelSignal,
    });

    return {
      ok: true,
      result: {
        stdout: res.stdout,
        stderr: res.stderr,
        code: res.code,
        signal: res.signal,
        timedOut: res.timedOut,
      },
    };
  },
};
