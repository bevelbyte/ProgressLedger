// Hooks — lifecycle event extension layer.
//
// Covers:
//   - the 7 events are present in HOOK_EVENTS
//   - register / unregister / list
//   - emit calls every registered hook in registration order
//   - exceptions in one hook do NOT stop the others
//   - unknown event names are rejected at register time + at emit time

import test from "node:test";
import assert from "node:assert/strict";

import { Hooks, HOOK_EVENTS } from "../src/services/hooks/index.js";

const SEVEN = [
  "task.started",
  "task.completed",
  "task.failed",
  "tool.invoked",
  "tool.failed",
  "agent.stopped",
  "verification.completed",
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fresh() {
  Hooks._resetForTests();
  return Hooks;
}

// ---------------------------------------------------------------------------
// event taxonomy
// ---------------------------------------------------------------------------

test("HOOK_EVENTS contains exactly the 7 brief events", () => {
  fresh();
  assert.equal(HOOK_EVENTS.length, 7);
  for (const want of SEVEN) {
    assert.ok(HOOK_EVENTS.includes(want), `missing event: ${want}`);
  }
});

// ---------------------------------------------------------------------------
// register / unregister / list
// ---------------------------------------------------------------------------

test("register: a function returns an id and shows up in list()", () => {
  const h = fresh();
  const id = h.register("task.started", async () => {});
  assert.equal(typeof id, "string");
  const list = h.list("task.started");
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
});

test("register: an object form { id, fn } respects the caller-supplied id", () => {
  const h = fresh();
  const id = h.register("tool.invoked", { id: "my-plugin", fn: async () => {} });
  assert.equal(id, "my-plugin");
  const list = h.list("tool.invoked");
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "my-plugin");
});

test("register: same id replaces (last-write-wins)", () => {
  const h = fresh();
  const id1 = h.register("task.started", async () => {});
  const id2 = h.register("task.started", { id: id1, fn: async () => {} });
  assert.equal(id2, id1);
  assert.equal(h.list("task.started").length, 1);
});

test("unregister: removes a hook by id", () => {
  const h = fresh();
  const id = h.register("task.started", async () => {});
  assert.equal(h.unregister(id), true);
  assert.equal(h.list("task.started").length, 0);
  // idempotent
  assert.equal(h.unregister(id), false);
});

test("unregister: returns false for unknown id", () => {
  const h = fresh();
  assert.equal(h.unregister("nope"), false);
});

test("register: unknown event throws", () => {
  const h = fresh();
  assert.throws(() => h.register("nope.event", async () => {}), /unknown event/);
});

test("register: hook without function throws", () => {
  const h = fresh();
  assert.throws(() => h.register("task.started", null), /function/);
  assert.throws(() => h.register("task.started", {}), /function/);
});

test("list(): without eventName returns all events with their hooks", () => {
  const h = fresh();
  h.register("task.started", async () => {});
  h.register("tool.failed", async () => {});
  const all = h.list();
  assert.equal(all.length, 7);
  const started = all.find((e) => e.eventName === "task.started");
  assert.equal(started.hooks.length, 1);
  const plan = all.find((e) => e.eventName === "task.completed");
  assert.equal(plan.hooks.length, 0);
});

test("list(): unknown eventName returns []", () => {
  const h = fresh();
  assert.deepEqual(h.list("nope.event"), []);
});

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

test("emit: calls every registered hook in registration order", async () => {
  const h = fresh();
  const order = [];
  h.register("task.started", async () => { order.push("a"); });
  h.register("task.started", async () => { order.push("b"); });
  h.register("task.started", async () => { order.push("c"); });
  const r = await h.emit("task.started", 1, 1, { foo: "bar" });
  assert.equal(r.ok, true);
  assert.equal(r.count, 3);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("emit: passes profileId, projectId, payload to the hook", async () => {
  const h = fresh();
  let captured = null;
  h.register("task.completed", async (profileId, projectId, payload) => {
    captured = { profileId, projectId, payload };
  });
  await h.emit("task.completed", 42, 7, { runId: "abc" });
  assert.equal(captured.profileId, 42);
  assert.equal(captured.projectId, 7);
  assert.deepEqual(captured.payload, { runId: "abc" });
});

test("emit: exceptions in one hook do NOT stop the others", async () => {
  const h = fresh();
  const order = [];
  const errors = [];
  h.setErrorSink((id, event, err) => errors.push({ id, event, msg: err.message }));
  h.register("task.failed", async () => { order.push("a"); });
  h.register("task.failed", async () => { order.push("b"); throw new Error("boom"); });
  h.register("task.failed", async () => { order.push("c"); });
  const r = await h.emit("task.failed", 1, 1, {});
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(r.ok, true);
  assert.equal(r.count, 3);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].id.length > 0, true);
  assert.match(r.errors[0].error.message, /boom/);
  // sink received the error
  assert.equal(errors.length, 1);
  assert.equal(errors[0].event, "task.failed");
  assert.match(errors[0].msg, /boom/);
});

