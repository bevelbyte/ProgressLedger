// Skills â€” typed bundles of system-prompt fragments + tools.
//
// A Skill is a content bundle the agent can opt into. Skills live on disk
// under <userData>/skills/<id>/SKILL.md and are loaded once at startup.
// Enable/disable state is stored separately at <userData>/skills-state.json
// as a JSON map keyed by (profileId, projectId, skillId).
//
// Skills are an EXTENSION POINT. The core agent never imports a concrete
// skill; it calls `Skills.buildSystemPrompt(profileId, projectId)` to gather
// the active fragments for a given context. Adding a new skill is a matter
// of dropping a SKILL.md on disk â€” no agent changes required.
//
// All public functions are pure w.r.t. their inputs and never throw. Disk
// I/O failures surface as `{ ok: false, error }` or empty results so the
// agent loop cannot crash on a malformed SKILL.md.

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";

// ---- module state ---------------------------------------------------------

// In-memory registry of every skill we have discovered on disk.
const registry = new Map();   // id -> skill

// Enable state per (profileId, projectId, skillId) -> true.
const enabled = new Map();    // key -> true

// Per-instance storage helpers; injected so tests can use a tmp dir.
let _rootDir = null;          // <userData> equivalent (where skills/ lives)
let _statePath = null;        // <userData>/skills-state.json

// ---- key helpers ----------------------------------------------------------

function key(profileId, projectId, skillId) {
  // Scope is implicit in the (profileId, projectId) tuple: a global skill
  // is recorded under projectId = '*'. This keeps the storage shape flat.
  return `${profileId}::${projectId}::${skillId}`;
}

function safeSkillPath(rootDir, candidate) {
  try {
    const root = realpathSync(rootDir);
    const abs = realpathSync(candidate);
    const rootNorm = root.replace(/[\\/]+$/, "").toLowerCase();
    const absNorm = abs.toLowerCase();
    return absNorm === rootNorm || absNorm.startsWith(`${rootNorm}\\`) || absNorm.startsWith(`${rootNorm}/`) ? abs : null;
  } catch {
    return null;
  }
}
function nowMs() {
  return Date.now();
}

// ---- frontmatter parser ---------------------------------------------------

/**
 * Tiny frontmatter parser. A SKILL.md starts with one or more lines of the
 * form `---key: value---`. Anything after the first non-frontmatter line is
 * the body. Returns `{ frontmatter, body }`.
 *
 * Recognized frontmatter keys: id, name, description, tools (csv),
 * scope ('project' | 'global'), project_id (number, optional).
 */
export function parseSkillFrontmatter(text) {
  if (typeof text !== "string") return { frontmatter: {}, body: "" };
  const lines = text.split(/\r?\n/);
  const fm = {};
  let i = 0;
  // Skip leading blank lines so a SKILL.md can start with a newline.
  while (i < lines.length && lines[i].trim() === "") i++;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("---")) break;
    const trimmed = line.slice(3).replace(/---$/, "");
    const idx = trimmed.indexOf(":");
    if (idx < 0) continue;
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + 1).trim();
    if (k) fm[k] = v;
  }
  const body = lines.slice(i).join("\n").trim();
  return { frontmatter: fm, body };
}

// ---- storage --------------------------------------------------------------

function loadState() {
  enabled.clear();
  if (!_statePath || !existsSync(_statePath)) return;
  try {
    const raw = readFileSync(_statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed)) {
        if (v === true) enabled.set(k, true);
      }
    }
  } catch {
    // Corrupt state file: start with no enabled skills. Do NOT throw â€”
    // the agent loop must keep working.
  }
}

