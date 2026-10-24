// Plugins — folders on disk that contribute Skills, tools, and MCP servers.
//
// A Plugin is a directory at <userData>/plugins/<id>/ with a `plugin.json`
// manifest. The manifest declares the plugin's name, version, and the
// ids of the Skills it ships. Tools and MCP servers are referenced by name
// only; their definitions live elsewhere (see shell-side registry).
//
// Lifecycle: DISCOVER → INSTALL → VALIDATE → ENABLE → USE → DISABLE → UPDATE → REMOVE.
//
// Plugins are an EXTENSION POINT. The core agent never imports a concrete
// plugin; it queries `Plugins.list()` and consults the Skills it
// contributes. Adding a new plugin is a matter of dropping a folder on
// disk — no agent changes required.
//
// All public functions never throw; failures surface as
// `{ ok: false, reason }`.

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync, rmSync, cpSync, watch as fsWatch } from "node:fs";
import { join, basename, dirname } from "node:path";
import { EventEmitter } from "node:events";
import { assertInsideProjectRoot } from "../project-tools/security.js";

// ---- module state ---------------------------------------------------------

// Map<id, { id, name, version, skills: string[], tools: string[], mcpServers: string[], enabled: boolean }>
const plugins = new Map();

// On-disk locations.
let _rootDir = null;       // <userData>
let _statePath = null;     // <userData>/plugins-state.json

// Hot-reload event bus. Consumers subscribe via
// `Plugins.on('changed', ({ id, plugin }) => …)` and `Plugins.on('reloaded', ...)`.
// The bus is process-local; the IPC layer forwards events to the renderer.
const pluginBus = new EventEmitter();

// ---- auto-reload config ---------------------------------------------------

// Default off — opt-in via `Plugins.configureAutoReload({ enabled: true })`.
// When enabled, an `fs.watch` is opened on the per-plugin install dir
// after `reload()`; the watcher is torn down on `uninstall()`.
let _autoReloadEnabled = false;
// Map<id, FSWatcher> — open watchers, keyed by plugin id.
const _watchers = new Map();

// ---- manifest validation --------------------------------------------------

// Whitelist of top-level fields permitted in a plugin.json manifest.
  // STRICT: any field not in this set is rejected. This prevents a malicious
// manifest from smuggling extra metadata (e.g. `permissions`, `__proto__`)
// that could be misinterpreted by the runtime or future code.
//
// `id` is allowed as an OPTIONAL manifest-declared identifier. It is validated
// for path-traversal safety but the canonical on-disk id is always the folder
// name — the manifest id must match it or be ignored (see install()).
const ALLOWED_MANIFEST_FIELDS = new Set([
  "name", "version", "id", "skills", "tools", "mcpServers", "entry",
]);

// Safe plugin-id pattern: alphanumeric + dot, underscore, hyphen only.
// Rejects path separators (/  \\) and traversal sequences (..).
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Returns true iff `id` is a safe plugin identifier — non-empty, matches
 * SAFE_ID_RE, and is neither "." nor ".." (which match the regex but are
 * path-traversal vectors).
 */
export function isValidPluginId(id) {
  if (typeof id !== "string" || !id) return false;
  if (id === "." || id === "..") return false;
  return SAFE_ID_RE.test(id);
}

/**
 * Validates a plugin `entry` field — a relative path to the plugin's main
 * code file (e.g. "index.js", "src/main.js"). Returns true iff the entry is
 * a safe relative path: no `..` traversal, no absolute paths, no backslashes.
 *
 * This is the manifest-level gate; Plugins.load() applies a second, deeper
 * check with assertInsideProjectRoot() at resolution time.
 */
