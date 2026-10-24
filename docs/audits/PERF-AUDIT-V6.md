# GATE 20 — Performance Audit Report

**Date:** 2026-08-31  
**Commit:** 634f2d2  
**Auditor:** hcnsec (slot 3)  
**Scope:** Agent loop, context builder, project-intel, memory service, IPC layer

---

## Per-Round Work: What ONE Loop Iteration Does

A single iteration of the `while (true)` loop in `loop.js` (lines 628-976) performs:

| Operation | Frequency per round | Cost class |
|---|---|---|
| `pickNextReadyBatch(plan, batchSize)` | 1 | Pure JS, O(steps) |
| `markStep` × batchSize | 1-3 | Pure JS, O(1) each |
| `core.pmUpdateAgent` (plan persist) | 1 | NAPI roundtrip, serializes full plan_json |
| `prov.streamChat` | 1 | Network/model call (dominant cost) |
| `core.pmAppendMessage` (assistant text) | 0-1 | NAPI roundtrip |
| `core.pmAppendMessage` (tool_call JSON) | 0-1 | NAPI roundtrip |
| `core.pmAppendMessage` (tool_result) × toolCalls | 0-N | NAPI roundtrips, one per tool |
| `core.pmUpdateAgent` (state transitions) | 2-4 | NAPI roundtrips, each serializes plan_json |
| `isPlanComplete`, `classifyStall`, `canTransition` | Several | Pure JS, negligible |

**Per-round NAPI call count:** ~5-10 roundtrips into Rust (excluding the model call).  
**Per-round plan_json serialization count:** 3-5 times (each `pmUpdateAgent` re-serializes the full plan).

---

## Identified Bottlenecks

### BOTTLENECK 1: ProjectIntel full table scan per agent run

**File:** `shell/src/services/project-intel/index.js:790`  
**Line:** `const rows = db.prepare('SELECT path FROM files').all();`  
**Measurable impact:** For a project with 50,000 indexed files, `relevantFiles` transfers 50,000 path strings from SQLite into JS heap, then ranks them in-process. This happens once per agent run (called from `context-builder.js:159`).  
**Current mitigation:** The result is capped to `max=20` after ranking, but the full scan happens first.  
**Fix proposal (1-3 lines):** Add a lightweight SQL WHERE filter for the top tokens before the full scan, or use a virtual table / FTS index. Smallest correct change: limit the SQL result set size and rank fewer candidates.

### BOTTLENECK 2: Memory projectList full scan per agent run

**File:** `shell/src/services/memory/index.js:299-307`  
**Lines:** `SELECT kind, key, value, confidence, created_at, updated_at FROM project_memory WHERE project_id = ? ORDER BY kind ASC, key ASC`  
**Measurable impact:** Every agent run calls `buildContextPacket` (loop.js:501) which calls `projectList` and retrieves ALL project memory entries, then ranks them by token overlap in JS. For projects with hundreds of memory entries, this is O(N) data transfer + O(N*M) ranking (N entries × M query tokens).  
**Fix proposal (1-3 lines):** Add a `LIMIT` clause to the SQL query (e.g. 100) and push the token-overlap scoring into SQL using a simple LIKE-based filter. Smallest correct change: `SELECT ... WHERE project_id = ? AND (kind LIKE ? OR key LIKE ? OR value LIKE ?) ORDER BY ... LIMIT 100`.

### BOTTLENECK 3: Multiple pmUpdateAgent calls per round (plan re-serialization)

**File:** `shell/src/services/agent/loop.js`  
**Lines:** 697, 816, 831, 857, 900, 909, 914, 933, 950, 973, 975  
**Measurable impact:** The plan JSON is serialized and sent over NAPI on every state transition. A round with 3 tool calls can trigger 5-7 `pmUpdateAgent` calls, each serializing the full plan (which can be 10KB+ for a 20-step plan). That's 50-70KB of redundant NAPI payload per round.  
**Fix proposal (1-3 lines):** Batch the plan persist with the state transition — add a `planJson` parameter to a combined `pmTransitionAndUpdatePlan` NAPI call, or cache the serialized plan_json and only send it when it actually changed. Smallest correct change: in `transition()` (loop.js:278), skip the write when `planJson` is unchanged from the prior call.

