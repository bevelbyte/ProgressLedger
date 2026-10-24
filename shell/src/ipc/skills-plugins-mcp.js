import { safeHandle } from "../security/safe-handle.js";
// Skills + Plugins + MCP - renderer IPC surface for the extension layer.
//
// Channels:
//   skills:list              - metadata (id, name, description, scope, tools)
//   skills:set-enabled       - toggle enable/disable for a (profile, project)
//   skills:preview           - raw SKILL.md text for a single skill (sandboxed)
//   plugins:list             - metadata for every installed plugin
//   plugins:install-local    - take a local path, copy into plugins/<id>
//   plugins:reload           - re-read on-disk manifest for an installed plugin
//
// MCP tools themselves are NOT exposed to the renderer. The MCP layer is
// shell-side plumbing only; its tools become regular project-tools via the
// registry (see shell/src/services/mcp/).
//
// CORRECTION (2026-09-27): the comment here used to describe an
// `mcp:list-curated` channel as a "read-only window into the curated server
// catalogue". NO SUCH CHANNEL IS REGISTERED — there is no `mcp:*` IPC handler
// anywhere in shell/src, and shell/src/preload.cjs exposes no `mcp` namespace.
// The description was aspirational and had been read as a live contract by at
// least one audit report. The renderer-isolation decision itself is real and is
// asserted by shell/tests/gate7-mcp-e2e.test.js; only the channel reference
// was wrong.
//
// Consequence to keep in mind: `MCP.list()` is therefore always `[]` from the
// renderer's point of view, and `marketplace.listMcp()` always answers
// `{ ok: true, mcp: [] }`. Whether the curated catalogue should be reachable at
// all is an open design question, not an existing feature.

import { ipcMain } from "electron";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Skills } from "../services/skills/index.js";
import { Plugins } from "../services/plugins/index.js";
import { Audit } from "../services/audit/index.js";
import { validateSkillEnableScope } from "../security/skills-auth.js";

// ---- helpers ---------------------------------------------------------------

/**
 * Resolve the Electron userData dir from the IPC context. Returns null when
 * the app object is missing or getPath throws (e.g. in unit tests without
 * Electron).
 */
async function assertProfileOwned(ctx, profileId) {
  if (!Number.isInteger(profileId) || profileId < 1) return { ok: false, reason: "invalid-profile-id" };
  const getProfiles = ctx?.core && typeof ctx.core.getProfiles === "function" ? ctx.core.getProfiles.bind(ctx.core) : null;
  if (!getProfiles) return { ok: false, reason: "core-not-wired" };
  try {
    const profiles = await Promise.resolve(getProfiles());
    return Array.isArray(profiles) && profiles.some((p) => Number(p?.id ?? p?.profile_id) === profileId) ? { ok: true } : { ok: false, reason: "profile-not-found" };
  } catch { return { ok: false, reason: "profile-ownership-check-failed" }; }
}
function safeUserDataFile(userDataDir, candidate) {
  try {
    const root = realpathSync(userDataDir).replace(/[\\/]+$/, "").toLowerCase();
    const resolved = realpathSync(candidate).toLowerCase();
    return resolved.startsWith(`${root}\\`) || resolved.startsWith(`${root}/`) ? resolved : null;
  } catch { return null; }
}
function getUserDataDir(ctx) {
  const electronApp = ctx && ctx.app;
  if (electronApp && typeof electronApp.getPath === "function") {
    try {
      return electronApp.getPath("userData");
    } catch {
      return null;
    }
  }
  return null;
}

