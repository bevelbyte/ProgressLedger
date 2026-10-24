// GATE 11 — Memory participates in Project Mode (learn → retrieve).
//
// These tests verify the end-to-end contract: a fact learned in one
// agent run (TASK A) is retrievable by a later agent run (TASK B)
// when the objective shares tokens with the stored fact. They also
// verify isolation, bounded recall, and same-run set+retrieve.
//
// Tests drive the real Memory service (no mocks) with a temp userData
// directory so every run is hermetic.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  Memory,
  _setUserDataDir,
  _closeAll,
} from "../src/services/memory/index.js";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "cf-gate11-"));
}

// ---------------------------------------------------------------------------
// 1) TASK A learns a fact — it is persisted to disk
// ---------------------------------------------------------------------------

test("GATE 11: projectSet persists a fact to disk (sidecar SQLite file created)", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    const set = await Memory.projectSet(
      42,
      "finding",
      "feature-x-path",
      "feature X is in /src/feature-x.js",
    );
    assert.equal(set.ok, true);

    // The memory layer stores each project's data in a sidecar SQLite file
    // under <userData>/project-memory/<projectId>.sqlite. Verify it exists.
    const dbPath = Memory._dbPathFor(42);
    assert.ok(existsSync(dbPath), `sidecar DB should exist at ${dbPath}`);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2) TASK B (later, new agent) retrieves the fact via buildContextPacket
// ---------------------------------------------------------------------------

test("GATE 11: a later agent run retrieves the fact when the objective shares tokens", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    // TASK A: learn the fact.
    await Memory.projectSet(
      77,
      "finding",
      "feature-x-path",
      "feature X is in /src/feature-x.js",
    );

    // TASK B: later agent run, same project. Query with a related objective.
    // In the real app the DB stays open across agent runs, so no _closeAll
    // is needed here — the learn→retrieve cycle happens in the same process.
    const packet = await Memory.buildContextPacket(77, "where is feature X located");
    assert.equal(packet.ok, true);
    assert.ok(packet.result.packet.length > 0, "packet must contain the retrieved fact");
    assert.match(packet.result.packet, /feature-x-path/);
    assert.match(packet.result.packet, /\/src\/feature-x.js/);
    assert.equal(packet.result.entries.length, 1);
    assert.equal(packet.result.entries[0].key, "feature-x-path");
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3) Irrelevant facts are NOT returned (no context pollution)
// ---------------------------------------------------------------------------

test("GATE 11: buildContextPacket excludes facts that share no tokens with the objective", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    // One relevant fact.
    await Memory.projectSet(9, "finding", "auth-flow", "OAuth 2.1 PKCE for login");
    // Several irrelevant facts about completely different topics.
    await Memory.projectSet(9, "preference", "indent-tabs", "use tabs not spaces");
    await Memory.projectSet(9, "decision", "db-choice", "better-sqlite3 for persistence");
    await Memory.projectSet(9, "risk", "deploy-risk", "friday deploys are risky");

    const packet = await Memory.buildContextPacket(9, "how does the OAuth login flow work");
    assert.equal(packet.ok, true);

    const returnedKeys = packet.result.entries.map((e) => e.key);
    assert.ok(returnedKeys.includes("auth-flow"), "relevant fact must be returned");
    assert.ok(!returnedKeys.includes("indent-tabs"), "irrelevant fact must NOT be returned");
    assert.ok(!returnedKeys.includes("db-choice"), "irrelevant fact must NOT be returned");
    assert.ok(!returnedKeys.includes("deploy-risk"), "irrelevant fact must NOT be returned");
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4) Memory recall is bounded: a large corpus respects maxTokens
// ---------------------------------------------------------------------------

test("GATE 11: a 10,000-fact corpus does not blow the context budget", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    // Seed 10,000 facts, all sharing the token "alpha" so they all score > 0.
    for (let i = 0; i < 10000; i++) {
      await Memory.projectSet(55, "finding", `fact-${i}`, "alpha beta gamma delta epsilon");
    }

    // Cap at 50 tokens — should return only a handful of entries.
    const packet = await Memory.buildContextPacket(55, "alpha", 50);
    assert.equal(packet.ok, true);

    const tokenCount = packet.result.packet.split(/\s+/).filter(Boolean).length;
    assert.ok(
      tokenCount <= 100,
      `packet exceeded budget: ${tokenCount} tokens for ${packet.result.entries.length} entries`,
    );
    // Sanity: we got some results but not 10,000.
    assert.ok(packet.result.entries.length > 0);
    assert.ok(packet.result.entries.length < 10000);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5) Same-run set then search works (no stale cache issue)
// ---------------------------------------------------------------------------

test("GATE 11: projectSet followed by buildContextPacket in the same run returns the new fact", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    // Set a fact.
    const set = await Memory.projectSet(33, "architecture", "api-gateway", "use Kong as API gateway");
    assert.equal(set.ok, true);

    // Immediately search — the in-process cache must reflect the write.
    const packet = await Memory.buildContextPacket(33, "what API gateway do we use");
    assert.equal(packet.ok, true);
    assert.ok(packet.result.packet.length > 0, "packet must include the just-written fact");
    assert.match(packet.result.packet, /api-gateway/);
    assert.match(packet.result.packet, /Kong/);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6) Session vs project memory scopes are separated across profiles
// ---------------------------------------------------------------------------

test("GATE 11: session memory does not leak across profiles; project memory is scoped by profile", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    // Session memory: same key, different (profile, agent) pairs.
    await Memory.sessionSet("profile-A", "agent-1", "temp-note", "session fact A");
    await Memory.sessionSet("profile-B", "agent-1", "temp-note", "session fact B");

    const getA = await Memory.sessionGet("profile-A", "agent-1", "temp-note");
    assert.equal(getA.ok, true);
    assert.equal(getA.result, "session fact A");

    const getB = await Memory.sessionGet("profile-B", "agent-1", "temp-note");
    assert.equal(getB.ok, true);
    assert.equal(getB.result, "session fact B");

    // Project memory: same key, different profiles.
    await Memory.projectSet("profile-A", "decision", "shared-key", "decision for A");
    await Memory.projectSet("profile-B", "decision", "shared-key", "decision for B");

    const projA = await Memory.projectGet("profile-A", "decision", "shared-key");
    assert.equal(projA.ok, true);
    assert.equal(projA.result.value, "decision for A");

    const projB = await Memory.projectGet("profile-B", "decision", "shared-key");
    assert.equal(projB.ok, true);
    assert.equal(projB.result.value, "decision for B");

    // Project memory retrieval is also scoped: querying profile-A must
    // not return profile-B's entries.
    // Use distinctive non-STOP-word tokens (avoids "a"/"to"/"in" etc.
    // being filtered by tokenize()).
    await Memory.projectSet("profile-A", "finding", "alpha-key", "alpha-content profile-a");
    const pktA = await Memory.buildContextPacket("profile-A", "alpha-key");
    assert.equal(pktA.ok, true);
    assert.match(pktA.result.packet, /alpha-content/);

    const pktB = await Memory.buildContextPacket("profile-B", "alpha-key");
    assert.equal(pktB.ok, true);
    assert.equal(pktB.result.packet, "", "profile-B must not see profile-A's fact");
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});
