import { realpath, stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

function isInsideCanonicalDir(baseDir, targetPath) {
  const base = resolvePath(baseDir).toLowerCase();
  const target = resolvePath(targetPath).toLowerCase();
  return target === base || target.startsWith(base + "\\");
}

/**
 * Resolve an existing backup through the filesystem before native import.
 * Canonical containment prevents a symlink/junction in the configured vault
 * from redirecting a privileged read outside that vault.
 */
export async function resolveSafeBackupFile(baseDir, targetPath) {
  if (!baseDir || !targetPath || !isInsideCanonicalDir(baseDir, targetPath)) {
    return { ok: false, reason: "outside-backup-folder" };
  }
  try {
    const [baseReal, targetReal] = await Promise.all([
      realpath(baseDir),
      realpath(targetPath),
    ]);
    if (!isInsideCanonicalDir(baseReal, targetReal)) {
      return { ok: false, reason: "outside-backup-folder" };
    }
    const info = await stat(targetReal);
    if (!info.isFile()) return { ok: false, reason: "backup-is-not-file" };
    return { ok: true, path: targetReal };
  } catch {
    return { ok: false, reason: "backup-not-found" };
  }
}
