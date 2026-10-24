// GATE 10 — Marketplace git install functional path with rollback.
//
// Verifies the full git install pipeline end-to-end against the REAL
// `installGit` (shell/src/services/marketplace/git-install.js) and
// `Marketplace.installGit` (shell/src/services/marketplace/index.js) code:
//
//   Git source -> fetch/clone -> validate -> inspect manifest -> install
//   -> register -> enable -> uninstall
//
// Hermetic strategy (matches the convention in marketplace-git.test.js):
// we exercise the REAL implementation modules; we only substitute the
// `git` BINARY via the `execFile` dependency-injection seam that git-install.js
// explicitly exposes for tests (JSDoc: `execFile: optional, injected for
// tests`). No test here performs a real network call — the git binary is a
// stub that fakes `git clone` by materializing a fixture directory and
// `git rev-parse HEAD` by returning a hardcoded sha.
//
// Note on storage location: the immutable git-install pipeline lands clones
// under `<userData>/marketplace/<id>/` (NOT `plugins/<id>/`). Git-installed
// marketplace items are registered in the Marketplace registry — i.e. they
// appear in `Marketplace.list()` — not in `Plugins.list()` (the latter is the
// registry for locally `Plugins.install`-ed plugins). The assertions below
// therefore target the real, reachable surfaces; the brief's
// `plugins/<id>/` / `Plugins.list()` references describe the conceptual
// plugin location, which for git installs is `marketplace/<id>/` /
// `Marketplace.list()`.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  cpSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  isValidGitUrl,
  installGit,
} from "../src/services/marketplace/git-install.js";
import { Marketplace, configureMarketplace } from "../src/services/marketplace/index.js";

// Reset module-singleton state between tests so registry roots don't bleed.
test.beforeEach(() => {
  Marketplace._resetForTests();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "cf-gate10-"));
}

// Write a plugin.json manifest (and optional extra files) into `dir`.
function writeManifest(dir, manifest, extra = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  for (const [name, body] of Object.entries(extra)) {
    const p = join(dir, name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body, "utf8");
  }
  return dir;
}

const VALID_MANIFEST = {
  name: "G10 Plugin",
  version: "0.3.0",
  skills: ["s1", "s2"],
  tools: ["tool-a"],
  mcpServers: [],
};

const FAKE_SHA = "deadbeefcafef00ddeadbeefcafef00d00000000";

/**
 * An `execFile` stand-in for the `git` binary. Mirrors the real argv shape
 * used by git-install.js: `git clone [...] <dest>` and
 * `git -C <dest> rev-parse HEAD`.
 *
 * `git clone` is faked by copying `fixtureDir` into the requested destination
 * (the staging path the impl chose). `git rev-parse HEAD` is faked by returning
 * `sha`. This keeps tests hermetic: no real git invocation, no network.
 *
 * `calls` (optional) is a counter object the caller can inspect to assert the
 * binary was/wasn't consulted.
 */
function fakeExecFile({ fixtureDir, failClone = false, failRevParse = false, sha = FAKE_SHA, calls } = {}) {
  return (bin, args) => new Promise((resolveP, rejectP) => {
    if (calls) calls.total++;
    if (bin !== "git") return rejectP(new Error(`unexpected bin ${bin}`));
    const argv = args || [];
    if (argv[0] === "clone") {
      if (failClone) return rejectP(new Error("fatal: could not read Username for 'https://github.com': no credentials"));
      const dest = argv[argv.length - 1];
      try {
        mkdirSync(dest, { recursive: true });
        cpSync(fixtureDir, dest, { recursive: true, force: true });
      } catch (e) {
        return rejectP(e);
      }
      return resolveP({ stdout: "", stderr: "" });
    }
    if (argv[0] === "-C" && argv[2] === "rev-parse" && argv[3] === "HEAD") {
      if (failRevParse) return rejectP(new Error("fatal: not a git repository"));
      return resolveP({ stdout: sha + "\n", stderr: "" });
    }
    return rejectP(new Error(`unexpected git args: ${argv.join(" ")}`));
  });
}

// ---------------------------------------------------------------------------
// GATE 10.1 — invalid repo URL is rejected gracefully (no real network)
// ---------------------------------------------------------------------------

