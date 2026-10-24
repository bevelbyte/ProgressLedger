// Hooks — lifecycle event extension layer for the shell-side Project Mode.
//
// A Hook is a small async function subscribed to a named event. The intended
// contract is that a shell-side surface calls
// `Hooks.emit(eventName, profileId, projectId, payload)` and every registered
// hook is invoked in registration order.
//
// REACHABILITY — READ THIS BEFORE TRUSTING THE PANEL
//   As of the 2026-09-26 final validation, `Hooks.register()` and
//   `Hooks.emit()` have **ZERO production call sites**. The only emitters in
//   the repository are in `shell/tests/gate11-v8-plugin-audit.test.js`, which
//   calls `Hooks.emit` itself. Nothing in `shell/src/main.js` or
//   `shell/src/ipc/**` calls them, so in the running application:
//     * `_executions` is always empty, so `hooks:list-executions` always
//       answers `{ ok: true, executions: [] }` and HooksLog.svelte renders a
//       permanently empty log;
//     * a plugin that registers a hook is silently never called.
//
//   The 7-event taxonomy, the isolation guarantees and the "a throwing hook
//   must not bring down the agent loop" contract below are all implemented and
//   unit-tested; they are simply not connected to anything yet. Wiring the
//   loop's AGENT_STARTED / AGENT_TOOL_* / AGENT_COMPLETED transitions to the
//   7 user-facing events is a real, outstanding piece of work — reported in
//   _evidence_FINALVAL_remaining_gaps_20260926.txt rather than quietly assumed
//   to be in place.
//
//   WHY THE WIRING IS STILL NOT DONE (re-confirmed 2026-09-27)
//   The agent loop publishes 16 internal `agent.*` events. The mapping onto
//   these 7 is specified for 5 of them, and ONE further mapping is now
//   RESOLVED (see below). Exactly one remains genuinely ambiguous:
//     * `agent.completed` -> `task.completed` AND/OR `agent.stopped`
//       (the header for `agent.stopped` says "completed or cancelled", which
//       overlaps `task.completed`).
//   Wiring 6 of 7 would still leave `agent.completed` unresolved, and a plugin
//   registered for an event that never fires is the exact failure mode the
//   previous validation was trying to eliminate. Partial wiring is worse than
//   visible dormancy, so it is not done. The remaining mapping needs a product
//   decision, not a guess.
//
//   `verification.completed` — RESOLVED 2026-09-27 from the code, not guessed
//   This was previously recorded here as "nothing clearly corresponds to
//   `verification.completed` -- the loop's `agent.verifying` marks the START of
//   a pass, not its completion". That statement was WRONG, and the correction
//   matters because it is the reason the mapping looked ambiguous.
//
//   The loop does not have a separate "verification finished" event name. It
//   reuses ONE event, `agent.verifying`, for both the start and the end of a
//   pass, and disambiguates them with the `verified` payload field:
//
//     loop.js:832   agent.verifying { agentId }                              <- start
//     loop.js:1017  agent.verifying { agentId }                              <- start
//     loop.js:1234  agent.verifying { agentId }                              <- start
//     loop.js:1452  agent.verifying { agentId, verified: true }             <- PASSED
//     loop.js:1472  agent.verifying { agentId, verified: false, exhausted }  <- exhausted
//     loop.js:1511  agent.verifying { agentId, verified: false, fixStepId } <- fix attempt
//
//   So the answer to "does one verification completion raise one public hook
//   event or two?" is ONE. `loop.js:1452` is a single `bus.emit` reached once
//   per passing verification, on the single `v.ok` path. The apparent two-ness
//   was an artifact of the overloaded NAME, not of the lifecycle.
//
//   The correct mapping, when the wiring is done:
//     verification.completed  <-  agent.verifying with verified === true
//   (The `verified: false` emissions are the verifier's own fix-retry
//   bookkeeping and are already visible to consumers as `agent.verifying`; they
//   are not a second completion and must not be surfaced as one.)
//
//   THE DORMANT STATE IS NOW SELF-REPORTING
//   The genuine harm was not the gap itself but its presentation: an empty
//   execution log read as "working, just no data yet". `emitterStatus()` below
//   derives dormancy from real emit() calls, `hooks:list-executions` returns it,
//   and HooksLog.svelte says plainly that hooks are not wired up. Because it is
//   derived rather than a maintained flag, the notice disappears automatically
//   the day an emitter is wired, and nothing needs remembering.
//
// 7 user-facing events (matching the brief):
//   task.started         — a Project Mode task has started
//   task.completed       — a Project Mode task completed
//   task.failed          — a Project Mode task failed
//   tool.invoked         — a tool was invoked (mirrors agent.tool.started
//                          but normalised to the 7-event surface)
//   tool.failed          — a tool invocation failed
//   agent.stopped        — the agent loop has stopped (completed or
//                          cancelled; payload.state disambiguates)
//   verification.completed — the verifier finished a pass
//
// The agent loop's 12 internal events (see loop.js AGENT_EVENTS) are a
// SUPERSET of these. The hooks layer EXPOSES only the 7 user-facing
// events; the internal ones stay in the loop and are not part of the
// public extension surface. Plugins register against the 7.
//
// All public functions never throw. A hook that throws is logged (via
// console.error in production; exposed via the optional `onError`
// callback for tests) and execution continues with the next hook. The
// emit() call is best-effort: a broken plugin MUST NOT bring down the
// agent loop.

