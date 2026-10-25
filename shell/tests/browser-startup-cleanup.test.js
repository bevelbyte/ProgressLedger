import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// V2-41 regression: pending-delete cleanup must run only AFTER the
// main window is shown, with a time budget, and it must log what it
// did. This is a source-order test (same precedent as the engine
// guard): shell/src/ipc/browser.js imports electron, so it cannot be
// loaded under plain node --test, and no fake Electron shim is
// invented to pretend otherwise. Live proof is the diag18 driver run
// (four startup cases, window under 30 s, cleanup after window).
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const browserIpc = readFileSync(join(root, "shell", "src", "ipc", "browser.js"), "utf8");
const main = readFileSync(join(root, "shell", "src", "main.js"), "utf8");

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

describe("startup pending-delete cleanup ordering (V2-41)", () => {
  it("exposes cleanup on ctx instead of running it at registration", () => {
    const code = stripComments(browserIpc);
    assert.ok(
      code.includes("ctx.runPendingDeleteCleanup = cleanupPendingDeletes;"),
      "browser IPC must expose cleanup on ctx for main to call after the window is shown",
    );
    assert.ok(
      !code.includes("void cleanupPendingDeletes();"),
      "browser IPC must not run cleanup at registration time",
    );
  });

  it("budgets the cleanup pass and logs its result", () => {
    const code = stripComments(browserIpc);
    assert.ok(code.includes("budgetMs = 30000"), "cleanup pass must have a 30 s budget");
    assert.ok(code.includes("budgetExceeded"), "cleanup must stop when the budget runs out");
    assert.ok(
      code.includes("[pending-delete-cleanup] done:"),
      "cleanup must log entries/removed/kept/skipped/elapsed",
    );
  });

  it("main calls cleanup only after createWindow()", () => {
    const code = stripComments(main);
    const createIdx = code.indexOf("createWindow();");
    const cleanupIdx = code.indexOf("ctx.runPendingDeleteCleanup();");
    assert.ok(createIdx !== -1, "main must call createWindow()");
    assert.ok(cleanupIdx !== -1, "main must call ctx.runPendingDeleteCleanup()");
    assert.ok(
      cleanupIdx > createIdx,
      "cleanup call must come after createWindow() in main",
    );
    assert.ok(
      code.includes('typeof ctx.runPendingDeleteCleanup === "function"'),
      "main must guard the cleanup call",
    );
  });
});
