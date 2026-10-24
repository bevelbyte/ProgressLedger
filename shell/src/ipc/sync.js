import { safeHandle } from "../security/safe-handle.js";
import { ipcMain } from "electron";
import { readBackupSettings, writeBackupSettings, DEFAULT_AUTOMATION } from "../services/backup-settings.js";
import { runAutomatedSync, scheduleAutomation } from "../services/sync-runner.js";

export function register({ core, notify }) {
  safeHandle("sync:get-automation", async () => {
    const settings = await readBackupSettings();
    return {
      automation: { ...DEFAULT_AUTOMATION, ...settings.automation },
      capabilities: {
        localReady: Boolean(settings.backupDir),
        cloudReady: Boolean(settings.cloud?.url),
      },
    };
  });

  safeHandle("sync:update-automation", async (_e, patch) => {
    const settings = await readBackupSettings();
    const next = {
      ...DEFAULT_AUTOMATION,
      ...settings.automation,
      ...patch,
      intervalMinutes: Math.max(15, Number(patch?.intervalMinutes ?? settings.automation.intervalMinutes) || 60),
      retentionKeep: Math.max(1, Math.min(30, Number(patch?.retentionKeep ?? settings.automation.retentionKeep) || 5)),
    };
    if (!["local", "cloud", "both"].includes(next.target)) next.target = "local";
    settings.automation = next;
    await writeBackupSettings(settings);
    scheduleAutomation(core, notify);
    return {
      automation: next,
      capabilities: {
        localReady: Boolean(settings.backupDir),
        cloudReady: Boolean(settings.cloud?.url),
      },
    };
  });

  safeHandle("sync:run-now", async () => {
    const result = await runAutomatedSync(core, notify, "manual");
    scheduleAutomation(core, notify);
    return result;
  });
}
