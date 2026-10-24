import { join } from "node:path";
import { mkdir, readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  readBackupSettings,
  writeBackupSettings,
  DEFAULT_AUTOMATION,
} from "./backup-settings.js";
import { listWebDavBackups, pruneWebDavBackups, webdavFileUrl, webdavFetch, bundleGroupName } from "./webdav.js";
import { listBackupFiles, pruneLocalBackups } from "./local-vault.js";
import { resolveTempDir } from "../workspace.js";

let automationTimer = null;
let automationRunning = false;

/** Export one profile to a temp .cfprofile bundle and upload it. Returns remote name. */
export async function uploadBundleToCloud(core, cloud, profile) {
  const dir = await mkdtemp(join(resolveTempDir(), "progressledger-cloud-"));
  try {
    const safeSlug = String(profile.slug || "profile").replace(/[^a-z0-9_-]+/gi, "-");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const path = join(dir, `${safeSlug}-${stamp}.cfprofile`);
    await core.exportProfile(profile.id, path);
    const bytes = await readFile(path);
    await webdavFetch(cloud, webdavFileUrl(cloud.url, basename(path)), {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    });
    return basename(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function runAutomatedSync(core, notify, reason = "manual") {
  if (automationRunning) return { skipped: true, reason: "Sync already running." };
  automationRunning = true;
  const startedAt = new Date().toISOString();
  let settings = await readBackupSettings();
  const automation = { ...DEFAULT_AUTOMATION, ...settings.automation };
  const target = automation.target;
  const profiles = core.getProfiles();
  const result = {
    reason,
    startedAt,
    finishedAt: null,
    localUploaded: 0,
    cloudUploaded: 0,
    localPruned: 0,
    cloudPruned: 0,
    errors: [],
  };

  try {
    if ((target === "local" || target === "both") && settings.backupDir) {
      await mkdir(settings.backupDir, { recursive: true });
      for (const profile of profiles) {
        const safeSlug = String(profile.slug || "profile").replace(/[^a-z0-9_-]+/gi, "-");
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
        const outPath = join(settings.backupDir, `${safeSlug}-${stamp}.cfprofile`);
        await core.exportProfile(profile.id, outPath);
        const info = await stat(outPath);
        settings.lastBackups[String(profile.id)] = {
          path: outPath,
          at: new Date().toISOString(),
          byteSize: info.size,
        };
        result.localUploaded += 1;
      }
      result.localPruned = (await pruneLocalBackups(settings.backupDir, automation.retentionKeep)).removed;
    }

    if ((target === "cloud" || target === "both") && settings.cloud?.url) {
      for (const profile of profiles) {
        await uploadBundleToCloud(core, settings.cloud, profile);
        result.cloudUploaded += 1;
      }
      result.cloudPruned = (await pruneWebDavBackups(settings.cloud, automation.retentionKeep)).removed;
      settings.cloud.lastSyncAt = new Date().toISOString();
    }
  } catch (e) {
    result.errors.push(e?.message ?? String(e));
  } finally {
    result.finishedAt = new Date().toISOString();
    settings.automation = {
      ...DEFAULT_AUTOMATION,
      ...settings.automation,
      lastRunAt: result.finishedAt,
      lastResult: result,
    };
    await writeBackupSettings(settings);
    automationRunning = false;
  }

  notify("sync:automation-result", result);
  return result;
}

export async function scheduleAutomation(core, notify) {
  if (automationTimer) {
    clearTimeout(automationTimer);
    automationTimer = null;
  }
  try {
    const settings = await readBackupSettings();
    const automation = { ...DEFAULT_AUTOMATION, ...settings.automation };
    if (!automation.enabled) return;
    const minutes = Math.max(15, Number(automation.intervalMinutes) || 60);
    automationTimer = setTimeout(async () => {
      await runAutomatedSync(core, notify, "scheduled");
      scheduleAutomation(core, notify);
    }, minutes * 60 * 1000);
    // Scheduled backup work must never be the reason the Electron main
    // process remains alive during application shutdown. The callback is
    // still allowed to run while the process is otherwise alive.
    if (automationTimer && typeof automationTimer.unref === "function") automationTimer.unref();
  } catch (e) {
    console.error("scheduleAutomation failed:", e);
  }
}

/** Cancel future scheduled automation during application teardown. */
export function stopAutomation() {
  if (automationTimer) {
    clearTimeout(automationTimer);
    automationTimer = null;
  }
}

export { listBackupFiles, listWebDavBackups, pruneLocalBackups, pruneWebDavBackups, bundleGroupName };
