// Legacy Donut Browser Workspace IPC compatibility surface.
//
// Donut's supported Local API does not expose general tab/page controls.
// Browser Manager profile CRUD and explicit URL opening remain in
// ipc/browser-manager.js and services/donut*.js. This module deliberately
// fails closed instead of reaching into Donut with CDP or native HWND/PID
// operations. CareerFlow's own embedded WebContentsView is independent.
import { safeHandle } from "../security/safe-handle.js";
import { registerUnsupportedDonutTools } from "../services/browser-workspace-tools.js";

export const UNSUPPORTED_DONUT_CONTROL = Object.freeze({
  ok: false,
  reason: "feature-not-supported",
  message:
    "Donut page/tab control is unavailable through the supported Local API. Use Saved Places to open a managed profile or URL, or use CareerFlow's embedded browser.",
});

const unsupported = () => ({ ...UNSUPPORTED_DONUT_CONTROL });

export function register() {
  // The agent tool contract also stays visible so tool callers receive an
  // explicit unsupported result, not a misleading success or empty tab list.
  registerUnsupportedDonutTools();

  safeHandle("browser-workspace:state", async () => unsupported());
  safeHandle("browser-workspace:stop", async () => unsupported());
  safeHandle("browser-workspace:launch", async () => unsupported());
  safeHandle("browser-workspace:navigate", async () => unsupported());
  safeHandle("browser-workspace:new-tab", async () => unsupported());
  safeHandle("browser-workspace:close-tab", async () => unsupported());
  safeHandle("browser-workspace:activate-tab", async () => unsupported());
  safeHandle("browser-workspace:reload", async () => unsupported());
  safeHandle("browser-workspace:back", async () => unsupported());
  safeHandle("browser-workspace:forward", async () => unsupported());
  safeHandle("browser-workspace:screenshot", async () => unsupported());
  safeHandle("browser-workspace:subscribe", async () => unsupported());
}
