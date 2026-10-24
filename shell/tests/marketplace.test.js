// Marketplace — discovery + install layer above Skills / Plugins.
//
// Covers:
//   - installLocal copies a temp dir into <rootDir>/marketplace/<id>/
//   - list returns the registered item
//   - get returns the full manifest record
//   - remove clears the item and its folder
//   - installGit returns not-implemented
//   - validateManifest delegates to the Plugins validator
//
// All disk activity is hermetic via a per-test tmp dir. No Electron.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";

import {
  Marketplace,
  configureMarketplace,
  resolveMarketplaceDestination,
  validateManifest,
} from "../src/services/marketplace/index.js";
import {
  cleanupMarketplaceDestination,
  cleanupMarketplacePath,
} from "../src/services/marketplace/path-security.js";

test.beforeEach(() => {
  Marketplace._resetForTests();
});

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "cf-marketplace-"));
}

function makeMarketplaceDir(root, id, manifest) {
  const dir = join(root, "src-mkt", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  return dir;
}

// ---------------------------------------------------------------------------
// validateManifest (delegates to Plugins validator)
// ---------------------------------------------------------------------------

test("validateManifest: ok with full manifest", () => {
  const v = validateManifest({
    name: "Sample", version: "0.1.0",
    skills: ["s1"], tools: ["t1"], mcpServers: ["m1"],
  });
  assert.equal(v.ok, true);
  assert.equal(v.manifest.name, "Sample");
  assert.equal(v.manifest.version, "0.1.0");
});

test("validateManifest: missing name → invalid-manifest", () => {
  const v = validateManifest({ version: "1.0.0" });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "invalid-manifest");
});

// ---------------------------------------------------------------------------
// installLocal
// ---------------------------------------------------------------------------

test("installLocal copies a temp dir and registers the item", () => {
  const root = freshRoot();
  configureMarketplace({ rootDir: root });
  const src = makeMarketplaceDir(root, "starter", {
    name: "Starter", version: "0.1.0", skills: ["hello"],
  });
  const r = Marketplace.installLocal(src);
  assert.equal(r.ok, true);
  assert.equal(r.id, "starter");
  // Folder was actually copied.
  assert.ok(
    existsSync(join(root, "marketplace", "starter", "plugin.json")),
    "marketplace folder should be created",
  );
  assert.ok(
    readFileSync(join(root, "marketplace", "starter", "plugin.json"), "utf8").includes("Starter"),
  );
  // And registered.
  const list = Marketplace.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "starter");
  assert.equal(list[0].source.kind, "local");
  assert.equal(list[0].enabled, false);
  rmSync(root, { recursive: true, force: true });
});

test("installLocal rejects malformed manifest and cleans only the contained destination", () => {
  const root = freshRoot();
  configureMarketplace({ rootDir: root });
  const src = makeMarketplaceDir(root, "broken", { name: "Broken" /* no version */ });
  const marketplaceRoot = join(root, "marketplace");
  const rootSentinel = join(root, "root-sentinel.txt");
  writeFileSync(rootSentinel, "keep", "utf8");

  const r = Marketplace.installLocal(src);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-manifest");
  assert.equal(existsSync(join(marketplaceRoot, "broken")), false);
  assert.equal(existsSync(src), true, "source must survive rollback");
  assert.equal(readFileSync(rootSentinel, "utf8"), "keep", "rollback must not delete the marketplace root");
  rmSync(root, { recursive: true, force: true });
});

test("marketplace destination resolver rejects every non-child identity form", () => {
  const root = freshRoot();
  const expectedRoot = join(root, "marketplace");

  assert.deepEqual(resolveMarketplaceDestination(root, "normal-plugin"), {
    ok: true,
    marketplaceRoot: expectedRoot,
    destination: join(expectedRoot, "normal-plugin"),
  });

  for (const id of [
    "..",
    ".",
    "..\\escape",
    "../escape",
    "nested/plugin",
    "nested\\plugin",
    "C:\\escape",
    "C:escape",
    "\\\\server\\share\\escape",
    "\\\\?\\C:\\escape",
    "\\escape",
    "trailing\\",
    "trailing/",
    "normalized\\..\\escape",
    "/absolute/escape",
    "//server/share/escape",
    "plugin.",
    "plugin ",
  ]) {
    const result = resolveMarketplaceDestination(root, id);
    assert.equal(result.ok, false, `must reject ${JSON.stringify(id)}`);
    assert.equal(result.reason, "invalid-id");
  }

  rmSync(root, { recursive: true, force: true });
});