### BOTTLENECK 4: 500ms polling fallback in delegate_research

**File:** `shell/src/services/project-tools/delegate_research.js:165,183,193`  
**Lines:** `const POLL_MS = 500;` and the `Promise.race([waitForEvent, waitForPoll])` loop  
**Measurable impact:** A parent waiting for a sub-agent polls `getChildState` every 500ms. `getChildState` (loop.js:105) has a 200ms cache, so every other poll hits the NAPI `pmGetAgent`. For a 30-second sub-agent task, that's ~60 poll iterations, ~30 NAPI calls, all unnecessary if the event-driven wake-up works.  
**Fix proposal (1-3 lines):** Increase `POLL_MS` to 2000ms (the event is the primary wake mechanism; the poll is only a safety net for missed events). Smallest correct change: change `const POLL_MS = 500` to `const POLL_MS = 2000` on line 165.

### BOTTLENECK 5: Per-tool pmAppendMessage roundtrips

**File:** `shell/src/services/agent/loop.js:917-918`  
**Line:** `await appendToolResult(core, profileId, agentId, tc.id, tool.name, result);` inside the `for (const tc of toolCalls)` loop  
**Measurable impact:** Each tool result is persisted via a separate `pmAppendMessage` NAPI call. For a round with 5 tool calls, that's 5 separate NAPI roundtrips. Combined with the tool_call append (line 858) and assistant text append (line 806), a single round with 5 tools = 7 NAPI message roundtrips.  
**Fix proposal (1-3 lines):** Batch tool result appends into a single NAPI call `pmAppendMessages` that accepts an array of messages. Smallest correct change: accumulate tool results in an array and call a new batched NAPI function once per round.

---

## What Is Already Optimized (No Action Needed)

| Concern | Current state | Verdict |
|---|---|---|
| ProjectIntel index built per project, not per round | `indexProject` is called externally; `relevantFiles` reads the cache | Correct |
| Memory packet built once per agent run | `buildContextPacket` called before the while loop (loop.js:501) | Correct |
| Task history fetched once per agent run | `taskList` called before the while loop (loop.js:507) | Correct |
| Sub-agent state cache with 200ms TTL | `getChildState` caches (loop.js:106-119) | Correct |
| Event-driven sub-agent wake-up | `onSubAgentTerminal` + EventTarget (loop.js:72-86) | Correct |
| Token budget enforced per round | `budgetExceeded` checked on usage events (loop.js:780) | Correct |
| Plan batch marking (multiple steps marked running in one persist) | loop.js:694-704 | Correct |
| Paginated message list for UI | `pmListMessagesPaginated` via `agent:list-messages` IPC (project-mode.js:208) | Correct |

---

## Concrete Fix Summary

| # | File:Line | Change | Expected savings |
|---|---|---|---|
| 1 | project-intel/index.js:790 | Add token-based SQL filter + LIMIT before in-JS ranking | Reduces scan from 50K rows to ~500 for typical queries |
| 2 | memory/index.js:299 | Add LIMIT 100 + LIKE filter to projectList SQL | Reduces memory transfer from O(N) to O(100) |
| 3 | loop.js:278 (transition) | Skip write when planJson unchanged | Cuts 2-4 NAPI calls per round |
| 4 | delegate_research.js:165 | POLL_MS: 500 → 2000 | Cuts poll NAPI calls by 75% |
| 5 | loop.js:917 | Batch tool result appends | Cuts N-1 NAPI roundtrips per round |

---

## Regression Tests

See `shell/tests/gate20-perf-noop-assertions.test.js` for assertions that pin:
- ProjectIntel.relevantFiles called at most once per agent run
- Memory.buildContextPacket + Memory.taskList called at most twice per agent run
- Context packet token estimate bounded below 50,000 tokens
- IPC `agent:list-messages` uses paginated handler (not per-message roundtrips)