function isValidEntryPath(entry) {
  if (typeof entry !== "string" || !entry) return false;
  if (entry.includes("..")) return false;            // path traversal
  if (entry.startsWith("/")) return false;           // absolute (POSIX)
  if (entry.startsWith("\\")) return false;           // absolute (Windows)
  if (entry.includes("\\")) return false;           // no backslashes in manifest paths
  if (/^[A-Za-z]:[\\/]/.test(entry)) return false;   // Windows drive letter
  // Allow only a conservative subset of characters: letters, digits, dot,
  // underscore, hyphen, slash (for sub-paths like 'src/main.js'). Block
  // shell metacharacters and control characters are rejected.
  if (!/^[A-Za-z0-9._\-\/]+$/.test(entry)) return false;
  return true;
}

/**
 * Validates a parsed plugin.json manifest. Returns `{ ok, manifest }` or
 * `{ ok: false, reason }`.
 *
 * Trust boundary:
 *   - Strict field whitelist — unknown fields are rejected (no smuggling).
 *   - If an `id` field is present it must pass isValidPluginId (no path
 *     traversal, no separators).
 *   - If an `entry` field is present it must be a safe relative path (no
 *     `..`, no absolute path, no backslashes). The deeper assertInsideProjectRoot
 *     check happens in Plugins.load().
 *   - `name` and `version` must be non-empty strings.
 *
 * We only check shape; semantic checks (e.g. "every declared skill exists in
 * the registry") belong to the runtime.
 */
export function validateManifest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "invalid-manifest" };
  }
  // Strict: reject any field not in the whitelist. This catches smuggled
  // `permissions`, `__proto__`, or any future field the runtime has not
  // explicitly opted into. (`entry` IS whitelisted but its VALUE is
  // validated below for path-traversal safety.)
  //
  // Use Reflect.ownKeys() instead of Object.keys() because __proto__ and
  // constructor are NOT own enumerable properties — Object.keys() returns []
  // for them, bypassing the whitelist and allowing prototype-pollution
  // payloads to slip through.
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== "string") continue; // Symbol keys are not manifest fields
    if (!ALLOWED_MANIFEST_FIELDS.has(key)) {
      return { ok: false, reason: "invalid-manifest" };
    }
  }
  if (typeof raw.name !== "string" || !raw.name) {
    return { ok: false, reason: "invalid-manifest" };
  }
  if (typeof raw.version !== "string" || !raw.version) {
    return { ok: false, reason: "invalid-manifest" };
  }
  // Optional `id`: if the manifest declares one, it must be a safe identifier.
  if (raw.id !== undefined) {
    if (!isValidPluginId(raw.id)) {
      return { ok: false, reason: "invalid-manifest" };
    }
  }
  // Optional `entry`: a relative path to the plugin's main code file.
  // Rejected at this layer if it contains `..`, an absolute path, or
  // backslashes. Plugins.load() re-checks with assertInsideProjectRoot().
  let entry = null;
  if (raw.entry !== undefined) {
    if (!isValidEntryPath(raw.entry)) {
      return { ok: false, reason: "invalid-manifest" };
    }
    entry = raw.entry;
  }
  const skills = Array.isArray(raw.skills) ? raw.skills.filter((s) => typeof s === "string") : [];
  const tools = Array.isArray(raw.tools) ? raw.tools.filter((s) => typeof s === "string") : [];
  const mcpServers = Array.isArray(raw.mcpServers) ? raw.mcpServers.filter((s) => typeof s === "string") : [];
  return {
    ok: true,
    manifest: { name: raw.name, version: raw.version, id: raw.id, skills, tools, mcpServers, entry },
  };
}

// ---- state persistence ----------------------------------------------------

function loadState() {
  // The state file records the set of enabled plugin ids. Missing file
  // means "nothing enabled"; corrupt file means "nothing enabled".
  if (!_statePath || !existsSync(_statePath)) return;
  try {
    const raw = readFileSync(_statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      for (const [id, rec] of Object.entries(parsed)) {
        const p = plugins.get(id);
        if (p && rec && rec.enabled === true) p.enabled = true;
      }
    }
  } catch {
    // Ignore — start with no enabled plugins.
  }
}

