import { safeHandle } from "../security/safe-handle.js";
// Project Mode â€” Diff IPC.
//
// The `shell_git_diff` tool is already wired in shell/src/services/project-tools/.
// This module exposes a thin IPC channel so the renderer can show a
// diff view for the active project's working tree.
//
// Security:
//   * The path is gated by `assertInsideProjectRoot` (already in
//     shell/src/services/project-tools/security.js).
//   * The diff is capped at 1 MiB by the tool itself.
//   * No API key, no token, no PID; just `git -C <projectRoot> diff`.
//
// Renderer is the SOLE caller of this channel; the agent does not
// need it (it has the `shell_git_diff` tool directly).

import { ipcMain } from "electron";
import { getActiveProjectRootFor } from "./agent-root-registry.js";
import { runTool } from "../services/project-tools/_runtime.js";
import { getTool } from "../services/project-tools/index.js";
import { authorizeAgentRecord } from "../security/project-mode-auth.js";
import { normalizeAgentRow } from "../services/agent/loop.js";

const MAX_BYTES = 1 * 1024 * 1024;

/**
 * Verify that `agentId` really belongs to `profileId`.
 *
 * THIS GATE WAS MISSING. `project:diff` took `profileId` and `agentId` from the
 * renderer, looked the project root up in a registry keyed by that pair, and
 * returned the working-tree diff plus the absolute project path — without ever
 * checking that the agent belongs to the profile. Every sibling agent-scoped
 * channel (`project:start-agent`, the goals channels, 17 call sites in
 * project-mode.js) gates on exactly this. Without it, a renderer that knew or
 * guessed another profile's (profileId, agentId) pair could read that
 * workspace's source: a cross-profile information disclosure, and the returned
 * `root` also leaked an absolute filesystem path.
 *
 * Same construction as `ipc/goals.js`: fail closed, never throw.
 */
async function assertAgentOwned(ctx, profileId, agentId) {
  const fn = ctx && ctx.core && typeof ctx.core.pmGetAgent === "function" ? ctx.core.pmGetAgent : null;
  if (!fn) return { ok: false, reason: "core-not-wired" };
  let row;
  try {
    row = await fn.call(ctx.core, profileId, agentId);
  } catch (e) {
    return { ok: false, reason: "core-error" };
  }
  return authorizeAgentRecord(profileId, agentId, normalizeAgentRow(row));
}

export function registerDiffIpc(ctx) {
  safeHandle("project:diff", async (_e, { profileId, agentId, staged = false, maxBytes = MAX_BYTES } = {}) => {
    if (profileId == null || agentId == null) {
      return { ok: false, error: { code: "invalid-input", message: "profileId + agentId required" } };
    }
    if (!Number.isInteger(Number(profileId)) || !Number.isInteger(Number(agentId))) {
      return { ok: false, error: { code: "invalid-input", message: "profileId + agentId must be integers" } };
    }
    // Ownership BEFORE any root resolution. Nothing about the target workspace
    // may be revealed to a caller that does not own the agent.
    const ownership = await assertAgentOwned(ctx, Number(profileId), Number(agentId));
    if (!ownership.ok) {
      return { ok: false, error: { code: ownership.reason || "agent-not-owned", message: "agent does not belong to this profile" } };
    }
    const projectRoot = getActiveProjectRootFor(Number(profileId), Number(agentId));
    if (!projectRoot) {
      return { ok: false, error: { code: "project-root-not-set", message: "active agent has no projectRoot registered" } };
    }
    const tool = getTool("shell_git_diff");
    if (!tool) {
      return { ok: false, error: { code: "tool-missing", message: "shell_git_diff tool is not registered" } };
    }
    const result = await runTool(tool, { path: projectRoot, staged, maxBytes }, {
      projectRoot,
      isCancellable: () => false,
      nowMs: () => Date.now(),
    });
    if (!result || !result.ok) {
      return { ok: false, error: (result && result.error) || { code: "tool-failed", message: "shell_git_diff failed" } };
    }
    return { ok: true, result: { diff: result.result.diff, truncated: result.result.truncated, root: projectRoot, staged } };
  });
}
