// GATE A — credentials store format hardening.
//
// Contract under test:
//   1. A UTF-8 BOM before valid JSON no longer breaks parsing (Windows
//      editors commonly write one). The store loads normally.
//   2. A malformed (non-JSON) store is NOT silently treated as empty:
//      reads resolve nothing AND a structured sanitized diagnostic
//      (`credential-store-malformed`) is available — reason only,
//      never file content, never field values.
//   3. A valid store loads exactly as before (no behavior change).
//   4. Zero secret serialization: the apiKey must never appear in any
//      safe view, diagnostic, or error — under any store condition.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCredentialsStore } from "../src/services/agent/credentials.js";

const KEY = "sk-test-SECRET-VALUE-DO-NOT-PRINT";
const ENDPOINT = "https://api.example.com";
const MODEL = "test-model";

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "cf-cred-"));
  return { dir, store: createCredentialsStore({ userDataDir: dir }) };
}

test("GATE A: BOM'd valid JSON store loads normally", () => {
  const { dir, store } = makeStore();
  try {
    const payload = JSON.stringify({ "0:0": { endpoint: ENDPOINT, apiKey: KEY, model: MODEL, updatedAt: 1 } }, null, 2);
    writeFileSync(join(dir, "pm-secrets.json"), "\uFEFF" + payload, "utf8");
    const cfg = store.readProviderConfig(0, 0);
    assert.ok(cfg, "BOM'd store must resolve");
    assert.equal(cfg.endpoint, ENDPOINT);
    assert.equal(cfg.model, MODEL);
    assert.equal(store.diagnostic(), null, "no diagnostic for a healthy store");
    const safe = store.readProviderConfigSafe(0, 0);
    assert.equal(safe.hasKey, true);
    assert.equal(safe.endpoint, ENDPOINT);
    assert.equal(safe.model, MODEL);
    assert.equal(safe.diagnostic, undefined, "healthy safe view carries no diagnostic");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GATE A: malformed (non-JSON) store is structured-diagnostic, never silent-empty", () => {
  const { dir, store } = makeStore();
  try {
    // Simulates the observed real-world malformation: plain text
    // (endpoint line first), NOT JSON. Content written here is a
    // fixture, not a secret.
    writeFileSync(join(dir, "pm-secrets.json"), "https://t\nline2\n", "utf8");
    const cfg = store.readProviderConfig(0, 0);
    assert.equal(cfg, null, "no credential resolves from a malformed store");
    const diag = store.diagnostic();
    assert.ok(diag, "diagnostic must be present");
    assert.equal(diag.code, "credential-store-malformed");
    assert.equal(diag.reason, "unparseable-json");
    // Sanitization: the diagnostic must not carry file content.
    assert.ok(!JSON.stringify(diag).includes("https://t"), "diagnostic must not contain file content");
    // The safe view surfaces the diagnostic with hasKey:false.
    const safe = store.readProviderConfigSafe(0, 0);
    assert.ok(safe, "safe view present for malformed store");
    assert.equal(safe.hasKey, false);
    assert.equal(safe.diagnostic && safe.diagnostic.code, "credential-store-malformed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GATE A: wrong-shape JSON (array/primitive) is also credential-store-malformed", () => {
  const { dir, store } = makeStore();
  try {
    writeFileSync(join(dir, "pm-secrets.json"), "[1,2,3]", "utf8");
    store.readProviderConfig(0, 0);
    assert.equal(store.diagnostic() && store.diagnostic().reason, "not-an-object");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GATE A: valid store behaves exactly as before (no behavior change)", () => {
  const { dir, store } = makeStore();
  try {
    const w = store.writeProviderConfig(3, 7, { endpoint: ENDPOINT, apiKey: KEY, model: MODEL });
    assert.equal(w.ok, true);
    const safe = store.readProviderConfigSafe(3, 7);
    assert.equal(safe.hasKey, true);
    assert.equal(safe.endpoint, ENDPOINT);
    assert.equal(safe.model, MODEL);
    assert.equal(safe.diagnostic, undefined);
    assert.equal(store.diagnostic(), null);
    // Persistence round-trip on disk.
    const store2 = createCredentialsStore({ userDataDir: dir });
    assert.equal(store2.readProviderConfig(3, 7).model, MODEL);
    // UNCHANGED sentinel still preserves the key.
    const w2 = store2.writeProviderConfig(3, 7, { endpoint: ENDPOINT + "/v2", apiKey: "UNCHANGED", model: MODEL });
    assert.equal(w2.ok, true);
    assert.equal(store2.readProviderConfig(3, 7).endpoint, ENDPOINT + "/v2");
    assert.equal(store2.readProviderConfig(3, 7).apiKey, KEY);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GATE A: missing and empty stores stay non-diagnostic (empty ≠ malformed)", () => {
  const { dir, store } = makeStore();
  try {
    assert.equal(store.readProviderConfig(9, 9), null, "missing store resolves nothing");
    assert.equal(store.diagnostic(), null, "missing store is not malformed");
    writeFileSync(join(dir, "pm-secrets.json"), "   \n  ", "utf8");
    assert.equal(store.readProviderConfig(9, 9), null, "whitespace-only store resolves nothing");
    assert.equal(store.diagnostic(), null, "empty store is not malformed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GATE A: zero secret serialization — apiKey never appears in any safe view or diagnostic", () => {
  const { dir, store } = makeStore();
  try {
    store.writeProviderConfig(1, 2, { endpoint: ENDPOINT, apiKey: KEY, model: MODEL });
    // Collect every externally observable surface.
    const surfaces = [];
    surfaces.push(["safe-view", store.readProviderConfigSafe(1, 2)]);
    surfaces.push(["write-result", store.writeProviderConfig(1, 2, { endpoint: ENDPOINT, apiKey: "UNCHANGED", model: MODEL })]);
    surfaces.push(["clear-result", store.clearProviderConfig(1, 2)]);
    for (const [name, obj] of surfaces) {
      const s = JSON.stringify(obj);
      assert.ok(!s.includes(KEY), `${name} must never contain the apiKey`);
    }
    // After clear, the store is empty: no credential, no diagnostic.
    assert.equal(store.readProviderConfig(1, 2), null);
    assert.equal(store.diagnostic(), null);
    // The on-disk file is the only place the key ever lived (written
    // through writeProviderConfig with the key) — assert the file no
    // longer contains it after clear.
    if (existsSync(join(dir, "pm-secrets.json"))) {
      assert.ok(!readFileSync(join(dir, "pm-secrets.json"), "utf8").includes(KEY),
        "cleared store must not retain the key");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
