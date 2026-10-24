#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const file = join(dirname(fileURLToPath(import.meta.url)), "..", "core", "index.js");
let source = readFileSync(file, "utf8");
if (!source.includes("function nativePath(filename)")) {
  const anchor = "let loadError = null";
  const helper = `${anchor}

function nativePath(filename) {
  const unpacked = process.resourcesPath
    ? join(process.resourcesPath, "app.asar.unpacked", "core", filename)
    : null
  if (unpacked && existsSync(unpacked)) return unpacked
  return join(__dirname, filename)
}`;
  if (!source.includes(anchor)) throw new Error("NAPI-RS loader anchor not found");
  source = source.replace(anchor, helper);
}
source = source.replaceAll("join(__dirname, 'progress_ledger_core", "nativePath('progress_ledger_core");
source = source.replace(/require\('\.\/(progress_ledger_core\.[^']+\.node)'\)/g, "require(nativePath('$1'))");
source = source.replace(/require\(nativePath\('(progress_ledger_core\.[^']+\.node)'\)\)+/g, "require(nativePath('$1'))");
writeFileSync(file, source);
