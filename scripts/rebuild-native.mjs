#!/usr/bin/env node
// rebuild-native.mjs — rebuild better-sqlite3 for the target runtime.
//
// Progress Ledger may run better-sqlite3 under both the system Node and Electron.
// The native binary must match the active Node module ABI. Modern Electron
// can share the system-Node ABI; older Electron lines may require a rebuild.
// The lockfile pins the JS dependency versions; only the compiled artifact
// changes when a rebuild is actually required.
//
// Usage:
//   node scripts/rebuild-native.mjs electron   # rebuild only when Electron ABI differs
//   node scripts/rebuild-native.mjs node       # node-gyp rebuild for the running Node
//
// Both commands print the ABI they targeted so CI can verify.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const mode = process.argv[2];
if (mode !== "electron" && mode !== "node") {
  console.error("usage: node scripts/rebuild-native.mjs <electron|node>");
  process.exit(1);
}

// Locate the better-sqlite3 install (shell workspace hoists to root in
// some layouts; the shell workspace is authoritative).
const candidates = [
  join(root, "shell", "node_modules", "better-sqlite3"),
  join(root, "node_modules", "better-sqlite3"),
];
const moduleDir = candidates.find((c) => existsSync(join(c, "package.json")));
if (!moduleDir) {
  console.error("better-sqlite3 not found — run `npm install` first.");
  process.exit(1);
}
console.log("target module:", moduleDir);

const require = createRequire(import.meta.url);

let cmd, args;
if (mode === "electron") {
  const targetElectronVersion = require(join(root, "node_modules", "electron", "package.json")).version;
  cmd = "npx";
  args = [
    "--yes",
    "@electron/rebuild@3.7.2",
    "-f",
    "-w",
    "better-sqlite3",
    "-v",
    targetElectronVersion,
  ];
} else {
  // Rebuild for the running Node only when the installed binary cannot be
  // loaded by this Node. This keeps ordinary `npm test` runs fast while still
  // repairing the common Electron-vs-system-Node ABI mismatch automatically.
  try {
    const Database = require(moduleDir);
    const probe = new Database(":memory:");
    probe.pragma("journal_mode = memory");
    probe.close();
    console.log("better-sqlite3 native binding already loads under system Node; no rebuild needed.");
    process.exit(0);
  } catch (error) {
    console.warn("better-sqlite3 needs a system-Node rebuild:", error?.message || error);
  }
  cmd = process.platform === "win32" ? "npm.cmd" : "npm";
  args = ["rebuild", "better-sqlite3"];
}

const res = spawnSync(cmd, args, {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (res.status !== 0) {
  console.error(`rebuild for ${mode} failed (exit ${res.status})`);
  process.exit(res.status || 1);
}

console.log(`\nbetter-sqlite3 rebuilt for ${mode}.`);
console.log("Current ABI (system Node):", process.versions.modules);
const installedElectron = require(join(root, "node_modules", "electron", "package.json"));
console.log(`Electron target: ${installedElectron.version}`);
