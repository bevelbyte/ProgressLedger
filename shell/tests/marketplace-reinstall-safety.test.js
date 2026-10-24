// SF-8 — safe marketplace reinstall.
//
// Original defect: installLocal copied the source into the FINAL destination
// with `cpSync(..., { force: true })` and validated the manifest only
// afterwards. When the replacement manifest was invalid, the rollback cleanup
// called cleanupMarketplaceDestination(_rootDir, derivedId) — deleting the
// destination, which at that point contained a previously VALID installation.
// Net effect: a failed reinstall destroyed a working install.
//
// Fix: stage -> validate -> swap (mirrors ./git-install.js). An invalid
// replacement never reaches the installed tree.
//
// These tests prove the OLD valid content survives a failed replacement, that
// a failed replacement is cleaned up safely, that no containment regression
// was introduced, and that duplicate handling is unchanged.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Marketplace, configureMarketplace } from "../src/services/marketplace/index.js";

const VALID = { name: "Good Plugin", version: "1.0.0", skills: [], tools: [], mcpServers: [] };
// `version` is required by the shared Plugins manifest validator, so a manifest
// without it is genuinely invalid.
const INVALID_NO_VERSION = { name: "Broken Plugin", skills: [], tools: [], mcpServers: [] };

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "cf-mkt-sf8-"));
}

/**
 * A source plugin folder at a fixed basename (which becomes the install id).
 * `slot` lets several DIFFERENT source directories share that basename, so a
 * "reinstall" is a genuinely separate source tree rather than an edit in place.
 */
function makeSource(parent, id, manifest, extraFiles = {}, slot = "v1") {
  const dir = join(parent, slot, id);
  mkdirSync(dir, { recursive: true });
  if (manifest) writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  for (const [name, body] of Object.entries(extraFiles)) {
    writeFileSync(join(dir, name), body, "utf8");
  }
  return dir;
}

function stagingEntries(root) {
  const staging = join(root, "marketplace", "staging");
  if (!existsSync(staging)) return [];
  return readdirSync(staging);
}

test.beforeEach(() => Marketplace._resetForTests());
test.afterEach(() => Marketplace._resetForTests());

test("SF-8: a valid install survives a reinstall whose manifest is invalid", () => {
  const root = freshRoot();
  const sourceParent = mkdtempSync(join(tmpdir(), "cf-mkt-sf8-src-"));
  try {
    configureMarketplace({ rootDir: root });
    const dest = join(root, "marketplace", "replaceme");

    // 1) Install a VALID v1 with a payload file we can look for.
    const v1 = makeSource(sourceParent, "replaceme", VALID, { "keep-me.txt": "original-payload" });
    const first = Marketplace.installLocal(v1);
    assert.equal(first.ok, true, `first install must succeed: ${JSON.stringify(first)}`);
    assert.equal(readFileSync(join(dest, "keep-me.txt"), "utf8"), "original-payload");

    // 2) Reinstall from a source with an INVALID manifest.
    const v2 = makeSource(sourceParent, "replaceme", INVALID_NO_VERSION, { "keep-me.txt": "CLOBBERED" }, "v2");
    const second = Marketplace.installLocal(v2);
    assert.equal(second.ok, false);
    assert.equal(second.reason, "invalid-manifest");

    // 3) The previously VALID install must be fully intact.
    assert.ok(existsSync(dest), "the existing installation must NOT be deleted by a failed replacement");
    assert.equal(readFileSync(join(dest, "keep-me.txt"), "utf8"), "original-payload",
      "the original payload must survive a failed replacement");
    const manifest = JSON.parse(readFileSync(join(dest, "plugin.json"), "utf8"));
    assert.equal(manifest.version, "1.0.0", "the original manifest must survive");
    assert.equal(manifest.name, "Good Plugin");

    // 4) The registry must still describe the valid v1, not the invalid one.
    const item = Marketplace.get("replaceme");
    assert.equal(item.ok !== false, true);
    assert.equal(item.version, "1.0.0");
    assert.equal(item.name, "Good Plugin");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(sourceParent, { recursive: true, force: true });
  }
});

