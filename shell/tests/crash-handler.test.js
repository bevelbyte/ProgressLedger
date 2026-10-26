import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

// Crash safety (V2-42, item B). The module imports no Electron, so it
// loads under plain node --test with fakes.
import { installCrashHandlers, crashFileName, formatCrashLog } from "../src/services/crash-handler.js";

function fakeProcess() {
  const listeners = new Map();
  return {
    pid: 1234,
    on(event, fn) {
      listeners.set(event, fn);
    },
    removeListener(event) {
      listeners.delete(event);
    },
    emit(event, value) {
      listeners.get(event)?.(value);
    },
    listenerCount(event) {
      return listeners.has(event) ? 1 : 0;
    },
  };
}

describe("main-process crash handlers (V2-42)", () => {
  it("names crash files with kind + timestamp, no colons (Windows-safe)", () => {
    const name = crashFileName("uncaughtException", new Date("2026-10-26T05:30:00.000Z"));
    assert.equal(name, "crash-uncaughtException-2026-10-26T05-30-00-000Z.log");
    assert.ok(!name.includes(":"));
  });

  it("formats a log with time, kind, message and stack", () => {
    const err = new Error("boom");
    const text = formatCrashLog({ kind: "unhandledRejection", error: err, date: new Date("2026-10-26T05:30:00.000Z"), pid: 7 });
    assert.ok(text.includes("2026-10-26T05:30:00.000Z"));
    assert.ok(text.includes("unhandledRejection"));
    assert.ok(text.includes("boom"));
    assert.ok(text.includes("Error: boom"));
  });

  it("uncaught exception writes a log, shows an error box, then quits", () => {
    const files = {};
    const shown = [];
    let quit = 0;
    const proc = fakeProcess();
    const h = installCrashHandlers({
      process: proc,
      showError: (t, m) => shown.push([t, m]),
      userDataDir: "/fake/user-data",
      mkdirSync: () => {},
      writeFileSync: (p, c) => {
        files[p] = c;
      },
      now: () => new Date("2026-10-26T05:30:00.000Z"),
      quit: () => {
        quit += 1;
      },
    });
    // join() here, not a literal: on Windows the module's path.join
    // returns backslashes, and a POSIX literal fails there (found by
    // the laptop gate, where this test was the only failure).
    assert.equal(h.crashLogDir, join("/fake/user-data", "crash-logs"));
    proc.emit("uncaughtException", new Error("fatal-test"));
    const paths = Object.keys(files);
    assert.equal(paths.length, 1);
    assert.ok(paths[0].includes("crash-uncaughtException-2026-10-26T05-30-00-000Z.log"));
    assert.ok(files[paths[0]].includes("fatal-test"));
    assert.equal(shown.length, 1);
    assert.ok(shown[0][0].includes("ran into a problem"));
    assert.ok(shown[0][1].includes("will close"));
    assert.equal(quit, 1);
    h.uninstall();
    assert.equal(proc.listenerCount("uncaughtException"), 0);
  });

  it("unhandled rejection writes a log and shows an error but does NOT quit", () => {
    const files = {};
    const shown = [];
    let quit = 0;
    const proc = fakeProcess();
    installCrashHandlers({
      process: proc,
      showError: (t, m) => shown.push([t, m]),
      userDataDir: "/fake/user-data",
      mkdirSync: () => {},
      writeFileSync: (p, c) => {
        files[p] = c;
      },
      now: () => new Date("2026-10-26T05:31:00.000Z"),
      quit: () => {
        quit += 1;
      },
    });
    proc.emit("unhandledRejection", new Error("rejected-test"));
    assert.equal(Object.keys(files).length, 1);
    assert.ok(Object.keys(files)[0].includes("crash-unhandledRejection-"));
    assert.equal(shown.length, 1);
    assert.ok(shown[0][1].includes("keep running"));
    assert.equal(quit, 0);
  });

  it("a handler failure (no dialog, unwritable disk) never throws", () => {
    const proc = fakeProcess();
    installCrashHandlers({
      process: proc,
      showError: null,
      userDataDir: "/fake/user-data",
      mkdirSync: () => {
        throw new Error("no disk");
      },
      writeFileSync: () => {
        throw new Error("no disk");
      },
    });
    assert.doesNotThrow(() => proc.emit("uncaughtException", new Error("x")));
    assert.doesNotThrow(() => proc.emit("unhandledRejection", new Error("y")));
  });
});
