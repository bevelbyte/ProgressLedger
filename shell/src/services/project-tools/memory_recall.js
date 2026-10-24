// Tool: memory_recall — surface the most relevant prior knowledge
// (project memory + recent task history) for the current objective.
//
// READ permission. The agent uses this at the top of a run to rehydrate
// the "important things the model needs to remember" that the flat
// transcript doesn't carry across runs. The retrieval is cheap
// (token-overlap ranker) and bounded by an output line cap.

import { errorEnvelope } from "./_runtime.js";
import { Memory } from "../memory/index.js";

const MAX_LINES = 200;

export const tool = {
  name: "memory_recall",
  description:
    "Recall relevant prior memory for this project. Returns project-memory entries (decisions, findings, preferences, architecture notes, risks) ranked by token-overlap with the query, plus recent task-history summaries. Use at the top of a run to rehydrate what the model already knows about this project.",
  permission: "READ",
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        description:
          "Optional filter on project_memory.kind: decision | finding | preference | architecture | risk.",
      },
      keyPrefix: {
        type: "string",
        description: "Optional key prefix to narrow the project-memory lookup.",
      },
      query: {
        type: "string",
        description:
          "Free-text query (usually the current objective). Used to rank project-memory entries by token overlap.",
      },
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      lines: { type: "array", items: { type: "string" } },
      entries: { type: "array" },
      taskHistory: { type: "array" },
      count: { type: "number" },
    },
  },
  timeoutMs: 5_000,

  async execute(input, ctx) {
    const projectId =
      ctx && typeof ctx.projectId === "number" ? ctx.projectId : null;
    if (!projectId) {
      return errorEnvelope(
        "invalid-input",
        "memory_recall requires projectId in the agent context",
      );
    }

    const opts = {};
    if (input && typeof input.kind === "string" && input.kind) {
      opts.kind = input.kind;
    }
    if (input && typeof input.keyPrefix === "string" && input.keyPrefix) {
      opts.keyPrefix = input.keyPrefix;
    }

    // Direct project list (with optional filters) — bounded by an
    // explicit max so a large project can't blow the timeout.
    const list = await Memory.projectList(projectId, { ...opts, limit: MAX_LINES });
    if (!list.ok) {
      return errorEnvelope(
        list.error?.code || "memory-failed",
        list.error?.message || "memory list failed",
      );
    }
    let entries = list.result || [];

    // Optional rank: only when the caller supplied a query. The list
    // service does no ranking itself.
    const query = input && typeof input.query === "string" ? input.query : "";
    if (query) {
      entries = rankByQuery(entries, query);
    }

    // Recent task history is always included (cheap, append-only).
    const tasks = await Memory.taskList(projectId, { limit: 10 });
    const taskHistory = tasks.ok ? tasks.result : [];

    const lines = entries.slice(0, MAX_LINES).map(formatLine);
    if (taskHistory.length) {
      lines.push("", "## recent runs");
      for (const t of taskHistory) {
        const tag = t.success ? "ok" : "fail";
        lines.push(`- [${tag}] ${t.summary}`);
      }
    }

    return {
      ok: true,
      result: {
        lines,
        entries: entries.slice(0, MAX_LINES),
        taskHistory,
        count: lines.length,
      },
    };
  },
};

function formatLine(e) {
  const conf = typeof e.confidence === "number" ? ` (confidence=${e.confidence.toFixed(2)})` : "";
  return `${e.kind}: ${e.key} = ${e.value}${conf}`;
}

function rankByQuery(entries, query) {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter(Boolean);
  if (tokens.length === 0) return entries;

  const STOP = new Set([
    "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "with",
    "is", "are", "be", "this", "that", "it", "as", "at", "by", "from",
  ]);
  const filt = tokens.filter((t) => !STOP.has(t));
  const use = filt.length ? filt : tokens;
  if (use.length === 0) return entries;

  const scored = entries.map((e) => {
    const hay = `${e.kind} ${e.key} ${e.value}`.toLowerCase();
    let hits = 0;
    for (const t of use) {
      if (hay.includes(t)) hits++;
    }
    return { e, score: hits };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.e.confidence !== a.e.confidence) return b.e.confidence - a.e.confidence;
    return (b.e.updatedAt || 0) - (a.e.updatedAt || 0);
  });
  return scored.map((s) => s.e);
}