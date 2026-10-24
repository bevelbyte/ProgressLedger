import { safeHandle } from "../security/safe-handle.js";
import { ipcMain } from "electron";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
  readBackupSettings,
  writeBackupSettings,
} from "../services/backup-settings.js";
import {
  ensureWebDavFolder,
  listWebDavBackups,
  normalizeWebDavUrl,
  pruneWebDavBackups,
  webdavFileUrl,
  webdavFetch,
} from "../services/webdav.js";
import { encryptSecret } from "../services/secrets.js";
import { cloudPublicState } from "../services/cloud-state.js";
import { uploadBundleToCloud } from "../services/sync-runner.js";
import { inspectBundleConflicts } from "../services/inspect.js";
import { resolveTempDir } from "../workspace.js";

function assertValidRemoteName(remoteName) {
  if (!remoteName || String(remoteName).includes("/") || !String(remoteName).toLowerCase().endsWith(".cfprofile")) {
    throw new Error("Invalid remote backup name.");
  }
}

export function register({ core }) {
  safeHandle("cloud:get", async () => {
    const settings = await readBackupSettings();
    if (!settings.cloud?.url) return cloudPublicState(settings, { backups: [] });
    try {
      const backups = await listWebDavBackups(settings.cloud);
      return cloudPublicState(settings, { backups });
    } catch (e) {
      return cloudPublicState(settings, { backups: [], error: e?.message ?? String(e) });
    }
  });

  safeHandle("cloud:configure", async (_e, { url, username, password }) => {
    const settings = await readBackupSettings();
    const cloud = {
      provider: "webdav",
      url: normalizeWebDavUrl(url),
      username: username ?? "",
      secret: encryptSecret(password ?? ""),
      lastSyncAt: settings.cloud?.lastSyncAt ?? null,
    };
    await ensureWebDavFolder(cloud);
    const next = { ...settings, cloud };
    await writeBackupSettings(next);
    const backups = await listWebDavBackups(cloud);
    return cloudPublicState(next, { backups });
  });

  safeHandle("cloud:disconnect", async () => {
    const settings = await readBackupSettings();
    settings.cloud = null;
    await writeBackupSettings(settings);
    return cloudPublicState(settings, { backups: [] });
  });

  safeHandle("cloud:upload", async (_e, { profileId, slug }) => {
    const settings = await readBackupSettings();
    if (!settings.cloud?.url) throw new Error("Connect a WebDAV cloud vault first.");
    const name = await uploadBundleToCloud(core, settings.cloud, { id: profileId, slug });
    await pruneWebDavBackups(settings.cloud, settings.automation.retentionKeep);
    settings.cloud.lastSyncAt = new Date().toISOString();
    await writeBackupSettings(settings);
    const backups = await listWebDavBackups(settings.cloud);
    return cloudPublicState(settings, { uploaded: true, name, backups });
  });

  safeHandle("cloud:upload-all", async (_e, profiles) => {
    const settings = await readBackupSettings();
    if (!settings.cloud?.url) throw new Error("Connect a WebDAV cloud vault first.");
    let uploaded = 0;
    for (const profile of profiles ?? []) {
      await uploadBundleToCloud(core, settings.cloud, profile);
      uploaded += 1;
    }
    await pruneWebDavBackups(settings.cloud, settings.automation.retentionKeep);
    settings.cloud.lastSyncAt = new Date().toISOString();
    await writeBackupSettings(settings);
    const backups = await listWebDavBackups(settings.cloud);
    return cloudPublicState(settings, { uploaded, backups });
  });

  safeHandle("cloud:inspect", async (_e, remoteName) => {
    const settings = await readBackupSettings();
    if (!settings.cloud?.url) throw new Error("Connect a WebDAV cloud vault first.");
    assertValidRemoteName(remoteName);
    const dir = await mkdtemp(join(resolveTempDir(), "progressledger-cloud-inspect-"));
    const localPath = join(dir, basename(remoteName));
    try {
      const res = await webdavFetch(settings.cloud, webdavFileUrl(settings.cloud.url, remoteName));
      const bytes = Buffer.from(await res.arrayBuffer());
      await writeFile(localPath, bytes);
      return inspectBundleConflicts(core, localPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  safeHandle("cloud:restore", async (_e, remoteName) => {
    const settings = await readBackupSettings();
    if (!settings.cloud?.url) throw new Error("Connect a WebDAV cloud vault first.");
    assertValidRemoteName(remoteName);
    const dir = await mkdtemp(join(resolveTempDir(), "progressledger-cloud-restore-"));
    const localPath = join(dir, basename(remoteName));
    try {
      const res = await webdavFetch(settings.cloud, webdavFileUrl(settings.cloud.url, remoteName));
      const bytes = Buffer.from(await res.arrayBuffer());
      await writeFile(localPath, bytes);
      const profile = await core.importProfile(localPath);
      return { restored: true, profile };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
