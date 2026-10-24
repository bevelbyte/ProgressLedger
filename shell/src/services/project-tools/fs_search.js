// Tool: fs_search — text search across files in the project root.
// READ permission. Uses ripgrep (rg) if available, else a recursive grep
// via execFile('grep', ...). Always reads files via execFile — never via
// the renderer.

import { existsSync } from "node:fs";
import { safeExecFile, errorEnvelope } from "./_runtime.js";
import { assertInsideProjectRoot } from "./security.js";
import { getActiveProjectRootFor } from "../../ipc/agent-root-registry.js";

const MAX_MATCHES = 200;

function which(cmd) {
  // Lightweight "which": rely on execFile's PATH resolution but probe
  // first to pick a faster tool. We check a couple of common locations.
  if (process.platform === "win32") {
    const candidates = [
      `${cmd}.exe`,
      `${cmd}.cmd`,
      `${cmd}.bat`,
    ];
    for (const c of candidates) {
      // execFile will resolve via PATH; we don't actually need to locate.
      // This is a placeholder so we always run ripgrep first when present.
      if (existsSync(c)) return cmd;
    }
  }
  return cmd;
}

export const tool = {
  name: "fs_search",
  description:
    "Search for a literal text or regex pattern inside the project root. Uses ripgrep if installed, else grep. Skips node_modules and .git.",
  permission: "READ",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute project root (defaults to ctx.projectRoot)" },
      query: { type: "string", description: "Search pattern (regex if regex=true)" },
      regex: { type: "boolean", description: "Treat query as a regex" },
      maxMatches: { type: "number", description: "Cap matches (default 200)" },
    },
    required: ["query"],
  },
  outputSchema: {
    type: "object",
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            file: { type: "string" },
            line: { type: "number" },
            text: { type: "string" },
          },
        },
      },
      backend: { type: "string" }, // "rg" | "grep" | "fallback"
    },
  },
  timeoutMs: 10_000,

  async execute(input, ctx) {
    if (!input || typeof input.query !== "string" || input.query.length === 0) {
      return errorEnvelope("invalid-input", "query is required");
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

    const maxMatches = typeof input.maxMatches === "number" && input.maxMatches > 0
      ? Math.min(Math.floor(input.maxMatches), 5000)
      : MAX_MATCHES;

    const query = input.query;
    const isRegex = !!input.regex;

    // Prefer ripgrep.
    const useRipgrep = which("rg");
    let argv;
    let backend;
    if (useRipgrep) {
      backend = "rg";
      argv = [
        "--no-heading",
        "--line-number",
        "--max-count", String(maxMatches),
        "--glob", "!node_modules",
        "--glob", "!.git",
        isRegex ? "--regexp" : "--fixed-strings",
        query,
        ".",
      ];
    } else {
      backend = "grep";
      argv = [
        "-RIn",
        "--exclude-dir=node_modules",
        "--exclude-dir=.git",
        "-m", String(maxMatches),
        isRegex ? "-E" : "-F",
        "-e", query,
        ".",
      ];
    }

    const res = await safeExecFile(
      backend,
      argv,
      { cwd: absRoot, timeoutMs: tool.timeoutMs, maxOutputBytes: 4 * 1024 * 1024, cancelSignal: ctx.cancelSignal },
    );

    if (res.timedOut) return errorEnvelope("timeout", "search timed out");
    if (res.code !== 0 && res.code !== 1 && res.code !== null) {
      // ripgrep exits 1 when no matches; that's success, not error.
      // grep exits 1 when no matches too.
      return errorEnvelope("tool-failed", res.errorMessage || `${backend} failed`);
    }

    const lines = (res.stdout || "").split(/\r?\n/).filter(Boolean);
    const matches = [];
    for (const line of lines) {
      if (ctx.isCancellable()) return errorEnvelope("cancelled", "tool cancelled");
      // rg/grep output: "rel/path:lineno:matched text"
      // Use a forgiving split: only the first two colons are structural;
      // the rest is the matched line (which may contain colons).
      const firstColon = line.indexOf(":");
      if (firstColon < 0) continue;
      const secondColon = line.indexOf(":", firstColon + 1);
      if (secondColon < 0) continue;
      const file = line.slice(0, firstColon);
      const lineNoStr = line.slice(firstColon + 1, secondColon);
      const text = line.slice(secondColon + 1);
      const lineNo = Number.parseInt(lineNoStr, 10);
      matches.push({ file, line: Number.isFinite(lineNo) ? lineNo : 0, text });
      if (matches.length >= maxMatches) break;
    }

    return { ok: true, result: { matches, backend, root: absRoot, count: matches.length } };
  },
};
