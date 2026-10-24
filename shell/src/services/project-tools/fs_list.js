// Tool: fs_list — list files in a project directory (recursively).
// READ permission. Skips noisy directories (node_modules, .git, target,
// dist, build) by default.

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { errorEnvelope } from "./_runtime.js";
import { assertInsideProjectRoot } from "./security.js";
import { getActiveProjectRootFor } from "../../ipc/agent-root-registry.js";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".svelte-kit",
  ".cache",
  ".venv",
  "__pycache__",
  ".idea",
  ".vscode",
]);

function matchesGlob(name, glob) {
  if (!glob) return true;
  // Tiny glob support: only the "*" wildcard is interpreted; the rest of
  // the pattern is treated literally. Good enough for "*.rs", "README.*".
  const re = new RegExp(
    "^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
  );
  return re.test(name);
}

export const tool = {
  name: "fs_list",
  description:
    "List files in a project directory (recursively). Skips node_modules, .git, target, dist, build.",
  permission: "READ",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute project root (defaults to ctx.projectRoot)" },
      glob: { type: "string", description: "Optional glob pattern (only * supported)" },
      maxDepth: { type: "number", description: "Recursion depth (default 6)" },
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
            path: { type: "string" },
            type: { type: "string" }, // "file" | "dir"
            size: { type: "number" },
          },
        },
      },
    },
  },
  timeoutMs: 5_000,

  async execute(input, ctx) {
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
    // `input.path` may either pin us to a subdirectory of the project
    // root or be omitted (in which case the project root itself is the
    // listing target). Either way, the path must stay inside the
    // project root.
    const requestedRoot = (input && typeof input.path === "string" && input.path) || projectRoot;
    const inside = assertInsideProjectRoot(requestedRoot, projectRoot);
    if (!inside.ok) return inside;
    const absRoot = inside.path;

    const maxDepth = typeof input?.maxDepth === "number" && input.maxDepth >= 1 ? Math.floor(input.maxDepth) : 6;
    const glob = typeof input?.glob === "string" && input.glob.length > 0 ? input.glob : null;

    let rootStat;
    try {
      rootStat = await stat(absRoot);
    } catch (e) {
      return errorEnvelope("not-found", `path not found: ${absRoot}`);
    }
    if (!rootStat.isDirectory()) {
      return errorEnvelope("invalid-input", `path is not a directory: ${absRoot}`);
    }

    const entries = [];
    const queue = [{ dir: absRoot, depth: 0 }];
    const visited = new Set();

    while (queue.length) {
      if (ctx.isCancellable()) return errorEnvelope("cancelled", "tool cancelled");
      const { dir, depth } = queue.shift();
      if (visited.has(dir)) continue;
      visited.add(dir);

      let names;
      try {
        names = await readdir(dir);
      } catch (e) {
        // Skip directories we can't read (permission denied, etc).
        continue;
      }

      for (const name of names) {
        const full = path.join(dir, name);
        if (SKIP_DIRS.has(name)) continue;
        if (!matchesGlob(name, glob) && depth > 0) continue;
        let st;
        try {
          st = await stat(full);
        } catch {
          continue;
        }
        const rel = path.relative(absRoot, full).split(path.sep).join("/");
        if (st.isDirectory()) {
          entries.push({ path: rel, type: "dir", size: 0 });
          if (depth + 1 < maxDepth) queue.push({ dir: full, depth: depth + 1 });
        } else if (st.isFile()) {
          entries.push({ path: rel, type: "file", size: st.size });
        }
      }
    }

    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.path.localeCompare(b.path);
    });

    return { ok: true, result: { entries, root: absRoot, count: entries.length } };
  },
};