function saveState() {
  if (!_statePath) return;
  try {
    mkdirSync(dirname(_statePath), { recursive: true });
    const obj = {};
    for (const [id, p] of plugins) obj[id] = { enabled: p.enabled };
    writeFileSync(_statePath, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    // Best-effort.
  }
}

export function configurePlugins({ rootDir, statePath } = {}) {
  _rootDir = rootDir || null;
  _statePath = statePath || (_rootDir ? join(_rootDir, "plugins-state.json") : null);
}

// ---- public API -----------------------------------------------------------

/**
 * Install a plugin from a local path. Copies the source directory into
 * `<rootDir>/plugins/<id>/`. The plugin id is derived from the folder
 * name. Returns `{ ok, id }` or `{ ok: false, reason }`.
 *
 * `source` must be a filesystem path string. Git-source marketplace
 * installs are handled by the Marketplace service (see
 * shell/src/services/marketplace/git-install.js), which clones into
 * `<rootDir>/marketplace/<id>/` and is loaded via `Marketplace.start()`,
 * not `Plugins.loadFromDisk()`.
 */
function install({ id, source }) {
  if (typeof source !== "string" || !source) {
    return { ok: false, reason: "invalid-source" };
  }
  if (!existsSync(source)) return { ok: false, reason: "source-not-found" };
  let srcStat;
  try { srcStat = statSync(source); } catch { return { ok: false, reason: "source-not-found" }; }
  if (!srcStat.isDirectory()) return { ok: false, reason: "source-not-directory" };
  const derivedId = id || basename(source);
  if (!derivedId) return { ok: false, reason: "missing-id" };
  if (!_rootDir) return { ok: false, reason: "no-root" };

  // Trust boundary: validate the derived id with a strict whitelist.
  // The id becomes a path component under <rootDir>/plugins/<id>.
  // Reject path-traversal payloads (e.g. "../../escape") and nested
  // directory names (e.g. "plugin/sub") that could clobber or escape.
  if (!isValidPluginId(derivedId)) {
    return { ok: false, reason: "invalid-id" };
  }

  const dest = join(_rootDir, "plugins", derivedId);
  // Duplicate check: refuse to silently overwrite an existing install.
  // This prevents a malicious or buggy source from clobbering a trusted
  // plugin in place.
  if (existsSync(dest)) {
    return { ok: false, reason: "duplicate" };
  }
  try { mkdirSync(_rootDir, { recursive: true }); mkdirSync(join(_rootDir, "plugins"), { recursive: true }); }
  catch { return { ok: false, reason: "mkdir-failed" }; }
  try { cpSync(source, dest, { recursive: true, force: true }); }
  catch { return { ok: false, reason: "copy-failed" }; }

  const manifestPath = join(dest, "plugin.json");
  if (!existsSync(manifestPath)) {
    // Roll back the copy so we don't leave a half-installed plugin behind.
    try { rmSync(dest, { recursive: true, force: true }); } catch {}
    return { ok: false, reason: "invalid-manifest" };
  }
  let raw;
  try { raw = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch { try { rmSync(dest, { recursive: true, force: true }); } catch {} return { ok: false, reason: "invalid-manifest" }; }
  const v = validateManifest(raw);
  if (!v.ok) {
    try { rmSync(dest, { recursive: true, force: true }); } catch {}
    return { ok: false, reason: "invalid-manifest" };
  }
  plugins.set(derivedId, {
    id: derivedId,
    name: v.manifest.name,
    version: v.manifest.version,
    skills: v.manifest.skills,
    tools: v.manifest.tools,
    mcpServers: v.manifest.mcpServers,
    entry: v.manifest.entry,
    enabled: false,
  });
  saveState();
  if (_autoReloadEnabled) startWatcher(derivedId);
  return { ok: true, id: derivedId };
}

/**
 * Remove an installed plugin and its folder.
 */
function uninstall(id) {
  if (typeof id !== "string" || !id) return { ok: false, reason: "missing-id" };
  if (!isValidPluginId(id)) return { ok: false, reason: "invalid-id" };
  if (!_rootDir) return { ok: false, reason: "no-root" };
  stopWatcher(id);
  if (plugins.has(id)) {
    const dest = join(_rootDir, "plugins", id);
    try { rmSync(dest, { recursive: true, force: true }); } catch {}
  }
  plugins.delete(id);
  saveState();
  return { ok: true };
}

/**
 * Mark a plugin enabled. Disabled by default after install. Idempotent.
 */
function enable(id) {
  const p = plugins.get(id);
  if (!p) return { ok: false, reason: "unknown-plugin" };
  p.enabled = true;
  saveState();
  return { ok: true };
}

/**
 * Mark a plugin disabled. Idempotent.
 */
function disable(id) {
  const p = plugins.get(id);
  if (!p) return { ok: false, reason: "unknown-plugin" };
  p.enabled = false;
  saveState();
  return { ok: true };
}

/**
 * Re-read the plugin.json manifest for an installed plugin and refresh the
 * in-memory record. Used by `update`.
 */
function update(id) {
  if (typeof id !== "string" || !isValidPluginId(id)) return { ok: false, reason: "invalid-id" };
  if (!_rootDir) return { ok: false, reason: "no-root" };
  const dest = join(_rootDir, "plugins", id);
  if (!existsSync(dest)) return { ok: false, reason: "unknown-plugin" };
  const manifestPath = join(dest, "plugin.json");
  if (!existsSync(manifestPath)) return { ok: false, reason: "invalid-manifest" };
  let raw;
  try { raw = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch { return { ok: false, reason: "invalid-manifest" }; }
  const v = validateManifest(raw);
  if (!v.ok) return { ok: false, reason: v.reason || "invalid-manifest" };
  const prev = plugins.get(id);
  plugins.set(id, {
    id,
    name: v.manifest.name,
    version: v.manifest.version,
    skills: v.manifest.skills,
    tools: v.manifest.tools,
    mcpServers: v.manifest.mcpServers,
    entry: v.manifest.entry,
    enabled: !!(prev && prev.enabled),
  });
  saveState();
  return { ok: true };
}

// ---- hot-reload -----------------------------------------------------------

/**
 * Read the manifest from disk and return the validated record, or
 * `{ ok: false, reason }`. Shared between `update` and `reload`.
 */
function readManifest(id) {
  if (typeof id !== "string" || !isValidPluginId(id)) return { ok: false, reason: "invalid-id" };
  if (!_rootDir) return { ok: false, reason: "no-root" };
  const dest = join(_rootDir, "plugins", id);
  if (!existsSync(dest)) return { ok: false, reason: "unknown-plugin" };
  const manifestPath = join(dest, "plugin.json");
  if (!existsSync(manifestPath)) return { ok: false, reason: "invalid-manifest" };
  let raw;
  try { raw = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch { return { ok: false, reason: "invalid-manifest" }; }
  const v = validateManifest(raw);
  if (!v.ok) return { ok: false, reason: v.reason || "invalid-manifest" };
  return { ok: true, manifest: v.manifest };
}

/**
 * Open an `fs.watch` on the per-plugin install dir and emit `changed` on the
 * bus whenever a file is added, changed, or removed. Coalesces bursts via a
 * 100 ms trailing debounce per plugin id.
 */
function startWatcher(id) {
  if (!_rootDir || !_autoReloadEnabled) return;
  if (_watchers.has(id)) return;
  const dir = join(_rootDir, "plugins", id);
  if (!existsSync(dir)) return;
  let timer = null;
  // Coalesce: a single dirty event across the watcher tree is enough.
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      // Auto-reload is a semantic reload, not merely a notification. Re-read
      // and validate the manifest through the same guarded path as an explicit
      // Plugins.reload() call. A failed reload keeps the previous record alive
      // but still emits `changed` so consumers can surface the invalid state.
      const result = reload(id);
      if (!result.ok) {
        pluginBus.emit("changed", {
          id,
          plugin: plugins.get(id) || null,
          reloadFailed: result.reason || "reload-failed",
        });
      } else {
        pluginBus.emit("changed", { id, plugin: result.plugin });
      }
    }, 100);
  };
  // Try recursive first (macOS/Windows always; Linux needs inotify).
  // Track every watcher we open so stopWatcher can close all of them.
  const watchers = [];
  let opened = false;
  try {
    const w = fsWatch(dir, { recursive: true }, fire);
    w.on("error", () => {
      // Swallow — see below.
    });
    watchers.push(w);
    opened = true;
  } catch {
    // Fall through to manual recursive watch.
  }
  if (!opened) {
    // Linux fallback: open a non-recursive watcher on every subdirectory.
    // New subdirectories created after startWatcher won't be tracked;
    // that mirrors the historical non-recursive behaviour and is fine
    // for the plugin-on-disk use case.
    const walk = (d) => {
      try {
        const w = fsWatch(d, { recursive: false }, fire);
        w.on("error", () => {});
        watchers.push(w);
      } catch {
        return;
      }
      let entries;
      try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (ent.isDirectory()) walk(join(d, ent.name));
      }
    };
    walk(dir);
    if (watchers.length === 0) return;
  }
  // Expose a small handle that closes every underlying watcher.
  const handle = {
    close() {
      for (const w of watchers) {
        try { w.close(); } catch {}
      }
    },
  };
  _watchers.set(id, handle);
}

