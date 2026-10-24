import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Engine check (Phase 3, user condition 3): the embedded browser MUST
// use WebContentsView, and there must be no <webview> tag and no
// BrowserView anywhere in shipped code. Comments are stripped before
// matching (the host's own header explains what it is NOT), test files
// are not shipped code and are skipped, and the generated TS output
// (browser-ts/dist) is skipped with them.
// The test file lives at shell/tests/, so the repo root is TWO levels up
// (shell/tests -> shell -> root). One level up points at shell/ itself
// and makes the walk look for shell/shell/src, which does not exist.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIRS = [join(root, "shell", "src"), join(root, "ui", "src")];
const SKIP_DIRS = new Set(["node_modules", "dist"]);
const SKIP_SUFFIX = ".test.js";

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (
      /\.(js|cjs|mjs|ts|svelte)$/.test(entry) &&
      !entry.endsWith(SKIP_SUFFIX) &&
      !entry.endsWith("engine-guard.test.js")
    ) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(text, isSvelte) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, "");
  if (isSvelte) out = out.replace(/<!--[\s\S]*?-->/g, "");
  out = out
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
  return out;
}

const FORBIDDEN = [
  { name: "<webview> tag", re: /<webview(?=[\s/>])/ },
  { name: "new BrowserView", re: /\bnew\s+BrowserView\s*\(/ },
  { name: "BrowserView import", re: /import\s*\{[^}]*\bBrowserView\b/ },
  { name: "electron.BrowserView", re: /\.BrowserView\b/ },
];

describe("browser engine guard", () => {
  it("uses WebContentsView and forbids <webview> and BrowserView", () => {
    const files = DIRS.flatMap((dir) => walk(dir, []));
    assert.ok(files.length > 100, `expected many source files, got ${files.length}`);
    const hits = [];
    let usesWebContentsView = false;
    for (const file of files) {
      const raw = readFileSync(file, "utf8");
      if (/from\s+["']electron["']/.test(raw) && /\bWebContentsView\b/.test(raw)) {
        usesWebContentsView = true;
      }
      const code = stripComments(raw, file.endsWith(".svelte"));
      const lines = code.split("\n");
      lines.forEach((line, i) => {
        for (const { name, re } of FORBIDDEN) {
          if (re.test(line)) hits.push(`${file}:${i + 1} (${name}): ${line.trim().slice(0, 120)}`);
        }
      });
    }
    assert.equal(usesWebContentsView, true, "no file imports WebContentsView from electron");
    assert.deepEqual(hits, [], `forbidden browser engine usage:\n${hits.join("\n")}`);
  });
});
