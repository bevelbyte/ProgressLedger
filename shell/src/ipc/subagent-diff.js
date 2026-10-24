import { safeHandle } from "../security/safe-handle.js";
// Project Mode Ã¢â‚¬â€ sub-agent diff IPC.
//
// Lets the renderer ask "what did sub-agent X edit?" by passing the
// child agent's id and the list of files the child reported in its
// `files_changed`. The main process resolves the active project root
// from the existing per-agent registry, runs `git -C <root> diff --`
// for each path through the `SubAgentDiff` service (in main, not via
// a tool round-trip), and returns the per-file diffs.
//
// Security:
//   * profileId + agentId + runId are required.
//   * The caller (the renderer for the parent's UI) must be the parent
//     (or self) of the referenced agent. Foreign-agent reads are
//     refused with `not-authorised`. This is the same gate as the
//     transcript-list channels, just expressed in terms of the
//     `parent_agent_id` column.
//   * The path sandbox is enforced inside the service (`..`-escape and
//     absolute paths are rejected; see subagent-diff.js).
//   * Output is capped: 200 lines per file, 1 MiB total. Truncated
//     entries are reported via `truncated: true` so the UI can show
//     "...and N more".
//
// Renderer is the SOLE caller; the agent itself does not need this
// channel because it has `shell_git_diff`.

import { ipcMain } from "electron";
import { getActiveProjectRootFor } from "./agent-root-registry.js";
import { authorizeDiffCaller } from "../security/subagent-diff-auth.js";
import { SubAgentDiff } from "../services/agent/subagent-diff.js";

const MAX_FILES = 200;          // hard cap on `files` length
const DEFAULT_MAX_BYTES = 1 * 1024 * 1024;

/**
 * Resolve the parent chain for the (profileId, agentId) tuple using
 * the persisted `parent_agent_id` column. Returns null if the agent
 * cannot be loaded (DB unavailable, agent deleted, etc).
 *
 * The IPC handler below uses this to verify the caller's agent is the
 * parent (or the agent itself).
 */
export function registerSubAgentDiffIpc({ core }) {
  safeHandle(
    "project:subagent-diff",
    async (_e, { profileId, callerAgentId, agentId, runId, files, maxBytes } = {}) => {
      if (!Number.isInteger(profileId) || profileId < 1 || !Number.isInteger(agentId) || agentId < 1) {
        return { ok: false, error: { code: "invalid-input", message: "profileId + agentId required" } };
      }
      if (typeof runId !== "string" || runId.length === 0) {
        return { ok: false, error: { code: "invalid-input", message: "runId required" } };
      }
      if (!Array.isArray(files)) {
        return { ok: false, error: { code: "invalid-input", message: "files must be an array of paths" } };
      }
      if (files.length > MAX_FILES) {
        return { ok: false, error: { code: "too-many-files", message: `files capped at ${MAX_FILES}` } };
      }

      // Authorize the actual caller against the target agent's ancestry.
      // The target id is untrusted renderer input and must never stand in
      // for the caller identity.
      const auth = await authorizeDiffCaller(core, profileId, callerAgentId, agentId);
      if (!auth.ok) return auth;
      const callerAgent = auth.caller;

      // Resolve the project root from the caller's per-agent
      // registry. The CHILD may have already unregistered; we use the
      // PARENT's root (which is the same project).
      const projectRoot = getActiveProjectRootFor(profileId, callerAgentId);
      if (!projectRoot) {
        return { ok: false, error: { code: "project-root-not-set", message: "active agent has no projectRoot registered" } };
      }

      const cap = typeof maxBytes === "number" && maxBytes > 0
        ? Math.floor(maxBytes)
        : DEFAULT_MAX_BYTES;

      const out = await SubAgentDiff.computeForFiles({
        projectRoot,
        files,
        maxBytes: cap,
      });
      if (!out || !out.ok) {
        return { ok: false, error: (out && out.error) || { code: "compute-failed", message: "subagent diff failed" } };
      }
      return { ok: true, result: { perFile: out.result.perFile, truncated: out.result.truncated, skipped: out.result.skipped, runId, root: projectRoot } };
    },
  );
}