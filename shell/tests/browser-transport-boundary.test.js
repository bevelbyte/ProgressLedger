// Anti-regression: the raw Chromium/CDP transport must stay gone.
//
// The Playwright-over-CDP migration removed Progress Ledger's hand-rolled DevTools
// transport (/json discovery, raw WebSocket, Target.* commands, fake /tabs REST
// fallbacks). The dynamic tests for the transport (cdp-session.test.js and
// cdp-adapter.test.js) are gone with the transport itself: Phase 2 removed
// Donut/CDP entirely. This file pins the STATIC shape: that the obsolete
// implementation never comes back anywhere in shell/src.
//
// The separate gate script (scripts/check-cdp-auth-boundary.mjs) was removed
// with Donut; this file is now the sole guard, so a unit-test run fails on its own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const shellSrc = join(root, "shell", "src");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".js") || entry.endsWith(".cjs")) out.push(full);
  }
  return out;
}

const files = walk(shellSrc).map((f) => ({
  rel: relative(root, f).split(sep).join("/"),
  src: readFileSync(f, "utf8"),
}));

const find = (pattern) =>
  files.filter((f) => pattern.test(f.src)).map((f) => f.rel);

test("no raw WebSocket transport remains anywhere in shell/src", () => {
  assert.deepEqual(find(/new\s+WebSocket\s*\(/), []);
});

test("no /json endpoint discovery remains", () => {
  assert.deepEqual(find(/"\/json\/(version|list)"/), []);
});

test("no webSocketDebuggerUrl or DevTools URL construction remains", () => {
  assert.deepEqual(find(/webSocketDebuggerUrl/), []);
  assert.deepEqual(find(/\/devtools\/(?:browser|page)\//), []);
});

test("no DevTools protocol command names remain in production code", () => {
  for (const cmd of [
    "Target.createTarget",
    "Target.closeTarget",
    "Target.activateTarget",
    "Target.getTargets",
    "Page.getNavigationHistory",
    "Page.navigateToHistoryEntry",
    "Runtime.evaluate",
    "Input.dispatchMouseEvent",
    "Input.insertText",
    "Input.dispatchKeyEvent",
  ]) {
    assert.deepEqual(
      find(new RegExp(cmd.replace(".", "\\."))),
      [],
      `${cmd} must not appear in shell/src`,
    );
  }
});

test("no fake /tabs REST fallback remains against the Donut API", () => {
  assert.deepEqual(find(/\/v1\/profiles\/[^"']*\/tabs/), []);
});

test("Playwright is imported nowhere in shell/src", () => {
  const importers = files
    .filter(
      (f) =>
        /from\s+["']playwright(-core)?["']/.test(f.src) ||
        /require\(["']playwright/.test(f.src) ||
        /import\(["']playwright/.test(f.src),
    )
    .map((f) => f.rel);
  assert.deepEqual(importers, []);
});

test("the renderer surface (preload.cjs) exposes no Playwright/CDP endpoint detail", () => {
  const preload = readFileSync(join(shellSrc, "preload.cjs"), "utf8");
  for (const [pattern, label] of [
    [/new\s+WebSocket\s*\(/, "WebSocket construction"],
    [/webSocketDebuggerUrl/, "DevTools URL"],
    [/playwright/i, "Playwright reference"],
    [/remote_debugging_port|remoteDebuggingPort/, "remote_debugging_port"],
    [/connectOverCDP/, "connectOverCDP"],
    [/\/devtools\//, "DevTools endpoint path"],
  ]) {
    assert.equal(pattern.test(preload), false, `preload.cjs must not expose ${label}`);
  }
});

// REWRITTEN during repository recovery (2026-10-05).
//
// This test used to assert "the provider seam exposes no CDP/Playwright
// transport detail" by requiring `services/browser-provider/` to exist and
// contain at least 4 files. That generic engine seam was deliberately REMOVED
// from the architecture:
//
//   * Progress Ledger's browser is its OWN embedded Electron browser (WebContentsView).
//   * Donut is a separate, externally installed application — not a swappable
//     browser engine inside Progress Ledger.
//   * There is no Brave and no generic "add any browser" system.
//
// Deleting the seam made this test fail on a stale structural precondition
// (`seamFiles.length >= 4`) even though the boundary it protects is intact and
// must be kept.
//
// The CONTRACT is unchanged and still enforced — it is simply expressed against
// the modules that actually exist now:
//
//   1. The removed seam directory stays removed (so it cannot be reintroduced
//      unnoticed).
//   2. No renderer-facing module may name a CDP transport primitive or endpoint.
//   3. No Donut transport module exists at all, and no renderer-facing
//      module may name a transport primitive or endpoint.
test("no removed provider seam is present, and no CDP transport detail exists anywhere", () => {
  const seamFiles = files.filter((f) => f.rel.includes("services/browser-provider/"));
  assert.equal(
    seamFiles.length,
    0,
    "services/browser-provider/ must not exist: the generic engine seam was removed by design",
  );

  const rendererFacing = files.filter(
    (f) => f.rel.endsWith("preload.cjs") || /(^|\/)ipc\//.test(f.rel),
  );
  assert.ok(rendererFacing.length > 0, "expected renderer-facing surfaces to scan");

  for (const f of rendererFacing) {
    for (const [pattern, label] of [
      [/new\s+WebSocket\s*\(/, "raw WebSocket"],
      [/webSocketDebuggerUrl/, "DevTools WebSocket URL"],
      [/connectOverCDP/, "connectOverCDP"],
    ]) {
      assert.equal(
        pattern.test(f.src),
        false,
        `${f.rel} must not expose ${label} (renderer-facing surface)`,
      );
    }
  }

  // The Donut bearer token may legitimately be READ inside a main-process IPC
  // module — that is how Progress Ledger authenticates an official Donut request, and
  // `ipc/browser-manager.js` does exactly that (it never returns the token to
  // the renderer). What must never happen is a credential or debugging port
  // being handed BACK across the IPC boundary. So the contract is expressed on
  // the handler RESULT shape, not on the presence of the reader.
  for (const f of rendererFacing.filter((x) => /\/ipc\//.test(x.rel))) {
    assert.doesNotMatch(
      f.src,
      /return\s*\{[^}]*\b(token|apiToken|bearer)\s*:/i,
      `${f.rel} must not return a Donut credential to the renderer`,
    );
  }

  // The transport is gone entirely: Phase 2 removed Donut/CDP, so no module
  // may own a Playwright/CDP transport and connectOverCDP must not appear.
  const transportOwners = files.filter((f) => f.rel.endsWith("services/cdp-session.js"));
  assert.equal(
    transportOwners.length,
    0,
    "services/cdp-session.js must not exist: the Playwright/CDP transport was removed with Donut",
  );
  assert.deepEqual(find(/connectOverCDP/), []);
});
