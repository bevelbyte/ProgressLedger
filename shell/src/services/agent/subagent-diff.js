// Sub-agent diff service.
//
// Computes the per-file diff for a list of paths the sub-agent claims to have
// edited. The parent agent's UI then renders this as a tree node so the user
// can see "sub-agent X edited these files" without leaving Project Mode.
//
// Why a separate module (and not just `shell_git_diff` per-file)? Two reasons:
//   1. The existing `shell_git_diff` tool is a single argv-driven tool that
//      runs ONE `git diff` against the project root. We need per-path output
//      in a single round-trip so the IPC payload is bounded and the parent
//      agent doesn't issue N tool calls.
//   2. We want stable per-file caps (200 lines each) and a global cap
//      (1 MiB) so a runaway agent that edited 200 files can't OOM the
//      renderer.
//
// The diff is computed in the main process using `git -C <root> diff -- <path>`
// (one execFile per file, no shell). AbortSignal support is cooperative —
// the runner checks `signal.aborted` between files and reports
// `cancelled: true` instead of erroring.
//
// PURE: no Electron, no globals. Tested in isolation in
// shell/tests/subagent-diff.test.js.

import { execFile as nodeExecFile } from "node:child_process";

export const SUBAGENT_DIFF_DEFAULT_MAX_BYTES = 1 * 1024 * 1024; // 1 MiB
export const SUBAGENT_DIFF_DEFAULT_PER_FILE_LINES = 200;

// ---- internal helpers -----------------------------------------------------

/**
 * Run `git -C <root> diff --no-color -- <path>` and return stdout.
 * The argv is constructed as an array — no shell, no interpolation.
 *
 * @param {object} args
 * @param {string} args.root       absolute project root
 * @param {string} args.relPath    repo-relative path to diff
 * @param {object} [args.execFileImpl]  injection point for tests
 * @returns {Promise<{ stdout: string, timedOut: boolean, code: number|null, errorMessage?: string }>}
 */
function runGitDiffForFile({ root, relPath, execFileImpl = nodeExecFile }) {
  return new Promise((resolve) => {
    const argv = ["-C", root, "diff", "--no-color", "--", relPath];
    execFileImpl(
      "git",
      argv,
      { windowsHide: true, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && (err.killed || err.signal === "SIGTERM")) {
          return resolve({ stdout: "", timedOut: true, code: null, errorMessage: "timeout" });
        }
        if (err) {
          return resolve({
            stdout: "",
            timedOut: false,
            code: typeof err.code === "number" ? err.code : null,
            errorMessage: typeof err.message === "string" ? err.message : "git failed",
          });
        }
        return resolve({
          stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
          timedOut: false,
          code: 0,
        });
      },
    );
  });
}

/**
 * Cap a diff string to at most `maxLines` lines (plus a trailing "..." marker
 * when truncated). Lines starting with the unified-diff header
 * (`diff --git ...`) count toward the cap.
 */
function capDiffLines(diff, maxLines) {
  if (!diff) return { text: "", truncated: false };
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return { text: diff, truncated: false };
  return { text: lines.slice(0, maxLines).join("\n") + "\n…", truncated: true };
}

/**
 * Normalize a path the sub-agent reported. The contract is "repo-relative
 * path strings" (matches `files_changed` from the coder/reviewer role output
 * and from `_roles.js`). Absolute paths and `..`-escape paths are rejected
 * at the caller; this helper just normalizes slashes and strips a leading
 * `./`.
 */
function normalizeRelPath(p) {
  if (typeof p !== "string") return null;
  let s = p.replace(/\\/g, "/").trim();
  if (s.startsWith("./")) s = s.slice(2);
  // Strip any leading slash so the path is truly repo-relative.
  while (s.startsWith("/")) s = s.slice(1);
  if (s.length === 0 || s === ".") return null;
  return s;
}

// ---- public surface -------------------------------------------------------

export const SubAgentDiff = {
  /**
   * Compute per-file diffs for a list of repo-relative paths.
   *
   * @param {object} args
   * @param {string} args.projectRoot   absolute path to the project root
   * @param {string[]} args.files       list of repo-relative paths
   * @param {AbortSignal} [args.signal] optional signal for cooperative cancel
   * @param {number} [args.maxBytes]    global cap on concatenated output
   *                                    (default 1 MiB)
   * @param {number} [args.maxLinesPerFile] per-file line cap (default 200)
   * @param {object} [args.execFileImpl] injection point for tests
   * @returns {Promise<{
   *   ok: true,
   *   result: { perFile: Record<string,string>, truncated: boolean, skipped: string[] }
   * } | {
   *   ok: false,
   *   error: { code: string, message: string }
   * }>}
   */
  async computeForFiles({
    projectRoot,
    files,
    signal,
    maxBytes = SUBAGENT_DIFF_DEFAULT_MAX_BYTES,
    maxLinesPerFile = SUBAGENT_DIFF_DEFAULT_PER_FILE_LINES,
    execFileImpl = nodeExecFile,
  } = {}) {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      return { ok: false, error: { code: "invalid-input", message: "projectRoot is required" } };
    }
    if (!Array.isArray(files)) {
      return { ok: false, error: { code: "invalid-input", message: "files must be an array of paths" } };
    }

    const perFile = Object.create(null);
    const skipped = [];
    let truncated = false;

    for (const raw of files) {
      if (signal && signal.aborted) {
        return { ok: true, result: { perFile, truncated: true, skipped, cancelled: true } };
      }
      const rel = normalizeRelPath(raw);
      if (!rel) {
        skipped.push(String(raw));
        continue;
      }
      // Reject any path that tries to escape the project root (defense in
      // depth: the contract says repo-relative, but the renderer is
      // untrusted).
      if (rel.split("/").includes("..")) {
        skipped.push(raw);
        continue;
      }

      const { stdout, timedOut, errorMessage } = await runGitDiffForFile({
        root: projectRoot,
        relPath: rel,
        execFileImpl,
      });
      if (timedOut) {
        skipped.push(raw);
        continue;
      }
      if (errorMessage) {
        // `git diff` exits non-zero for untracked-but-already-staged cases
        // very rarely; if it does fail we still record a marker so the
        // caller can show something rather than nothing.
        perFile[rel] = `# git diff failed: ${errorMessage}\n`;
        continue;
      }

      if (!stdout) {
        // No diff for this file (clean, or untracked + not added).
        // Still record an empty string so the caller can iterate uniformly.
        perFile[rel] = "";
        continue;
      }

      const { text, truncated: fileTrunc } = capDiffLines(stdout, maxLinesPerFile);
      perFile[rel] = text;
      if (fileTrunc) truncated = true;
    }

    // Enforce the global byte cap across the concatenated perFile map.
    let total = 0;
    for (const v of Object.values(perFile)) total += v.length;
    if (total > maxBytes) {
      truncated = true;
      const entries = Object.entries(perFile);
      // Trim from the END until we fit. Each entry we drop entirely gets
      // recorded in `skipped` so the caller can show "...and N more".
      while (total > maxBytes && entries.length > 0) {
        const [k, v] = entries.pop();
        total -= v.length;
        delete perFile[k];
        skipped.push(k);
      }
    }

    return { ok: true, result: { perFile, truncated, skipped } };
  },
};