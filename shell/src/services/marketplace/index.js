// Marketplace — discovery + install layer above the Skills / Plugins runtime.
//
// A "marketplace item" is conceptually a Plugin (a folder containing
// `plugin.json` plus optional `skills/<id>/SKILL.md`). The marketplace
// service is the *install + discovery* mechanism; the plugin runtime
// (see shell/src/services/plugins) is what actually runs the skill.
//
// Storage layout:
//   <userData>/marketplace/<id>/                 (installed item folders)
//   <userData>/marketplace-state.json            (sidecar: id, source, version, enabled)
//
// Sources supported in this slice:
//   - local   : a directory on disk (staged, validated, then swapped into the
//               marketplace folder — see installLocal)
//   - git     : a clone performed by ./git-install.js into a contained staging
//               directory, validated, then renamed into place
//
// `validateManifest` is REUSED from the Plugins layer — a marketplace item
// IS a plugin, so we do not duplicate the schema. See
// shell/src/services/plugins/index.js.
//
// All public functions never throw; failures surface as `{ ok: false, reason }`.

import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  renameSync,
} from "node:fs";
import { join, basename, dirname } from "node:path";
import { randomBytes } from "node:crypto";

import {
  cleanupMarketplaceDestination,
  cleanupMarketplacePath,
  resolveMarketplaceDestination,
  resolveMarketplacePath,
  verifyMarketplaceDestination,
  verifyMarketplaceRoot,
} from "./path-security.js";

import { Plugins, validateManifest as pluginsValidateManifest } from "../plugins/index.js";
import { Skills } from "../skills/index.js";
import { Commands } from "../commands/index.js";
import { Hooks } from "../hooks/index.js";
import { MCP } from "../mcp/index.js";
import { installGit as installGitImpl } from "./git-install.js";

// ---- module state ---------------------------------------------------------

// Map<id, { id, name, version, source, enabled, skills, tools, mcpServers }>
const items = new Map();

/**
 * Reserved directory name under `<rootDir>/marketplace/` used for the
 * stage -> validate -> swap lifecycle shared by local and Git installs. It is
 * never an installable item id: `start()` skips it, and it is not registered
 * from disk.
 */
const STAGING_SEGMENT = "staging";

// On-disk locations.
let _rootDir = null;       // <userData>
let _statePath = null;     // <userData>/marketplace-state.json

// ---- state persistence ----------------------------------------------------

function loadState() {
  // The sidecar JSON records `installed items (id, source, version, enabled)`.
  // Missing file → empty registry. Corrupt file → empty registry.
  if (!_statePath || !existsSync(_statePath)) return;
  try {
    const raw = readFileSync(_statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.items)) {
      for (const rec of parsed.items) {
        if (!rec || typeof rec.id !== "string") continue;
        const it = items.get(rec.id);
        if (it && rec && rec.enabled === true) it.enabled = true;
      }
    }
  } catch {
    // Ignore — start with no enabled items.
  }
}

function saveState() {
  if (!_statePath) return;
  try {
    mkdirSync(dirname(_statePath), { recursive: true });
    const arr = [];
    for (const it of items.values()) {
      arr.push({
        id: it.id,
        name: it.name,
        version: it.version,
        source: it.source,
        enabled: it.enabled,
      });
    }
    writeFileSync(_statePath, JSON.stringify({ items: arr }, null, 2), "utf8");
  } catch {
    // Best-effort.
  }
}

export function configureMarketplace({ rootDir, statePath } = {}) {
  _rootDir = rootDir || null;
  _statePath = statePath || (_rootDir ? join(_rootDir, "marketplace-state.json") : null);
}

// ---- validation -----------------------------------------------------------

/**
 * Validate a parsed plugin.json manifest. Thin pass-through to the Plugins
 * validator so the marketplace never drifts from the runtime's schema.
 *
 * Returns `{ ok, manifest }` or `{ ok: false, reason }`.
 */
export function validateManifest(raw) {
  return pluginsValidateManifest(raw);
}

// ---- install --------------------------------------------------------------