function saveState() {
  if (!_statePath) return;
  try {
    mkdirSync(dirname(_statePath), { recursive: true });
    const obj = {};
    for (const [k, v] of enabled) if (v) obj[k] = true;
    writeFileSync(_statePath, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    // Persistence is best-effort.
  }
}

/**
 * Configure the on-disk locations for this instance. `rootDir` is the
 * `<userData>` equivalent and contains the `skills/` subfolder. The state
 * file path defaults to `<rootDir>/skills-state.json`.
 */
export function configureSkills({ rootDir, statePath } = {}) {
  _rootDir = rootDir || null;
  _statePath = statePath || (_rootDir ? join(_rootDir, "skills-state.json") : null);
  loadState();
}

// ---- public API -----------------------------------------------------------

/**
 * Add a skill to the in-memory registry. Called by `loadFromDisk` and by
 * tests. Does not touch disk.
 */
function register(skill) {
  if (!skill || typeof skill.id !== "string" || !skill.id) return;
  if (typeof skill.name !== "string") skill.name = skill.id;
  if (typeof skill.description !== "string") skill.description = "";
  if (typeof skill.systemPrompt !== "string") skill.systemPrompt = "";
  if (!Array.isArray(skill.tools)) skill.tools = [];
  if (skill.scope !== "project" && skill.scope !== "global") skill.scope = "global";
  if (skill.scope === "project" && typeof skill.project_id !== "number") {
    // Project-scoped skills must have a project_id; otherwise treat as global.
    skill.scope = "global";
  }
  skill.enabled = false;
  registry.set(skill.id, skill);
}

/**
 * Mark a skill enabled for a given (profile, project) context. If the skill
 * is project-scoped, the projectId must match its `project_id`.
 *
 * Returns `{ ok, error? }`. Never throws.
 */
function enable(profileId, projectId, skillId) {
  const skill = registry.get(skillId);
  if (!skill) return { ok: false, error: { code: "unknown-skill", skillId } };
  if (skill.scope === "project") {
    if (typeof projectId !== "number" || projectId !== skill.project_id) {
      return { ok: false, error: { code: "scope-mismatch", scope: "project", project_id: skill.project_id } };
    }
  }
  enabled.set(key(profileId, projectId, skillId), true);
  saveState();
  return { ok: true };
}

/**
 * Disable a skill for a given (profile, project) context. Idempotent.
 */
function disable(profileId, projectId, skillId) {
  enabled.delete(key(profileId, projectId, skillId));
  saveState();
  return { ok: true };
}

/**
 * Returns the enabled skills for a context. A global skill is included if
 * the key `(profileId, '*', skillId)` is set. A project skill is included
 * only when `projectId === skill.project_id`.
 */
function forContext(profileId, projectId) {
  const out = [];
  for (const skill of registry.values()) {
    const k1 = key(profileId, projectId, skill.id);
    const k2 = key(profileId, "*", skill.id);
    if (enabled.has(k1) || enabled.has(k2)) {
      // Mark it enabled in the returned copy for clarity; registry stays clean.
      out.push({ ...skill, enabled: true });
    }
  }
  return out;
}

/**
 * Concatenates the `systemPrompt` of every enabled skill for this context,
 * joined with `\n\n---\n\n`. Stable ordering: registry insertion order.
 */
function buildSystemPrompt(profileId, projectId) {
  const parts = [];
  for (const skill of forContext(profileId, projectId)) {
    if (skill.systemPrompt) parts.push(skill.systemPrompt);
  }
  return parts.join("\n\n---\n\n");
}

/**
 * Returns metadata for every registered skill (no systemPrompts).
 */
function list() {
  return [...registry.values()].map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    tools: [...s.tools],
    scope: s.scope,
    project_id: s.project_id,
  }));
}

/**
 * Reads rootDir/skills/<id>/SKILL.md, parses frontmatter, populates the
 * registry. Skips malformed files silently â€” the agent loop must not crash
 * on a bad skill.
 *
 * Returns `{ ok, count, errors }` where `errors` is an array of
 * `{ id, reason }` for files that were skipped.
 */
function loadFromDisk({ rootDir } = {}) {
  if (rootDir) _rootDir = rootDir;
  const dir = _rootDir ? join(_rootDir, "skills") : null;
  registry.clear();
  const errors = [];
  let count = 0;
  if (!dir || !existsSync(dir)) {
    return { ok: true, count: 0, errors };
  }
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return { ok: false, count: 0, errors: [{ id: "*", reason: "readdir-failed" }] };
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (!safeSkillPath(_rootDir, full)) { errors.push({ id: entry, reason: "path-escape" }); continue; }
    let st;
    try { st = statSync(full); } catch { continue; }
    if (!st.isDirectory()) continue;
    const file = join(full, "SKILL.md");
    if (!existsSync(file)) {
      errors.push({ id: entry, reason: "missing-SKILL.md" });
      continue;
    }
    if (!safeSkillPath(_rootDir, file)) { errors.push({ id: entry, reason: "path-escape" }); continue; }
    let text;
    try { text = readFileSync(file, "utf8"); }
    catch { errors.push({ id: entry, reason: "read-failed" }); continue; }
    const { frontmatter, body } = parseSkillFrontmatter(text);
    // Require an explicit id frontmatter. Falling back to the directory
    // name would let any folder on disk register itself as a skill, which
    // we don't want â€” the loader must be principled.
    const id = frontmatter.id;
    if (!id) { errors.push({ id: entry, reason: "missing-id" }); continue; }
    const tools = typeof frontmatter.tools === "string"
      ? frontmatter.tools.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const project_id = frontmatter.project_id != null && !Number.isNaN(Number(frontmatter.project_id))
      ? Number(frontmatter.project_id)
      : undefined;
    const skill = {
      id,
      name: frontmatter.name || id,
      description: frontmatter.description || "",
      systemPrompt: body,
      tools,
      enabled: false,
      scope: frontmatter.scope === "project" ? "project" : "global",
      project_id,
    };
    if (skill.scope === "project" && typeof project_id !== "number") {
      errors.push({ id, reason: "project-scope-without-project_id" });
      continue;
    }
    register(skill);
    count++;
  }
  return { ok: true, count, errors };
}

// ---- exports --------------------------------------------------------------

export const Skills = {
  register,
  enable,
  disable,
  forContext,
  buildSystemPrompt,
  list,
  loadFromDisk,
  // exposed for tests + advanced callers
  configureSkills,
  parseSkillFrontmatter,
  _resetForTests() {
    registry.clear();
    enabled.clear();
    _rootDir = null;
    _statePath = null;
  },
};

// Internal helpers exported only for tests.
export const _internal = { key, nowMs };
