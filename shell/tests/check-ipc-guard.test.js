// Regression guard for scripts/check-ipc.mjs itself.
//
// The static IPC guard is the ONLY thing standing between a new
// `ipcMain.handle("…")` and a channel that never passes through
// `verifyIpcSender`. Two defects made it toothless:
//
//   1. `rel.startsWith("ipc\\")` — a hard-coded WINDOWS separator. On Linux and
//      macOS `rel` is "ipc/audit.js", so the predicate is never true and the
//      "no raw ipcMain.handle in an ipc module" branch is a silent no-op on
//      every non-Windows runner. `check:ipc` printed OK regardless.
//
//   2. `rawMainHandlers` was declared, read, and compared against
//      `ALLOWED_RAW_MAIN_HANDLERS` — but nothing ever pushed into it, so the
//      "unexpected raw ipcMain.handle in main.js" check was permanently
//      vacuous. `ALLOWED_RAW_MAIN_HANDLERS` was dead code.
//
// This test drives the real script as a subprocess against a synthetic tree so
// both branches are actually exercised, and asserts the script's own output.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const script = join(repoRoot, "scripts", "check-ipc.mjs");

/** Build a throwaway repo-shaped tree and run the real check-ipc against it. */
function runCheck({ preloadChannels, modules, mainExtra = "" }) {
  const root = mkdtempSync(join(tmpdir(), "cf-checkipc-"));
  try {
    mkdirSync(join(root, "shell", "src", "ipc"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(
      join(root, "shell", "src", "preload.cjs"),
      `const api = {\n${preloadChannels.map((c) => `  x: () => ipcRenderer.invoke("${c}"),`).join("\n")}\n};\n`,
      "utf8"
    );
    for (const [name, src] of Object.entries(modules)) {
      writeFileSync(join(root, "shell", "src", "ipc", name), src, "utf8");
    }
    writeFileSync(join(root, "shell", "src", "main.js"), mainExtra, "utf8");
    cpSync(script, join(root, "scripts", "check-ipc.mjs"));
    try {
      const out = execFileSync(process.execPath, [join(root, "scripts", "check-ipc.mjs")], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status, out: `${e.stdout || ""}${e.stderr || ""}` };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SAFE = { "safe.js": 'import { safeHandle } from "../security/safe-handle.js";\nsafeHandle("ok:channel", () => ({ ok: true }));\n' };

test("a clean tree passes and reports the channel count", () => {
  const r = runCheck({ preloadChannels: ["ok:channel"], modules: SAFE });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /check-ipc OK: 1 channels, all handled/);
});

test("a channel with no handler fails", () => {
  const r = runCheck({ preloadChannels: ["ok:channel", "missing:channel"], modules: SAFE });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /have NO ipcMain handler/);
  assert.match(r.out, /missing:channel/);
});

test("a raw ipcMain.handle inside an ipc module is REJECTED (defect 1: separator)", () => {
  // This is the branch that could never fire off Windows. The module path is
  // built with the platform separator, so on POSIX the old
  // `rel.startsWith("ipc\\")` predicate returned false and the check passed.
  const r = runCheck({
    preloadChannels: ["raw:channel"],
    modules: {
      "safe.js": SAFE["safe.js"],
      "bad.js":
        'import { ipcMain } from "electron";\nfunction h(_e){ return { ok: true }; }\nipcMain.handle("raw:channel", h);\n',
    },
  });
  assert.equal(r.code, 1, `a raw ipcMain.handle in an ipc module must fail the guard:\n${r.out}`);
  assert.match(r.out, /raw ipcMain\.handle registrations bypass the sender-authenticated safeHandle wrapper/);
  assert.match(r.out, /bad\.js/);
});

test("a raw ipcMain.handle in main.js outside the migration allow-list is REJECTED (defect 2: dead branch)", () => {
  const r = runCheck({
    preloadChannels: ["sneaky:channel"],
    modules: SAFE,
    mainExtra:
      'import { ipcMain } from "electron";\nfunction h(_e){ return { ok: true }; }\nipcMain.handle("sneaky:channel", h);\n',
  });
  assert.equal(r.code, 1, `an unexpected raw handler in main.js must fail the guard:\n${r.out}`);
  assert.match(r.out, /unexpected raw ipcMain\.handle registrations in main\.js/);
  assert.match(r.out, /sneaky:channel/);
});

test("the three migration handlers remain the allowed main.js exceptions", () => {
  const r = runCheck({
    preloadChannels: ["migration:select-dir", "migration:cancel", "migration:start"],
    modules: SAFE,
    mainExtra:
      'import { ipcMain } from "electron";\n' +
      'function a(_e){ return 1; }\nfunction b(_e){ return 2; }\nfunction c(_e){ return 3; }\n' +
      'ipcMain.handle("migration:select-dir", a);\n' +
      'ipcMain.handle("migration:cancel", b);\n' +
      'ipcMain.handle("migration:start", c);\n' +
      'function r(_e){ return { ok: true }; }\n',
  });
  assert.equal(r.code, 0, `the documented migration exceptions must still pass:\n${r.out}`);
  assert.match(r.out, /check-ipc OK/);
});
