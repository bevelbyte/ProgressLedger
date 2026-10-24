#!/usr/bin/env node
/**
 * check-napi — regression guard for the shell→Rust half of the IPC contract.
 *
 * check:ipc proves every preload channel has a handler. This proves every
 * handler that calls into the native core actually references an exported
 * NAPI function. It would have caught the career→subject linking defect,
 * where preload+handler existed but the Rust export never did.
 *
 * Usage: node scripts/check-napi.mjs   (exit 1 on any missing export)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ipcDir = join(root, "shell", "src", "ipc");
const dts = readFileSync(join(root, "core", "index.d.ts"), "utf8");

// Exported NAPI functions from the generated typings.
const exported = new Set();
for (const m of dts.matchAll(/export declare function (\w+)/g)) exported.add(m[1]);

// core.<fn>( references across all shell IPC registrars.
const used = new Map(); // fn -> [file]
for (const file of readdirSync(ipcDir).filter((f) => f.endsWith(".js"))) {
  const src = readFileSync(join(ipcDir, file), "utf8");
  for (const m of src.matchAll(/\bcore\.(\w+)\s*\(/g)) {
    const fn = m[1];
    used.set(fn, [...(used.get(fn) ?? []), file]);
  }
}

const missing = [...used.keys()].filter((fn) => !exported.has(fn));
if (missing.length > 0) {
  console.error("check-napi FAILED: handlers call NAPI functions that are not exported:");
  for (const fn of missing) {
    console.error(`  core.${fn}() <- ${used.get(fn).join(", ")}`);
  }
  process.exit(1);
}
console.log(`check-napi OK: ${used.size} core functions referenced by IPC handlers are all exported.`);
