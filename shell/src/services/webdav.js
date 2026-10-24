import { join } from "node:path";
import { decryptSecret } from "./secrets.js";

export function normalizeWebDavUrl(raw) {
  const url = new URL(raw);
  if (!url.protocol.startsWith("http")) throw new Error("WebDAV URL must start with http or https.");
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

export function webdavFileUrl(baseUrl, name) {
  return new URL(encodeURIComponent(name), baseUrl).toString();
}

function webdavHeaders(cloud, extra = {}) {
  const password = decryptSecret(cloud.secret);
  const headers = { ...extra };
  if (cloud.username || password) {
    headers.Authorization = `Basic ${Buffer.from(`${cloud.username ?? ""}:${password}`).toString("base64")}`;
  }
  return headers;
}

/** Authenticated WebDAV request primitive. Public: callers PUT/GET/DELETE bundle URLs. */
export async function webdavFetch(cloud, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: webdavHeaders(cloud, options.headers),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`WebDAV ${options.method ?? "GET"} failed (${res.status}): ${body.slice(0, 180)}`);
  }
  return res;
}

export async function ensureWebDavFolder(cloud) {
  const propfindBody = `<?xml version="1.0" encoding="utf-8" ?>
<propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>`;
  const probe = await fetch(cloud.url, {
    method: "PROPFIND",
    headers: webdavHeaders(cloud, { Depth: "0", "Content-Type": "application/xml" }),
    body: propfindBody,
  });
  if (probe.ok) return;
  if (probe.status !== 404) {
    throw new Error(`WebDAV folder check failed (${probe.status}).`);
  }
  const created = await fetch(cloud.url, {
    method: "MKCOL",
    headers: webdavHeaders(cloud),
  });
  if (!created.ok && created.status !== 405) {
    throw new Error(`Could not create WebDAV folder (${created.status}).`);
  }
}

function parseWebDavDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
}

export async function listWebDavBackups(cloud) {
  const body = `<?xml version="1.0" encoding="utf-8" ?>
<propfind xmlns="DAV:"><prop><getcontentlength/><getlastmodified/><resourcetype/></prop></propfind>`;
  const res = await webdavFetch(cloud, cloud.url, {
    method: "PROPFIND",
    headers: { Depth: "1", "Content-Type": "application/xml" },
    body,
  });
  const xml = await res.text();
  const blocks = xml.split(/<\/[^:>]*:?response>/i);
  const files = [];
  for (const block of blocks) {
    const href = block.match(/<[^:>]*:?href[^>]*>([\s\S]*?)<\/[^:>]*:?href>/i)?.[1]?.trim();
    if (!href) continue;
    const name = decodeURIComponent(href.split("/").filter(Boolean).pop() ?? "");
    if (!name.toLowerCase().endsWith(".cfprofile")) continue;
    const byteSize = Number(block.match(/<[^:>]*:?getcontentlength[^>]*>(\d+)<\/[^:>]*:?getcontentlength>/i)?.[1] ?? 0);
    const modifiedRaw = block.match(/<[^:>]*:?getlastmodified[^>]*>([\s\S]*?)<\/[^:>]*:?getlastmodified>/i)?.[1]?.trim();
    files.push({
      name,
      path: webdavFileUrl(cloud.url, name),
      byteSize,
      modifiedAt: parseWebDavDate(modifiedRaw) ?? null,
    });
  }
  return files.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
}

/** Strip the timestamp suffix so all snapshots of one profile group together. */
export function bundleGroupName(name) {
  return name.replace(/-\d{8}T\d{6}Z\.cfprofile$/i, ".cfprofile");
}

export async function pruneWebDavBackups(cloud, keep) {
  if (!cloud?.url || keep <= 0) return { removed: 0 };
  const backups = await listWebDavBackups(cloud);
  const groups = new Map();
  for (const backup of backups) {
    const group = bundleGroupName(backup.name);
    groups.set(group, [...(groups.get(group) ?? []), backup]);
  }
  let removed = 0;
  for (const groupBackups of groups.values()) {
    const stale = groupBackups.slice(keep);
    for (const backup of stale) {
      await webdavFetch(cloud, webdavFileUrl(cloud.url, backup.name), { method: "DELETE" });
      removed += 1;
    }
  }
  return { removed };
}

/** Download a remote bundle to a local temp path; caller cleans up the dir. */
export async function downloadWebDavBundle(cloud, remoteName, targetPath) {
  const res = await webdavFetch(cloud, webdavFileUrl(cloud.url, remoteName));
  const bytes = Buffer.from(await res.arrayBuffer());
  const { writeFile } = await import("node:fs/promises");
  await writeFile(targetPath, bytes);
  return targetPath;
}
