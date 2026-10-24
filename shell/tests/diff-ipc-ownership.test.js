// SECURITY — `project:diff` cross-profile source disclosure.
//
// THE DEFECT THIS LOCKS OUT
// `shell/src/ipc/diff.js` accepted `profileId` and `agentId` from the renderer,
// resolved the project root from a registry keyed by that pair, and returned the
// working-tree diff plus the absolute project path — WITHOUT verifying that the
// agent belongs to the profile.
//
// Every sibling agent-scoped channel already gated on exactly this:
// `project:start-agent` and 16 other call sites in `ipc/project-mode.js`, plus
// the goals channels, all call `assertAgentOwned` before touching agent state.
// `project:subagent-diff`, the closest sibling, has its own ancestry gate
// (`authorizeDiffCaller`). `project:diff` was the one that did not.
//
// The impact: a renderer that knew or guessed another profile's
// (profileId, agentId) pair could read that workspace's source code, and the
// `root` field in the response leaked an absolute filesystem path. That is a
// cross-profile information disclosure across an ownership boundary the rest of
// the product enforces.
//
// WHAT IS ASSERTED HERE
//   1. The handler validates id shape, then calls the ownership gate, and does
//      so BEFORE any project-root resolution — ordering matters, because
//      resolving the root first is what leaks.
//   2. The gate is reached on the failure path too, and the refusal carries a
//      machine-readable code rather than a bare false.
//   3. Behavioural proof of the decision function itself: `authorizeAgentRecord`
//      refuses a cross-profile pair, a mismatched id, and a missing agent, and
//      accepts the genuinely-owned pair. That is the function the gate delegates
//      to, so a regression in it is caught here behaviourally rather than only
//      by reading source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { authorizeAgentRecord } from "../src/security/project-mode-auth.js";
import { normalizeAgentRow } from "../src/services/agent/loop.js";

const here = dirname(fileURLToPath(import.meta.url));
const diffSrc = readFileSync(join(here, "..", "src", "ipc", "diff.js"), "utf8");

// ---------------------------------------------------------------------------
// 1 + 2. The wiring, and its ordering
// ---------------------------------------------------------------------------

test("project:diff gates on agent ownership before it resolves any project root", () => {
  // Extract the handler body so the assertions are about the real code, not
  // about the whole file (which also contains the gate's own definition).
  const handlerStart = diffSrc.indexOf('safeHandle("project:diff"');
  assert.ok(handlerStart > 0, "the project:diff handler must exist");
  const body = diffSrc.slice(handlerStart);

  assert.match(
    body,
    /assertAgentOwned\(/,
    "project:diff must verify that the agent belongs to the profile",
  );

  const gateAt = body.indexOf("assertAgentOwned(");
  const rootAt = body.indexOf("getActiveProjectRootFor(");
  assert.ok(rootAt > 0, "the handler must still resolve the project root");
  assert.ok(
    gateAt < rootAt,
    "the ownership gate must run BEFORE getActiveProjectRootFor — resolving the root first is what leaks",
  );

  // The refusal must be returned, not swallowed, and must carry a code.
  assert.match(
    body,
    /if \(!ownership\.ok\)[\s\S]{0,220}return \{ ok: false, error: \{ code:/,
    "a refused ownership check must return a machine-readable refusal",
  );

  // And the id shape must be validated before the gate is asked to authorise.
  assert.ok(
    body.indexOf("Number.isInteger") < gateAt,
    "profileId/agentId shape must be validated before the ownership gate runs",
  );

  // The gate itself must delegate to the shared decision function rather than
  // reimplementing a weaker comparison.
  assert.match(diffSrc, /import \{ authorizeAgentRecord \} from "\.\.\/security\/project-mode-auth\.js"/);
  assert.match(diffSrc, /return authorizeAgentRecord\(/);
  // ...and must never throw out of an IPC handler.
  assert.match(diffSrc, /catch \(e\) \{\s*return \{ ok: false, reason: "core-error" \}/);
});

// ---------------------------------------------------------------------------
// 3. Behaviour of the decision function the gate delegates to
// ---------------------------------------------------------------------------

const owned = { id: 7, profileId: 1, state: "running" };

test("authorizeAgentRecord accepts only the genuinely-owned agent", () => {
  // The real, owned pair.
  const good = authorizeAgentRecord(1, 7, normalizeAgentRow(owned));
  assert.equal(good.ok, true, "the owning profile must be allowed");

  // Cross-profile: profile 2 asking about profile 1's agent. This is the exact
  // cross-profile read the missing gate allowed.
  const crossProfile = authorizeAgentRecord(2, 7, normalizeAgentRow(owned));
  assert.equal(crossProfile.ok, false, "a foreign profile must be refused");
  assert.equal(crossProfile.error, "agent-not-owned");

  // Mismatched id: the record says 7, the caller claims 9.
  const wrongId = authorizeAgentRecord(1, 9, normalizeAgentRow(owned));
  assert.equal(wrongId.ok, false, "an agentId the record does not carry must be refused");
  assert.equal(wrongId.error, "agent-not-owned");

  // Missing agent (deleted row, DB unavailable, unknown id).
  const missing = authorizeAgentRecord(1, 7, normalizeAgentRow(null));
  assert.equal(missing.ok, false, "a missing agent record must fail closed");
  assert.equal(missing.error, "agent-not-owned");

  // Rows with NO profile attribution at all are deliberately permitted by this
  // primitive: `ownerProfile === undefined` is allowed, because several callers
  // hand it a normalized row whose profile column has been projected away. That
  // is pre-existing, shared behaviour and is NOT changed here.
  //
  // What still holds for such a row is the id check, which is the part that
  // matters for `project:diff` (it keys the project-root registry by agentId):
  // an id-7 row satisfies a request for agent 7 and is refused for agent 9.
  const unattributed = normalizeAgentRow({ id: 7 });
  assert.equal(authorizeAgentRecord(1, 7, unattributed).ok, true, "an unattributed row is accepted for its own id");
  assert.equal(authorizeAgentRecord(1, 9, unattributed).ok, false, "an unattributed row must still be refused for a different id");

  // Rows that cannot yield a numeric id must fail closed, with no throw.
  for (const bad of [undefined, {}, { profileId: 1 }, { id: "seven" }, { id: null }]) {
    const r = authorizeAgentRecord(1, 7, normalizeAgentRow(bad));
    assert.equal(r.ok, false, `row without a usable id must fail closed: ${JSON.stringify(bad)}`);
    assert.equal(r.error, "agent-not-owned");
  }

  // Non-numeric / non-integer ids must fail closed too. The handler validates
  // shape before calling this, and the decision function must not be the weaker
  // of the two. The exact refusal code varies with which check trips first
  // (non-numeric -> `invalid-ids`; numeric-but-wrong -> `agent-not-owned`);
  // what matters is that none of them is ever allowed.
  for (const [p, a] of [[1.5, 7], [1, 7.5], [1, null], ["1", 7], [1, "7"]]) {
    const r = authorizeAgentRecord(p, a, normalizeAgentRow(owned));
    assert.equal(r.ok, false, `non-integer ids must fail closed: ${JSON.stringify([p, a])}`);
    assert.ok(
      ["invalid-ids", "agent-not-owned"].includes(r.error),
      `unexpected refusal code ${r.error}`,
    );
  }
  // The purely non-numeric cases are classified as invalid ids.
  assert.equal(authorizeAgentRecord("1", 7, normalizeAgentRow(owned)).error, "invalid-ids");
  assert.equal(authorizeAgentRecord(1, "7", normalizeAgentRow(owned)).error, "invalid-ids");
});
