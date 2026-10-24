import { app } from "electron";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { isDestinationOccupied } from "./security/migration-safety.js";

const LAUNCHER_JSON = "launcher.json";
const WORKSPACE_JSON = "workspace.json";

let activeWorkspace = null;

// --- Launcher.json Management ---
function getLauncherState() {
  const launcherPath = join(app.getPath("userData"), LAUNCHER_JSON);
  if (!existsSync(launcherPath)) {
    return { lastWorkspace: null, recentWorkspaces: [] };
  }
  try {
    const data = readFileSync(launcherPath, "utf8");
    return JSON.parse(data);
  } catch (e) {
    console.error("Failed to parse launcher.json", e);
    return { lastWorkspace: null, recentWorkspaces: [] };
  }
}

function saveLauncherState(state) {
  const launcherPath = join(app.getPath("userData"), LAUNCHER_JSON);
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(launcherPath, JSON.stringify(state, null, 2), "utf8");
}

// --- Path Resolver API ---

/**
 * Validates a directory as a Workspace
 * A valid workspace must have a workspace.json file that parses correctly.
 */
function isValidWorkspace(dirPath) {
  if (!dirPath || !existsSync(dirPath)) return false;
  const wsJsonPath = join(dirPath, WORKSPACE_JSON);
  if (!existsSync(wsJsonPath)) return false;
  try {
    const data = readFileSync(wsJsonPath, "utf8");
    const parsed = JSON.parse(data);
    // Schema version check (must be supported)
    if (!parsed || parsed.schemaVersion !== 1 || !parsed.workspaceId) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Internal function to lock the workspace using a .careerflow.lock file
 */
function lockWorkspace(dirPath) {
  const lockPath = join(dirPath, ".careerflow.lock");
  if (existsSync(lockPath)) {
    try {
      const pid = parseInt(readFileSync(lockPath, "utf8"), 10);
      if (!isNaN(pid)) {
        if (pid === process.pid) return; // We already hold the lock
        try {
          process.kill(pid, 0); // Check if process is running
          throw new Error(`Workspace is locked by running process PID: ${pid}`);
        } catch (e) {
          if (e.message && e.message.includes("Workspace is locked")) throw e;
          // Process not running, stale lock, safe to overwrite
        }
      }
    } catch (e) {
      if (e.message && e.message.includes("Workspace is locked")) throw e;
      // Corrupt lock file, safe to overwrite
    }
  }
  writeFileSync(lockPath, process.pid.toString(), "utf8");
}

/**
 * Internal function to activate the workspace in memory without touching launcher.json.
 */
function setActiveWorkspace(dirPath) {
  if (!isValidWorkspace(dirPath)) {
    throw new Error("Invalid workspace directory: " + dirPath);
  }
  lockWorkspace(dirPath);
  activeWorkspace = dirPath;
}

function unlockWorkspace() {
  if (activeWorkspace) {
    const lockPath = join(activeWorkspace, ".careerflow.lock");
    if (existsSync(lockPath)) {
      try {
        unlinkSync(lockPath);
      } catch (e) {} 
    }
  }
}

/**
 * Switches the active workspace. Validates and updates launcher state.
 */
function switchWorkspace(dirPath) {
  setActiveWorkspace(dirPath);
  const state = getLauncherState();
  state.lastWorkspace = dirPath;
  if (!state.recentWorkspaces.includes(dirPath)) {
    state.recentWorkspaces.unshift(dirPath);
    // keep recent bounded (e.g. max 10)
    if (state.recentWorkspaces.length > 10) {
      state.recentWorkspaces.pop();
    }
  } else {
    // move to front
    state.recentWorkspaces = [
      dirPath,
      ...state.recentWorkspaces.filter(p => p !== dirPath)
    ];
  }
  saveLauncherState(state);
}

/**
 * Returns the legacy AppData directory where old settings reside.
 */
function getLegacyAppDataPath() {
  return app.getPath("userData");
}

/**
 * Ensures the required subdirectories exist within the active workspace.
 */
function ensureWorkspaceStructure() {
  if (!activeWorkspace) throw new Error("No active workspace to initialize");
  const dirs = [
    join(activeWorkspace, "Logs"),
    join(activeWorkspace, "Temp"),
    join(activeWorkspace, "Backups"),
    join(activeWorkspace, "attachments"),
    join(activeWorkspace, "downloads")
  ];
  for (const d of dirs) {
    if (!existsSync(d)) {
      mkdirSync(d, { recursive: true });
    }
  }
}

/**
 * Returns the path to the sqlite database for the active workspace.
 */
function resolveDbPath() {
  if (!activeWorkspace) throw new Error("No active workspace set");
  return join(activeWorkspace, "careerflow.db");
}

/**
 * Returns the path to the main log file for the active workspace.
 */
function resolveLogPath() {
  if (!activeWorkspace) throw new Error("No active workspace set");
  return join(activeWorkspace, "Logs", "careerflow.log");
}

/**
 * Returns the attachments directory for the active workspace.
 */
function resolveAttachmentsDir() {
  if (!activeWorkspace) throw new Error("No active workspace set");
  return join(activeWorkspace, "attachments");
}

/**
 * Returns the MANAGED DOWNLOADS directory for the active workspace.
 *
 * Approved decision D: the CareerFlow-owned browser writes downloads to
 * `<workspace>/downloads` and nowhere else. It is per-workspace on purpose -
 * switching workspace switches the download set the same way it switches the
 * database - and it is a directory, not a schema change.
 *
 * The containment rule lives in services/browser/policy.js; this function only
 * answers WHERE the directory is. It THROWS when no workspace is active, and the
 * browser treats that as a refusal to download rather than falling back to the
 * OS download folder (see services/browser/downloads.js: fail closed).
 */
function resolveDownloadsDir() {
  if (!activeWorkspace) throw new Error("No active workspace set");
  return join(activeWorkspace, "downloads");
}

/**
 * Returns the path to the backup settings file for the active workspace.
 */
function resolveBackupSettingsPath() {
  if (!activeWorkspace) throw new Error("No active workspace set");
  return join(activeWorkspace, "backup-settings.json");
}

/**
 * Returns the path to the CareerFlow↔Donut profile mapping file for the
 * active workspace. Machine-local by design and NOT part of backup bundles.
 */
function resolveDonutMappingPath() {
  if (!activeWorkspace) throw new Error("No active workspace set");
  return join(activeWorkspace, "donut-mapping.json");
}

/**
 * Returns the path to the browser-profile binding store (managed browser
 * profile local id -> machine-local Donut profile UUID). Same isolation rules
 * as donut-mapping.json: machine-local, never exported.
 */
function resolveDonutBindingsPath() {
  if (!activeWorkspace) throw new Error("No active workspace set");
  return join(activeWorkspace, "donut-bindings.json");
}

function resolveTempDir() {
  if (!activeWorkspace) throw new Error("No active workspace set");
  return join(activeWorkspace, "Temp");
}

/**
 * Returns the path to the sidecar SQLite store used by the file-
 * reservations service. This file is NOT part of the main pm_* schema:
 * it is a small dedicated DB so the reservation lifecycle never touches
 * the canonical CareerFlow DB and so it can be wiped independently.
 */
function resolveReservationsDbPath() {
  if (!activeWorkspace) throw new Error("No active workspace set");
  return join(activeWorkspace, "file_reservations.sqlite");
}

/**
 * Returns the root directory for the Marketplace service.
 *
 * The marketplace stores installed items at
 * `<rootDir>/marketplace/<id>/` plus a `<rootDir>/marketplace-state.json`
 * sidecar. It is deliberately scoped to the ACTIVE WORKSPACE (not the OS
 * userData dir) so switching workspaces switches the installed-item set, the
 * same way the plugin registry is scoped via `dirname(resolveDbPath())`.
 * Everything under this root is governed by the centralized containment
 * policy in services/marketplace/path-security.js.
 */
function resolveMarketplaceDir() {
  if (!activeWorkspace) throw new Error("No active workspace set");
  return activeWorkspace;
}

export {
  getLauncherState,
  saveLauncherState,
  isValidWorkspace,
  setActiveWorkspace,
  switchWorkspace,
  getLegacyAppDataPath,
  ensureWorkspaceStructure,
  resolveDbPath,
  resolveLogPath,
  resolveAttachmentsDir,
  resolveDownloadsDir,
  resolveBackupSettingsPath,
  resolveDonutMappingPath,
  resolveDonutBindingsPath,
  resolveTempDir,
  resolveReservationsDbPath,
  resolveMarketplaceDir,
  unlockWorkspace,
  isDestinationOccupied,
};
