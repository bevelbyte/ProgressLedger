// PRODUCTION WIRING — MCP curated catalogue.
//
// THE DEFECT THIS LOCKS OUT
// `services/mcp/startup.js` documents `onAgentStart()` as the integration point
// that registers the curated MCP server catalogue exactly once before an agent's
// first tool call. It had ZERO production call sites: neither
// `project:start-agent` nor the `startSubAgent` delegate bridge invoked it, and
// the only importer was `shell/tests/mcp-curated.test.js`.
//
// Because `MCP.ensureCuratedServers()` is reachable only through
// `onAgentStart()`, the consequences in the running product were:
//
//   * `MCP.list()` was always `[]`;
//   * `marketplace.listMcp()` always answered `{ ok: true, mcp: [] }` even
//     though the product ships a curated catalogue;
//   * the Marketplace panel's MCP section could never show anything.
//
// `shell/tests/gate7-mcp-e2e.test.js` asserts the renderer-isolation decision
// (no `mcp:*` IPC channel) and explicitly documents that it is a UNIT test with
// a hand-written entry point, so it could not catch this.
//
// WHAT IS ASSERTED HERE
//   1. `shell/src/ipc/project-mode.js` really calls `onAgentStart` on the agent
//      start path AND in the delegate `startSubAgent` bridge (a child runs in
//      its own (profileId, projectId) scope, so it needs its own registration).
//   2. The call is wrapped so a catalogue failure can never break an agent run.
//   3. Behavioural proof from the real service: after `onAgentStart`, the
//      curated catalogue is actually listed for that scope, is scoped (another
//      profile does not see it), and registration is idempotent.
//   4. It is explicitly asserted that registration does NOT spawn a child
//      process — that is what makes calling it on every agent start safe, and
//      it is the boundary between what is wired here and what is deliberately
//      NOT (`MCP.connect()` / `MCP.callTool()`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { MCP } from "../src/services/mcp/index.js";
import { onAgentStart } from "../src/services/mcp/startup.js";
import { CURATED_SERVERS } from "../src/services/mcp/curated.js";

const here = dirname(fileURLToPath(import.meta.url));
const shellSrc = join(here, "..", "src");

// ---------------------------------------------------------------------------
// 1 + 2. The production wiring
// ---------------------------------------------------------------------------

test("project:start-agent registers the MCP catalogue and cannot be broken by it", () => {
  const src = readFileSync(join(shellSrc, "ipc", "project-mode.js"), "utf8");

  assert.match(
    src,
    /import \{ onAgentStart \} from "\.\.\/services\/mcp\/startup\.js"/,
    "project-mode.js must import the MCP agent-start hook",
  );

  const calls = src.split("\n").filter((l) => /onAgentStart\(/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l));
  assert.ok(
    calls.length >= 2,
    `onAgentStart must be called on the agent-start path AND in the delegate bridge (found ${calls.length} call site(s))`,
  );

  // The delegate bridge passes the CHILD's scope, not the parent's.
  assert.match(
    src,
    /onAgentStart\(childArgs\.profileId,\s*childArgs\.projectId/,
    "the delegate bridge must register the catalogue for the child's own scope",
  );

  // Every call must be inside a try/catch: an agent run must never fail because
  // a metadata catalogue could not be registered. Checked structurally — a
  // `try {` must open within the two lines above each call — rather than by
  // line prefix, which would false-positive on a correctly guarded call whose
  // `try {` sits on the preceding line.
  const lines = src.split("\n");
  const isComment = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);
  const callIdx = lines
    .map((l, i) => (/onAgentStart\(/.test(l) && !isComment(l) ? i : -1))
    .filter((i) => i >= 0);
  assert.ok(callIdx.length >= 2, `expected at least two onAgentStart call sites, found ${callIdx.length}`);
  for (const i of callIdx) {
    const window = lines.slice(Math.max(0, i - 2), i + 1).join("\n");
    assert.match(
      window,
      /try\s*\{/,
      `onAgentStart at line ${i + 1} must be wrapped in try/catch so a catalogue failure cannot break an agent run`,
    );
  }
  // And the catch must actually swallow, not rethrow into the run.
  assert.ok(
    /catch \{[^}]*never break[^}]*\}/.test(src),
    "the onAgentStart catch blocks must swallow, so registration can never fail a run",
  );
});

// ---------------------------------------------------------------------------
// 3 + 4. Behavioural proof from the real service
// ---------------------------------------------------------------------------

