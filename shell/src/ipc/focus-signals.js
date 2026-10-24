import { safeHandle } from "../security/safe-handle.js";
import { ipcMain } from "electron";

/**
 * Academic Focus â€” read-only signal batch for the Dashboard's "Focus Now"
 * panel. The pure prioritization algorithm lives in
 * ui/src/features/dashboard/academic-focus.js; this IPC handler only
 * fetches the bounded input data the algorithm needs.
 *
 * No mutation, no new tables, no caching layer (the core does the
 * SQL-boundary scoping already). Each Dashboard load = one IPC call.
 */
export function register({ core }) {
  safeHandle("focus:signals", (_e, profileId) => core.getFocusSignals(profileId ?? 0));
}
