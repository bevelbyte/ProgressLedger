import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserRegistry, MAX_LIVE_PAGES } from "../src/services/browser/registry.js";

// Plain-Node registry tests: the registry takes its view factory as a
// dependency, so no Electron is needed here.
function setup(maxLive = 2) {
  const created = [];
  const destroyed = [];
  let clock = 1000;
  const registry = createBrowserRegistry({
    createView: (spec) => {
      const view = { ...spec };
      created.push(view);
      return view;
    },
    destroyView: (id) => {
      destroyed.push(id);
    },
    maxLive,
    now: () => (clock += 100),
  });
  return { registry, created, destroyed };
}

test("phase 3 live cap is 5", () => {
  assert.equal(MAX_LIVE_PAGES, 5);
});

test("creating past the cap hibernates the least-recently-used background page", () => {
  const { registry, created, destroyed } = setup(2);
  const a = registry.create({ profileId: 1, url: "https://a.example/" });
  const b = registry.create({ profileId: 1, url: "https://b.example/" });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const c = registry.create({ profileId: 1, url: "https://c.example/" });
  assert.equal(c.ok, true, "third page should evict, not refuse");
  assert.deepEqual(destroyed, [a.page.id], "oldest background view torn down");
  assert.equal(registry.get(a.page.id).hibernated, true);
  assert.equal(registry.get(b.page.id).hibernated, false);
  assert.equal(registry.get(c.page.id).hibernated, false);
  assert.equal(registry.count(), 3, "hibernated record kept");
  assert.equal(created.length, 3);
});

test("visible pages are never evicted; all-visible refuses", () => {
  const { registry } = setup(2);
  const a = registry.create({ profileId: 1, url: "https://a.example/" });
  const b = registry.create({ profileId: 1, url: "https://b.example/" });
  registry.update(a.page.id, { visible: true });
  const c = registry.create({ profileId: 1, url: "https://c.example/" });
  assert.equal(c.ok, true);
  assert.equal(registry.get(b.page.id).hibernated, true, "background page evicted, visible kept");
  assert.equal(registry.get(a.page.id).hibernated, false);
  registry.update(c.page.id, { visible: true });
  const d = registry.create({ profileId: 1, url: "https://d.example/" });
  assert.equal(d.ok, false);
  assert.equal(d.reason, "live-cap-reached");
});

test("wake rebuilds the same id; destroying a sleeping page tears nothing down twice", () => {
  const { registry, created, destroyed } = setup(2);
  const a = registry.create({ profileId: 1, url: "https://a.example/" });
  registry.create({ profileId: 1, url: "https://b.example/" });
  registry.create({ profileId: 1, url: "https://c.example/" });
  assert.equal(registry.get(a.page.id).hibernated, true);
  const woken = registry.wake(a.page.id);
  assert.equal(woken.ok, true);
  assert.equal(woken.page.id, a.page.id, "same id after wake");
  assert.equal(woken.page.hibernated, false);
  assert.equal(created.length, 4, "fresh view built on wake");
  assert.equal(registry.destroy(a.page.id), true);
  const p = registry.create({ profileId: 1, url: "https://p.example/" });
  registry.create({ profileId: 1, url: "https://q.example/" });
  registry.create({ profileId: 1, url: "https://r.example/" });
  assert.equal(registry.get(p.page.id).hibernated, true);
  const destroysOfP = destroyed.filter((id) => id === p.page.id).length;
  assert.equal(destroysOfP, 1, "eviction tore the view down once");
  assert.equal(registry.destroy(p.page.id), true);
  assert.equal(
    destroyed.filter((id) => id === p.page.id).length,
    1,
    "destroying a sleeping page must not tear the view down again",
  );
});
