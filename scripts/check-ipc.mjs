#!/usr/bin/env node
/**
 * IPC contract guard: every channel invoked by preload.cjs must have an
 * ipcMain.handle/safeHandle in the shell. Main-only handlers are deliberately
 * outside this renderer contract. This exists because the
 * previous CareerFlow implementation shipped 26 preload channels with no
 * main-process handler (courses, labs, projects, projectTasks, formulas,
 * focus, notes:quick) - features that failed silently at runtime.
 *
 * Run: npm run check:ipc
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shellSrc = join(root, "shell", "src");

const preload = readFileSync(join(shellSrc, "preload.cjs"), "utf8");
const invoked = new Set([...preload.matchAll(/ipcRenderer\.invoke\(\s*"([^"]+)"/g)].map((m) => m[1]));
if (invoked.size === 0) {
  console.error("check-ipc: no invoke() channels found in preload.cjs - regex broken?");
  process.exit(2);
}

const handled = new Set();
const files = ["main.js", ...readdirSync(join(shellSrc, "ipc")).filter((f) => f.endsWith(".js")).map((f) => join("ipc", f))];
const rawHandlerFiles = [];
const rawMainHandlers = [];
for (const rel of files) {
  const src = readFileSync(join(shellSrc, rel), "utf8");
  for (const m of src.matchAll(/(?:ipcMain\.(?:handle|handleOnce)|safeHandle)\(\s*"([^"]+)"/g)) {
    handled.add(m[1]);
  }
  // Separator-agnostic. The previous predicate was `rel.startsWith("ipc\\")`,
  // which can never match on Linux/macOS where `rel` is "ipc/audit.js" - so the
  // whole "no raw ipcMain.handle" guard was silently a no-op off Windows.
  const isIpcModule = rel === "main.js" ? false : rel.replace(/[\\/]+$/, "").split(/[\\/]/)[0] === "ipc";
  const rawMatches = [...src.matchAll(/(?<![A-Za-z0-9_$.])ipcMain\.(?:handle|handleOnce)\s*\(\s*"([^"]+)"/g)];
  if (isIpcModule && rawMatches.length) rawHandlerFiles.push(rel);
  if (rel === "main.js") for (const m of rawMatches) rawMainHandlers.push(m[1]);
}

const missingHandlers = [...invoked].filter((c) => !handled.has(c)).sort();
// Channels invoked by migration-preload.cjs (not the main preload) register as
const ALLOWED_RAW_MAIN_HANDLERS = new Set(["migration:select-dir", "migration:cancel", "migration:start"]);
const unexpectedRawMainHandlers = rawMainHandlers.filter((channel) => !ALLOWED_RAW_MAIN_HANDLERS.has(channel));
if (unexpectedRawMainHandlers.length) {
  console.error("\nFAIL: unexpected raw ipcMain.handle registrations in main.js (only migration handlers are allowed as explicit exceptions):");
  for (const channel of unexpectedRawMainHandlers) console.error(`  - ${channel}`);
}
let failed = unexpectedRawMainHandlers.length > 0;
if (rawHandlerFiles.length) {
  failed = true;
  console.error("\nFAIL: raw ipcMain.handle registrations bypass the sender-authenticated safeHandle wrapper:");
  for (const rel of rawHandlerFiles) console.error(`  - ${rel}`);
}
if (missingHandlers.length) {
  failed = true;
  console.error(`\nFAIL: ${missingHandlers.length} channel(s) invoked in preload.cjs have NO ipcMain handler:`);
  for (const c of missingHandlers) console.error(`  - ${c}`);
}
if (!failed) {
  console.log(`check-ipc OK: ${invoked.size} channels, all handled.`);
}
process.exit(failed ? 1 : 0);