test("installLocal canonical source spellings stay contained and clean only the derived destination", () => {
  const root = freshRoot();
  configureMarketplace({ rootDir: root });
  const sourceParent = join(root, "source-parent");
  mkdirSync(sourceParent, { recursive: true });
  const sentinel = join(root, "root-sentinel.txt");
  writeFileSync(sentinel, "keep", "utf8");

  // These spellings all canonicalize to the same local source directory. The
  // basename-derived id remains contained, and failed-manifest cleanup cannot
  // affect the parent or an outside sentinel.
  for (const source of [
    sourceParent,
    `${sourceParent}${sep}`,
  ]) {
    const r = Marketplace.installLocal(source);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "invalid-manifest");
    assert.equal(existsSync(join(root, "marketplace", "source-parent")), false);
  }

  // A dot suffix is a different spelling whose basename is not a valid
  // marketplace identity. Reject it before copy.
  const dotSource = `${sourceParent}${sep}.`;
  const dot = Marketplace.installLocal(dotSource);
  assert.equal(dot.ok, false);
  assert.equal(dot.reason, "invalid-id");
  assert.equal(existsSync(join(root, "marketplace", "source-parent")), false);

  // The parent traversal spelling is a real different source directory, and
  // its basename is not a valid marketplace identity. Reject it before copy.
  const traversalSource = `${sourceParent}${sep}..`;
  const traversal = Marketplace.installLocal(traversalSource);
  assert.equal(traversal.ok, false);
  assert.equal(traversal.reason, "invalid-id");
  assert.equal(existsSync(join(root, "marketplace", "source-parent")), false);

  assert.equal(readFileSync(sentinel, "utf8"), "keep");
  rmSync(root, { recursive: true, force: true });
});

test("remove and update reject unsafe ids without touching an outside sentinel", () => {
  const root = freshRoot();
  configureMarketplace({ rootDir: root });
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "keep", "utf8");

  for (const id of ["..", ".", "..\\outside", "../outside", "C:\\escape", "\\\\server\\share\\escape"]) {
    const removed = Marketplace.remove(id);
    assert.deepEqual(removed, { ok: false, reason: "invalid-id" });
    const updated = Marketplace.update(id);
    assert.deepEqual(updated, { ok: false, reason: "invalid-id" });
  }

  assert.equal(readFileSync(outside, "utf8"), "keep");
});

test("cleanup only removes validated nested staging children", () => {
  const root = freshRoot();
  const staging = join(root, "marketplace", "staging", "attempt-1");
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "clone.tmp"), "temporary", "utf8");
  const sibling = join(root, "marketplace", "installed-plugin");
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "keep.txt"), "keep", "utf8");

  for (const segments of [[".."], ["staging", ".."], ["staging", "attempt-1", ".."], [""]]) {
    const result = cleanupMarketplacePath(root, ...segments);
    assert.equal(result.ok, false);
  }
  assert.equal(existsSync(staging), true);

  const cleaned = cleanupMarketplacePath(root, "staging", "attempt-1");
  assert.deepEqual(cleaned, { ok: true });
  assert.equal(existsSync(staging), false);
  assert.equal(readFileSync(join(sibling, "keep.txt"), "utf8"), "keep");
  rmSync(root, { recursive: true, force: true });
});

test("cleanup rejects symlink and junction destinations before recursive deletion", (t) => {
  const root = freshRoot();
  const outside = join(root, "outside-target");
  mkdirSync(outside, { recursive: true });
  const sentinel = join(outside, "keep.txt");
  writeFileSync(sentinel, "keep", "utf8");
  const marketplaceRoot = join(root, "marketplace");
  mkdirSync(marketplaceRoot, { recursive: true });
  const link = join(marketplaceRoot, "linked-plugin");

  try {
    symlinkSync(outside, link, "junction");
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    if (["EPERM", "EACCES", "ENOSYS"].includes(error && error.code)) {
      t.skip("symlink/junction creation is not permitted in this environment");
      return;
    }
    throw error;
  }

  const result = cleanupMarketplaceDestination(root, "linked-plugin");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-destination");
  assert.equal(readFileSync(sentinel, "utf8"), "keep");
  assert.equal(existsSync(link), true, "the link itself must not be removed");
  rmSync(root, { recursive: true, force: true });
});