test("SF-8: a valid reinstall still replaces the content (no regression in the happy path)", () => {
  const root = freshRoot();
  const sourceParent = mkdtempSync(join(tmpdir(), "cf-mkt-sf8-src-"));
  try {
    configureMarketplace({ rootDir: root });
    const dest = join(root, "marketplace", "upgrader");

    const v1 = makeSource(sourceParent, "upgrader", VALID, { "keep-me.txt": "v1" });
    assert.equal(Marketplace.installLocal(v1).ok, true);

    const v2 = makeSource(sourceParent, "upgrader", { ...VALID, version: "2.0.0" }, { "keep-me.txt": "v2" }, "v2");
    const second = Marketplace.installLocal(v2);
    assert.equal(second.ok, true, `a valid reinstall must still succeed: ${JSON.stringify(second)}`);
    assert.equal(readFileSync(join(dest, "plugin.json"), "utf8").includes('"2.0.0"'), true);
    assert.equal(readFileSync(join(dest, "keep-me.txt"), "utf8"), "v2");
    assert.equal(Marketplace.get("upgrader").version, "2.0.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(sourceParent, { recursive: true, force: true });
  }
});

test("SF-8: a reinstall with no manifest at all leaves the valid install intact", () => {
  const root = freshRoot();
  const sourceParent = mkdtempSync(join(tmpdir(), "cf-mkt-sf8-src-"));
  try {
    configureMarketplace({ rootDir: root });
    const dest = join(root, "marketplace", "nomanifest");

    const v1 = makeSource(sourceParent, "nomanifest", VALID, { "keep-me.txt": "original" });
    assert.equal(Marketplace.installLocal(v1).ok, true);

    // A source folder with NO plugin.json at all.
    const v2 = makeSource(sourceParent, "nomanifest", null, { "keep-me.txt": "CLOBBERED" }, "v2");
    const second = Marketplace.installLocal(v2);
    assert.equal(second.ok, false);
    assert.equal(second.reason, "invalid-manifest");
    assert.equal(readFileSync(join(dest, "keep-me.txt"), "utf8"), "original");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(sourceParent, { recursive: true, force: true });
  }
});

test("SF-8: a reinstall with unparseable JSON leaves the valid install intact", () => {
  const root = freshRoot();
  const sourceParent = mkdtempSync(join(tmpdir(), "cf-mkt-sf8-src-"));
  try {
    configureMarketplace({ rootDir: root });
    const dest = join(root, "marketplace", "badjson");

    const v1 = makeSource(sourceParent, "badjson", VALID, { "keep-me.txt": "original" });
    assert.equal(Marketplace.installLocal(v1).ok, true);

    const v2 = makeSource(sourceParent, "badjson", null, {}, "v2");
    writeFileSync(join(v2, "plugin.json"), "{ this is not json", "utf8");
    const second = Marketplace.installLocal(v2);
    assert.equal(second.ok, false);
    assert.equal(second.reason, "invalid-manifest");
    assert.equal(readFileSync(join(dest, "keep-me.txt"), "utf8"), "original");
    const manifest = JSON.parse(readFileSync(join(dest, "plugin.json"), "utf8"));
    assert.equal(manifest.version, "1.0.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(sourceParent, { recursive: true, force: true });
  }
});

test("SF-8: a failed replacement leaves no staging residue", () => {
  const root = freshRoot();
  const sourceParent = mkdtempSync(join(tmpdir(), "cf-mkt-sf8-src-"));
  try {
    configureMarketplace({ rootDir: root });
    const v1 = makeSource(sourceParent, "tidy", VALID);
    assert.equal(Marketplace.installLocal(v1).ok, true);
    assert.deepEqual(stagingEntries(root), [], "a successful install must leave no staging residue");

    const v2 = makeSource(sourceParent, "tidy", INVALID_NO_VERSION, {}, "v2");
    assert.equal(Marketplace.installLocal(v2).ok, false);
    assert.deepEqual(stagingEntries(root), [], "a failed replacement must clean its staging attempt");

    const v3 = makeSource(sourceParent, "tidy", null, {}, "v3");
    assert.equal(Marketplace.installLocal(v3).ok, false);
    assert.deepEqual(stagingEntries(root), [], "a failed replacement must clean its staging attempt");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(sourceParent, { recursive: true, force: true });
  }
});

test("SF-8: a failed FIRST install still leaves nothing behind", () => {
  const root = freshRoot();
  const sourceParent = mkdtempSync(join(tmpdir(), "cf-mkt-sf8-src-"));
  try {
    configureMarketplace({ rootDir: root });
    const bad = makeSource(sourceParent, "firstbad", INVALID_NO_VERSION);
    const r = Marketplace.installLocal(bad);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "invalid-manifest");
    assert.equal(existsSync(join(root, "marketplace", "firstbad")), false,
      "a failed first install must not leave a destination folder");
    assert.deepEqual(stagingEntries(root), []);
    assert.deepEqual(Marketplace.list(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(sourceParent, { recursive: true, force: true });
  }
});

test("SF-8: the staging directory is not registered as an installed item", () => {
  const root = freshRoot();
  const sourceParent = mkdtempSync(join(tmpdir(), "cf-mkt-sf8-src-"));
  try {
    configureMarketplace({ rootDir: root });
    const good = makeSource(sourceParent, "realitem", VALID);
    assert.equal(Marketplace.installLocal(good).ok, true);

    // A hostile tree dropped into the reserved staging area must not be
    // registered on the next boot.
    const planted = join(root, "marketplace", "staging", "planted");
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, "plugin.json"), JSON.stringify(VALID), "utf8");

    const booted = Marketplace.start();
    assert.equal(booted.ok, true);
    assert.deepEqual(booted.errors, [], "the reserved staging dir must not produce a spurious error");
    assert.deepEqual(Marketplace.list().map((i) => i.id), ["realitem"],
      "only the real item may be registered");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(sourceParent, { recursive: true, force: true });
  }
});

test("SF-8: containment is unchanged — hostile source spellings are still refused", () => {
  const root = freshRoot();
  const sourceParent = mkdtempSync(join(tmpdir(), "cf-mkt-sf8-src-"));
  try {
    configureMarketplace({ rootDir: root });
    const sentinel = join(root, "outside.txt");
    writeFileSync(sentinel, "keep", "utf8");

    // A valid plugin folder, then every hostile SPELLING of a path whose
    // basename would not be a legal marketplace identity.
    const real = makeSource(sourceParent, "legit", VALID);
    assert.equal(Marketplace.installLocal(real).ok, true, "the legitimate source must still install");

    for (const spelling of [
      join(sourceParent, "legit", ".."),        // basename ".."
      join(sourceParent, "legit", "..", ".."),  // basename ".."
      `${real}.`,                               // trailing dot
      `${real} `,                               // trailing space
    ]) {
      const r = Marketplace.installLocal(spelling);
      assert.equal(r.ok, false, `${JSON.stringify(spelling)} must be refused`);
      assert.equal(typeof r.reason, "string");
    }

    // Windows-reserved and separator-bearing identities are refused upstream by
    // the shared containment policy.
    for (const id of ["con", "nul", "a/b", "a\\b", "C:\\escape"]) {
      const r = Marketplace.installLocal(join(sourceParent, "..", "..", "x", id));
      assert.notEqual(r.ok, true);
    }

    assert.equal(readFileSync(sentinel, "utf8"), "keep", "nothing outside the marketplace root may change");
    assert.equal(existsSync(join(root, "marketplace", "legit")), true, "the legitimate install must survive");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(sourceParent, { recursive: true, force: true });
  }
});
