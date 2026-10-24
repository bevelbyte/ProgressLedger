// Lock the renderer-visible Donut status surface. The PUBLIC_STATUS_KEYS
// whitelist is the contract between the main process and the UI; if a
// forbidden field (e.g. the backend pid) is added back, this test fails
// and forces a deliberate update of the privacy contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PUBLIC_STATUS_KEYS, sanitizeStatus } from "../src/services/donut.js";

test("PUBLIC_STATUS_KEYS excludes process IDs and tokens", () => {
  for (const forbidden of ["pid", "launcherPid", "api_token", "mcp_token", "port", "data_dir"]) {
    assert.equal(
      PUBLIC_STATUS_KEYS.includes(forbidden),
      false,
      `${forbidden} must not be renderer-reachable`
    );
  }
});

test("sanitizeStatus strips forbidden keys even if present in input", () => {
  const out = sanitizeStatus({
    state: "running",
    available: true,
    ready: true,
    owned: true,
    pid: 12345,                  // forbidden
    launcherPid: 67890,          // forbidden
    api_token: "D-leak",         // forbidden
    mcp_token: "wp-leak",        // forbidden
    port: 10108,                 // forbidden
    data_dir: "/etc/donut",      // forbidden
    detail: "ok",
  });
  assert.equal(out.state, "running");
  assert.equal(out.detail, "ok");
  for (const forbidden of ["pid", "launcherPid", "api_token", "mcp_token", "port", "data_dir"]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(out, forbidden),
      false,
      `sanitizeStatus leaked ${forbidden}`
    );
  }
});
