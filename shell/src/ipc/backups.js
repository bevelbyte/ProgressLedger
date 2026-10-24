import { safeHandle } from "../security/safe-handle.js";
import { ipcMain, dialog } from "electron";
import { mkdir, stat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { shell } from "electron";
import {
  readBackupSettings,
  writeBackupSettings,
} from "../services/backup-settings.js";
import { isInsideDir, listBackupFiles, pruneLocalBackups, stampForFile } from "../services/local-vault.js";
import { resolveSafeBackupFile } from "../services/backup-path-security.js";
import { inspectBundleConflicts } from "../services/inspect.js";
import { Audit } from "../services/audit/index.js";

export function register({ core, win }) {
  safeHandle("backups:get", async () => {
    const settings = await readBackupSettings();
    const backups = await listBackupFiles(settings.backupDir);
    return { ...settings, backups };
  });

  safeHandle("backups:choose-folder", async () => {
    const res = await dialog.showOpenDialog(win(), {
      title: "Choose Progress Ledger Backup Folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || res.filePaths.length === 0) return { selected: false };

    const settings = await readBackupSettings();
    settings.backupDir = res.filePaths[0];
    await mkdir(settings.backupDir, { recursive: true });
    await writeBackupSettings(settings);
    const backups = await listBackupFiles(settings.backupDir);
    Audit.log({
      event: "backup.configure_folder",
      input_summary: basename(settings.backupDir),
      result: "ok",
      detail: JSON.stringify({ configured: true, cleared: false }),
    });
    return { selected: true, ...settings, backups };
  });

  safeHandle("backups:clear-folder", async () => {
    const settings = await readBackupSettings();
    settings.backupDir = null;
    await writeBackupSettings(settings);
    Audit.log({
      event: "backup.configure_folder",
      input_summary: "cleared",
      result: "ok",
      detail: JSON.stringify({ configured: false, cleared: true }),
    });
    return { ...settings, backups: [] };
  });

  safeHandle("backups:run", async (_e, { profileId, slug } = {}) => {
    const settings = await readBackupSettings();
    if (!settings.backupDir) {
      Audit.log({
        event: "backup.export",
        profileId: typeof profileId === "number" ? profileId : null,
        input_summary: String(slug || "profile"),
        result: "error",
        detail: JSON.stringify({ reason: "missing-backup-dir" }),
      });
      throw new Error("Choose a backup folder first.");
    }
    await mkdir(settings.backupDir, { recursive: true });

    const safeSlug = String(slug || "profile").replace(/[^a-z0-9_-]+/gi, "-");
    const outPath = join(settings.backupDir, `${safeSlug}-${stampForFile()}.cfprofile`);
    try {
      const path = await core.exportProfile(profileId, outPath);
      const info = await stat(path);
      settings.lastBackups[String(profileId)] = {
        path,
        at: new Date().toISOString(),
        byteSize: info.size,
      };
      await pruneLocalBackups(settings.backupDir, settings.automation.retentionKeep);
      await writeBackupSettings(settings);
      const backups = await listBackupFiles(settings.backupDir);
      Audit.log({
        event: "backup.export",
        profileId: typeof profileId === "number" ? profileId : null,
        input_summary: basename(path),
        result: "ok",
        detail: JSON.stringify({ filename: basename(path), byteSize: info.size }),
      });
      return { backedUp: true, path, ...settings, backups };
    } catch (err) {
      Audit.log({
        event: "backup.export",
        profileId: typeof profileId === "number" ? profileId : null,
        input_summary: String(slug || "profile"),
        result: "error",
        detail: JSON.stringify({ reason: err.message || "export-failed" }),
      });
      throw err;
    }
  });

  safeHandle("backups:inspect", async (_e, path) => {
    const settings = await readBackupSettings();
    if (!settings.backupDir) throw new Error("Choose a backup folder first.");
    if (!path || extname(path).toLowerCase() !== ".cfprofile") {
      throw new Error("Selected backup is outside the configured backup folder.");
    }
    const safe = await resolveSafeBackupFile(settings.backupDir, path);
    if (!safe.ok) throw new Error("Selected backup is outside the configured backup folder.");
    return inspectBundleConflicts(core, safe.path);
  });

  safeHandle("backups:restore", async (_e, path) => {
    const settings = await readBackupSettings();
    if (!settings.backupDir) {
      Audit.log({
        event: "backup.restore",
        input_summary: typeof path === "string" ? basename(path) : null,
        result: "error",
        detail: JSON.stringify({ reason: "missing-backup-dir" }),
      });
      throw new Error("Choose a backup folder first.");
    }
    if (!path || extname(path).toLowerCase() !== ".cfprofile") {
      Audit.log({
        event: "backup.restore",
        input_summary: typeof path === "string" ? basename(path) : null,
        result: "error",
        detail: JSON.stringify({ reason: "invalid-backup-path" }),
      });
      throw new Error("Selected backup is outside the configured backup folder.");
    }
    const safe = await resolveSafeBackupFile(settings.backupDir, path);
    if (!safe.ok) {
      Audit.log({
        event: "backup.restore",
        input_summary: typeof path === "string" ? basename(path) : null,
        result: "error",
        detail: JSON.stringify({ reason: "unsafe-backup-path" }),
      });
      throw new Error("Selected backup is outside the configured backup folder.");
    }
    try {
      const profile = await core.importProfile(safe.path);
      const restoredProfileId = profile && (typeof profile.id === "number" ? profile.id : (typeof profile.profile_id === "number" ? profile.profile_id : null));
      Audit.log({
        event: "backup.restore",
        profileId: restoredProfileId,
        input_summary: basename(safe.path),
        result: "ok",
        detail: JSON.stringify({ filename: basename(safe.path), restoredProfileId }),
      });
      return { restored: true, profile };
    } catch (err) {
      Audit.log({
        event: "backup.restore",
        input_summary: basename(safe.path),
        result: "error",
        detail: JSON.stringify({ reason: err.message || "restore-failed" }),
      });
      throw err;
    }
  });

  safeHandle("backups:open-folder", async () => {
    const settings = await readBackupSettings();
    if (!settings.backupDir) return { opened: false };
    const err = await shell.openPath(settings.backupDir);
    if (err) throw new Error(err);
    return { opened: true };
  });
}
