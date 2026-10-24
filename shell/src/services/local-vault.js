import { readdir, stat, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { dirname, resolve as resolvePath } from "node:path";

import { bundleGroupName } from "./webdav.js";
export { bundleGroupName };

export function stampForFile(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function isInsideDir(baseDir, targetPath) {
  const base = resolvePath(baseDir).toLowerCase();
  const target = resolvePath(targetPath).toLowerCase();
  return target === base || target.startsWith(base + "\\");
}

/**
 * Validate an existing backup path against the configured vault using the
 * filesystem's canonical paths. Lexical containment alone is insufficient:
 * a symlink/junction inside the vault can point outside it. `realpath()` makes
 * the containment check follow the actual filesystem target before the caller
 * hands the path to the native bundle reader.
 */
export async function pathStatus(path) {
  if (!path) return { exists: false, path: null };
  try {
    const info = await stat(path);
    return {
      exists: true,
      path,
      isFile: info.isFile(),
      isDirectory: info.isDirectory(),
      byteSize: info.size,
      modifiedAt: info.mtime.toISOString(),
    };
  } catch (e) {
    return { exists: false, path, error: e?.message ?? String(e) };
  }
}

export async function listBackupFiles(backupDir) {
  if (!backupDir) return [];
  const entries = await readdir(backupDir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".cfprofile") continue;
    const path = join(backupDir, entry.name);
    const info = await stat(path).catch(() => null);
    if (!info) continue;
    files.push({
      name: entry.name,
      path,
      byteSize: info.size,
      modifiedAt: info.mtime.toISOString(),
    });
  }
  return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export async function pruneLocalBackups(backupDir, keep) {
  if (!backupDir || keep <= 0) return { removed: 0 };
  const backups = await listBackupFiles(backupDir);
  const groups = new Map();
  for (const backup of backups) {
    const group = bundleGroupName(backup.name);
    groups.set(group, [...(groups.get(group) ?? []), backup]);
  }
  let removed = 0;
  for (const groupBackups of groups.values()) {
    const stale = groupBackups.slice(keep);
    for (const backup of stale) {
      await rm(backup.path, { force: true });
      removed += 1;
    }
  }
  return { removed };
}