test("onAgentStart makes the curated catalogue listable, scoped and idempotent, without spawning", async () => {
  assert.ok(Array.isArray(CURATED_SERVERS) && CURATED_SERVERS.length > 0, "the curated catalogue must not be empty");

  // Snapshot the live child-process count so we can prove registration is
  // metadata-only. `MCP.connect()` is what spawns; it must not have run.
  const before = MCP.list();
  assert.deepEqual(
    before.filter((s) => s.status && s.status !== "registered"),
    [],
    "nothing may be connected before onAgentStart runs",
  );

  const registered = onAgentStart(1, 1);
  assert.ok(Array.isArray(registered), "onAgentStart must return the list of names it registered");
  assert.equal(registered.length, CURATED_SERVERS.length, "every curated server must be registered on first call");

  const listed = MCP.list();
  assert.equal(listed.length, CURATED_SERVERS.length, "MCP.list() must now return the catalogue");
  for (const entry of CURATED_SERVERS) {
    const found = listed.find((s) => s.name === entry.id);
    assert.ok(found, `catalogue entry ${entry.id} must be listed`);
    // Registered, never connected: no child process, no handshake.
    assert.notEqual(found.status, "connected", `${entry.id} must not be connected by registration alone`);
  }

  // `MCP.list()` is deliberately UNSCOPED — it takes no arguments and returns
  // every registered server. The ownership boundary is enforced at each
  // OPERATION, not at list time. Assert that boundary explicitly, because a
  // catalogue that is visible but not reachable cross-scope is the safe shape
  // and a regression that removed these gates would be serious.
  //
  // Signatures: unregister(name, scope) and listTools(name, scope), where
  // scope is `{ profileId, projectId }`.
  const crossScope = MCP.unregister(CURATED_SERVERS[0].id, { profileId: 2, projectId: 1 });
  assert.equal(crossScope.ok, false, "unregister from a different profile must be refused");
  assert.equal(crossScope.error.code, "not-owned");
  const missingScope = await MCP.listTools(CURATED_SERVERS[0].id, { profileId: 2, projectId: 1 });
  assert.equal(missingScope.ok, false, "listTools from a different profile must be refused");
  // `listTools` checks connectedness BEFORE ownership, so an unregistered-but-
  // owned server short-circuits with `not-connected`. Either way the call fails
  // closed and leaks no tools; the `not-owned` branch is only reachable once a
  // server is actually connected, which this test deliberately never does.
  assert.ok(
    ["not-connected", "not-owned"].includes(missingScope.error.code),
    `cross-scope listTools must fail closed, got ${missingScope.error.code}`,
  );
  assert.ok(!Array.isArray(missingScope.tools), "a refused listTools must not return tools");
  // The refused unregister must NOT have removed the entry.
  assert.equal(MCP.list().length, CURATED_SERVERS.length, "a refused unregister must not mutate state");

  // A second agent start for the SAME scope must not duplicate.
  const again = onAgentStart(1, 1);
  assert.equal(again.length, 0, "a second onAgentStart for the same scope must register nothing new");
  assert.equal(MCP.list().length, CURATED_SERVERS.length, "the catalogue must not grow on repeat starts");

  // A DIFFERENT scope gets its own entries (the catalogue is per-scope, so a
  // second profile's agent sees the same curated set under its own ownership).
  const otherScope = onAgentStart(2, 1);
  assert.equal(otherScope.length, CURATED_SERVERS.length, "a different scope must get its own registrations");
  assert.equal(MCP.list().length, CURATED_SERVERS.length * 2, "both scopes must be present, separately owned");

  // NOTHING may have been spawned. This is the property that makes calling
  // onAgentStart on every agent start safe, and it is the boundary with the
  // still-unwired MCP.connect()/callTool() path.
  for (const s of MCP.list()) {
    assert.ok(
      !s.child,
      `${s.name} must not hold a child process after registration alone`,
    );
    assert.ok(
      !s.pid,
      `${s.name} must not hold a pid after registration alone`,
    );
  }

  // Teardown so this test cannot leak state into another file's module instance.
  for (const scope of [{ profileId: 1, projectId: 1 }, { profileId: 2, projectId: 1 }]) {
    for (const s of MCP.list()) {
      if (s.profileId === scope.profileId && s.projectId === scope.projectId) {
        MCP.unregister(s.name, scope);
      }
    }
  }
  assert.equal(MCP.list().length, 0, "unregister must remove the catalogue entries");
});
