// Tests for `verifyIpcSender` (shell/src/security/ipc-auth.js).
//
// The function is pure: it inspects `event.senderFrame.url` and either
// returns `{ ok: true }` or `{ ok: false, reason }`. No Electron runtime
// is required — we pass a minimal mock event object per case.
//
// The "smallest correct" wrapper (`safeHandle`) is NOT imported here
// because it pulls in `electron` at module load; it is exercised in the
// integration tests that load the full shell. The allow-list logic is
// fully covered here.

import test from "node:test";
import assert from "node:assert/strict";

import {
  verifyIpcSender,
  DEFAULT_IPC_ALLOW_LIST,
} from "../src/security/ipc-auth.js";

const mkEvent = (url, frame = {}) => ({ senderFrame: { url, parent: null, top: null, ...frame } });

// ---------------------------------------------------------------------------
// Default allow-list
// ---------------------------------------------------------------------------

test("verifyIpcSender: http://localhost:5173 (vite dev) is allowed", () => {
  const event = mkEvent("http://localhost:5173/");
  assert.deepEqual(verifyIpcSender(event), { ok: true });
});

test("verifyIpcSender: http://127.0.0.1:5173 (vite dev) is allowed", () => {
  const event = mkEvent("http://127.0.0.1:5173/src/main.ts");
  assert.deepEqual(verifyIpcSender(event), { ok: true });
});

test("verifyIpcSender: the app-owned progressledger-v2:// origin is allowed", () => {
  const event = mkEvent("progressledger-v2://app/index.html");
  assert.deepEqual(verifyIpcSender(event), { ok: true });
});

test("verifyIpcSender: arbitrary file:// origins are rejected", () => {
  const event = mkEvent("file:///C:/attacker/index.html");
  assert.deepEqual(verifyIpcSender(event), { ok: false, reason: "unknown-origin" });
});

test("verifyIpcSender: http://evil.com origin is rejected", () => {
  const event = mkEvent("http://evil.com/");
  const verdict = verifyIpcSender(event);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "unknown-origin");
});

test("verifyIpcSender: evil host sharing a trusted URL prefix is rejected", () => {
  assert.equal(verifyIpcSender(mkEvent("http://localhost:51730/")).ok, false);
  assert.equal(verifyIpcSender(mkEvent("http://localhost:5173.evil.example/")).ok, false);
  assert.equal(verifyIpcSender(mkEvent("app://progressledger.evil.example/")).ok, false);
});

test("verifyIpcSender: event with no senderFrame is rejected", () => {
  const event = {};
  const verdict = verifyIpcSender(event);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "unknown-origin");
});

test("verifyIpcSender: trusted-origin child frame is rejected", () => {
  const top = {};
  const verdict = verifyIpcSender(mkEvent("http://localhost:5173/", { parent: top, top }));
  assert.deepEqual(verdict, { ok: false, reason: "untrusted-frame" });
});

test("verifyIpcSender: senderFrame with no url is rejected", () => {
  const event = { senderFrame: {} };
  const verdict = verifyIpcSender(event);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "unknown-origin");
});

// ---------------------------------------------------------------------------
// Test-mode + override semantics
// ---------------------------------------------------------------------------

test("verifyIpcSender: skipForTests:true always returns ok", () => {
  const event = mkEvent("http://evil.com/");
  const verdict = verifyIpcSender(event, { skipForTests: true });
  assert.deepEqual(verdict, { ok: true });
});

test("verifyIpcSender: skipForTests:true tolerates missing senderFrame", () => {
  const event = {};
  const verdict = verifyIpcSender(event, { skipForTests: true });
  assert.deepEqual(verdict, { ok: true });
});

test("verifyIpcSender: allowList override rejects default-allowed origins", () => {
  const event = mkEvent("app://progressledger/index.html");
  const verdict = verifyIpcSender(event, { allowList: ["app://custom"] });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "unknown-origin");
});

test("verifyIpcSender: allowList override accepts only the overridden origin", () => {
  const event = mkEvent("app://custom/page");
  const verdict = verifyIpcSender(event, { allowList: ["app://custom"] });
  assert.deepEqual(verdict, { ok: true });
});

test("verifyIpcSender: allowList entries match parsed origin, not a URL prefix", () => {
  const allowList = ["https://example.com:8443"];
  assert.deepEqual(verifyIpcSender(mkEvent("https://example.com:8443/path"), { allowList }), { ok: true });
  assert.equal(verifyIpcSender(mkEvent("https://example.com:84430/path"), { allowList }).ok, false);
  assert.equal(verifyIpcSender(mkEvent("https://example.com.attacker/path"), { allowList }).ok, false);
});

test("verifyIpcSender: empty allowList falls back to default", () => {
  // An override that is an empty array must not silently disable the
  // allow-list (that would re-introduce the trust-everything posture).
  const event = mkEvent("http://evil.com/");
  const verdict = verifyIpcSender(event, { allowList: [] });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "unknown-origin");
});

// ---------------------------------------------------------------------------
// Default allow-list sanity
// ---------------------------------------------------------------------------

test("DEFAULT_IPC_ALLOW_LIST contains only active renderer origins", () => {
  assert.ok(Array.isArray(DEFAULT_IPC_ALLOW_LIST));
  assert.equal(DEFAULT_IPC_ALLOW_LIST.length, 3);
  assert.equal(DEFAULT_IPC_ALLOW_LIST.includes("app://progressledger"), false);
  assert.ok(DEFAULT_IPC_ALLOW_LIST.includes("progressledger-v2://app"));
  assert.ok(DEFAULT_IPC_ALLOW_LIST.includes("http://localhost:5173"));
  assert.ok(DEFAULT_IPC_ALLOW_LIST.includes("http://127.0.0.1:5173"));
});

test("DEFAULT_IPC_ALLOW_LIST is frozen (cannot be mutated at runtime)", () => {
  assert.equal(Object.isFrozen(DEFAULT_IPC_ALLOW_LIST), true);
});
