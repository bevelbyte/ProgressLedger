#!/usr/bin/env node
// Runs the hermetic Playwright E2E suite in bounded batches, reclaiming
// Electron/Playwright processes between batches.
//
// WHY THIS EXISTS
// The suite is 93 tests across 38 spec files, each launching a real Electron
// application serially (`workers: 1`). Run as ONE invocation on a host that is
// also running a desktop browser, the run degrades: fast failures appear in
// specs that normally pass in 2 seconds, and the dominant error becomes
//     "Target page, context or browser has been closed"
// i.e. the Electron app process is reaped mid-test. Every one of those specs
// passes in isolation, and the failing set is different on every run.
//
// That makes a single 14-minute invocation an unreliable regression signal on
// this host. Running the SAME specs in bounded batches, with the leftover
// Electron/Playwright processes reclaimed between batches, produces a stable
// result and covers exactly the same tests.
//
// This changes nothing about what is asserted. It only changes the batching
// and adds cleanup.
//
// Usage:  node scripts/run-e2e-batched.mjs [--batch 10] [spec ...]
// Env:    CAREERFLOW_E2E_REAL_DONUT=1 is honoured by playwright.config.js; the
//         destructive real-Donut specs are excluded unless it is set.

import { spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const e2eDir = join(root, "e2e");

const argv = process.argv.slice(2);
let batchSize = 10;
const bi = argv.indexOf("--batch");
if (bi >= 0) {
  batchSize = Number(argv[bi + 1]) || 10;
  argv.splice(bi, 2);
}

const specs = argv.length
  ? argv.map((a) => a.replace(/^e2e[\\/]/, ""))
  : readdirSync(e2eDir)
      .filter((f) => f.endsWith(".spec.js"))
      // `playwright.config.js` already excludes the opt-in DevTools evidence
      // spec and the zero-assertion explore-ui; keep the same default here.
      .filter((f) => ![
        "explore-ui.spec.js",
        "devtools-auth-boundary-evidence.spec.js",
      ].includes(f))
      .sort();

const chunks = [];
for (let i = 0; i < specs.length; i += batchSize) chunks.push(specs.slice(i, i + batchSize));

/** Reclaim Electron + Playwright worker processes left behind by a batch. */
function reclaim() {
  const ps = spawnSync(
    "powershell",
    ["-NoProfile", "-Command",
      "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; " +
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      "Where-Object { $_.CommandLine -match 'playwright' } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; " +
      "exit 0"],
    { encoding: "utf8" }
  );
  void ps;
  spawnSync(process.execPath, ["-e", "setTimeout(()=>{},1200)"]); // brief settle
}

let totalPass = 0;
let totalFail = 0;
const failedSpecs = [];
const perBatch = [];

for (let i = 0; i < chunks.length; i += 1) {
  const batch = chunks[i];
  process.stdout.write(`\n===== E2E BATCH ${i + 1}/${chunks.length} (${batch.length} specs) =====\n`);
  // Invoke the Playwright CLI entrypoint directly with the current Node
  // binary. Going through `npx` is unreliable here: on Windows `npx` is a .cmd
  // shim (spawnSync needs an explicit shell, which then mangles the
  // backslash-separated spec paths), and without a shell it fails ENOENT.
  const cli = join(root, "node_modules", "@playwright", "test", "cli.js");
  // Playwright treats positional arguments as REGEXES matched against the test
  // file path, so a Windows backslash path (`e2e\smoke.spec.js`) is read as
  // `e2e` + whitespace + `moke...` and matches nothing ("No tests found").
  // Forward slashes are required.
  const args = [cli, "test", ...batch.map((f) => `e2e/${f}`)];
  const code = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (code.error) {
    process.stdout.write(`batch ${i + 1} FAILED TO LAUNCH: ${code.error.message}\n`);
    totalFail += batch.length;
    perBatch.push({ batch: i + 1, passed: 0, failed: batch.length, exit: "launch-error" });
    reclaim();
    continue;
  }
  const out = `${code.stdout || ""}${code.stderr || ""}`;
  const m = out.match(/^\s*(\d+) passed/m);
  const f = out.match(/^\s*(\d+) failed/m);
  const p = m ? Number(m[1]) : 0;
  const fl = f ? Number(f[1]) : 0;
  totalPass += p;
  totalFail += fl;
  perBatch.push({ batch: i + 1, passed: p, failed: fl, exit: code.status });
  if (fl > 0 || p + fl === 0) {
    // Always surface the batch's own summary/failure lines. When neither a
    // passed nor a failed count was found the batch did not run at all, so the
    // raw tail is dumped rather than silently counted as zero.
    process.stdout.write(
      out.split("\n").filter((l) => /^\s*x\s+\d+|passed|failed|Error/.test(l)).join("\n") + "\n"
    );
    if (p + fl === 0) {
      process.stdout.write(`--- batch ${i + 1} produced no test counts; raw tail ---\n`);
      process.stdout.write(out.split("\n").slice(-25).join("\n") + "\n");
    }
    for (const mm of out.matchAll(/^\s*x\s+\d+\s+(\S+)/gm)) failedSpecs.push(mm[1]);
  }
  reclaim();
}

process.stdout.write("\n===== E2E BATCHED SUMMARY =====\n");
for (const b of perBatch) {
  process.stdout.write(`batch ${b.batch}: passed=${b.passed} failed=${b.failed} exit=${b.exit}\n`);
}
process.stdout.write(`TOTAL: passed=${totalPass} failed=${totalFail}\n`);
if (failedSpecs.length) {
  process.stdout.write("FAILED TESTS:\n");
  for (const s of failedSpecs) process.stdout.write(`  - ${s}\n`);
}
process.exit(totalFail > 0 ? 1 : 0);
