// Electron-aware wrapper around ipcMain.handle that enforces the sender
// origin allow-list defined in ./ipc-auth.js.

import { ipcMain } from "electron";
import { verifyIpcSender } from "./ipc-auth.js";

/**
 * Register a sender-authenticated IPC handler.
 * Rejected senders receive the same structured error envelope used by the
 * rest of Progress Ledger rather than executing the privileged callback.
 */
export function safeHandle(channel, handler, opts = {}) {
  ipcMain.handle(channel, async (event, ...args) => {
    const verdict = verifyIpcSender(event, opts);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    return handler(event, ...args);
  });
}