/**
 * Close and discard the watcher for a plugin id (if any).
 */
function stopAllWatchers() {
  for (const id of [..._watchers.keys()]) stopWatcher(id);
  return { ok: true };
}

function stopWatcher(id) {
  const w = _watchers.get(id);
  if (!w) return;
  try { w.close(); } catch {}
  _watchers.delete(id);
}

/**
 * Tear down the in-memory registration of a plugin so a subsequent reload
 * can re-establish it. In this slice the only registration is the entry in
 * `plugins`; future tool/hook/MCP wiring would be torn down here. The bus
 * event is fired AFTER the new record is in place so listeners see a
 * coherent post-reload view.
 */
function reload(id) {
  if (typeof id !== "string" || !id) return { ok: false, reason: "missing-id" };
  if (!isValidPluginId(id)) return { ok: false, reason: "invalid-id" };
  const prev = plugins.get(id);
  if (!prev) return { ok: false, reason: "unknown-plugin" };
  // Stop any active watcher while we're swapping the record.
  const wasWatched = _watchers.has(id);
  stopWatcher(id);
  const r = readManifest(id);
  if (!r.ok) {
    // Leave the old record untouched and re-arm the watcher.
    if (wasWatched) startWatcher(id);
    return { ok: false, reason: r.reason };
  }
  plugins.set(id, {
    id,
    name: r.manifest.name,
    version: r.manifest.version,
    skills: [...r.manifest.skills],
    tools: [...r.manifest.tools],
    mcpServers: [...r.manifest.mcpServers],
    entry: r.manifest.entry,
    enabled: prev.enabled,
  });
  saveState();
  if (_autoReloadEnabled) startWatcher(id);
  const fresh = plugins.get(id);
  pluginBus.emit("reloaded", { id, plugin: fresh });
  return { ok: true, plugin: fresh };
}

