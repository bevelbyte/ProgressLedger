// Read-only size accounting for a browser partition directory.
//
// Symlinks are never followed, so a link loop cannot hang the walk.
// Caps keep a huge profile (multi-GB caches) from blocking the UI:
// the walk stops at maxFiles or maxMs and reports complete: false,
// so the caller can say "at least X" instead of hanging.
import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";

export async function measureDirectory(root, { maxFiles = 200_000, maxMs = 60_000 } = {}) {
  const started = Date.now();
  let bytes = 0;
  let files = 0;
  let complete = true;
  const stack = [root];
  while (stack.length > 0) {
    if (files >= maxFiles || Date.now() - started > maxMs) {
      complete = false;
      break;
    }
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        stack.push(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const st = await lstat(join(dir, entry.name));
        if (st.isFile()) {
          bytes += st.size;
          files += 1;
        }
      } catch {
        // Unreadable file: skip it and keep walking.
      }
      if (files >= maxFiles || Date.now() - started > maxMs) {
        complete = false;
        break;
      }
    }
    if (!complete) break;
  }
  return { bytes, files, complete };
}