export function register(ctx) {
  // --- skills -------------------------------------------------------------

  safeHandle("skills:list", () => {
    // Enrich the raw skill metadata with the renderer-facing shape the
    // Skill Inventory panel expects: triggers (= the on-disk `tools`
    // frontmatter) and the project/global booleans derived from scope.
    // The raw shape from `Skills.list()` is preserved so other consumers
    // (Marketplace, agent loop debug) keep working unchanged.
    const skills = Skills.list().map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      triggers: Array.isArray(s.tools) ? [...s.tools] : [],
      scope: s.scope,
      project: s.scope === "project",
      global: s.scope === "global",
      project_id: s.project_id,
    }));
    return { ok: true, skills };
  });

  // Returns the raw SKILL.md text for a given skill id. Read-only and
  // sandboxed to <userData>/skills/<id>/SKILL.md so the renderer cannot
  // coerce the shell into reading arbitrary paths. Missing files or
  // a missing userData dir surface as `{ ok:false, reason }`.
  safeHandle("skills:preview", (_e, payload) => {
    const skillId = payload && typeof payload.skillId === "string" ? payload.skillId : "";
    if (!skillId) return { ok: false, reason: "missing-skill-id" };
    // Reject path-traversal: skillId is the on-disk directory name.
    if (skillId.includes("/") || skillId.includes("\\") || skillId.includes("..")) {
      return { ok: false, reason: "invalid-skill-id" };
    }
    const userDataDir = getUserDataDir(ctx);
    if (!userDataDir) return { ok: false, reason: "no-userdata" };
    const file = join(userDataDir, "skills", skillId, "SKILL.md");
    if (!safeUserDataFile(userDataDir, file)) return { ok: false, reason: "path-escape" };
    if (!existsSync(file)) return { ok: false, reason: "not-found" };
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      return { ok: false, reason: "read-failed" };
    }
    return { ok: true, skillId, content };
  });

  safeHandle("skills:set-enabled", async (_e, payload) => {
    const skillId = payload && typeof payload.skillId === "string" ? payload.skillId : "";
    const profileId = payload && typeof payload.profileId === "number" ? payload.profileId : null;
    const projectId = payload && typeof payload.projectId === "number" ? payload.projectId : null;
    const enabled = !!(payload && payload.enabled);
    const scope = await validateSkillEnableScope(ctx, profileId, projectId, skillId);
    if (!scope.ok) {
      // A refused enablement is still a security-relevant event: it means a
      // renderer tried to change agent behaviour outside its ownership
      // boundary. Record the refusal, not just the success.
      // NOTE: Audit.normalize() only persists a STRING `detail`; an object
      // would be silently dropped, so it is stringified here.
      Audit.log({
        event: "skill.set_enabled",
        profileId,
        projectId,
        agentId: null,
        tool: null,
        input_summary: skillId || null,
        result: "denied",
        durationMs: null,
        detail: JSON.stringify({ reason: scope.reason || "scope-rejected", requested: enabled }),
      });
      return scope;
    }
    // When the caller didn't supply a projectId, use '*' (global scope).
    const ctxId = projectId == null ? "*" : projectId;
    const r = enabled
      ? Skills.enable(profileId, ctxId, skillId)
      : Skills.disable(profileId, ctxId, skillId);
    // Enabling a skill materially changes the agent's system prompt
    // (agent/loop.js -> Skills.buildSystemPrompt), so it belongs on the
    // security record alongside the other capability-changing operations.
    Audit.log({
      event: "skill.set_enabled",
      profileId,
      projectId,
      agentId: null,
      tool: null,
      input_summary: skillId || null,
      result: r.ok ? "ok" : "error",
      durationMs: null,
      detail: JSON.stringify({ enabled, scopeId: ctxId, reason: r?.error?.code || null }),
    });
    if (!r.ok) return r;
    return { ok: true };
  });

  // --- plugins ------------------------------------------------------------

  safeHandle("plugins:list", async (_e, payload) => {
    const profileId = payload && typeof payload.profileId === "number" ? payload.profileId : null;
    const ownership = await assertProfileOwned(ctx, profileId);
    if (!ownership.ok) return ownership;
    return { ok: true, plugins: Plugins.list() };
  });

  safeHandle("plugins:install-local", (_e, payload) => {
    const source = payload && typeof payload.source === "string" ? payload.source : "";
    const id = payload && typeof payload.id === "string" ? payload.id : null;
    const profileId = payload && typeof payload.profileId === "number" ? payload.profileId : null;
    if (!source) return { ok: false, reason: "invalid-source" };
    return assertProfileOwned(ctx, profileId).then((ownership) => {
      if (!ownership.ok) return ownership;
      return Plugins.install({ id: id || null, source });
    });
  });

  // Hot-reload: re-read the on-disk manifest for an installed plugin and
// refresh the in-memory record. Used by the dev loop - edit a plugin's
  // plugin.json on disk, then trigger this channel without restarting the
  // app.
  safeHandle("plugins:reload", (_e, payload) => {
    const id = payload && typeof payload.id === "string" ? payload.id : "";
    const profileId = payload && typeof payload.profileId === "number" ? payload.profileId : null;
    if (!id) return { ok: false, reason: "missing-id" };
    return assertProfileOwned(ctx, profileId).then((ownership) => {
      if (!ownership.ok) return ownership;
      return Plugins.reload(id);
    });
  });

  safeHandle("plugins:enable", async (_e, payload) => {
    const id = payload && typeof payload.id === "string" ? payload.id : "";
    const profileId = payload && typeof payload.profileId === "number" ? payload.profileId : null;
    if (!id) return { ok: false, reason: "missing-id" };
    const ownership = await assertProfileOwned(ctx, profileId);
    if (!ownership.ok) return ownership;
    return Plugins.enable(id);
  });

  safeHandle("plugins:disable", async (_e, payload) => {
    const id = payload && typeof payload.id === "string" ? payload.id : "";
    const profileId = payload && typeof payload.profileId === "number" ? payload.profileId : null;
    if (!id) return { ok: false, reason: "missing-id" };
    const ownership = await assertProfileOwned(ctx, profileId);
    if (!ownership.ok) return ownership;
    return Plugins.disable(id);
  });

}
