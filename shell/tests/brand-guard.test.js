// Phase 2 guards: the rename is total and Donut is gone from product source.
//
// "careerflow" must not appear anywhere in ui/src, shell/src or core/src.
// "donut" must not appear either, except in three files whose Donut mentions
// are deliberate documentation, not references to live code:
//   - shell/src/ipc/browser.js and shell/src/services/browser/host.js carry
//     an independence comment (the embedded browser depends on NOTHING
//     from the removed Donut integration);
//   - shell/tests/browser-transport-boundary.test.js is the regression guard
//     that names the removed transport so it can never come back unnoticed.
// This file itself is excluded: it necessarily spells both names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SELF = "shell/tests/brand-guard.test.js";
const DONUT_EXCEPTIONS = new Set([
  "shell/src/ipc/browser.js",
  "shell/src/services/browser/host.js",
  "shell/tests/browser-transport-boundary.test.js",
]);
const EXTENSIONS = new Set([".js", ".cjs", ".svelte", ".rs", ".css"]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if ([...EXTENSIONS].some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

const sources = ["ui/src", "shell/src", "core/src"].flatMap((d) => walk(join(root, d))).map((f) => ({
  rel: relative(root, f).split(sep).join("/"),
  src: readFileSync(f, "utf8"),
}));

test("no 'careerflow' remains in product source", () => {
  const hits = sources
    .filter((f) => f.rel !== SELF && /careerflow/i.test(f.src))
    .map((f) => f.rel);
  assert.deepEqual(hits, []);
});

test("no 'donut' remains in product source except documented guards", () => {
  const hits = sources
    .filter((f) => f.rel !== SELF && !DONUT_EXCEPTIONS.has(f.rel) && /donut/i.test(f.src))
    .map((f) => f.rel);
  assert.deepEqual(hits, []);
});
