// SF-1 — Project Mode root trust anchor.
//
// Threat: `project:create-project` took a renderer-supplied `rootPath` and the
// backend then treated that stored root as the TRUSTED filesystem scope for
// Project Intelligence and every project tool. Containment correctly enforces
// "stay inside <root>", so a root of `C:\` makes the whole disk the blast
// radius. That is a trust-anchor problem, not a traversal bug.
//
// Fix: canonicalize + validate every root, and require an explicit
// main-process confirmation gesture before a BROAD root (volume root, OS
// user-profile root, or a well-known system directory) may be established.
// Narrow roots behave exactly as before.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join, parse as parsePath, sep } from "node:path";
import { tmpdir, homedir } from "node:os";

import {
  authorizeProjectRoot,
  canonicalizeProjectRoot,
  classifyProjectRootBreadth,
  isVolumeRoot,
} from "../src/security/project-root-trust.js";

function tmpDir(tag) {
  return mkdtempSync(join(tmpdir(), `cf-sf1-${tag}-`));
}

// ---------------------------------------------------------------------------
// NEGATIVE: the malicious / broad root
// ---------------------------------------------------------------------------

test("SF-1: a broad root is refused when no main-process confirmation is possible", async () => {
  const volumeRoot = parsePath(process.cwd()).root;
  assert.ok(volumeRoot, "the test needs a resolvable volume root");

  // No confirmBroad supplied at all — a headless / automated caller, or a
  // compromised renderer that cannot reach a dialog.
  const res = await authorizeProjectRoot(volumeRoot);
  assert.equal(res.ok, false, "a volume root must not be establishable silently");
  assert.equal(res.reason, "root-too-broad");
});

