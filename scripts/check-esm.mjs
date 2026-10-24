#!/usr/bin/env node
/**
 * Static ES-module import guard for the Electron shell.
 *
 * The main process is plain ESM that Node/Electron instantiate eagerly: a named
 * import that the target module doesn't export is a hard SyntaxError at load
 * time, before any code runs — so it crashes Electron startup but is invisible
 * to Vite (UI only) and cargo (Rust only). This script resolves every relative
 * `import { ... } from "./x.js"` in shell/src against the actual named exports of
 * the target file, catching the mismatch in `npm test` instead of at launch.
 *
 * Limitations: handles the syntax this codebase uses — named/namespace/default
 * imports and `export function|const|class`, `export { a, b }`, and
 * `export { x } from "./y.js"` re-exports. It does not execute code.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shellSrc = join(root, "shell", "src");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

/** Collect names a module exports (own declarations + re-exports). */
function exportsOf(file, cache = new Map()) {
  if (cache.has(file)) return cache.get(file);
  const names = new Set();
  cache.set(file, names); // set early to tolerate cycles
  if (!existsSync(file)) return names;
  const src = readFileSync(file, "utf8");

  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(m[1]);
  }
  if (/export\s+default/.test(src)) names.add("default");

  // export { a, b as c } [from "./y.js"]
  for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*(?:from\s*["']([^"']+)["'])?/g)) {
    const spec = m[1];
    const from = m[2];
    for (const part of spec.split(",")) {
      const piece = part.trim();
      if (!piece) continue;
      const asMatch = piece.match(/\s+as\s+([A-Za-z0-9_$]+)$/);
      if (asMatch) {
        names.add(asMatch[1]);
      } else if (from) {
        names.add(piece); // re-export of same name; assume target provides it (checked separately)
      } else {
        names.add(piece);
      }
    }
  }
  return names;
}

const files = walk(shellSrc);
const cache = new Map();
const problems = [];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  // import { a, b as c } from "./rel.js"  (relative only — bare specifiers are npm deps)
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g)) {
    const spec = m[1];
    const rel = m[2];
    const target = resolve(dirname(file), rel);
    const exp = exportsOf(target, cache);
    for (const part of spec.split(",")) {
      const piece = part.trim();
      if (!piece) continue;
      const name = piece.split(/\s+as\s+/)[0].trim();
      if (!exp.has(name)) {
        problems.push(`${file}: imports { ${name} } from "${rel}", but that module does not export it`);
      }
    }
  }
}

if (problems.length) {
  console.error(`\nFAIL: ${problems.length} broken ES-module import(s) in shell/src:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

// --- Electron built-in usage guard -----------------------------------------
// A bare reference to an Electron symbol that was never imported (e.g. using
// `ipcMain.handle` without `import { ipcMain } from "electron"`) is a runtime
// ReferenceError that only fires when that code path executes at startup —
// invisible to Vite/cargo. Check the symbols this codebase relies on.
const ELECTRON_SYMBOLS = [
  "ipcMain", "dialog", "shell", "globalShortcut", "safeStorage",
  "BrowserWindow", "Menu", "app",
];
// Strip JS string literals, line comments, and block comments so the
// symbol-usage check below doesn't false-positive on words like
// `dialog` / `shell` that only appear inside a description string
// or a `//` / `/* */` comment. The Electron import collection
// above still scans the original source — comments can't introduce
// an import, and we only care about runtime symbol resolution.
function stripJsComments(src) {
  // Order matters: handle escapes inside strings first, then strings,
  // then block comments, then line comments. Each pass replaces the
  // matched run with spaces (preserving line numbers) so subsequent
  // regex offsets stay valid.
  let s = src;
  // 1. Block comments — must come before line comments so `//` inside
  //    a `/* */` isn't treated as a line comment.
  s = s.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
  // 2. String literals (single, double, backtick). The body of a
  //    string never runs, so any Electron symbol inside it can't
  //    be a real `foo.bar` call.
  s = s.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, (m) => " ".repeat(m.length));
  // 3. Line comments — only after strings, so we don't kill
  //    `//` inside a string (already removed).
  s = s.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  return s;
}

const refProblems = [];
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const codeOnly = stripJsComments(src);
  const imported = new Set();
  for (const line of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']electron["']/g)) {
    for (const s of line[1].split(",")) {
      const n = s.trim().split(/\s+as\s+/)[0].trim();
      if (n) imported.add(n);
    }
  }
  for (const sym of ELECTRON_SYMBOLS) {
    const used = new RegExp(`\\b${sym}\\.`).test(codeOnly) || new RegExp(`new\\s+${sym}\\b`).test(codeOnly);
    if (used && !imported.has(sym)) {
      refProblems.push(`${file}: uses "${sym}" but does not import it from "electron"`);
    }
  }
}
if (refProblems.length) {
  console.error(`\nFAIL: ${refProblems.length} missing Electron import(s) in shell/src:`);
  for (const p of refProblems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`check-esm OK: all relative shell imports resolve (${files.length} files).`);
