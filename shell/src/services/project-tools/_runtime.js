// Internal helpers shared by every tool. NOT exported through the registry.
//
// Tool contract: every tool's `execute(input, ctx)` returns
//   { ok: true,  result: any, elapsedMs: number }
//   { ok: false, error: { code, message } }
// The wrapper in `runTool()` enforces that contract, plus timeout and
// cooperative cancellation. Tools themselves never throw for the normal
// "not found" / "permission denied" path.

import { execFile as nodeExecFile } from "node:child_process";
import { Audit } from "../audit/index.js";

function terminateOwnedProcessTree(child, done) {
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return done();

  // The child handle is the ownership proof: this PID came directly from the
  // execFile invocation above. Never search by image name or port. On Windows
  // taskkill /T is the only reliable way to prevent a timed-out command from
  // leaving its npm/node/child-process descendants behind. This is a timeout
  // / output-cap recovery path only; normal completion never force-kills.
  if (process.platform === "win32") {
    const kill = nodeExecFile("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 5_000,
    }, () => {
      const deadline = Date.now() + 2000;
      const verifyExit = () => {
        nodeExecFile("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { windowsHide: true, timeout: 1000 }, (_error, stdout) => {
          if (!String(stdout || "").includes(String(pid)) || Date.now() >= deadline) return done();
          setTimeout(verifyExit, 50);
        });
      };
      verifyExit();
    });
    void kill;
    return;
  }

  // POSIX: the direct child is already addressed exactly; there is no image
  // or port based cleanup. Best effort parent termination is intentionally
  // retained for platforms where the caller did not create a process group.
  try { process.kill(pid, "SIGTERM"); } catch {}
  done();
}

export const TOOL_VERSION = 1;

/** Format a structured error envelope. */
export function errorEnvelope(code, message) {
  return { ok: false, error: { code, message: String(message ?? code) } };
}

/** Format a successful result. */
export function successEnvelope(result, elapsedMs) {
  return { ok: true, result, elapsedMs: Number(elapsedMs) || 0 };
}

/**
 * Wrap a tool's execute so we get:
 *   - a uniform { ok, result|error, elapsedMs } envelope
 *   - AbortSignal.timeout() forwarding
 *   - cooperative cancellation via ctx.isCancellable()
 *
 * If the tool throws, we convert it to a `{ ok:false, error:{...} }`.
 */
export async function runTool(tool, input, ctx) {
  const startedAt = Date.now();
  const timeoutMs = typeof tool.timeoutMs === "number" && tool.timeoutMs > 0
    ? tool.timeoutMs
    : 30_000;

  const innerCtx = {
    projectRoot: ctx && typeof ctx.projectRoot === "string" ? ctx.projectRoot : null,
    // Reservation scoping (used by fs_write). The IPC and agent loop
    // pass these in when they have them; tools that don't care can
    // ignore them, and fs_write refuses safely when any is missing.
    profileId: ctx && typeof ctx.profileId === "number" ? ctx.profileId : null,
    projectId: ctx && typeof ctx.projectId === "number" ? ctx.projectId : null,
    agentId: ctx && typeof ctx.agentId === "number" ? ctx.agentId : null,
    isCancellable: () => !!(ctx && typeof ctx.isCancellable === "function" && ctx.isCancellable()),
    nowMs: () => Date.now(),
    timeoutMs,
    signal: typeof AbortSignal !== "undefined" ? AbortSignal.timeout(timeoutMs) : undefined,
  };

  // Audit: tool invocation. Logged BEFORE the call so the trail has a
  // 'tool.invoked' event paired with the corresponding 'tool.completed'
  // / 'tool.failed'. `input_summary` is a short label (tool name only)
  // — the full input is never persisted.
  Audit.log({
    event: "tool.invoked",
    profileId: innerCtx.profileId,
    projectId: innerCtx.projectId,
    agentId: innerCtx.agentId,
    tool: tool && typeof tool.name === "string" ? tool.name : null,
    input_summary: tool && typeof tool.name === "string" ? tool.name : null,
    result: null,
    durationMs: null,
    detail: null,
  });

  let out;
  try {
    const result = await tool.execute(input, innerCtx);
    const elapsedMs = Date.now() - startedAt;

    if (result === null || result === undefined || typeof result !== "object") {
      out = errorEnvelope("invalid-input", "tool returned non-object result");
    } else if (result.ok === true) {
      out = {
        ok: true,
        result: result.result,
        elapsedMs: typeof result.elapsedMs === "number" ? result.elapsedMs : elapsedMs,
      };
    } else if (result.ok === false && result.error && typeof result.error === "object") {
      out = {
        ok: false,
        error: {
          code: typeof result.error.code === "string" ? result.error.code : "tool-failed",
          message: typeof result.error.message === "string" ? result.error.message : "tool failed",
        },
        elapsedMs: typeof result.elapsedMs === "number" ? result.elapsedMs : elapsedMs,
      };
    } else {
      out = errorEnvelope("tool-failed", "tool returned malformed envelope");
    }
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    // AbortError from AbortSignal.timeout() → timeout.
    if (e && (e.name === "AbortError" || e.code === "ABORT_ERR")) {
      out = { ok: false, error: { code: "timeout", message: "tool timed out" }, elapsedMs };
    } else {
      const message = e && e.message ? e.message : String(e);
      out = { ok: false, error: { code: "tool-failed", message }, elapsedMs };
    }
  }

  // Audit: tool completion / failure. Logged after the call so the
  // duration is accurate. The redaction in Audit.log() protects against
  // accidental key leakage through `detail`.
  Audit.log({
    event: out && out.ok ? "tool.completed" : "tool.failed",
    profileId: innerCtx.profileId,
    projectId: innerCtx.projectId,
    agentId: innerCtx.agentId,
    tool: tool && typeof tool.name === "string" ? tool.name : null,
    input_summary: tool && typeof tool.name === "string" ? tool.name : null,
    result: out && out.ok
      ? "ok"
      : out && out.error && out.error.code === "timeout"
        ? "timeout"
        : "fail",
    durationMs: typeof out.elapsedMs === "number" ? out.elapsedMs : null,
    detail: out && out.error && typeof out.error.message === "string"
      ? out.error.message
      : null,
  });
  return out;
}

