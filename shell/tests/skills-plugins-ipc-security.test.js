import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/ipc/skills-plugins-mcp.js", import.meta.url), "utf8");
const preload = readFileSync(new URL("../src/preload.cjs", import.meta.url), "utf8");

function bodyOf(channel, size = 1200) {
  const start = source.indexOf(`safeHandle("${channel}"`);
  assert.ok(start >= 0, `${channel} must be registered`);
  return source.slice(start, start + size);
}

test("plugin list and state mutations require an existing profile", () => {
  for (const channel of ["plugins:list", "plugins:install-local", "plugins:reload", "plugins:enable", "plugins:disable"]) {
    const body = bodyOf(channel);
    assert.match(body, /profileId/, `${channel} must accept a profile identity`);
    assert.match(body, /assertProfileOwned\(ctx, profileId\)/, `${channel} must verify profile ownership`);
    assert.match(body, /if \(!ownership\.ok\) return ownership/, `${channel} must stop on failed ownership`);
  }
});

test("plugin install/reload authorize profile before mutation", () => {
  for (const channel of ["plugins:install-local", "plugins:reload"]) {
    const body = bodyOf(channel);
    const auth = body.indexOf("assertProfileOwned(ctx, profileId)");
    const mutation = body.indexOf(`Plugins.${channel === "plugins:install-local" ? "install" : "reload"}`);
    assert.ok(auth >= 0 && mutation >= 0 && auth < mutation, `${channel} must authorize before mutation`);
  }
});

test("plugin handlers cannot mutate global state before profile authorization", () => {
  for (const channel of ["plugins:enable", "plugins:disable"]) {
    const body = bodyOf(channel);
    const auth = body.indexOf("assertProfileOwned(ctx, profileId)");
    const mutation = body.indexOf(`Plugins.${channel === "plugins:enable" ? "enable" : "disable"}(id)`);
    assert.ok(auth >= 0 && mutation >= 0 && auth < mutation, `${channel} must authorize before mutation`);
  }
});

test("preload forwards the active profile to every profile-gated plugin operation", () => {
  assert.match(preload, /listPlugins: \(profileId\) => ipcRenderer\.invoke\("plugins:list", \{ profileId \}\)/);
  assert.match(preload, /installLocalPlugin: \(profileId, source, id\) =>[\s\S]*ipcRenderer\.invoke\("plugins:install-local", \{ profileId, source/);
  assert.match(preload, /reloadPlugin: \(id, profileId\) =>[\s\S]*ipcRenderer\.invoke\("plugins:reload", \{ profileId/);
  assert.match(preload, /enablePlugin: \(id, profileId\) =>[\s\S]*ipcRenderer\.invoke\("plugins:enable", \{ profileId/);
  assert.match(preload, /disablePlugin: \(id, profileId\) =>[\s\S]*ipcRenderer\.invoke\("plugins:disable", \{ profileId/);
});
