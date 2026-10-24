// Supported credential-store IPC boundary.
//
// The credential path is the seam the REAL-PROVIDER gate depends on:
//
//   ProviderConfigPanel -> projectModeService.setProviderConfig(pid, projid, cfg)
//     -> preload setProviderConfig(profileId, projectId, config)   [POSITIONAL]
//       -> project:set-provider-config handler -> credentialsStore.writeProviderConfig
//
// A renderer-side argument-contract defect (collapsing the payload into a single
// object) silently killed this path, so the agent fell back to the mock provider.
// These source-level assertions lock the preload/handler seams that cannot be
// executed under `node --test` (project-mode.js imports electron). The
// renderer forwarding itself is locked behaviourally by
// ui/tests/credential-ipc-contract.test.js; the store semantics by
// shell/tests/credentials-format.test.js + shell/tests/provider.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const preload = readFileSync(fileURLToPath(new URL("../src/preload.cjs", import.meta.url)), "utf8");
const projectMode = readFileSync(fileURLToPath(new URL("../src/ipc/project-mode.js", import.meta.url)), "utf8");

// Slice from the channel's registration up to the NEXT handler (never beyond),
// so assertions cannot be satisfied by a neighbouring channel's source.
function handlerBody(channel, span = 900) {
  const start = projectMode.indexOf(`safeHandle("${channel}"`);
  assert.ok(start >= 0, `${channel} must be registered`);
  const next = projectMode.indexOf("safeHandle(", start + 1);
  const end = next === -1 ? start + span : Math.min(next, start + span);
  return projectMode.slice(start, end);
}

test("credential IPC: preload setProviderConfig is positional and reads the config arg", () => {
  assert.match(
    preload,
    /setProviderConfig:\s*\(profileId,\s*projectId,\s*config\)\s*=>/,
    "preload setProviderConfig must take (profileId, projectId, config)",
  );
  assert.match(preload, /endpoint:\s*config\s*&&\s*config\.endpoint/);
  assert.match(preload, /apiKey:\s*config\s*&&\s*config\.apiKey/);
  assert.match(preload, /model:\s*config\s*&&\s*config\.model/);
});

test("credential IPC: get-provider-config uses the SAFE reader (apiKey never crosses)", () => {
  const body = handlerBody("project:get-provider-config");
  assert.match(body, /readProviderConfigSafe\(profileId,\s*projectId\)/);
  assert.doesNotMatch(body, /readProviderConfig\(profileId/, "must not use the raw reader");
  assert.doesNotMatch(body, /\bapiKey\b/, "renderer response must carry no apiKey field");
});

test("credential IPC: get/set/clear-provider-config gate on project ownership", () => {
  for (const channel of [
    "project:get-provider-config",
    "project:set-provider-config",
    "project:clear-provider-config",
  ]) {
    assert.match(
      handlerBody(channel),
      /assertProjectOwned\(profileId,\s*projectId\)/,
      `${channel} must verify project ownership before the credential store call`,
    );
  }
});

test("credential IPC: set-provider-config returns only the sanitized config", () => {
  const body = handlerBody("project:set-provider-config");
  // The write result handed to the renderer is the store's sanitized
  // { endpoint, model, hasKey } view — never the raw stored object.
  assert.match(body, /return\s*\{\s*ok:\s*true,\s*config:\s*result\.config\s*\}/);
  assert.doesNotMatch(body, /apiKey:\s*result\.config\.apiKey/);
});
