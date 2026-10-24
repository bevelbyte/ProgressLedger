import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(repo, path), "utf8");

test("production IPC does not register a direct CDP surface", () => {
  const index = read("shell/src/ipc/index.js");
  const preload = read("shell/src/preload.cjs");
  assert.doesNotMatch(index, /registerCdp|\.\/cdp\.js/);
  assert.doesNotMatch(preload, /ipcRenderer\.invoke\(\s*["']cdp:/);
  assert.doesNotMatch(preload, /^\s*cdp:\s*\{/m);
});

test("legacy Donut workspace IPC is fail-closed and has no CDP/native-window dependencies", () => {
  const workspace = read("shell/src/ipc/browser-workspace.js");
  assert.doesNotMatch(workspace, /services\/cdp-(?:adapter|session)\.js/);
  assert.doesNotMatch(workspace, /findWindowForProcess|findWindowsForProcess|inspectWindow|focusWindow|focusHostedWindow|hostWindow|resizeHostedWindow/);
  assert.match(workspace, /reason:\s*["']feature-not-supported["']/);
  assert.match(workspace, /registerUnsupportedDonutTools\(\)/);
});

test("CareerFlow embedded browser remains independent of Donut and CDP", () => {
  const host = read("shell/src/services/browser/host.js");
  const browserIpc = read("shell/src/ipc/browser.js");
  assert.match(host, /WebContentsView/);
  assert.doesNotMatch(host, /^\s*import\s+(?:[^;\n]*?\s+from\s+)?["'][^"']*(?:donut|cdp-adapter|cdp-session)[^"']*["'];/im);
  assert.match(browserIpc, /browser:create-page|browser:create/);
  assert.doesNotMatch(browserIpc, /cdp-adapter|cdp-session|focusWindow|hostWindow/i);
});