/**
 * Toggle the auto-reload watcher. When enabled, every currently-installed
 * plugin gets a watcher; when disabled, all watchers are torn down.
 */
function configureAutoReload({ enabled } = {}) {
  _autoReloadEnabled = !!enabled;
  if (_autoReloadEnabled) {
    for (const id of plugins.keys()) startWatcher(id);
  } else {
    for (const id of [..._watchers.keys()]) stopWatcher(id);
  }
  return { ok: true, enabled: _autoReloadEnabled };
}

/**
 * Returns metadata for every installed plugin.
 */
function list() {
  return [...plugins.values()].map((p) => ({
    id: p.id,
    name: p.name,
    version: p.version,
    skills: [...p.skills],
    tools: [...p.tools],
    mcpServers: [...p.mcpServers],
    entry: p.entry,
    enabled: p.enabled,
  }));
}

/**
 * Scan <rootDir>/plugins/* at startup, validate each manifest, and
 * populate the in-memory registry. Plugins with malformed plugin.json are
 * skipped (not crashed) and recorded in `errors`.
 */
function loadFromDisk({ rootDir } = {}) {
  if (rootDir) _rootDir = rootDir;
  plugins.clear();
  const errors = [];
  const dir = _rootDir ? join(_rootDir, "plugins") : null;
  if (!dir || !existsSync(dir)) {
    loadState();
    return { ok: true, count: 0, errors };
  }
  let entries;
  try { entries = readdirSync(dir); } catch {
    loadState();
    return { ok: false, count: 0, errors: [{ id: "*", reason: "readdir-failed" }] };
  }
  for (const entry of entries) {
    // readdir() yields untrusted directory names. Validate the plugin id
    // before using it as a filesystem path component.
    if (!isValidPluginId(entry)) {
      errors.push({ id: entry, reason: "invalid-id" });
      continue;
    }
    const full = join(dir, entry);
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
    plugins.set(entry, {
      id: entry,
      name: v.manifest.name,
      version: v.manifest.version,
      skills: v.manifest.skills,
      tools: v.manifest.tools,
      mcpServers: v.manifest.mcpServers,
      entry: v.manifest.entry,
      enabled: false,
    });
  }
  loadState();
  return { ok: true, count: plugins.size, errors };
}

