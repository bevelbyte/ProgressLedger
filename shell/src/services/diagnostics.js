import { join } from "node:path";
import { app } from "electron";
import { readBackupSettings } from "./backup-settings.js";
import { listBackupFiles, pathStatus } from "./local-vault.js";
import { listWebDavBackups } from "./webdav.js";
import { logPath, writeLog } from "./logger.js";
import { getLauncherState, resolveDbPath } from "../workspace.js";
import { DEFAULT_AUTOMATION } from "./backup-settings.js";

function healthStatus(checks) {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "pass";
}

function makeCheck(id, label, ok, detail = null, warn = false) {
  return {
    id,
    label,
    status: ok ? "pass" : warn ? "warn" : "fail",
    detail,
  };
}

export async function buildDiagnosticsReport(core, { includeNetwork = false } = {}) {
  const settings = await readBackupSettings();
  const dbPath = resolveDbPath();
  const uiPath = join(app.getAppPath(), "ui", "dist", "index.html");
  const nativePath = join(app.getAppPath(), "core", "careerflow_core.win32-x64-msvc.node");
  const profiles = (() => {
    try {
      return core.getProfiles();
    } catch {
      return [];
    }
  })();

  let localBackups = [];
  if (settings.backupDir) localBackups = await listBackupFiles(settings.backupDir);

  let cloudBackups = [];
  let cloudError = null;
  if (settings.cloud?.url && includeNetwork) {
    try {
      cloudBackups = await listWebDavBackups(settings.cloud);
    } catch (e) {
      cloudError = e?.message ?? String(e);
    }
  }

  const checks = [
    makeCheck("core", "Native Rust core responds", core.ping?.() === "CareerFlow core online"),
    makeCheck("db", "SQLite database exists", (await pathStatus(dbPath)).exists, dbPath),
    makeCheck(
      "ui-dist",
      "Built UI is present",
      !app.isPackaged || (await pathStatus(uiPath)).exists,
      uiPath,
      !app.isPackaged
    ),
    makeCheck("native-binding", "Native addon is present", (await pathStatus(nativePath)).exists, nativePath),
    makeCheck("local-backup", "Local backup folder configured", Boolean(settings.backupDir), settings.backupDir, true),
    makeCheck("cloud", "Cloud sync configured", Boolean(settings.cloud?.url), settings.cloud?.url ?? null, true),
  ];

  if (cloudError) {
    checks.push(makeCheck("cloud-reachability", "Cloud sync reachable", false, cloudError));
  } else if (settings.cloud?.url && includeNetwork) {
    checks.push(makeCheck("cloud-reachability", "Cloud sync reachable", true, `${cloudBackups.length} remote bundles`));
  }

  const logInfo = await pathStatus(logPath());
  const report = {
    generatedAt: new Date().toISOString(),
    status: healthStatus(checks),
    app: {
      name: app.getName(),
      version: app.getVersion(),
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      userData: app.getPath("userData"),
      workspace: getLauncherState().lastWorkspace || app.getPath("userData"),
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
    },
    checks,
    data: {
      profiles: profiles.map(({ id, name, slug, createdAt }) => ({ id, name, slug, createdAt })),
      profileCount: profiles.length,
      database: await pathStatus(dbPath),
      uiDist: await pathStatus(uiPath),
      nativeBinding: await pathStatus(nativePath),
      log: logInfo,
    },
    sync: {
      local: {
        configured: Boolean(settings.backupDir),
        backupDir: settings.backupDir,
        bundleCount: localBackups.length,
        latest: localBackups[0] ?? null,
      },
      cloud: {
        configured: Boolean(settings.cloud?.url),
        provider: settings.cloud?.provider ?? "webdav",
        url: settings.cloud?.url ?? null,
        username: settings.cloud?.username ?? null,
        credentialStored: Boolean(settings.cloud?.secret),
        bundleCount: cloudBackups.length,
        latest: cloudBackups[0] ?? null,
        error: cloudError,
      },
      automation: {
        ...DEFAULT_AUTOMATION,
        ...settings.automation,
      },
    },
  };
  await writeLog("info", "Diagnostics report generated", { status: report.status, includeNetwork });
  return report;
}
