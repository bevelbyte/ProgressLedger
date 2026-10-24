import { defineConfig } from "@playwright/test";
// E2E config. Electron tests run serially against a single app instance.
//
// POST-MIGRATION NOTE
// The DBI-era real-Donut group (which spawned DonutBrowser-Unlocked.exe via
// CareerFlow-Start-Donut.bat, deleted runtime.json files and force-killed
// workspace processes) is gone with the Donut ownership layer. CareerFlow no
// longer launches Donut; remaining specs use the CAREERFLOW_E2E_DONUT_STUB
// seam (hermetic) or read-only contract checks.
//
// The DevTools security-evidence probe (raw unauthenticated WebSocket
// handshake, documented BLOCKED finding) lives in
// e2e/devtools-auth-boundary-evidence.spec.js and is opt-in:
//   CAREERFLOW_E2E_DEVTOOLS_EVIDENCE=1 npx playwright test e2e/devtools-auth-boundary-evidence.spec.js

const allowDevtoolsEvidence = process.env.CAREERFLOW_E2E_DEVTOOLS_EVIDENCE === "1";

const EVIDENCE_SPECS = ["devtools-auth-boundary-evidence.spec.js"];

export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  testIgnore: allowDevtoolsEvidence ? [] : EVIDENCE_SPECS.map((s) => `**/${s}`),
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: { args: ["--no-sandbox"] },
      },
    },
  ],
});
