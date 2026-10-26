import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Item 4 (2026-10-26): no text below 11px anywhere in the UI.
// Literal px sizes under 11 fail. Relative em sizes under 1em fail
// too, because an em under 1 can resolve below 11px inside an 11px
// context (that is how the old PaneGrid kbd rule could reach 9.9px).
// Sizes given as var(--text-*) are covered by the token check below:
// every --text-* token must itself be at least 11px.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".css") || p.endsWith(".svelte")) out.push(p);
  }
  return out;
}

describe("text size floor: no text below 11px (item 4)", () => {
  it("every --text-* token is at least 11px", () => {
    const css = readFileSync(join(root, "ui", "src", "app.css"), "utf8");
    const tokens = [...css.matchAll(/--text-[a-z0-9-]+:\s*([\d.]+)px/g)];
    assert.ok(tokens.length > 0, "no --text-* px tokens found");
    for (const m of tokens) {
      assert.ok(Number(m[1]) >= 11, `--text token is ${m[1]}px: ${m[0]}`);
    }
  });

  it("no literal font size below 11px in ui/src", () => {
    const bad = [];
    for (const file of walk(join(root, "ui", "src"))) {
      const src = readFileSync(file, "utf8");
      // Strip comments so a commented-out size cannot fail (or hide).
      const clean = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
      for (const m of clean.matchAll(/font-size:\s*([\d.]+)(px|em)/g)) {
        const v = Number(m[1]);
        if ((m[2] === "px" && v < 11) || (m[2] === "em" && v < 1)) {
          bad.push(`${file}: font-size ${m[1]}${m[2]}`);
        }
      }
      for (const m of clean.matchAll(/font:\s*([\d.]+)(px|em)\b/g)) {
        const v = Number(m[1]);
        if ((m[2] === "px" && v < 11) || (m[2] === "em" && v < 1)) {
          bad.push(`${file}: font ${m[1]}${m[2]}`);
        }
      }
    }
    assert.deepEqual(bad, []);
  });
});