test("GATE 10 — invalid repo URL (nonexistent) is rejected gracefully without a real network call", async () => {
  const root = freshRoot();
  const url = "https://github.com/nonexistent/this-does-not-exist-12345.git";

  // The fake git binary fails the clone (simulating a nonexistent remote).
  // Crucially, no real git is spawned and no real network is attempted.
  const exec = fakeExecFile({ failClone: true, calls: { total: 0 } });
  const execCalls = { total: 0 };
  const r = await installGit({
    url,
    userDataDir: root,
    execFile: (bin, args, opts) => {
      const p = exec(bin, args, opts);
      execCalls.total++;
      return p;
    },
  });

  assert.equal(r.ok, false);
  assert.equal(r.reason, "clone-failed");
  // The git binary was consulted (clone attempted) — but only the stub.
  assert.equal(execCalls.total, 1, "git was only invoked for the faked clone");
  // No orphan install directory was created.
  assert.equal(existsSync(join(root, "marketplace", "this-does-not-exist-12345")), false);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// GATE 10.2 — invalid manifest (path-traversal entry) is rejected and rolled back
// ---------------------------------------------------------------------------

test("GATE 10 — invalid manifest with path-traversal `entry` is rejected and the install is rolled back", async () => {
  const root = freshRoot();
  // `entry` is NOT in the manifest whitelist (plugins/index.js ALLOWED_MANIFEST_FIELDS),
  // so validateManifest rejects it as smuggled metadata — the path-traversal
  // guard for the `entry` field is the strict field whitelist itself.
  const bad = {
    name: "Bad Plugin",
    version: "1.0.0",
    entry: "../escape.js", // rejected: unknown field
    skills: [],
    tools: [],
    mcpServers: [],
  };
  const fix = writeManifest(join(root, "fixture"), bad);
  const exec = fakeExecFile({ fixtureDir: fix });

  // URL derives id "escape".
  const r = await installGit({
    url: "https://github.com/owner/escape.git",
    userDataDir: root,
    execFile: exec,
  });

  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-manifest");
  // Rollback: no installed folder under marketplace/<id>.
  assert.equal(existsSync(join(root, "marketplace", "escape")), false);
  // Staging was cleaned up (no leftover random staging dirs).
  const staging = join(root, "marketplace", "staging");
  assert.equal(existsSync(staging), true);
  assert.equal(readdirSync(staging).length, 0, "staging must be empty after rollback");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// GATE 10.3 — duplicate install (same id twice) is rejected
// ---------------------------------------------------------------------------

test("GATE 10 — duplicate install of the same id is rejected", async () => {
  const root = freshRoot();
  configureMarketplace({ rootDir: root });
  const fix = writeManifest(join(root, "fixture"), VALID_MANIFEST);
  let execCalls = 0;
  const exec = (bin, args, opts) => { execCalls++; return fakeExecFile({ fixtureDir: fix })(bin, args, opts); };

  const url = "https://github.com/owner/dup-plugin.git";

  // First install: succeeds, registers in the Marketplace registry, writes
  // marketplace/dup-plugin/.
  const first = await Marketplace.installGit(url, "HEAD", { execFile: exec });
  assert.equal(first.ok, true);
  assert.equal(first.id, "dup-plugin");
  assert.equal(existsSync(join(root, "marketplace", "dup-plugin", "plugin.json")), true);
  // First install invokes git twice: `clone` then `rev-parse HEAD`.
  assert.equal(execCalls, 2);

  // Second install of the same id: the impl's duplicate guard fires BEFORE
  // cloning again — the on-disk tree is left untouched and the in-memory
  // registry keeps exactly one entry. No further git calls are made.
  const second = await Marketplace.installGit(url, "HEAD", { execFile: exec });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "duplicate");
  assert.equal(execCalls, 2, "git must not be re-invoked for a duplicate id");
  assert.equal(Marketplace.list().length, 1, "registry must still hold a single item");
  assert.equal(Marketplace.list()[0].id, "dup-plugin");
  assert.equal(existsSync(join(root, "marketplace", "dup-plugin", "plugin.json")), true);

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// GATE 10.4 — failed install after a valid manifest is rolled back (no orphans)
// ---------------------------------------------------------------------------

test("GATE 10 — a final-destination revalidation failure rolls back only validated staging", async () => {
  const root = freshRoot();
  const fix = writeManifest(join(root, "fixture"), VALID_MANIFEST);
  const outsideSentinel = join(root, "outside-sentinel.txt");
  writeFileSync(outsideSentinel, "keep", "utf8");
  const baseExec = fakeExecFile({ fixtureDir: fix });
  const exec = async (bin, args, opts) => {
    if (args[0] === "clone") {
      // Simulate an unsafe destination appearing after the initial duplicate
      // check but before the final move: a file, not a validated directory.
      writeFileSync(join(root, "marketplace", "race-target"), "occupied", "utf8");
    }
    return baseExec(bin, args, opts);
  };

  const r = await installGit({
    url: "https://github.com/owner/race-target.git",
    userDataDir: root,
    execFile: exec,
  });

  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-destination");
  assert.equal(readFileSync(outsideSentinel, "utf8"), "keep");
  assert.equal(readFileSync(join(root, "marketplace", "race-target"), "utf8"), "occupied");
  assert.equal(readdirSync(join(root, "marketplace", "staging")).length, 0, "staging must be empty after rollback");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// GATE 10.5 — successful install: manifest parsed, item registered, enable works
// ---------------------------------------------------------------------------

test("GATE 10 — successful install parses the manifest, registers the item, and enables it", async () => {
  const root = freshRoot();
  configureMarketplace({ rootDir: root });
  const fix = writeManifest(join(root, "fixture"), VALID_MANIFEST);
  const exec = fakeExecFile({ fixtureDir: fix });

  const r = await Marketplace.installGit(
    "https://github.com/owner/g10-plugin.git",
    "HEAD",
    { execFile: exec },
  );

  // installGit descriptor
  assert.equal(r.ok, true);
  assert.equal(r.id, "g10-plugin");
  assert.equal(r.name, "G10 Plugin");
  assert.equal(r.version, "0.3.0");
  assert.equal(r.sha, FAKE_SHA);
  assert.equal(r.ref, "HEAD");
  // Marketplace.installGit's wrapper returns the install descriptor minus the
  // runtime fields; source/skills/tools are surfaced via Marketplace.list().
  assert.equal(r.install_path, join(root, "marketplace", "g10-plugin"));
  // The manifest was parsed from disk.
  assert.equal(r.manifest.name, "G10 Plugin");
  // On-disk tree is real.
  assert.equal(existsSync(join(r.install_path, "plugin.json")), true);
  // No leftover staging.
  assert.equal(existsSync(join(root, "marketplace", "staging")), true);
  assert.equal(readdirSync(join(root, "marketplace", "staging")).length, 0);

  // The item appears in the registry (Marketplace.list), disabled by default.
  const listed = Marketplace.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "g10-plugin");
  assert.equal(listed[0].name, "G10 Plugin");
  assert.equal(listed[0].version, "0.3.0");
  assert.equal(listed[0].enabled, false);
  assert.equal(listed[0].source.kind, "git");
  assert.equal(listed[0].source.url, "https://github.com/owner/g10-plugin.git");
  assert.deepEqual(listed[0].skills, ["s1", "s2"]);
  assert.deepEqual(listed[0].tools, ["tool-a"]);

  // enable() flips the registered item on.
  const en = Marketplace.enable("g10-plugin");
  assert.equal(en.ok, true);
  assert.equal(Marketplace.list()[0].enabled, true);

  // The enabled state was persisted to the sidecar.
  const state = JSON.parse(readFileSync(join(root, "marketplace-state.json"), "utf8"));
  const rec = state.items.find((i) => i.id === "g10-plugin");
  assert.ok(rec, "state sidecar must record the installed item");
  assert.equal(rec.enabled, true);

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// GATE 10.6 — uninstall removes the item from disk and from the registry
// ---------------------------------------------------------------------------

test("GATE 10 — uninstall removes the installed item from disk and the registry", async () => {
  const root = freshRoot();
  configureMarketplace({ rootDir: root });
  const fix = writeManifest(join(root, "fixture"), VALID_MANIFEST);
  const exec = fakeExecFile({ fixtureDir: fix });

  const r = await Marketplace.installGit(
    "https://github.com/owner/g10-plugin.git",
    "HEAD",
    { execFile: exec },
  );
  assert.equal(r.ok, true);
  const installPath = join(root, "marketplace", "g10-plugin");
  assert.equal(existsSync(installPath), true);
  assert.equal(Marketplace.list().length, 1);

  // remove() is the uninstall operation for marketplace items.
  const un = Marketplace.remove("g10-plugin");
  assert.equal(un.ok, true);

  // No orphan folder remains on disk.
  assert.equal(existsSync(installPath), false);
  assert.equal(existsSync(join(root, "marketplace", "g10-plugin")), false);
  // Gone from the registry.
  assert.equal(Marketplace.list().length, 0);
  assert.equal(Marketplace.get("g10-plugin"), null);

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// GATE 10.7 — git URL with embedded credentials is rejected (GATE 14)
// ---------------------------------------------------------------------------

test("GATE 10 — git URL with embedded credentials is rejected and git is never invoked", async () => {
  const root = freshRoot();

  // Pure-function guard first.
  assert.equal(isValidGitUrl("https://user:pass@github.com/owner/repo.git"), false);
  assert.equal(isValidGitUrl("https://user@github.com/owner/repo.git"), false);
  // Sanity: a non-credentialed URL is still accepted.
  assert.equal(isValidGitUrl("https://github.com/owner/repo.git"), true);

  // installGit must short-circuit to invalid-url and never touch the git binary.
  let execCalled = false;
  const exec = () => { execCalled = true; return Promise.reject(new Error("git must not be invoked")); };
  const r = await installGit({
    url: "https://user:pass@github.com/owner/cred.git",
    userDataDir: root,
    execFile: exec,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-url");
  assert.equal(execCalled, false, "git must not be invoked for a credential-bearing URL");
  rmSync(root, { recursive: true, force: true });
});
