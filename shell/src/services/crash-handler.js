// Crash safety (V2-42, item B): main-process handlers for uncaught
// exceptions and unhandled promise rejections.
//
// Before this module, a main-process crash killed the app silently: the
// window vanished with no message and nothing on disk to explain it
// (the V2-40 `rm` crash was diagnosed only from driver logs). Now:
//   * every crash writes ONE timestamped log file under
//     <userData>/crash-logs/ (never in the app install folder, never
//     in the database folder, so a crash cannot corrupt data);
//   * the user sees a plain-language error box instead of a vanished
//     window;
//   * an uncaught exception still quits (the process state is
//     undefined after one), but only AFTER the log is written and the
//     error box is shown; an unhandled rejection is logged and shown
//     and the app keeps running, because a rejected promise does not
//     by itself mean the whole process is corrupt.
//
// This module imports NO Electron module, so it loads under plain
// node --test with fakes. main.js wires the real process/dialog/
// app.getPath("userData") in. The handler itself never throws: every
// step is guarded, and a second crash while handling the first is
// ignored (re-entry guard), so the handler can never be the crash.

import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

export function crashFileName(kind, date) {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  return `crash-${kind}-${stamp}.log`;
}

export function formatCrashLog({ kind, error, date, pid }) {
  const when = date.toISOString();
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  return [
    `Progress Ledger v2 crash log`,
    `time: ${when}`,
    `kind: ${kind}`,
    `pid: ${pid ?? ""}`,
    `message: ${message}`,
    stack ? `stack:\n${stack}` : `stack: (none)`,
    ``,
  ].join("\n");
}

export function installCrashHandlers(deps = {}) {
  const proc = deps.process ?? process;
  // The error box arrives as a plain callback, NOT as an Electron
  // `dialog` object: the repo's check:esm guard flags any bare
  // `dialog` identifier in shell/src that is not imported from
  // "electron", and this module must stay importable under plain
  // node --test. main.js passes (t, m) => dialog.showErrorBox(t, m).
  const showError = deps.showError ?? null;
  const userDataDir = deps.userDataDir ?? "";
  const mkdir = deps.mkdirSync ?? mkdirSync;
  const writeFile = deps.writeFileSync ?? writeFileSync;
  const now = deps.now ?? (() => new Date());
  const quit = deps.quit ?? null;
  const logDir = userDataDir ? join(userDataDir, "crash-logs") : null;

  let handling = false;

  function report(kind, error) {
    if (handling) return null;
    handling = true;
    let filePath = null;
    try {
      const date = now();
      if (logDir) {
        try {
          mkdir(logDir, { recursive: true });
        } catch {}
        filePath = join(logDir, crashFileName(kind, date));
        try {
          writeFile(filePath, formatCrashLog({ kind, error, date, pid: proc.pid }));
        } catch {
          filePath = null;
        }
      }
    } catch {}
    const detail =
      error instanceof Error ? error.message : String(error);
    const where = filePath
      ? `\n\nA crash log was saved to:\n${filePath}`
      : `\n\nNo crash log could be written.`;
    try {
      if (typeof showError === "function") {
        showError(
          "Progress Ledger v2 ran into a problem",
          kind === "uncaughtException"
            ? `The app hit an unexpected error and will close.\n\n${detail}${where}`
            : `The app hit an unexpected error, but it will keep running.\n\n${detail}${where}`,
        );
      }
    } catch {}
    try {
      console.error(`[crash] ${kind}:`, error);
    } catch {}
    handling = false;
    return filePath;
  }

  function onUncaught(error) {
    report("uncaughtException", error);
    try {
      if (typeof quit === "function") quit();
    } catch {}
  }

  function onUnhandled(reason) {
    report("unhandledRejection", reason);
    // Deliberately no quit: a rejected promise is not proof the
    // process is corrupt, and quitting on every one would turn a
    // single failed background job into a lost session.
  }

  if (typeof proc.on === "function") {
    proc.on("uncaughtException", onUncaught);
    proc.on("unhandledRejection", onUnhandled);
  }

  return {
    crashLogDir: logDir,
    uninstall() {
      try {
        proc.removeListener?.("uncaughtException", onUncaught);
        proc.removeListener?.("unhandledRejection", onUnhandled);
      } catch {}
    },
    // Exposed for tests only: run the report path without killing anything.
    _report: report,
  };
}
