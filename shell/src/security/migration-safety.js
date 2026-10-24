import { existsSync, statSync, readdirSync } from "node:fs";

export const HARMLESS_OS_METADATA = new Set([
  "desktop.ini",
  "thumbs.db",
  ".ds_store",
]);

/**
 * Checks whether a candidate migration target directory is occupied.
 * A directory is considered occupied if it contains any files or directories
 * other than harmless OS metadata (desktop.ini, thumbs.db, .ds_store).
 *
 * Returns true if the path is occupied or cannot safely be verified as empty (fails closed).
 * Returns false only if the directory is genuinely empty (or does not exist yet).
 */
export function isDestinationOccupied(dirPath) {
  if (!dirPath || typeof dirPath !== "string") return true;
  if (!existsSync(dirPath)) return false;
  try {
    const st = statSync(dirPath);
    if (!st.isDirectory()) return true;
    const entries = readdirSync(dirPath);
    const meaningfulEntries = entries.filter(
      (entry) => !HARMLESS_OS_METADATA.has(entry.toLowerCase())
    );
    return meaningfulEntries.length > 0;
  } catch {
    return true; // Fail closed on I/O or permission errors
  }
}
