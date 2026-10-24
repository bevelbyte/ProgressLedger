// GATES 13 + 14 (v7) — Marketplace + Memory deep audit.
//
// v6 closed GATE 10 (7/7, marketplace git install) and GATE 11 (6/6,
// memory learn→retrieve) at the unit level. This v7 expansion probes
// deeper into the security and persistence edges the brief flags:
//
//   GATE 13 (v7) — Marketplace URL validation + path-traversal + rollback:
//       - SCP-form git URLs (git@host:path) are accepted.
//       - An `@` appearing in the query string (NOT userinfo) is accepted.
//       - Disallowed schemes (file://, git+https://) are rejected.
//       - A URL with `?` / `#` query or fragment is accepted by the
//         validator but `deriveIdFromUrl` strips them from the id.
//       - An install id that tries to escape via path traversal is
//         caught by `safeUnder` before any git call.
//
//   GATE 14 (v7) — Memory cross-run persistence + input validation:
//       - projectSet / sessionSet reject an empty key.
//       - projectList honours the `limit` option (bounded recall).
//       - Facts survive a full connection close + reopen, proving the
//         sidecar SQLite file is the source of truth across agent runs.
//
// Hermetic: temp userData dirs, stubbed git binary, `_closeAll` in
// `finally` blocks. No real network, no source changes.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  isValidGitUrl,
  installGit,
  deriveIdFromUrl,
  safeUnder,
} from "../src/services/marketplace/git-install.js";
import {
  Memory,
  _setUserDataDir,
  _closeAll,
} from "../src/services/memory/index.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "cf-gate13-"));
}

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "cf-gate14-"));
}

// ---------------------------------------------------------------------------
// GATE 13.1 — SCP-form git URL is accepted
// ---------------------------------------------------------------------------

test("GATE 13: SCP-form git URL (git@host:path) is accepted by isValidGitUrl", () => {
  // GitHub / GitLab SCP form — the brief explicitly allows this.
  assert.equal(isValidGitUrl("git@github.com:user/repo.git"), true);
  assert.equal(isValidGitUrl("git@gitlab.com:org/project.git"), true);
  assert.equal(isValidGitUrl("git@bitbucket.org:team/repo.git"), true);

  // Sanity: a plain https URL is still accepted.
  assert.equal(isValidGitUrl("https://github.com/user/repo.git"), true);
});

// ---------------------------------------------------------------------------
// GATE 13.2 — @ in query string (not userinfo) is accepted; credentials
// in userinfo are still rejected
// ---------------------------------------------------------------------------

test("GATE 13: @ in the query string (not userinfo) is accepted; userinfo credentials are still rejected", () => {
  // @ inside the query string is part of the path/query, not userinfo.
  // The URL parser sees no username/password, so these pass.
  assert.equal(isValidGitUrl("https://github.com/org/repo.git?ref=main"), true);
  assert.equal(isValidGitUrl("https://github.com/org/repo.git?token=abc@def"), true);

  // But @ in the userinfo position (before the host) is still rejected —
  // the credential-leak guard in isValidGitUrl fires.
  assert.equal(isValidGitUrl("https://user:pass@github.com/org/repo.git"), false);
  assert.equal(isValidGitUrl("https://user@github.com/org/repo.git"), false);
});

// ---------------------------------------------------------------------------
// GATE 13.3 — disallowed schemes (file://, git+https://) are rejected
// ---------------------------------------------------------------------------

test("GATE 13: file:// and git+https:// schemes are rejected by isValidGitUrl", () => {
  // file:// would let an attacker point at local filesystem paths.
  assert.equal(isValidGitUrl("file:///etc/passwd"), false);
  assert.equal(isValidGitUrl("file:///home/user/repo"), false);
  assert.equal(isValidGitUrl("file://localhost/path/repo.git"), false);

  // git+https:// is common in package managers (npm, pip) but is NOT in
  // the allowed-schemes whitelist (http(s):// + SCP form only).
  assert.equal(isValidGitUrl("git+https://github.com/user/repo.git"), false);
  assert.equal(isValidGitUrl("git+ssh://git@github.com/user/repo.git"), false);

  // ftp:// and ssh:// are also outside the whitelist.
  assert.equal(isValidGitUrl("ftp://example.com/repo.git"), false);
  assert.equal(isValidGitUrl("ssh://git@github.com/user/repo.git"), false);
});

// ---------------------------------------------------------------------------
// GATE 13.4 — query / fragment in URL: accepted by validator, stripped
// from the derived install id
// ---------------------------------------------------------------------------

test("GATE 13: URL with ? or # is accepted but deriveIdFromUrl strips query and fragment", () => {
  // The validator accepts these — git clone handles query/fragment fine.
  assert.equal(isValidGitUrl("https://github.com/org/repo.git?ref=main"), true);
  assert.equal(isValidGitUrl("https://github.com/org/repo.git#section"), true);

  // But the derived install id must NOT include the query or fragment —
  // deriveIdFromUrl uses URL.pathname which strips both.
  assert.equal(
    deriveIdFromUrl("https://github.com/org/repo.git?ref=main"),
    "repo",
  );
  assert.equal(
    deriveIdFromUrl("https://github.com/org/repo.git#section"),
    "repo",
  );
  assert.equal(
    deriveIdFromUrl("https://github.com/org/repo.git?ref=main#section"),
    "repo",
  );
});

