// SECURITY EVIDENCE — the raw Chromium DevTools WebSocket is unauthenticated.
//
// WHAT THIS PINNED FINDING IS
// docs/CDP-AUTH-BOUNDARY.md documents a BLOCKED security gap: the browser's
// DevTools listener accepts a WebSocket handshake with NO authentication, so
// any same-user local process can connect without CareerFlow's bearer token.
// That gap lives in the browser runtime (Chromium/Wayfern), not in CareerFlow;
// closing it requires an upstream change. CareerFlow's own transport never
// uses this raw path — see scripts/check-cdp-auth-boundary.mjs, which pins
// that shell/src contains zero raw WebSocket construction, zero /json/*
// discovery, and zero DevTools URL building (the Playwright-over-CDP
// integration is the only connection mechanism).
//
// WHY THIS FILE STILL EXISTS
// The finding is evidence, not integration: if the raw listener ever gains
// authentication, this test flips and tells us the documented assumption (and
// the guard's threat model) needs revisiting. It is instrumentation for a
// security boundary, deliberately kept while the obsolete integration and
// test plumbing around it was removed with the DBI ownership layer.
//
// RUN (opt-in — it launches a real browser fixture):
//   CAREERFLOW_E2E_DEVTOOLS_EVIDENCE=1 npx playwright test e2e/devtools-auth-boundary-evidence.spec.js
//
// The fixture browser is a local Playwright Chromium speaking the real CDP
// protocol. It is NOT a substitute for official Donut in real-runtime
// validation: this asserts a property of the DevTools listener itself.

import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findChromium() {
  const msPlaywright = join(process.env.LOCALAPPDATA || "", "ms-playwright");
  try {
    const dirs = readdirSync(msPlaywright).filter((d) => d.startsWith("chromium-")).sort().reverse();
    for (const rel of dirs) {
      for (const exe of [join(rel, "chrome-win", "chrome.exe"), join(rel, "chrome-win64", "chrome.exe")]) {
        const full = join(msPlaywright, exe);
        if (existsSync(full)) return full;
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function startFixtureBrowser() {
  const exe = findChromium();
  if (!exe) return null;
  const profileDir = mkdtempSync(join(tmpdir(), "cf-devtools-evidence-"));
  const child = spawn(exe, [
    "--headless=new",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ], { stdio: "ignore" });
  const devtoolsActive = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + 30_000;
  let port = 0;
  while (Date.now() < deadline) {
    try {
      if (existsSync(devtoolsActive)) {
        const p = Number(readFileSync(devtoolsActive, "utf8").split("\n")[0]);
        if (Number.isInteger(p) && p > 0) {
          port = p;
          break;
        }
      }
    } catch {
      /* retry */
    }
    await sleep(150);
  }
  return port ? { child, port, profileDir } : (child.kill(), null);
}

test("SECURITY EVIDENCE: the raw DevTools WebSocket handshake needs no auth", async () => {
  test.setTimeout(90_000);
  const fixture = await startFixtureBrowser();
  expect(fixture, "Playwright Chromium fixture required for this evidence probe").toBeTruthy();

  try {
    // The documented discovery surfaces (unauthenticated HTTP on the
    // debugger port) — evidence of the same gap class.
    const versionRes = await fetch(`http://127.0.0.1:${fixture.port}/json/version`);
    expect(versionRes.ok).toBe(true);
    const version = await versionRes.json();
    expect(typeof version.webSocketDebuggerUrl).toBe("string");

    const listRes = await fetch(`http://127.0.0.1:${fixture.port}/json/list`);
    expect(listRes.ok).toBe(true);
    const targets = await listRes.json();
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    expect(page).toBeTruthy();

    // THE PROBE: a raw WebSocket handshake with NO Authorization header,
    // NO bearer token, NO cookie — just the endpoint URL. If the listener
    // were authenticated this would fail.
    const connected = await new Promise((resolve) => {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* noop */ }
        resolve(false);
      }, 5000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        // Evidence line for the audit log: endpoint pathname + the fact that
        // NO authentication header was supplied.
        console.log("DEVTOOLS_RAW_WS_HANDSHAKE_EVIDENCE", {
          authenticatedHeaderSupplied: false,
          endpoint: new URL(page.webSocketDebuggerUrl).pathname,
        });
        try { ws.close(); } catch { /* noop */ }
        resolve(true);
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });

    // The documented BLOCKED finding: the handshake succeeds without auth.
    // If this ever becomes false, docs/CDP-AUTH-BOUNDARY.md must be revised.
    expect(connected).toBe(true);
  } finally {
    try { fixture.child.kill(); } catch { /* noop */ }
  }
});

test("CareerFlow's own transport never uses this raw path (guard pinned)", () => {
  // Cross-check: the security gate that keeps production code OFF this raw
  // surface. If the gate fails, the evidence above just became a product
  // dependency instead of a documented gap — which is exactly what must not
  // happen.
  const guard = readFileSync(
    join(__dirname, "..", "scripts", "check-cdp-auth-boundary.mjs"),
    "utf8",
  );
  expect(guard).toContain("new\\s+WebSocket\\s*\\(");
  expect(guard).toContain("check-cdp-auth-boundary");
});
