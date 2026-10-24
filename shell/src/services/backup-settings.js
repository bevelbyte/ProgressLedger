import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolveBackupSettingsPath } from "../workspace.js";

export const BACKUP_SETTINGS_FILE = "backup-settings.json";

export const DEFAULT_AUTOMATION = {
  enabled: false,
  intervalMinutes: 60,
  target: "local",
  retentionKeep: 5,
  lastRunAt: null,
  lastResult: null,
};

export async function readBackupSettings() {
  try {
    const raw = await readFile(resolveBackupSettingsPath(), "utf8");
    const parsed = JSON.parse(raw);
    return {
      backupDir: typeof parsed.backupDir === "string" ? parsed.backupDir : null,
      lastBackups: parsed.lastBackups && typeof parsed.lastBackups === "object" ? parsed.lastBackups : {},
      cloud: parsed.cloud && typeof parsed.cloud === "object" ? parsed.cloud : null,
      automation: { ...DEFAULT_AUTOMATION, ...(parsed.automation ?? {}) },
    };
  } catch {
    return { backupDir: null, lastBackups: {}, cloud: null, automation: { ...DEFAULT_AUTOMATION } };
  }
}

export async function writeBackupSettings(settings) {
  const path = resolveBackupSettingsPath();
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(settings, null, 2), "utf8");
}