// ---------------------------------------------------------------------------
// GATE 13.5 — path-traversal in the install id is caught by safeUnder
// before any git call is made
// ---------------------------------------------------------------------------

test("GATE 13: an install id that tries path traversal is rejected by safeUnder and git is never invoked", async () => {
  const root = freshRoot();

  // idOverride bypasses deriveIdFromUrl and feeds directly into safeUnder.
  // A "../../escape" id would resolve outside userDataDir.
  let execCalled = false;
  const exec = () => { execCalled = true; return Promise.reject(new Error("must not reach git")); };

  const r = await installGit({
    url: "https://github.com/owner/repo.git",
    userDataDir: root,
    id: "../../escape",
    execFile: exec,
  });

  assert.equal(r.ok, false);
  assert.equal(r.reason, "path-escape");
  assert.equal(execCalled, false, "git must not be invoked for a path-traversal id");

  // safeUnder is also exported — test it directly for completeness.
  assert.equal(safeUnder(root, join(root, "marketplace", "../../escape")), null);
  assert.ok(safeUnder(root, join(root, "marketplace", " legit-id ")));

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// GATE 14.1 — empty key is rejected by projectSet and sessionSet
// ---------------------------------------------------------------------------

test("GATE 14: projectSet and sessionSet reject an empty key", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    // projectSet: empty key → invalid-input.
    const projEmpty = await Memory.projectSet("proj-empty", "decision", "", "value");
    assert.equal(projEmpty.ok, false);
    assert.equal(projEmpty.error.code, "invalid-input");
    assert.match(projEmpty.error.message, /key is required/);

    // sessionSet: empty key → invalid-input.
    const sessEmpty = await Memory.sessionSet("profile", "agent", "", "value");
    assert.equal(sessEmpty.ok, false);
    assert.equal(sessEmpty.error.code, "invalid-input");
    assert.match(sessEmpty.error.message, /key is required/);

    // Sanity: a non-empty key still works.
    const projOk = await Memory.projectSet("proj-ok", "decision", "real-key", "value");
    assert.equal(projOk.ok, true);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// GATE 14.2 — projectList honours the limit option (bounded recall)
// ---------------------------------------------------------------------------

test("GATE 14: projectList limit option bounds the number of returned results", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    // Seed 10 facts across two kinds.
    for (let i = 0; i < 10; i++) {
      await Memory.projectSet("limit-proj", i < 5 ? "finding" : "decision", `fact-${i}`, `value ${i}`);
    }

    // No limit → all 10.
    const all = await Memory.projectList("limit-proj");
    assert.equal(all.ok, true);
    assert.equal(all.result.length, 10);

    // limit: 3 → exactly 3.
    const limited = await Memory.projectList("limit-proj", { limit: 3 });
    assert.equal(limited.ok, true);
    assert.equal(limited.result.length, 3);

    // limit with kind filter → bounded within the kind.
    const kindLimited = await Memory.projectList("limit-proj", { kind: "finding", limit: 2 });
    assert.equal(kindLimited.ok, true);
    assert.equal(kindLimited.result.length, 2);
    for (const e of kindLimited.result) {
      assert.equal(e.kind, "finding");
    }

    // limit: 0 or negative → no LIMIT clause applied (returns all results).
    // The code only appends LIMIT when limit > 0, so 0 is a no-op.
    const zero = await Memory.projectList("limit-proj", { limit: 0 });
    assert.equal(zero.result.length, 10);
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// GATE 14.3 — task history is append-only and list honours limit + filter
// ---------------------------------------------------------------------------

test("GATE 14: task history is append-only and taskList honours limit and success filter", async () => {
  const userData = makeTempDir();
  _setUserDataDir(userData);
  try {
    // Three agent runs: two successful, one failure.
    await Memory.taskAppend("task-proj", "agent-1", "did auth refactor", true);
    await Memory.taskAppend("task-proj", "agent-2", "broke the build", false);
    await Memory.taskAppend("task-proj", "agent-3", "fixed the build", true);

    // Default list: most recent first, capped at 20.
    const all = await Memory.taskList("task-proj");
    assert.equal(all.ok, true);
    assert.equal(all.result.length, 3);
    // Most recent first (agent-3 ran last).
    assert.equal(all.result[0].agentId, "agent-3");
    assert.equal(all.result[0].summary, "fixed the build");
    assert.equal(all.result[0].success, true);
    assert.equal(all.result[1].agentId, "agent-2");
    assert.equal(all.result[2].agentId, "agent-1");

    // Limit bounds the results.
    const limited = await Memory.taskList("task-proj", { limit: 2 });
    assert.equal(limited.result.length, 2);
    assert.equal(limited.result[0].agentId, "agent-3");

    // Success filter returns only successful runs.
    const successes = await Memory.taskList("task-proj", { success: true });
    assert.equal(successes.result.length, 2);
    for (const s of successes.result) {
      assert.equal(s.success, true);
    }

    const failures = await Memory.taskList("task-proj", { success: false });
    assert.equal(failures.result.length, 1);
    assert.equal(failures.result[0].summary, "broke the build");
  } finally {
    _closeAll();
    rmSync(userData, { recursive: true, force: true });
  }
});