/**
 * Install a marketplace item from a local directory. Copies the source
 * folder into a contained staging directory, validates the manifest
 * THERE, and only then swaps the validated tree into
 * `<rootDir>/marketplace/<id>/`. The id defaults to the source folder name.
 *
 * SF-8 (safe reinstall): the previous implementation copied straight into the
 * final destination with `force: true` and validated afterwards. When the
 * replacement manifest was invalid, the rollback cleanup deleted the
 * destination — destroying a previously VALID installation. This
 * stage/validate/swap order mirrors the Git-install model in ./git-install.js:
 * an invalid replacement can never damage the installed item.
 *
 * Returns `{ ok, id }` or `{ ok: false, reason }`.
 */
function installLocal(source) {
  if (typeof source !== "string" || !source) {
    return { ok: false, reason: "invalid-source" };
  }
  if (!_rootDir) return { ok: false, reason: "no-root" };
  if (!existsSync(source)) return { ok: false, reason: "source-not-found" };
  let srcStat;
  try { srcStat = statSync(source); } catch { return { ok: false, reason: "source-not-found" }; }
  if (!srcStat.isDirectory()) return { ok: false, reason: "source-not-directory" };

  const derivedId = basename(source);
  if (!derivedId) return { ok: false, reason: "missing-id" };
  const target = resolveMarketplaceDestination(_rootDir, derivedId);
  if (!target.ok) return target;

  let verified = verifyMarketplaceDestination(target);
  if (!verified.ok) return verified;
  try {
    mkdirSync(target.marketplaceRoot, { recursive: true });
  } catch { return { ok: false, reason: "mkdir-failed" }; }
  verified = verifyMarketplaceDestination(target);
  if (!verified.ok) return verified;

  // ---- stage -------------------------------------------------------------
  // The copy target is a fresh, contained staging directory, so the copy can
  // never partially overwrite an existing installation.
  const stagingRootTarget = resolveMarketplacePath(_rootDir, STAGING_SEGMENT);
  if (!stagingRootTarget.ok) return stagingRootTarget;
  try { mkdirSync(stagingRootTarget.destination, { recursive: true }); }
  catch { return { ok: false, reason: "mkdir-failed" }; }
  const verifiedStagingRoot = verifyMarketplaceDestination(stagingRootTarget);
  if (!verifiedStagingRoot.ok) return verifiedStagingRoot;

  const stagingId = randomBytes(8).toString("hex");
  const stagingTarget = resolveMarketplacePath(_rootDir, STAGING_SEGMENT, stagingId);
  if (!stagingTarget.ok) return stagingTarget;
  const stagingPath = stagingTarget.destination;
  const verifiedStaging = verifyMarketplaceDestination(stagingTarget);
  if (!verifiedStaging.ok) return verifiedStaging;

  const dropStaging = () => { cleanupMarketplacePath(_rootDir, STAGING_SEGMENT, stagingId); };

  try { cpSync(source, stagingPath, { recursive: true, force: true }); }
  catch {
    dropStaging();
    return { ok: false, reason: "copy-failed" };
  }

  // ---- validate the STAGED manifest --------------------------------------
  const manifestPath = join(stagingPath, "plugin.json");
  if (!existsSync(manifestPath)) {
    dropStaging();
    return { ok: false, reason: "invalid-manifest" };
  }
  let raw;
  try { raw = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch {
    dropStaging();
    return { ok: false, reason: "invalid-manifest" };
  }
  const v = validateManifest(raw);
  if (!v.ok) {
    dropStaging();
    return { ok: false, reason: "invalid-manifest" };
  }

  // ---- swap --------------------------------------------------------------
  // Only a fully validated tree reaches this point. Move any previous install
  // aside first, then rename the staged tree into place. Both steps are
  // contained renames within the marketplace root.
  const hadPrevious = existsSync(verified.destination);
  let backupTarget = null;
  if (hadPrevious) {
    const backupId = `${stagingId}-prev`;
    const candidate = resolveMarketplacePath(_rootDir, STAGING_SEGMENT, backupId);
    if (!candidate.ok) {
      dropStaging();
      return candidate;
    }
    const verifiedBackup = verifyMarketplaceDestination(candidate);
    if (!verifiedBackup.ok) {
      dropStaging();
      return verifiedBackup;
    }
    try { renameSync(verified.destination, verifiedBackup.destination); }
    catch {
      // The previous install is still in place, untouched.
      dropStaging();
      return { ok: false, reason: "swap-failed" };
    }
    backupTarget = verifiedBackup;
  }

  try {
    // Re-verify immediately before the swap: a junction could have appeared
    // between the earlier check and now.
    const finalVerified = verifyMarketplaceDestination(target);
    if (!finalVerified.ok) throw new Error(finalVerified.reason);
    renameSync(stagingPath, finalVerified.destination);
  } catch {
    // Put the previous install back before reporting failure.
    if (backupTarget) {
      try { renameSync(backupTarget.destination, verified.destination); } catch { /* best effort */ }
    }
    dropStaging();
    return { ok: false, reason: "swap-failed" };
  }

  // The new tree is live. Discard the backup.
  if (backupTarget) cleanupMarketplacePath(_rootDir, STAGING_SEGMENT, `${stagingId}-prev`);

  items.set(derivedId, {
    id: derivedId,
    name: v.manifest.name,
    version: v.manifest.version,
    source: { kind: "local", path: source },
    enabled: false,
    skills: [...v.manifest.skills],
    tools: [...v.manifest.tools],
    mcpServers: [...v.manifest.mcpServers],
  });
  saveState();
  return { ok: true, id: derivedId };
}

/**
 * Install from a Git URL. Delegates to `./git-install.js`, which clones
 * into a sandboxed staging dir, validates the manifest, and only then
 * moves the tree into `<userData>/marketplace/<id>/`. The plugin
 * runtime is NEVER invoked at install time.
 *
 * On success the item is registered (disabled by default, matching the
 * local-install path) and `Marketplace.enable(id)` flips it on.
 *
 * Returns `{ ok, id, ... }` or `{ ok: false, reason }`.
 */
async function installGit(url, ref = "HEAD", opts = {}) {
  if (typeof url !== "string" || !url) {
    return { ok: false, reason: "invalid-source" };
  }
  if (!_rootDir) return { ok: false, reason: "no-root" };

  // The impl performs its own duplicate + URL validation. After it
  // returns successfully we check the in-memory registry — that is the
  // canonical source of "is this plugin already registered?". Re-using
  // a registered id returns `duplicate` with the existing version, and
  // crucially does NOT clobber the existing install.
  const preview = await installGitImpl({
    url,
    ref,
    userDataDir: _rootDir,
    execFile: opts.execFile,
  });
  if (!preview.ok) return preview;

  if (items.has(preview.id)) {
    // The impl copied the tree to disk but we refuse to register a
    // second item with the same id. Roll back the on-disk copy so we
    // don't leak an orphaned folder.
    const rolledBack = cleanupMarketplaceDestination(_rootDir, preview.id);
    if (!rolledBack.ok) return rolledBack;
    return {
      ok: false,
      reason: "duplicate",
      id: preview.id,
      existingVersion: items.get(preview.id)?.version ?? null,
    };
  }

  items.set(preview.id, {
    id: preview.id,
    name: preview.name,
    version: preview.version,
    source: preview.source,
    enabled: false,
    skills: preview.skills,
    tools: preview.tools,
    mcpServers: preview.mcpServers,
  });
  saveState();

  return {
    ok: true,
    id: preview.id,
    name: preview.name,
    version: preview.version,
    sha: preview.sha,
    ref: preview.ref,
    install_path: preview.install_path,
    manifest: preview.manifest,
  };
}

// ---- discovery ------------------------------------------------------------

/**
 * Returns metadata for every registered marketplace item.
 *
 * Each item carries the same shape as a Plugin manifest (id, name, version,
 * skills, tools, mcpServers, enabled) plus the install `source` so the
 * renderer can distinguish "local" vs "git" installs at a glance.
 */
function list() {
  return [...items.values()].map((it) => ({
    id: it.id,
    name: it.name,
    version: it.version,
    source: it.source,
    enabled: it.enabled,
    skills: [...it.skills],
    tools: [...it.tools],
    mcpServers: [...it.mcpServers],
  }));
}

/**
 * Convenience: items installed from a local source only.
 */
function listLocal() {
  return list().filter((it) => it.source && it.source.kind === "local");
}

/**
 * Returns the full record for an installed item, or null.
 */
function get(id) {
  if (typeof id !== "string" || !id) return null;
  const it = items.get(id);
  if (!it) return null;
  return {
    id: it.id,
    name: it.name,
    version: it.version,
    source: it.source,
    enabled: it.enabled,
    skills: [...it.skills],
    tools: [...it.tools],
    mcpServers: [...it.mcpServers],
  };
}

// ---- lifecycle ------------------------------------------------------------

/**
 * Remove an installed item and its folder. Idempotent on unknown ids.
 */
function remove(id) {
  if (typeof id !== "string" || !id) return { ok: false, reason: "missing-id" };
  if (!_rootDir) return { ok: false, reason: "no-root" };
  const target = resolveMarketplaceDestination(_rootDir, id);
  if (!target.ok) return target;
  if (items.has(id)) {
    const removed = cleanupMarketplaceDestination(_rootDir, id);
    if (!removed.ok) return removed;
  }
  items.delete(id);
  saveState();
  return { ok: true };
}

/**
 * Mark an item enabled. Idempotent.
 */
function enable(id) {
  const it = items.get(id);
  if (!it) return { ok: false, reason: "unknown-item" };
  it.enabled = true;
  saveState();
  return { ok: true };
}

/**
 * Mark an item disabled. Idempotent.
 */
function disable(id) {
  const it = items.get(id);
  if (!it) return { ok: false, reason: "unknown-item" };
  it.enabled = false;
  saveState();
  return { ok: true };
}

/**
 * Re-read the plugin.json manifest for an installed item and refresh the
 * in-memory record. Preserves the existing enabled flag.
 */
function update(id) {
  if (!_rootDir) return { ok: false, reason: "no-root" };
  const target = resolveMarketplaceDestination(_rootDir, id);
  if (!target.ok) return target;
  const verified = verifyMarketplaceDestination(target);
  if (!verified.ok) return verified;
  const dest = verified.destination;
  if (!existsSync(dest)) return { ok: false, reason: "unknown-item" };
  const manifestPath = join(dest, "plugin.json");
  if (!existsSync(manifestPath)) return { ok: false, reason: "invalid-manifest" };
  let raw;
  try { raw = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch { return { ok: false, reason: "invalid-manifest" }; }
  const v = validateManifest(raw);
  if (!v.ok) return { ok: false, reason: v.reason || "invalid-manifest" };
  const prev = items.get(id);
  if (!prev) return { ok: false, reason: "unknown-item" };
  items.set(id, {
    id,
    name: v.manifest.name,
    version: v.manifest.version,
    source: prev.source,
    enabled: !!prev.enabled,
    skills: [...v.manifest.skills],
    tools: [...v.manifest.tools],
    mcpServers: [...v.manifest.mcpServers],
  });
  saveState();
  return { ok: true };
}

// ---- listings (Skills / Commands / Sub-agents / MCP / Hooks / Plugins) ----

/**
 * Filter the global Skill list by the marketplace item's declared skills.
 * The marketplace item IS a plugin, so its `skills` array tells us which
 * registry entries belong to it.
 */
function listSkills(marketplaceId) {
  const it = items.get(marketplaceId);
  if (!it) return { ok: false, reason: "unknown-item" };
  const wanted = new Set(it.skills);
  const all = Skills.list();
  const subset = all.filter((s) => wanted.has(s.id));
  return { ok: true, skills: subset };
}

/**
 * Commands are global — there is no per-item scoping in this slice.
 * For a marketplace item, we return the full command list (commands are
 * user-invokable verbs; the marketplace's role is discovery, not gating).
 */
function listCommands(marketplaceId) {
  if (!items.has(marketplaceId)) return { ok: false, reason: "unknown-item" };
  return { ok: true, commands: Commands.list() };
}

/**
 * Sub-agents come from plugins. There is no dedicated sub-agent registry
 * yet; for now we report the items a marketplace plugin declares as
 * `tools` so the UI has something concrete to show. The shape is stable
 * even if the backing service lands later.
 */
function listSubAgents(marketplaceId) {
  const it = items.get(marketplaceId);
  if (!it) return { ok: false, reason: "unknown-item" };
  return { ok: true, subAgents: it.tools.map((name) => ({ name, source: marketplaceId })) };
}

/**
 * MCP servers a marketplace item contributes. Items declare mcpServers
 * in plugin.json; the runtime registry is the global MCP list.
 */
function listMcp(marketplaceId) {
  const it = items.get(marketplaceId);
  if (!it) return { ok: false, reason: "unknown-item" };
  const wanted = new Set(it.mcpServers);
  const all = MCP.list();
  const subset = all.filter((s) => wanted.has(s.name || s.id));
  return { ok: true, mcp: subset };
}

/**
 * Hooks are global. The marketplace item is the install target, not a
 * scoping boundary — return the full hook list.
 */
function listHooks(marketplaceId) {
  if (!items.has(marketplaceId)) return { ok: false, reason: "unknown-item" };
  return { ok: true, hooks: Hooks.list() };
}

// ---- start / stop ---------------------------------------------------------

/**
 * Load installed marketplace items from `<rootDir>/marketplace/*` and
 * refresh the in-memory registry. Items with bad manifests are skipped,
 * not crashed on, and recorded in `errors`.
 */
function start({ rootDir } = {}) {
  if (rootDir) _rootDir = rootDir;
  items.clear();
  const errors = [];
  const dir = _rootDir ? join(_rootDir, "marketplace") : null;
  if (!dir || !existsSync(dir)) {
    loadState();
    return { ok: true, count: 0, errors };
  }
  const verifiedRoot = verifyMarketplaceRoot(dir);
  if (!verifiedRoot.ok) {
    loadState();
    return { ok: false, count: 0, errors: [{ id: "*", reason: verifiedRoot.reason }] };
  }
  let entries;
  try { entries = readdirSync(dir); }
  catch { loadState(); return { ok: false, count: 0, errors: [{ id: "*", reason: "readdir-failed" }] }; }
  for (const entry of entries) {
    // `staging/` is the reserved stage area for in-flight installs, not an
    // installed item. Registering it would surface a spurious
    // "invalid-manifest" error on every boot and would let a dropped tree
    // under staging/ masquerade as an installed plugin.
    if (entry === STAGING_SEGMENT) continue;
    const target = resolveMarketplaceDestination(_rootDir, entry);
    if (!target.ok) {
      errors.push({ id: entry, reason: target.reason });
      continue;
    }
    const verified = verifyMarketplaceDestination(target);
    if (!verified.ok) {
      errors.push({ id: entry, reason: verified.reason });
      continue;
    }
    const full = verified.destination;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (!st.isDirectory()) continue;
    const manifestPath = join(full, "plugin.json");
    if (!existsSync(manifestPath)) { errors.push({ id: entry, reason: "invalid-manifest" }); continue; }
    let raw;
    try { raw = JSON.parse(readFileSync(manifestPath, "utf8")); }
    catch { errors.push({ id: entry, reason: "invalid-manifest" }); continue; }
    const v = validateManifest(raw);
    if (!v.ok) { errors.push({ id: entry, reason: v.reason }); continue; }
    items.set(entry, {
      id: entry,
      name: v.manifest.name,
      version: v.manifest.version,
      source: { kind: "local", path: full },
      enabled: false,
      skills: [...v.manifest.skills],
      tools: [...v.manifest.tools],
      mcpServers: [...v.manifest.mcpServers],
    });
  }
  loadState();
  return { ok: true, count: items.size, errors };
}

/**
 * Stop is a no-op in this slice — the registry lives in-memory and the
 * sidecar JSON is written on every mutation. Provided for symmetry with
 * future persistence needs (e.g. a daemon-style marketplace index).
 */
function stop() {
  saveState();
  return { ok: true };
}

// ---- exports --------------------------------------------------------------

export const Marketplace = {
  // install sources
  installLocal,
  installGit,
  // discovery
  list,
  listLocal,
  get,
  // lifecycle
  remove,
  enable,
  disable,
  update,
  // per-item listings
  listSkills,
  listCommands,
  listSubAgents,
  listMcp,
  listHooks,
  // lifecycle hooks
  start,
  stop,
  // config + validation
  configureMarketplace,
  validateManifest,
  _resetForTests() {
    items.clear();
    _rootDir = null;
    _statePath = null;
  },
};

// `Plugins` is imported above so we re-export it as a convenience for
// callers that want the underlying runtime alongside the marketplace
// (the marketplace service is a thin layer over the plugin runtime).
export { Plugins, resolveMarketplaceDestination };