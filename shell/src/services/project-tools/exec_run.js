// Tool: exec_run — run an arbitrary program inside the project root.
// EXECUTE permission; APPROVAL_REQUIRED.
//
// The renderer (or agent) supplies `command` and `argv` separately. We
// ALWAYS pass them to execFile, so no shell ever interprets them. No
// string interpolation happens. The cwd is pinned to projectRoot; the
// PATH is the user's PATH (we don't extend it). Approval tokens are
// checked by the IPC layer before this tool is called.

import { safeExecFile, errorEnvelope } from "./_runtime.js";
import { assertInsideProjectRoot } from "./security.js";
import { getActiveProjectRootFor } from "../../ipc/agent-root-registry.js";
import { Audit } from "../audit/index.js";

const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

// Tools we refuse to expose via exec_run, regardless of approval, because
// they would let the user re-define the sandbox from inside it.
const FORBIDDEN_COMMANDS = new Set([
  // Meta-shell interpreters
  "bash", "sh", "zsh", "fish", "cmd", "cmd.exe", "powershell", "pwsh",
  // Anything that could pivot to a shell
  "python", "python3", "perl", "ruby", "node", "deno", "bun",
]);

export const tool = {
  name: "exec_run",
  description:
    "Run an arbitrary program inside the project root. The command and argv are passed to execFile — no shell is ever involved. Requires explicit user approval.",
  permission: "EXECUTE",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute project root (defaults to ctx.projectRoot)" },
      command: { type: "string", description: "Executable name or absolute path" },
      argv: {
        type: "array",
        items: { type: "string" },
        description: "Arguments to pass (each as a separate array element — never a single shell-style string)",
      },
      timeoutMs: { type: "number", description: "Cap on execution time (default 60s)" },
      maxOutputBytes: { type: "number", description: "Cap on captured output (default 2 MiB)" },
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
  timeoutMs: 60_000,

  async execute(input, ctx) {
    if (!input || typeof input.command !== "string" || input.command.length === 0) {
      return errorEnvelope("invalid-input", "command is required");
    }
    if (input.argv && !Array.isArray(input.argv)) {
      return errorEnvelope("invalid-input", "argv must be an array of strings");
    }
    if (input.argv && !input.argv.every((a) => typeof a === "string")) {
      return errorEnvelope("invalid-input", "every argv entry must be a string");
    }
    const argv = Array.isArray(input.argv) ? input.argv : [];

    // Defense-in-depth: refuse shell-meta interpreters so even an
    // approval-approved call can't pivot to a shell. The agent must use
    // a direct binary path instead (which execFile still won't shell).
    const cmdBase = input.command.replace(/^.*[/\\]/, "").toLowerCase();
    if (FORBIDDEN_COMMANDS.has(cmdBase)) {
      return errorEnvelope(
        "permission-denied",
        `command '${cmdBase}' is not allowed; use a direct binary path instead`,
      );
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
    const requestedRoot = (input && typeof input.path === "string" && input.path) || projectRoot;
    const inside = assertInsideProjectRoot(requestedRoot, projectRoot);
    if (!inside.ok) return inside;
    const absRoot = inside.path;

    const timeoutMs = typeof input.timeoutMs === "number" && input.timeoutMs > 0
      ? Math.floor(input.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = typeof input.maxOutputBytes === "number" && input.maxOutputBytes > 0
      ? Math.floor(input.maxOutputBytes)
      : DEFAULT_MAX_OUTPUT_BYTES;

    const execStartedAt = Date.now();
    const res = await safeExecFile(input.command, argv, {
      cwd: absRoot,
      timeoutMs,
      maxOutputBytes,
      cancelSignal: ctx.cancelSignal,
    });

    // Audit: dedicated shell:exec event so the renderer's ShellHistoryFilter
    // can build a command-history UI without parsing the generic tool.* events.
    // The command text lives in input_summary; the exit code lives in `result`
    // (as a string for normalization parity); duration in durationMs.
    const execElapsedMs = Date.now() - execStartedAt;
    const commandStr = [input.command, ...argv].join(" ").trim();
    Audit.log({
      event: "shell:exec",
      profileId: ctx.profileId,
      projectId: ctx.projectId,
      agentId: ctx.agentId,
      tool: "exec_run",
      input_summary: commandStr,
      result: res.timedOut ? "timeout" : String(typeof res.code === "number" ? res.code : "null"),
      durationMs: execElapsedMs,
      detail: res.timedOut && res.signal
        ? `signal=${res.signal}`
        : null,
    });

    if (res.timedOut) {
      return { ok: true, result: { stdout: res.stdout, stderr: res.stderr, code: null, signal: res.signal, timedOut: true } };
    }

    return {
      ok: true,
      result: {
        stdout: res.stdout,
        stderr: res.stderr,
        code: res.code,
        signal: res.signal,
        timedOut: false,
      },
    };
  },
};
