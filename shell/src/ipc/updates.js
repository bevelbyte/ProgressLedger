import { safeHandle } from "../security/safe-handle.js";
import { ipcMain } from "electron";
import pkgUpdater from "electron-updater";

const { autoUpdater } = pkgUpdater;

/** Wire updater events â†’ renderer notifications. Production only. */
export function setupAutoUpdater(notify) {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => notify("update:status", { status: "checking" }));
  autoUpdater.on("update-available", (info) =>
    notify("update:status", { status: "available", version: info.version, releaseDate: info.releaseDate })
  );
  autoUpdater.on("update-not-available", (info) =>
    notify("update:status", { status: "up-to-date", version: info.version })
  );
  autoUpdater.on("download-progress", (progress) =>
    notify("update:status", {
      status: "downloading",
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    })
  );
  autoUpdater.on("update-downloaded", (info) =>
    notify("update:status", { status: "downloaded", version: info.version, releaseDate: info.releaseDate })
  );
  autoUpdater.on("error", (error) =>
    notify("update:status", { status: "error", message: error?.message ?? String(error) })
  );
}

export function register({ isDev }) {
  safeHandle("update:check", async () => {
    if (isDev) return { status: "disabled", message: "Auto-updater is disabled in development mode" };
    try {
      await autoUpdater.checkForUpdates();
      return { status: "checking" };
    } catch (e) {
      return { status: "error", message: e?.message ?? String(e) };
    }
  });

  safeHandle("update:download", async () => {
    if (isDev) return { status: "disabled", message: "Auto-updater is disabled in development mode" };
    try {
      await autoUpdater.downloadUpdate();
      return { status: "downloading" };
    } catch (e) {
      return { status: "error", message: e?.message ?? String(e) };
    }
  });

  safeHandle("update:install", () => {
    if (!isDev) autoUpdater.quitAndInstall();
    return { status: "installing" };
  });
}
