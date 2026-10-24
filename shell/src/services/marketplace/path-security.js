import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

const WINDOWS_FORBIDDEN_ID = /[<>:"|?*\u0000-\u001f]/;
const WINDOWS_RESERVED_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * A marketplace installation id is one filesystem name with no platform path
 * syntax. Reject both separator styles regardless of host platform so an
 * identity validated on one platform cannot become a path on another.
 */
export function isValidMarketplaceId(id) {
  if (typeof id !== "string" || !id || id === "." || id === "..") return false;
  if (id.includes("/") || id.includes("\\") || WINDOWS_FORBIDDEN_ID.test(id)) return false;
  if (id.endsWith(".") || id.endsWith(" ") || WINDOWS_RESERVED_ID.test(id)) return false;

  // Win32 normalization is another explicit boundary check; containment below
  // is still required and is never inferred from basename() alone.
  const normalized = win32.normalize(id);
  return normalized === id && !isAbsolute(normalized) && !win32.isAbsolute(normalized);
}

function isStrictChild(root, destination) {
  const rel = relative(root, destination);
  return Boolean(
    rel &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

/** Compatibility helper backed by the same strict-child predicate. */
export function safeUnder(rootDir, destination) {
  if (typeof rootDir !== "string" || !rootDir || typeof destination !== "string" || !destination) {
    return null;
  }
  const root = resolve(rootDir);
  const child = resolve(destination);
  return isStrictChild(root, child) ? child : null;
}

/**
 * Resolve one marketplace installation target and prove it is a strict child
 * of <rootDir>/marketplace. Returns only paths suitable for filesystem I/O.
 */
export function resolveMarketplaceDestination(rootDir, id) {
  if (typeof rootDir !== "string" || !rootDir) {
    return { ok: false, reason: "no-root" };
  }
  if (!isValidMarketplaceId(id)) {
    return { ok: false, reason: "invalid-id" };
  }

  const marketplaceRoot = resolve(rootDir, "marketplace");
  const destination = resolve(marketplaceRoot, id);
  if (!isStrictChild(marketplaceRoot, destination)) {
    return { ok: false, reason: "invalid-id" };
  }
  return { ok: true, marketplaceRoot, destination };
}

/**
 * Reject existing junctions/symlinks and independently verify their real
 * paths before a caller operates on an installation directory.
 */
export function verifyMarketplaceRoot(marketplaceRoot) {
  if (typeof marketplaceRoot !== "string" || !marketplaceRoot) {
    return { ok: false, reason: "invalid-destination" };
  }
  try {
    const rootEntry = lstatSync(marketplaceRoot);
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
      return { ok: false, reason: "invalid-destination" };
    }
  } catch (error) {
    if (error && error.code === "ENOENT") return { ok: true, marketplaceRoot };
    return { ok: false, reason: "invalid-destination" };
  }
  return { ok: true, marketplaceRoot };
}

export function verifyMarketplaceDestination(resolved) {
  if (!resolved || resolved.ok !== true) return { ok: false, reason: "invalid-id" };
  if (!isStrictChild(resolved.marketplaceRoot, resolved.destination)) {
    return { ok: false, reason: "invalid-id" };
  }
  if (!existsSync(resolved.marketplaceRoot)) return { ok: true, ...resolved };

  try {
    const rootEntry = lstatSync(resolved.marketplaceRoot);
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
      return { ok: false, reason: "invalid-destination" };
    }
    const rel = relative(resolved.marketplaceRoot, resolved.destination);
    let current = resolved.marketplaceRoot;
    for (const segment of rel.split(sep)) {
      current = resolve(current, segment);
      if (!existsSync(current)) break;
      const entry = lstatSync(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        return { ok: false, reason: "invalid-destination" };
      }
    }

    if (existsSync(resolved.destination)) {
      const realRoot = realpathSync(resolved.marketplaceRoot);
      const realDestination = realpathSync(resolved.destination);
      if (!isStrictChild(realRoot, realDestination)) {
        return { ok: false, reason: "invalid-destination" };
      }
    }
  } catch (error) {
    if (error && error.code === "ENOENT") return { ok: true, ...resolved };
    return { ok: false, reason: "invalid-destination" };
  }
  return { ok: true, ...resolved };
}

export function resolveMarketplacePath(rootDir, ...segments) {
  if (typeof rootDir !== "string" || !rootDir) return { ok: false, reason: "no-root" };
  if (segments.length === 0 || !segments.every(isValidMarketplaceId)) {
    return { ok: false, reason: "invalid-id" };
  }
  const marketplaceRoot = resolve(rootDir, "marketplace");
  let destination = marketplaceRoot;
  for (const segment of segments) {
    destination = resolve(destination, segment);
    if (!isStrictChild(marketplaceRoot, destination)) return { ok: false, reason: "invalid-id" };
  }
  return { ok: true, marketplaceRoot, destination };
}

/** Delete only a path proven to be a strict marketplace child. */
export function cleanupMarketplacePath(rootDir, ...segments) {
  const resolved = resolveMarketplacePath(rootDir, ...segments);
  if (!resolved.ok) return resolved;
  const verified = verifyMarketplaceDestination(resolved);
  if (!verified.ok) return verified;
  try { rmSync(verified.destination, { recursive: true, force: true }); }
  catch { return { ok: false, reason: "cleanup-failed" }; }
  return { ok: true };
}

export function cleanupMarketplaceDestination(rootDir, id) {
  return cleanupMarketplacePath(rootDir, id);
}
