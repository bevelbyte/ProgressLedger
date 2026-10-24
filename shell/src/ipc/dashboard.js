import { safeHandle } from "../security/safe-handle.js";
import { ipcMain } from "electron";

export function register({ core }) {
  safeHandle("dashboard:stats", (_e, profileId) => core.getDashboardStats(profileId));
}
