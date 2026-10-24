import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { safeHandle } from "../security/safe-handle.js";
import { getBrowserHost } from "./browser.js";

// Snapshot files live under the shell's vault, never under the database:
// <userData>/vault/sources/<source-id>.html. The database stores only the
// file NAME (plus its SHA-256), so a database copy never leaks a path.
const SNAPSHOT_NAME = /^[\w-]+\.html$/;
const MAX_SELECTION = 20000;

function vaultSourcesDir() {
  const dir = join(app.getPath("userData"), "vault", "sources");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Write-then-rename: a crash leaves at most a stray dotfile, never a
// half-written snapshot. The file is written BEFORE the database row
// references it, because a row pointing at a missing file is worse than
// an orphaned file (a re-capture of the same source overwrites it).
function writeSnapshot(fileName, html) {
  if (!SNAPSHOT_NAME.test(fileName)) throw new Error("Invalid snapshot file name");
  const dir = vaultSourcesDir();
  const tmp = join(dir, `.${fileName}.tmp-${process.pid}`);
  writeFileSync(tmp, html, "utf8");
  renameSync(tmp, join(dir, fileName));
  return createHash("sha256").update(html, "utf8").digest("hex");
}

// A malformed name is never unlinked: the database row is already gone,
// so such a file is an orphan to investigate, not a file to delete blindly.
function unlinkSnapshot(fileName) {
  if (!SNAPSHOT_NAME.test(fileName)) {
    console.warn(`[research] refusing to unlink malformed snapshot name: ${fileName}`);
    return false;
  }
  const target = join(vaultSourcesDir(), fileName);
  if (!existsSync(target)) return false;
  rmSync(target, { force: true });
  return true;
}

function positiveId(value, field) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
}

function validPageId(value) {
  if (typeof value !== "string" || value.length > 80) throw new Error("Invalid browser page identity");
  return value;
}

export function register(ctx) {
  const host = getBrowserHost(ctx);
  safeHandle("research:list-sources", (_event, payload) => {
    const profileId = positiveId(payload?.profileId, "profileId");
    return ctx.core.listResearchSources(profileId);
  });
  safeHandle("research:list-captures", (_event, payload) => {
    const profileId = positiveId(payload?.profileId, "profileId");
    return ctx.core.listResearchCaptures(profileId);
  });
  safeHandle("research:save-source", (_event, payload) => {
    const profileId = positiveId(payload?.profileId, "profileId");
    const pageId = validPageId(payload?.pageId);
    const owned = host.researchPage(pageId, profileId);
    if (!owned.ok) return owned;
    return ctx.core.saveResearchSource(profileId, owned.page.url, String(owned.page.title || owned.page.url).slice(0, 200));
  });
  safeHandle("research:capture", (_event, payload) => {
    const profileId = positiveId(payload?.profileId, "profileId");
    const pageId = validPageId(payload?.pageId);
    if (typeof payload?.text !== "string" || payload.text.length > 20000 || !payload.text.trim()) throw new Error("Passage must contain 1–20000 characters");
    if (!['clip', 'highlight', 'extraction'].includes(payload?.kind)) throw new Error("Unsupported capture kind");
    const owned = host.researchPage(pageId, profileId);
    if (!owned.ok) return owned;
    return ctx.core.captureResearchPassage(profileId, owned.page.url, String(owned.page.title || owned.page.url).slice(0, 200), owned.page.id, payload.kind, payload.text);
  });
  safeHandle("research:kept-count", (_event, payload) => {
    const profileId = positiveId(payload?.profileId, "profileId");
    const pageId = validPageId(payload?.pageId);
    const owned = host.researchPage(pageId, profileId);
    if (!owned.ok) return owned;
    return { ok: true, count: ctx.core.countKeptResearchPassages(profileId, owned.page.url) };
  });
  // Capture the whole live page: full text into the source row, HTML
  // snapshot into the vault (text-only when the page has no usable HTML
  // or it is over the snapshot cap). The frame (URL, title) is the
  // host's attested record, never renderer-supplied text.
  safeHandle("research:capture-page", (_event, payload) => {
    const profileId = positiveId(payload?.profileId, "profileId");
    const pageId = validPageId(payload?.pageId);
    const owned = host.researchPage(pageId, profileId);
    if (!owned.ok) return owned;
    const ext = host.extractPage(pageId, false);
    if (!ext.ok) return { ok: false, reason: ext.reason };
    const text = ext.extraction.text ?? "";
    if (!text.trim()) throw new Error("This page has no text to capture");
    const source = ctx.core.saveResearchSource(profileId, owned.page.url, String(owned.page.title || owned.page.url).slice(0, 200));
    let fileName = null;
    let sha = null;
    if (ext.extraction.html) {
      fileName = `${source.id}.html`;
      sha = writeSnapshot(fileName, ext.extraction.html);
    }
    const saved = ctx.core.saveResearchSourceContent(profileId, source.id, text, fileName, sha, ext.extraction.textTruncated === true);
    return { ok: true, source: saved, snapshotSaved: fileName !== null, textTruncated: ext.extraction.textTruncated === true };
  });
  // Capture only what the user selected. The extraction passes the
  // selection through untruncated, so this layer enforces the 20,000
  // cap and refuses over-long selections with the limit stated.
  safeHandle("research:capture-selection", (_event, payload) => {
    const profileId = positiveId(payload?.profileId, "profileId");
    const pageId = validPageId(payload?.pageId);
    const owned = host.researchPage(pageId, profileId);
    if (!owned.ok) return owned;
    const ext = host.extractPage(pageId, true);
    if (!ext.ok) return { ok: false, reason: ext.reason };
    const selection = ext.extraction.selection ?? "";
    if (!selection.trim()) throw new Error("Select some text on the page first");
    if (selection.length > MAX_SELECTION) throw new Error(`Selection is too long to keep: ${MAX_SELECTION} characters maximum`);
    return ctx.core.captureResearchPassage(profileId, owned.page.url, String(owned.page.title || owned.page.url).slice(0, 200), owned.page.id, "highlight", selection);
  });
  // Delete a source: the database row goes first, then the snapshot file
  // (if any) is unlinked under the filename-shape guard.
  safeHandle("research:delete-source", (_event, payload) => {
    const profileId = positiveId(payload?.profileId, "profileId");
    const sourceId = positiveId(payload?.sourceId, "sourceId");
    const fileName = ctx.core.deleteResearchSource(profileId, sourceId);
    const snapshotRemoved = fileName ? unlinkSnapshot(fileName) : false;
    return { ok: true, snapshotRemoved };
  });
  safeHandle("research:delete-passage", (_event, payload) => {
    const profileId = positiveId(payload?.profileId, "profileId");
    const captureId = positiveId(payload?.captureId, "captureId");
    ctx.core.deleteResearchPassage(profileId, captureId);
    return { ok: true };
  });
  safeHandle("research:search", (_event, payload) => {
    const profileId = positiveId(payload?.profileId, "profileId");
    const query = typeof payload?.query === "string" ? payload.query : "";
    const limit = Number.isInteger(payload?.limit) && payload.limit > 0 ? payload.limit : null;
    return ctx.core.searchResearch(profileId, query, limit);
  });
}