test("SF-1: a declined confirmation refuses the broad root", async () => {
  const volumeRoot = parsePath(process.cwd()).root;
  let asked = 0;
  const res = await authorizeProjectRoot(volumeRoot, {
    confirmBroad: async () => { asked++; return false; },
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "root-too-broad");
  assert.equal(asked, 1, "the user must actually be asked");
});

test("SF-1: a confirmation that throws is treated as a refusal, never as consent", async () => {
  const volumeRoot = parsePath(process.cwd()).root;
  const res = await authorizeProjectRoot(volumeRoot, {
    confirmBroad: async () => { throw new Error("dialog unavailable"); },
  });
  assert.equal(res.ok, false, "a broken dialog must fail closed");
  assert.equal(res.reason, "root-too-broad");
});

test("SF-1: a confirmation returning a non-boolean truthy value is not consent", async () => {
  const volumeRoot = parsePath(process.cwd()).root;
  const res = await authorizeProjectRoot(volumeRoot, {
    confirmBroad: async () => "yes",
  });
  assert.equal(res.ok, false, "consent must be an explicit true");
  assert.equal(res.reason, "root-too-broad");
});

test("SF-1: the OS user-profile root is broad", () => {
  const home = homedir();
  if (!home) return; // no home dir in this environment
  assert.equal(classifyProjectRootBreadth(home), "broad",
    "an agent rooted at the user profile can reach every personal document");
});

test("SF-1: every volume-root spelling is broad", () => {
  const cases = process.platform === "win32"
    ? ["C:\\", "D:/", "E:\\\\"]
    : ["/", "//"];
  for (const p of cases) {
    // Only assert on the ones that parse as a root on this platform.
    if (!parsePath(p).root) continue;
    assert.equal(isVolumeRoot(p), true, `${p} must be a volume root`);
    assert.equal(classifyProjectRootBreadth(p), "broad", `${p} must be broad`);
  }
});

test("SF-1: a junction pointing at a volume root cannot smuggle a broad anchor as narrow", () => {
  const parent = tmpDir("junction");
  try {
    const volumeRoot = parsePath(process.cwd()).root;
    const link = join(parent, "looks-narrow");
    try {
      symlinkSync(volumeRoot, link, "junction");
    } catch {
      return; // junction creation not permitted here — nothing to prove
    }
    // The textual spelling looks like an ordinary subfolder...
    assert.equal(isVolumeRoot(link), false);
    // ...but the production path canonicalizes FIRST, and breadth is then
    // classified on the real target, so it is broad and needs confirmation.
    const resolved = canonicalizeProjectRoot(link);
    assert.equal(resolved.ok, true, `canonicalization must succeed: ${JSON.stringify(resolved)}`);
    assert.equal(resolved.canonicalPath, volumeRoot,
      "the canonical root must be the junction's real target");
    assert.equal(resolved.breadth, "broad",
      "canonicalization must expose a junction to a volume root as broad");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("SF-1: relative, missing, and non-directory roots are refused", async () => {
  const missing = join(tmpDir("missing"), "nope");
  const file = join(tmpDir("file"), "a.txt");
  writeFileSync(file, "x", "utf8");

  for (const [p, reason] of [
    ["", "invalid-root"],
    ["   ", "invalid-root"],
    [null, "invalid-root"],
    [42, "invalid-root"],
    ["relative/path", "root-not-absolute"],
    [".", "root-not-absolute"],
    [missing, "root-not-found"],
    [file, "root-not-a-directory"],
  ]) {
    const res = await authorizeProjectRoot(p, { confirmBroad: async () => true });
    assert.equal(res.ok, false, `${JSON.stringify(p)} must be refused`);
    assert.equal(res.reason, reason, `${JSON.stringify(p)} -> ${res.reason}`);
  }
});

// ---------------------------------------------------------------------------
// POSITIVE: legitimate project roots must keep working unchanged
// ---------------------------------------------------------------------------

test("SF-1: an ordinary project directory needs no confirmation and is stored canonically", async () => {
  const root = tmpDir("narrow");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "index.js"), "export const a = 1;", "utf8");

    let asked = 0;
    const res = await authorizeProjectRoot(root, {
      confirmBroad: async () => { asked++; return false; },
    });
    assert.equal(res.ok, true, `a normal project root must still work: ${JSON.stringify(res)}`);
    assert.equal(res.breadth, "narrow");
    assert.equal(asked, 0, "a narrow root must not prompt the user");
    assert.equal(res.canonicalPath, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SF-1: a nested subdirectory of a broad location is still a legitimate project root", async () => {
  const home = homedir();
  if (!home) return;
  // A user may legitimately keep a project inside their home directory. That
  // must NOT require a confirmation prompt — only the profile root itself does.
  const nested = join(home, ".progressledger-sf1-probe");
  mkdirSync(nested, { recursive: true });
  try {
    const res = await authorizeProjectRoot(nested, {
      confirmBroad: async () => false,
    });
    assert.equal(res.ok, true, `a project folder inside the profile must work: ${JSON.stringify(res)}`);
    assert.equal(res.breadth, "narrow");
  } finally {
    rmSync(nested, { recursive: true, force: true });
  }
});

test("SF-1: a broad root IS allowed once the user explicitly confirms it", async () => {
  const volumeRoot = parsePath(process.cwd()).root;
  const res = await authorizeProjectRoot(volumeRoot, { confirmBroad: async () => true });
  assert.equal(res.ok, true, `an explicitly confirmed broad root must be allowed: ${JSON.stringify(res)}`);
  assert.equal(res.breadth, "broad");
  assert.equal(res.canonicalPath, volumeRoot);
});

test("SF-1: a trailing-separator spelling canonicalizes to the same stored root", () => {
  const root = tmpDir("spell");
  try {
    const plain = canonicalizeProjectRoot(root);
    const trailing = canonicalizeProjectRoot(`${root}${sep}`);
    assert.equal(plain.ok, true);
    assert.equal(trailing.ok, true);
    assert.equal(plain.canonicalPath, trailing.canonicalPath,
      "the stored trust anchor must be spelling-independent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Shipped wiring
// ---------------------------------------------------------------------------

test("SF-1: project:create-project authorizes the root before the core call and stores the canonical path", () => {
  const source = readFileSync(new URL("../src/ipc/project-mode.js", import.meta.url), "utf8");
  const start = source.indexOf('safeHandle("project:create-project"');
  assert.ok(start >= 0, "project:create-project must be registered");
  const end = source.indexOf("safeHandle(", start + 12);
  const body = source.slice(start, end < 0 ? source.length : end);

  const ownAt = body.indexOf("assertProfileOwned(profileId)");
  const authAt = body.indexOf("authorizeProjectRoot(rootPath");
  const coreAt = body.indexOf('callPm("pmCreateProject"');
  assert.ok(ownAt >= 0, "profile ownership must be checked");
  assert.ok(authAt > ownAt, "root authorization must follow the profile ownership check");
  assert.ok(coreAt > authAt, "root authorization must precede the core call");

  // The CANONICAL path is what reaches core — never the renderer spelling.
  const coreCall = body.slice(coreAt, body.indexOf(");", coreAt));
  assert.match(coreCall, /root\.canonicalPath/,
    "pmCreateProject must receive the canonical path");
  assert.doesNotMatch(coreCall, /rootPath/,
    "pmCreateProject must not receive the raw renderer path");
});

test("SF-1: a broad root without a working dialog can never be created", () => {
  const source = readFileSync(new URL("../src/ipc/project-mode.js", import.meta.url), "utf8");
  // The confirmation is a main-process dialog, and a failure is a refusal.
  assert.match(source, /dialog\.showMessageBox/,
    "broad roots must be confirmed by a main-process dialog");
  // Consent is read ONLY from an explicit response index of 1.
  assert.match(source, /return res && res\.response === 1;/,
    "consent must come only from an explicit 'Use this folder' click");
  // A dialog failure path must return false, never fall through to consent.
  const catchMatch = source.match(/catch \(e\) \{[\s\S]{0,240}?\}/);
  assert.ok(catchMatch, "the dialog call must have an explicit catch path");
  assert.match(catchMatch[0], /return false;/,
    "a dialog failure must return false, never fall through to consent");
  // Consent is the Cancel-safe default: response 0 (Cancel) is the defaultId.
  assert.match(source, /defaultId: 0/);
  assert.match(source, /cancelId: 0/);
});

test("SF-1: the preload bridge still forwards the whole createProject payload (contract unchanged)", () => {
  const preload = readFileSync(new URL("../src/preload.cjs", import.meta.url), "utf8");
  const start = preload.indexOf("createProject:");
  assert.ok(start >= 0, "createProject must stay on the preload bridge");
  const snippet = preload.slice(start, start + 200).replace(/\s+/g, " ");
  // The legitimate UI must still be able to PROPOSE a root; the main process
  // is what decides whether it may be established.
  assert.match(snippet, /invoke\("project:create-project", input \|\| \{\}\)/);
  const store = readFileSync(
    new URL("../../ui/src/features/project-mode/stores/projectMode.svelte.js", import.meta.url),
    "utf8",
  );
  assert.match(store, /rootPath/, "the store must still forward rootPath to the main process");
});