test("installLocal rejects missing source", () => {
  const root = freshRoot();
  configureMarketplace({ rootDir: root });
  const r = Marketplace.installLocal("/does/not/exist");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "source-not-found");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// list / get
// ---------------------------------------------------------------------------

test("list returns the registered marketplace items", () => {
  const root = freshRoot();
  configureMarketplace({ rootDir: root });
  Marketplace.installLocal(makeMarketplaceDir(root, "alpha", {
    name: "Alpha", version: "1.0.0",
  }));
  Marketplace.installLocal(makeMarketplaceDir(root, "beta", {
    name: "Beta", version: "2.0.0", skills: ["s"],
  }));
  const list = Marketplace.list();
  assert.equal(list.length, 2);
  const ids = list.map((it) => it.id).sort();
  assert.deepEqual(ids, ["alpha", "beta"]);
  // listLocal filters to source.kind === 'local'.
  assert.equal(Marketplace.listLocal().length, 2);
  rmSync(root, { recursive: true, force: true });
});

test("get returns the full manifest record for an installed item", () => {
  const root = freshRoot();
  configureMarketplace({ rootDir: root });
  Marketplace.installLocal(makeMarketplaceDir(root, "demo", {
    name: "Demo", version: "1.2.3",
    skills: ["s1", "s2"], tools: ["t1"], mcpServers: ["m1"],
  }));
  const got = Marketplace.get("demo");
  assert.ok(got);
  assert.equal(got.id, "demo");
  assert.equal(got.name, "Demo");
  assert.equal(got.version, "1.2.3");
  assert.deepEqual(got.skills, ["s1", "s2"]);
  assert.deepEqual(got.tools, ["t1"]);
  assert.deepEqual(got.mcpServers, ["m1"]);
  assert.equal(got.source.kind, "local");
  // Unknown id returns null, not an error.
  assert.equal(Marketplace.get("ghost"), null);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

test("remove clears the item and its folder", () => {
  const root = freshRoot();
  configureMarketplace({ rootDir: root });
  Marketplace.installLocal(makeMarketplaceDir(root, "p", { name: "P", version: "1" }));
  assert.equal(Marketplace.list().length, 1);
  const r = Marketplace.remove("p");
  assert.equal(r.ok, true);
  assert.equal(Marketplace.list().length, 0);
  assert.equal(existsSync(join(root, "marketplace", "p")), false);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// installGit (smoke — full coverage of the git install path lives in
// shell/tests/marketplace-git.test.js).
// ---------------------------------------------------------------------------

test("installGit rejects empty url with invalid-source", async () => {
  const r = await Marketplace.installGit("");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-source");
  // And nothing got installed.
  assert.equal(Marketplace.list().length, 0);
});

test("installGit without root returns no-root", async () => {
  // Explicitly do NOT configureMarketplace — root is unset on purpose.
  const r = await Marketplace.installGit("https://example.com/repo.git");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-root");
});

// ---------------------------------------------------------------------------
// enable / disable / update
// ---------------------------------------------------------------------------

test("enable/disable toggles a marketplace item", () => {
  const root = freshRoot();
  configureMarketplace({ rootDir: root });
  Marketplace.installLocal(makeMarketplaceDir(root, "p", { name: "P", version: "1" }));
  assert.equal(Marketplace.list()[0].enabled, false);
  const en = Marketplace.enable("p");
  assert.equal(en.ok, true);
  assert.equal(Marketplace.list()[0].enabled, true);
  const dis = Marketplace.disable("p");
  assert.equal(dis.ok, true);
  assert.equal(Marketplace.list()[0].enabled, false);
  rmSync(root, { recursive: true, force: true });
});

test("update re-reads plugin.json and keeps enabled state", () => {
  const root = freshRoot();
  configureMarketplace({ rootDir: root });
  Marketplace.installLocal(makeMarketplaceDir(root, "p", { name: "P", version: "1" }));
  Marketplace.enable("p");
  // Bump the on-disk manifest version.
  const dest = join(root, "marketplace", "p", "plugin.json");
  writeFileSync(
    dest,
    JSON.stringify({ name: "P", version: "2", skills: ["s"] }, null, 2),
  );
  const r = Marketplace.update("p");
  assert.equal(r.ok, true);
  const after = Marketplace.get("p");
  assert.equal(after.version, "2");
  assert.equal(after.enabled, true);
  rmSync(root, { recursive: true, force: true });
});