// ---- execFile wrapper with timeout + size caps ----------------------------

/**
 * Run an external program with a timeout, no shell, and an output cap.
 * Returns { stdout, stderr, code, signal, timedOut } — never throws for a
 * normal "process exited non-zero" case.
 *
 * The argv must already be an array of strings — no interpolation. This
 * is the only safe way to call into the OS from the main process for the
 * arbitrary-command case (exec_run, test_run, build_run, shell_git_*).
 */
export function safeExecFile(
  command,
  argv,
  options = {},
  execFileImpl = nodeExecFile,
) {
    const {
    cwd,
    timeoutMs = 30_000,
    maxOutputBytes = 2 * 1024 * 1024,
    env,
    windowsHide = true,
    cancelSignal = null,
  } = options;

  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    let cleanupStarted = false;
    let timeoutHandle = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const finishTimedOut = () => {
      if (settled || cleanupStarted) return;
      cleanupStarted = true;
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      const result = {
        stdout: "",
        stderr: "",
        code: null,
        signal: "SIGTERM",
        timedOut: true,
      };
      let closed = false;
      const settle = () => {
        if (closed) return;
        closed = true;
        child?.removeListener?.("close", onClose);
        finish(result);
      };
      const onClose = () => settle();
      child?.once?.("close", onClose);
      terminateOwnedProcessTree(child, settle);
      setTimeout(settle, 2_000);
    };

    const child = execFileImpl(
      command,
      Array.isArray(argv) ? argv : [],
      {
        cwd: typeof cwd === "string" ? cwd : undefined,
        env: env || process.env,
        windowsHide,
        // Do not delegate the deadline to execFile. Its built-in timeout kills
        // only the direct child and can invoke the callback before our exact
        // PID tree cleanup runs. The timer below is the single authoritative
        // timeout so descendants are always handled by terminateOwnedProcessTree.
        timeout: 0,
        killSignal: "SIGTERM",
        maxBuffer: maxOutputBytes,
      },
      (err, stdout, stderr) => {
        if (timedOut) {
          return finishTimedOut();
        }
        if (err) {
          // execFile puts the buffered stdout/stderr on the error object.
          return finish({
            stdout: stdout ? String(stdout) : "",
            stderr: stderr ? String(stderr) : "",
            code: typeof err.code === "number" ? err.code : null,
            signal: err.signal || null,
            timedOut: !!err.killed && err.signal === "SIGTERM",
            errorMessage: err.message,
          });
        }
        finish({
          stdout: stdout ? String(stdout) : "",
          stderr: stderr ? String(stderr) : "",
          code: 0,
          signal: null,
          timedOut: false,
        });
      },
    );

    if (child && typeof child.stdout?.on === "function") {
      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes) {
          if (!timedOut) {
            timedOut = true;
            finishTimedOut();
          }
        }
      });
      child.stderr.on("data", (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > maxOutputBytes) {
          if (!timedOut) {
            timedOut = true;
            finishTimedOut();
          }
        }
      });
    }

    // Hard timeout safety net — execFile's `timeout` is implemented but we
    // also enforce it here so we get a clean timedOut=true result.
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      finishTimedOut();
    }, timeoutMs);
    child.on?.("exit", () => {
      if (!cleanupStarted) clearTimeout(timeoutHandle);
    });
    child.on?.("close", () => {
      if (!cleanupStarted) clearTimeout(timeoutHandle);
    });

    // Agent cancellation is distinct from the execution deadline. The agent
    // owns the AbortSignal; once it fires, terminate only this exact child
    // process tree and let the normal execFile callback produce the envelope.
    if (cancelSignal && typeof cancelSignal.addEventListener === "function") {
      const onAbort = () => {
        if (settled || timedOut) return;
        timedOut = true;
        finishTimedOut();
      };
      if (cancelSignal.aborted) onAbort();
      else cancelSignal.addEventListener("abort", onAbort, { once: true });
      const removeAbort = () => cancelSignal.removeEventListener?.("abort", onAbort);
      child.on?.("exit", removeAbort);
      child.on?.("close", removeAbort);
    }
  });
}
