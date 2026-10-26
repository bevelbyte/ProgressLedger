import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Async audit (V2-42, item C). This is the source check that fails
// when a main-process handler calls an async function without
// awaiting it, and it encodes the V2-40 lesson directly:
//
//   * `rm` from "node:fs" is the CALLBACK API: awaiting it without a
//     callback returns immediately and the folder survives, and a
//     later rimraf-style call can throw and kill main. Every `rm`
//     import in IPC/browser code must come from "node:fs/promises".
//   * Electron session methods that return promises
//     (clearStorageData, clearCache, clearAuthCache, flushStorageData,
//     setProxy, loadURL) must appear awaited or inside a .then chain
//     on the same statement. A bare call is a floating promise: the
//     delete/cleanup returns "ok" before the data is actually gone.
//   * No `await <something>Sync(`: a Sync function returns a value,
//     awaiting it is harmless but a sign the author thought it was
//     async (the V2-40 shape in reverse).
//
// Files are read, not imported: ipc/browser.js imports Electron and
// cannot load under plain node --test (engine-guard precedent).
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function filesIn(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".js"))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function stripComments(text) {
  return text
    .replace(/\r/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

function repoFiles() {
  const ipc = filesIn(join(root, "shell", "src", "ipc"));
  const browser = filesIn(join(root, "shell", "src", "services", "browser"));
  assert.ok(ipc.length > 0, "expected shell/src/ipc/*.js under the repo root");
  return [...ipc, ...browser];
}

const ASYNC_CALLEES = [
  "clearStorageData",
  "clearCache",
  "clearAuthCache",
  "flushStorageData",
  "setProxy",
  "loadURL",
];

describe("IPC async guard (V2-42)", () => {
  it("no node:fs import brings in a callback-API function", () => {
    for (const file of repoFiles()) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const m of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*"node:fs"/g)) {
        const bad = m[1]
          .split(",")
          .map((s) => s.trim())
          .filter((n) => n && !n.endsWith("Sync"));
        assert.deepEqual(bad, [], `${file}: node:fs must only import *Sync functions, got ${bad.join(", ")}`);
      }
    }
  });

  it("no await on a filesystem Sync function", () => {
    // Only fs *Sync names count here: an app function that merely
    // ends in "Sync" (runAutomatedSync) is async and awaiting it is
    // correct, so it must not trip this check.
    const FS_SYNC = [
      "existsSync", "readFileSync", "writeFileSync", "mkdirSync", "rmSync",
      "readdirSync", "statSync", "unlinkSync", "renameSync", "realpathSync",
      "lstatSync", "cpSync", "appendFileSync",
    ];
    for (const file of repoFiles()) {
      const code = stripComments(readFileSync(file, "utf8"));
      const bad = code
        .split("\n")
        .filter((l) => FS_SYNC.some((n) => new RegExp(`await\\s+${n}\\s*\\(`).test(l)));
      assert.deepEqual(bad, [], `${file}: await on a Sync function: ${bad.join(" | ")}`);
    }
  });

  it("every Electron async session/page call is awaited or promise-chained", () => {
    for (const file of repoFiles()) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const [i, line] of code.split("\n").entries()) {
        for (const callee of ASYNC_CALLEES) {
          if (!line.includes(`.${callee}(`)) continue;
          // A .then chain on the same line, or an await, means the
          // promise is handled. `observeLoadPromise(id, ...loadURL...)`
          // also handles it (it observes the returned promise).
          if (line.includes("await") || line.includes(".then(") || line.includes("observeLoadPromise")) continue;
          // A returned promise is handled by the IPC layer (the
          // safeHandle wrapper is async and returns handler result).
          if (/^\s*return\b/.test(line)) continue;
          assert.fail(
            `${file}:${i + 1}: bare async call .${callee}( without await/.then: ${line.trim()}`,
          );
        }
      }
    }
  });

  it("rm is only imported from node:fs/promises where it is used", () => {
    for (const file of repoFiles()) {
      const code = stripComments(readFileSync(file, "utf8"));
      if (!/\brm\s*\(/.test(code)) continue;
      assert.ok(
        /import\s*\{[^}]*\brm\b[^}]*\}\s*from\s*"node:fs\/promises"/.test(code) ||
          /\brmSync\b/.test(code) === false ||
          /from\s*"node:fs\/promises"/.test(code),
        `${file}: rm() used but not imported from node:fs/promises`,
      );
    }
  });
});
