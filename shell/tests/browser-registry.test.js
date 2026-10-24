// Browser page registry — Phase 1 of the approved D2-D6 plan.
//
// The registry is the main process's table of live pages and the ONLY thing that
// can turn a renderer-supplied string into a real browser instance. These tests
// drive it with an injected fake view, so they prove the lifecycle and the
// refusals without an Electron runtime. The real WebContentsView half is proven
// in e2e/browser-page.spec.js.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createBrowserRegistry, MAX_LIVE_PAGES, REASONS } from "../src/services/browser/registry.js";

function fakeRegistry(extra = {}) {
  const views = [];
  const destroyed = [];
  const registry = createBrowserRegistry({
    createView: (spec) => {
      const view = { spec, detached: 0 };
      views.push(view);
      return view;
    },
    destroyView: (id) => destroyed.push(id),
    ...extra,
  });
  return { registry, views, destroyed };
}

test("mints opaque ids and never exposes a partition to the public shape", () => {
  const { registry } = fakeRegistry();
  const created = registry.create({ profileId: 4, url: "https://example.com/" });
  assert.equal(created.ok, true);
  assert.equal(created.page.id, "bp-1");
  assert.equal(created.page.url, "https://example.com/");

  // The renderer-visible shape must not carry the partition name, the profile id
  // or anything else main-process-owned.
  const publicShape = registry.get("bp-1");
  const keys = Object.keys(publicShape).sort();
  assert.deepEqual(keys, [
    "attached",
    "crashed",
    "createdAt",
    "hibernated",
    "id",
    "insecure",
    "lastError",
    "loading",
    "state",
    "title",
    "url",
    "visible",
  ]);
  assert.equal("partition" in publicShape, false);
  assert.equal("profileId" in publicShape, false);

  // …while the internal record keeps them, for main-process modules only.
  const record = registry.record("bp-1");
  assert.equal(record.partition, "persist:cf-browser-4");
  assert.equal(record.profileId, 4);
});

test("refuses an unknown profile and an unsafe URL before creating any view", () => {
  const { registry, views } = fakeRegistry();
  assert.equal(registry.create({ profileId: null, url: "https://x.test/" }).reason, REASONS.NO_PROFILE);
  assert.equal(registry.create({ profileId: 0, url: "https://x.test/" }).reason, REASONS.NO_PROFILE);
  assert.equal(
    registry.create({ profileId: 2, url: "file:///etc/passwd" }).reason,
    REASONS.INVALID_URL,
  );
  assert.equal(registry.create({ profileId: 2, url: "javascript:alert(1)" }).reason, REASONS.INVALID_URL);
  assert.equal(views.length, 0, "a refused create must not build a view");
  assert.equal(registry.count(), 0);
});

test("bounds the number of live pages", () => {
  const { registry, destroyed } = fakeRegistry({ maxLive: 2 });
  assert.equal(registry.create({ profileId: 1, url: "https://a.test/" }).ok, true);
  assert.equal(registry.create({ profileId: 1, url: "https://b.test/" }).ok, true);
  // A third background page does not grow the live views: the least
  // recently used background page sleeps (its record stays, its view is
  // torn down) and the new page takes the freed slot.
  const over = registry.create({ profileId: 1, url: "https://c.test/" });
  assert.equal(over.ok, true);
  assert.equal(registry.get("bp-1").hibernated, true);
  assert.deepEqual(destroyed, ["bp-1"]);
  assert.equal(registry.count(), 3, "records are kept; only views are bounded");
  // When every live page is visible there is nothing safe to sleep, so
  // the cap refuses instead of evicting a page the user is reading.
  registry.update("bp-2", { visible: true });
  registry.update("bp-3", { visible: true });
  const refused = registry.create({ profileId: 1, url: "https://d.test/" });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, REASONS.LIVE_CAP);
  assert.equal(MAX_LIVE_PAGES > 0, true);
});

test("destroy is idempotent, tears the view down once and frees the cap", () => {
  const { registry, destroyed } = fakeRegistry({ maxLive: 1 });
  registry.create({ profileId: 1, url: "https://a.test/" });
  assert.equal(registry.destroy("bp-1"), true);
  assert.deepEqual(destroyed, ["bp-1"]);
  assert.equal(registry.destroy("bp-1"), false, "second destroy is a no-op");
  assert.deepEqual(destroyed, ["bp-1"], "the view is not torn down twice");
  assert.equal(registry.create({ profileId: 1, url: "https://b.test/" }).ok, true);
});

test("a throwing teardown still removes the page from the table", () => {
  const registry = createBrowserRegistry({
    createView: () => ({ webContents: {} }),
    destroyView: () => {
      throw new Error("view refused to close");
    },
  });
  registry.create({ profileId: 1, url: "https://a.test/" });
  assert.equal(registry.destroy("bp-1"), true);
  assert.equal(registry.count(), 0, "a failed close must not leave a zombie");
});

test("update only touches known pages and never invents one", () => {
  const { registry } = fakeRegistry();
  registry.create({ profileId: 1, url: "https://a.test/" });
  assert.equal(registry.update("bp-1", { title: "Hello" }).title, "Hello");
  assert.equal(registry.get("bp-1").title, "Hello");
  assert.equal(registry.update("bp-9", { title: "nope" }), null);
  assert.equal(registry.count(), 1);
});

test("destroyAll empties the table and is safe twice", () => {
  const { registry, destroyed } = fakeRegistry();
  registry.create({ profileId: 1, url: "https://a.test/" });
  registry.create({ profileId: 1, url: "https://b.test/" });
  registry.destroyAll();
  assert.equal(registry.count(), 0);
  assert.deepEqual(destroyed, ["bp-1", "bp-2"]);
  registry.destroyAll();
  assert.deepEqual(destroyed, ["bp-1", "bp-2"]);
});

test("there is no provider/engine seam: the registry takes exactly one factory", () => {
  // Phase 1 forbids reintroducing a provider abstraction. The registry signature
  // is the guard: one `createView`, no registry-of-browsers, no capability
  // negotiation, no engine selection.
  const { registry } = fakeRegistry();
  for (const forbidden of ["register", "setProvider", "engines", "capabilities", "selectEngine"]) {
    assert.equal(typeof registry[forbidden], "undefined", `${forbidden} must not exist`);
  }
});
