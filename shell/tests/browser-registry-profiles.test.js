import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserRegistry } from "../src/services/browser/registry.js";

function stubRegistry() {
  const views = new Map();
  return createBrowserRegistry({
    createView: ({ id, partition }) => {
      const view = { id, partition, webContents: { session: null } };
      views.set(id, view);
      return view;
    },
    destroyView: (id) => views.delete(id),
  });
}

test("default profile adopts the legacy partition", () => {
  const registry = stubRegistry();
  const created = registry.create({
    profileId: 7,
    browserProfile: { localId: "bp-default-1", displayName: "Default", isDefault: true },
    url: "https://example.com",
  });
  assert.equal(created.ok, true);
  assert.equal(registry.record(created.page.id).partition, "persist:cf-browser-7");
  assert.equal(created.page.browserProfile.localId, "bp-default-1");
  assert.equal(created.page.browserProfile.isDefault, true);
});

test("a named profile gets its own persistent partition", () => {
  const registry = stubRegistry();
  const created = registry.create({
    profileId: 7,
    browserProfile: { localId: "bp-work-1", displayName: "Work", isDefault: false },
    url: "https://example.com",
  });
  assert.equal(created.ok, true);
  assert.equal(registry.record(created.page.id).partition, "persist:pl-browser-7-bp-work-1");
});

test("a temporary profile gets an in-memory partition", () => {
  const registry = stubRegistry();
  const created = registry.create({
    profileId: 7,
    browserProfile: { localId: "temp-abc-123", displayName: "Temporary", temporary: true },
    url: "https://example.com",
  });
  assert.equal(created.ok, true);
  assert.equal(registry.record(created.page.id).partition, "pl-temp-abc-123");
  assert.equal(created.page.browserProfile.temporary, true);
});

test("a malformed browser profile id is refused, never silently downgraded", () => {
  const registry = stubRegistry();
  const created = registry.create({
    profileId: 7,
    browserProfile: { localId: "user-text/../evil", displayName: "Evil" },
    url: "https://example.com",
  });
  assert.equal(created.ok, false);
  assert.equal(created.reason, "no-profile");
  assert.equal(registry.count(), 0);
});

test("the live cap is per workspace and shared across its profiles", () => {
  const registry = stubRegistry();
  // Workspace 7, cap 2: two pages live, the third sleeps the LRU one.
  const a = registry.create({ profileId: 7, browserProfile: { localId: "bp-a", displayName: "A" }, liveCap: 2, url: "https://a.example" });
  const b = registry.create({ profileId: 7, browserProfile: { localId: "bp-b", displayName: "B" }, liveCap: 2, url: "https://b.example" });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const c = registry.create({ profileId: 7, browserProfile: { localId: "bp-a", displayName: "A" }, liveCap: 2, url: "https://c.example" });
  assert.equal(c.ok, true);
  assert.equal(registry.record(a.page.id).hibernated, true);
  assert.equal(registry.record(b.page.id).hibernated, false);
  // Workspace 9 is untouched by workspace 7's eviction: its pages stay live.
  const d = registry.create({ profileId: 9, browserProfile: { localId: "bp-d", displayName: "D" }, liveCap: 2, url: "https://d.example" });
  assert.equal(d.ok, true);
  assert.equal(registry.record(d.page.id).hibernated, false);
  assert.equal(registry.record(b.page.id).hibernated, false);
});

test("the public shape never carries profile secrets", () => {
  const registry = stubRegistry();
  const created = registry.create({
    profileId: 7,
    browserProfile: {
      localId: "bp-secret",
      displayName: "Secret",
      proxyUsername: "user",
      proxyPassword: "hunter2",
      proxyPasswordEncrypted: "blob",
    },
    url: "https://example.com",
  });
  assert.equal(created.ok, true);
  const pub = created.page.browserProfile;
  assert.equal(JSON.stringify(pub).includes("hunter2"), false);
  assert.equal(JSON.stringify(pub).includes("blob"), false);
  assert.equal("proxyPassword" in pub, false);
});