test("emit: all hooks throwing still completes with all errors recorded", async () => {
  const h = fresh();
  h.setErrorSink(() => {});
  h.register("agent.stopped", async () => { throw new Error("e1"); });
  h.register("agent.stopped", async () => { throw new Error("e2"); });
  const r = await h.emit("agent.stopped", 1, 1, {});
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.equal(r.errors.length, 2);
});

test("emit: unknown event returns ok:false reason:unknown-event", async () => {
  const h = fresh();
  const r = await h.emit("nope.event", 1, 1, {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown-event");
});

test("emit: no listeners is a no-op success", async () => {
  const h = fresh();
  const r = await h.emit("verification.completed", 1, 1, {});
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
  assert.equal(r.errors.length, 0);
});

// ---------------------------------------------------------------------------
// Dormant-state invariant.
//
// The hooks surface is fully implemented but NO production code path calls
// emit() -- the agent loop publishes 16 internal `agent.*` events and the
// mapping onto the 7 user-facing ones is specified for only 5. Wiring 5 of 7
// would leave a plugin registered for `verification.completed` silently never
// firing, so the wiring is deliberately not done.
//
// The invariant these tests lock down is that the dormant state is DERIVED from
// real emit() calls rather than declared by a flag, so it cannot rot: the
// instant an emitter is wired, `dormant` becomes false and the UI notice
// disappears on its own. A hand-maintained boolean would have been the failure
// mode here.
// ---------------------------------------------------------------------------

test("emitterStatus: reports dormant before anything has ever emitted", () => {
  const h = fresh();
  const s = h.emitterStatus();
  assert.equal(s.dormant, true);
  assert.equal(s.emitCalls, 0);
});

test("emitterStatus: registering a hook does NOT make it non-dormant", async () => {
  // The critical property. A hook can be registered and still never be
  // triggered, so registration must not be mistaken for a working emitter --
  // that is exactly the "looks wired, is not" confusion being prevented.
  const h = fresh();
  h.register("tool.invoked", async () => {});
  assert.equal(h.emitterStatus().dormant, true);
  assert.equal(h.list("tool.invoked").length, 1);
});

test("emitterStatus: flips to non-dormant once emit is actually called", async () => {
  const h = fresh();
  h.register("tool.invoked", async () => {});
  await h.emit("tool.invoked", 1, 1, {});
  const s = h.emitterStatus();
  assert.equal(s.dormant, false);
  assert.equal(s.emitCalls, 1);
  await h.emit("tool.failed", 1, 1, {});
  assert.equal(h.emitterStatus().emitCalls, 2);
});

test("emitterStatus: a rejected emit does not count as an emission", async () => {
  const h = fresh();
  await h.emit("not.a.real.event", 1, 1, {});
  assert.equal(h.emitterStatus().dormant, true);
  assert.equal(h.emitterStatus().emitCalls, 0);
});

test("emitterStatus: a throwing hook still counts as an emission", async () => {
  // The emitter ran; the hook failed. The surface is wired even though the
  // hook did not succeed, so dormant must be false and the failure shows up in
  // the execution log instead.
  const h = fresh();
  h.register("task.started", async () => {
    throw new Error("boom");
  });
  const r = await h.emit("task.started", 1, 1, {});
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 1);
  assert.equal(h.emitterStatus().dormant, false);
  assert.equal(h.listExecutions({}).length, 1);
});

test("emitterStatus: _resetForTests returns the surface to dormant", async () => {
  const h = fresh();
  h.register("task.completed", async () => {});
  await h.emit("task.completed", 1, 1, {});
  assert.equal(h.emitterStatus().dormant, false);
  h._resetForTests();
  assert.equal(h.emitterStatus().dormant, true);
  assert.equal(h.emitterStatus().emitCalls, 0);
  assert.equal(h.listExecutions({}).length, 0);
});
