// Page network log rules (Bug 3): what is recorded, what is stripped,
// and what is never recorded. The module is pure, so every rule here is
// asserted directly — no Electron, no I/O, no page needed.
import test from "node:test";
import assert from "node:assert/strict";
import {
  PAGE_NETWORK_LOG_CAP,
  networkLogEntryFor,
  createPageNetworkLog,
  recordPageNetworkEntry,
  clearPageNetworkLog,
} from "../src/services/browser/page-network-log.js";

const AT = 1793120000000;
const now = () => AT;

test("records host + path + HTTP status + time, and nothing else", () => {
  const entry = networkLogEntryFor("https://chatgpt.com/backend-api/conversation?token=abc#frag", { status: 503 }, now);
  assert.deepEqual(entry, {
    at: AT,
    host: "chatgpt.com",
    path: "/backend-api/conversation",
    status: 503,
  });
});

test("records host + path + Chromium error + time for network errors", () => {
  const entry = networkLogEntryFor("https://api.example.com/v1/send", { error: "net::ERR_CONNECTION_REFUSED" }, now);
  assert.deepEqual(entry, {
    at: AT,
    host: "api.example.com",
    path: "/v1/send",
    error: "net::ERR_CONNECTION_REFUSED",
  });
});

test("strips query strings and fragments, even token-looking ones", () => {
  const entry = networkLogEntryFor(
    "https://example.com/path?api_key=secret&session=xyz#access_token=abc",
    { status: 403 },
    now,
  );
  assert.equal(entry.host, "example.com");
  assert.equal(entry.path, "/path");
  assert.equal(JSON.stringify(entry).includes("api_key"), false);
  assert.equal(JSON.stringify(entry).includes("session"), false);
  assert.equal(JSON.stringify(entry).includes("access_token"), false);
});

test("never records headers, cookies, or bodies: the entry has no such keys", () => {
  const entry = networkLogEntryFor("https://example.com/a", { status: 500 }, now);
  assert.deepEqual(Object.keys(entry).sort(), ["at", "host", "path", "status"]);
  const errorEntry = networkLogEntryFor("https://example.com/b", { error: "net::ERR_FAILED" }, now);
  assert.deepEqual(Object.keys(errorEntry).sort(), ["at", "error", "host", "path"]);
});

test("an unparseable URL records nothing, never a guessed host", () => {
  assert.equal(networkLogEntryFor("not a url", { status: 500 }, now), null);
  assert.equal(networkLogEntryFor("", { error: "net::ERR_FAILED" }, now), null);
  assert.equal(networkLogEntryFor(null, { status: 500 }, now), null);
});

test("an outcome with neither status nor error records nothing", () => {
  assert.equal(networkLogEntryFor("https://example.com/a", {}, now), null);
  assert.equal(networkLogEntryFor("https://example.com/a", { status: "500" }, now), null);
  assert.equal(networkLogEntryFor("https://example.com/a", { error: "" }, now), null);
});

test("a bare host gets the root path", () => {
  const entry = networkLogEntryFor("https://example.com", { status: 500 }, now);
  assert.equal(entry.path, "/");
});

test("the log caps at 200 entries, oldest dropped first", () => {
  const log = createPageNetworkLog();
  for (let i = 0; i < PAGE_NETWORK_LOG_CAP + 5; i += 1) {
    recordPageNetworkEntry(log, { at: AT + i, host: "example.com", path: `/p${i}`, status: 500 });
  }
  assert.equal(log.entries.length, PAGE_NETWORK_LOG_CAP);
  assert.equal(log.entries[0].path, "/p5");
  assert.equal(log.entries[log.entries.length - 1].path, `/p${PAGE_NETWORK_LOG_CAP + 4}`);
});

test("clear empties the log", () => {
  const log = createPageNetworkLog();
  recordPageNetworkEntry(log, networkLogEntryFor("https://example.com/a", { status: 500 }, now));
  assert.equal(log.entries.length, 1);
  clearPageNetworkLog(log);
  assert.equal(log.entries.length, 0);
});

test("null entries are ignored, never stored", () => {
  const log = createPageNetworkLog();
  recordPageNetworkEntry(log, null);
  assert.equal(log.entries.length, 0);
});