// ---- plugin code access (GATE 12) -----------------------------------------

/**
 * Resolve a plugin's entry-point path. The entry is the relative file the
 * plugin declared in its manifest (e.g. "index.js"). The path is resolved
 * against `<rootDir>/plugins/<id>/` and verified to stay inside that directory
 * via `assertInsideProjectRoot` — a read-only path gate, NOT code execution.
 *
 * Returns:
 *   - `{ ok: true,  path: <absPath> }` — the resolved, safe entry path.
 *   - `{ ok: true,  path: null }`      — plugin has no `entry` field (graceful).
 *   - `{ ok: false, reason }`          — unknown plugin, no root, or traversal.
 *
 * The caller (the agent) reads the file content via fs_read — the runtime
 * NEVER eval/require/vm.runInNewContext the entry. This is the "plugin code is
 * accessible" boundary without introducing arbitrary code execution.
 */
function load(id) {
  if (typeof id !== "string" || !id) return { ok: false, reason: "missing-id" };
  if (!isValidPluginId(id)) return { ok: false, reason: "invalid-id" };
  const p = plugins.get(id);
  if (!p) return { ok: false, reason: "unknown-plugin" };
  // Graceful: a plugin without an `entry` field simply has no code to load.
  if (!p.entry) return { ok: true, path: null };
  if (!_rootDir) return { ok: false, reason: "no-root" };

  const pluginDir = join(_rootDir, "plugins", id);
  // Defense-in-depth: even though validateManifest() already rejected `..`
  // and absolute paths at install time, we re-check at resolution time.
  // If the manifest was tampered on disk and reloaded, the in-memory entry
  // is whatever was last validated — but this gate catches anything that
  // resolves outside the plugin directory.
  const gate = assertInsideProjectRoot(p.entry, pluginDir);
  if (!gate.ok) return { ok: false, reason: "path-outside-plugin" };
  return { ok: true, path: gate.path };
}

// ---- exports --------------------------------------------------------------

export const Plugins = {
  install,
  uninstall,
  enable,
  disable,
  update,
  reload,
  load,
  list,
  loadFromDisk,
  configurePlugins,
  configureAutoReload,
  validateManifest,
  isValidPluginId,
  // Hot-reload event bus. Listeners receive `{ id, plugin }`.
  on(event, listener) { return pluginBus.on(event, listener); },
  off(event, listener) { return pluginBus.off(event, listener); },
  _bus: pluginBus,
  _resetForTests() {
    for (const id of [..._watchers.keys()]) stopWatcher(id);
    plugins.clear();
    _rootDir = null;
    _statePath = null;
    _autoReloadEnabled = false;
  },
};