// ---- event taxonomy -------------------------------------------------------

/**
 * The 7 user-facing hook event names. The list is frozen; new events
 * go in here, never inline at the call site. The agent loop's internal
 * 12-event taxonomy is INTENDED to map to these at emit time — see the
 * REACHABILITY note at the top of this file: that mapping is not wired yet.
 */
export const HOOK_EVENTS = Object.freeze([
  "task.started",
  "task.completed",
  "task.failed",
  "tool.invoked",
  "tool.failed",
  "agent.stopped",
  "verification.completed",
]);

const VALID_EVENTS = new Set(HOOK_EVENTS);

// ---- module state ---------------------------------------------------------

// Registry: eventName -> array of { id, fn }. Order is registration
// order. emit() walks the array in order.
const registry = new Map();
for (const e of HOOK_EVENTS) registry.set(e, []);

// Auto-incrementing hook id. Avoids collisions across re-registrations.
let _nextId = 1;

// Optional error sink. Tests inject a spy; production falls back to
// console.error so the agent loop never crashes on a bad plugin.
let _onError = null;

// In-memory execution log. Each emit() appends one record per hook
// invoked. Capped at 100 entries (FIFO eviction). Exposed via
// listExecutions() for the IPC layer — the renderer can show a
// "recent hook executions" panel without touching the registry.
const MAX_EXECUTIONS = 100;
const _executions = [];
let _execNextId = 1;

// ---- registration ---------------------------------------------------------

/**
 * Register a hook for an event. `hook` may be either a function
 * `async (profileId, projectId, payload) => void` or an object
 * `{ id?, fn }`. Returns the assigned id (string).
 */
function register(eventName, hook) {
  if (typeof eventName !== "string" || !VALID_EVENTS.has(eventName)) {
    throw new Error(`Hooks.register: unknown event "${eventName}"`);
  }
  let id = null;
  let fn = null;
  if (typeof hook === "function") {
    fn = hook;
  } else if (hook && typeof hook.fn === "function") {
    fn = hook.fn;
    if (typeof hook.id === "string" && hook.id.length > 0) id = hook.id;
  } else {
    throw new Error("Hooks.register: hook must be a function or { id?, fn }");
  }
  if (!id) id = `hook-${eventName}-${_nextId++}`;
  const list = registry.get(eventName);
  // Replace by id if it already exists.
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) {
      list[i] = { id, fn };
      return id;
    }
  }
  list.push({ id, fn });
  return id;
}

/**
 * Remove a hook by id. Returns true if it existed.
 */
function unregister(id) {
  if (typeof id !== "string") return false;
  for (const list of registry.values()) {
    const idx = list.findIndex((h) => h.id === id);
    if (idx >= 0) {
      list.splice(idx, 1);
      return true;
    }
  }
  return false;
}

/**
 * List every registered hook for an event (or for every event if
 * eventName is omitted). Returns a structured array — hook functions
 * are NOT exposed (only their ids), so the renderer can show a
 * plugin manager without leaking the actual callback.
 */
function list(eventName) {
  if (eventName == null) {
    const out = [];
    for (const [name, list_] of registry.entries()) {
      out.push({ eventName: name, hooks: list_.map((h) => ({ id: h.id })) });
    }
    return out;
  }
  if (!VALID_EVENTS.has(eventName)) return [];
  return registry.get(eventName).map((h) => ({ id: h.id }));
}

/**
 * List recent hook executions (most recent first). Optional filters:
 *   eventName — narrow to one event
 *   hookId    — narrow to one hook
 *   limit     — max records returned (default 100)
 */
function listExecutions(filters) {
  const { eventName, hookId, limit } = filters || {};
  let rows = _executions.slice().reverse();
  if (eventName) rows = rows.filter((r) => r.event === eventName);
  if (hookId) rows = rows.filter((r) => r.hookId === hookId);
  const n = typeof limit === "number" ? limit : _executions.length;
  return rows.slice(0, n);
}

