// Tool: inspect_project — return package.json + readme + top-N files.
// READ permission. The "everything an agent needs to plan" tool.

import { readFile, readdir, stat } from "node:fs/promises";
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
  ".cargo",
  "vendor",
]);

const DEFAULT_TOP_N = 50;
const MAX_README_BYTES = 64 * 1024;

async function readIfExists(abs, maxBytes) {
  try {
    const st = await stat(abs);
    if (!st.isFile()) return null;
    if (st.size > maxBytes) {
      // Read only the head of the file to give the agent a taste.
      // We approximate via readFile with an explicit byte-range cap; Node
      // doesn't expose a native byte-range read, so we fall back to a
      // string slice after a full read up to maxBytes.
      const fd = await readFile(abs, "utf8");
      return { content: fd.slice(0, maxBytes), truncated: true, size: st.size };
    }
    const fd = await readFile(abs, "utf8");
    return { content: fd, truncated: false, size: st.size };
  } catch {
    return null;
  }
}

async function detectReadme(absRoot) {
  for (const name of ["README.md", "README.MD", "readme.md", "README", "README.txt"]) {
    const found = await readIfExists(path.join(absRoot, name), MAX_README_BYTES);
    if (found) return { name, ...found };
  }
  return null;
}

async function detectPackageFiles(absRoot) {
  // Returns the contents of the first file in CANDIDATES that exists.
  const CANDIDATES = [
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "build.gradle",
    "build.gradle.kts",
    "pom.xml",
    "Gemfile",
  ];
  for (const name of CANDIDATES) {
    const found = await readIfExists(path.join(absRoot, name), 256 * 1024);
    if (found) return { name, ...found };
  }
  return null;
}

async function topFiles(absRoot, maxN) {
  const out = [];
  const queue = [{ dir: absRoot, depth: 0 }];
  const visited = new Set();

  while (queue.length && out.length < maxN * 4) {
    const { dir, depth } = queue.shift();
    if (visited.has(dir)) continue;
    visited.add(dir);
    let names;
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      if (SKIP_DIRS.has(name)) continue;
      let st;
      try { st = await stat(full); } catch { continue; }
      if (st.isFile()) {
        out.push({ path: path.relative(absRoot, full).split(path.sep).join("/"), size: st.size });
      } else if (st.isDirectory() && depth + 1 < 4) {
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }

  // Stable, useful ordering: prefer source files, then config, then docs.
  // Within a tier, sort by size ascending.
  const rank = (p) => {
    if (/\.(rs|ts|tsx|js|mjs|cjs|jsx|py|go|java|kt|c|h|cc|cpp|hpp|cs|rb|php)$/i.test(p)) return 0;
    if (/\.(json|toml|yaml|yml|toml)$/i.test(p)) return 1;
    if (/^(README|LICENSE|CONTRIBUTING|CHANGELOG)/i.test(p)) return 2;
    return 3;
  };
  out.sort((a, b) => {
    const ra = rank(a.path), rb = rank(b.path);
    if (ra !== rb) return ra - rb;
    return a.size - b.size;
  });

  return out.slice(0, maxN);
}

export const tool = {
  name: "inspect_project",
  description:
    "Return a summary of the project root: package descriptor, README, and top-N files. Useful as a first-call in a Project Mode session.",
  permission: "READ",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute project root (defaults to ctx.projectRoot)" },
      topN: { type: "number", description: "Number of top files to return (default 50, max 200)" },
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      root: { type: "string" },
      manifest: {
        type: "object",
        properties: {
          name: { type: "string" },
          content: { type: "string" },
          truncated: { type: "boolean" },
          size: { type: "number" },
        },
      },
      readme: {
        type: "object",
        properties: {
          name: { type: "string" },
          content: { type: "string" },
          truncated: { type: "boolean" },
          size: { type: "number" },
        },
      },
      topFiles: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
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
    const requestedRoot = (input && typeof input.path === "string" && input.path) || projectRoot;
    const inside = assertInsideProjectRoot(requestedRoot, projectRoot);
    if (!inside.ok) return inside;
    const absRoot = inside.path;

    const topN = typeof input?.topN === "number" && input.topN > 0
      ? Math.min(Math.floor(input.topN), 200)
      : DEFAULT_TOP_N;

    let rootStat;
    try {
      rootStat = await stat(absRoot);
    } catch (e) {
      return errorEnvelope("not-found", "project root not found");
    }
    if (!rootStat.isDirectory()) {
      return errorEnvelope("invalid-input", "path is not a directory");
    }

    const [manifest, readme, files] = await Promise.all([
      detectPackageFiles(absRoot),
      detectReadme(absRoot),
      topFiles(absRoot, topN),
    ]);

    return {
      ok: true,
      result: {
        root: absRoot,
        manifest,
        readme,
        topFiles: files,
        topN,
      },
    };
  },
};