// ---- emit -----------------------------------------------------------------

/**
 * Fire an event. Every registered hook is awaited in registration
 * order. A thrown hook is caught; the error is routed to `_onError`
 * (or console.error) and execution continues with the next hook.
 *
 * Returns `{ ok, eventName, count, errors }`. `errors` is an array of
 * `{ id, error }` for hooks that threw.
 */
async function emit(eventName, profileId, projectId, payload) {
  if (!VALID_EVENTS.has(eventName)) {
    return { ok: false, eventName, reason: "unknown-event" };
  }
  // Count REAL emission attempts. See emitterStatus() below.
  _emitCalls += 1;
  const list = registry.get(eventName);
  const errors = [];
  for (const h of list) {
    const started = Date.now();
    try {
      await h.fn(profileId, projectId, payload);
      _pushExecution(eventName, h.id, "ok", 0, null);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      errors.push({ id: h.id, error: err });
      const durationMs = Date.now() - started;
      _pushExecution(eventName, h.id, "failed", durationMs, err.message);
      if (_onError) {
        try { _onError(h.id, eventName, err); } catch { /* ignore */ }
      } else {
        // eslint-disable-next-line no-console
        console.error(`[hooks] ${eventName} hook "${h.id}" threw:`, err && err.message ? err.message : err);
      }
    }
  }
  return { ok: true, eventName, count: list.length, errors };
}

function _pushExecution(eventName, hookId, status, durationMs, error) {
  const record = {
    id: _execNextId++,
    hookId,
    hookName: hookId,
    event: eventName,
    status,
    durationMs,
    error: error || null,
    createdAt: new Date().toISOString(),
  };
  _executions.push(record);
  if (_executions.length > MAX_EXECUTIONS) _executions.shift();
}

// ---- configuration --------------------------------------------------------

/**
 * Set the error sink. Tests use this to assert that broken hooks are
 * isolated. Pass null to revert to console.error.
 */
function setErrorSink(fn) {
  _onError = typeof fn === "function" ? fn : null;
}

// ---- dormant-state reporting ----------------------------------------------
//
// WHY THIS EXISTS
//   This module is fully implemented (7-event taxonomy, isolation guarantees,
//   "a throwing hook must not bring down the agent loop") and its IPC surface
//   is registered, but NOTHING IN PRODUCTION CALLS emit(). The agent loop
//   publishes 16 internal `agent.*` events and the hooks surface exposes 7
//   user-facing ones; the mapping is specified for 6 of the 7 and genuinely
//   ambiguous for exactly ONE (`agent.completed` -> `task.completed` AND/OR
//   `agent.stopped`). `verification.completed` was resolved on 2026-09-27 from
//   the code — see the resolution note at the top of this file; the earlier claim
//   that nothing corresponded to it was wrong. Wiring 6 of 7 would still leave
//   `agent.completed` unresolved, so a plugin registering for the unresolved
//   event would silently never fire — the exact failure this is meant to
//   prevent. So the wiring is deliberately NOT done, and the gap is reported
//   rather than papered over.
//
//   The harm that was real, though, is the panel: HooksLog.svelte rendered
//   "No hook executions yet", which reads as "the feature works, there is just
//   no data yet". That is dormant infrastructure masquerading as active
//   functionality.
//
//   This function is the fix, and it is DERIVED rather than declared: it counts
//   actual calls to emit(). A hand-maintained `dormant: true` flag would rot the
//   moment somebody wired an emitter. Counting calls means the moment an emitter
//   lands, `dormant` becomes false and the UI becomes truthful with no code
//   change and nothing to remember to update.

let _emitCalls = 0;

/**
 * Whether the hooks surface has ever actually been driven in this process.
 *
 * @returns {{ dormant: boolean, emitCalls: number }}
 *   `dormant: true` means no production code path has ever called `emit()`, so
 *   an empty execution log is expected behaviour and NOT evidence of a fault.
 *   Once any emitter exists, `dormant` flips to false and the empty-log state
 *   once again means something is wrong.
 */
function emitterStatus() {
  return { dormant: _emitCalls === 0, emitCalls: _emitCalls };
}

// ---- exports --------------------------------------------------------------

export const Hooks = {
  register,
  unregister,
  list,
  emit,
  emitterStatus,
  setErrorSink,
  HOOK_EVENTS,
  _resetForTests() {
    for (const list of registry.values()) list.length = 0;
    _nextId = 1;
    _onError = null;
    _executions.length = 0;
    _execNextId = 1;
    _emitCalls = 0;
  },
  listExecutions,
};
