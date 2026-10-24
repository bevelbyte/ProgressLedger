// Commands — slash-command extension layer for the shell-side Project Mode.
//
// A Command is a user-invokable verb that resolves to a single async
// run(profileId, projectId, args, ctx) call. The renderer types "/cmd …"
// into the input box; the shell parses the line and dispatches.
//
// Built-in starter set (always registered):
//   /plan    — show the agent's plan
//   /review  — re-render the plan + status
//   /test    — run the project's test_command via test_run
//   /explain — open the most recent error in a chat bubble
//   /fix     — re-dispatch a coder sub-agent with the failure context
//   /commit  — git add . + git commit (only if shell_git_status succeeds;
//              only if exec_run is in APPROVAL_REQUIRED so we know the
//              user trusts this surface — it is, by definition)
//   /cancel  — call cancelAgent(agentId)
//
// Plugins can register more. The registry is in-process and ephemeral;
// nothing is persisted to disk. The /commands layer does NOT touch
// disk directly — every command goes through the existing tool layer
// (test_run, exec_run, shell_git_status) so the same approval flow,
// project-root pinning and audit trail apply.
//
// All public functions are pure w.r.t. their inputs and never throw. Disk
// I/O failures surface as `{ ok: false, reason }` so the agent loop
// cannot crash on a malformed command.

// ---- module state ---------------------------------------------------------

// In-memory registry of every command. id -> command (id is the
// canonical name, e.g. "plan" for "/plan").
const registry = new Map();

// Per-instance tool bridge; injected so tests can supply stubs.
let _invokeTool = null;       // async (toolName, input, ctx) => result
let _cancelAgent = null;      // async (agentId) => { ok, reason }
let _listMessages = null;     // async (profileId, agentId) => { ok, messages }
let _getAgent = null;         // async (profileId, agentId) => agent
let _getRun = null;           // (agentId) => run | null

// ---- helpers --------------------------------------------------------------

/**
 * Parse a "/cmd arg1 arg2 …" command line. Splits on whitespace; does not
 * honour quoting. Returns { name, args } where name is the bare verb
 * without the leading slash. The verb "list" is reserved for the
 * Commands.list() enumeration; "/list" is therefore NOT dispatched.
 */
export function parseCommandLine(commandLine) {
  if (typeof commandLine !== "string") return null;
  const trimmed = commandLine.trim();
  if (!trimmed.startsWith("/")) return null;
  const rest = trimmed.slice(1).trim();
  if (!rest) return null;
  const parts = rest.split(/\s+/).filter(Boolean);
  const name = parts.shift();
  if (!name) return null;
  return { name: name.toLowerCase(), args: parts };
}

/**
 * Configure the tool bridge. The IPC layer wires this up at register
 * time so the command dispatcher can route through the existing
 * project-tools layer (which enforces approval, project-root pinning,
 * and validation). Tests inject stubs.
 */
export function configureCommands({
  invokeTool,
  cancelAgent,
  listMessages,
  getAgent,
  getRun,
} = {}) {
  _invokeTool = typeof invokeTool === "function" ? invokeTool : null;
  _cancelAgent = typeof cancelAgent === "function" ? cancelAgent : null;
  _listMessages = typeof listMessages === "function" ? listMessages : null;
  _getAgent = typeof getAgent === "function" ? getAgent : null;
  _getRun = typeof getRun === "function" ? getRun : null;
}

// ---- command builders -----------------------------------------------------

/**
 * `/plan` — fetch the current agent and return its plan. The renderer
 * uses the result to refresh the PlanView. Falls back to "no active
 * agent" if the renderer didn't pass an agentId.
 */
function buildPlanCommand() {
  return {
    id: "plan",
    name: "plan",
    description: "Show the agent's current plan.",
    args: [],
    async run(profileId, projectId, args, ctx) {
      const agentId = ctx && typeof ctx.agentId === "number" ? ctx.agentId : null;
      if (!_getAgent) return { ok: false, reason: "commands-not-wired" };
      if (agentId == null) return { ok: false, reason: "no-active-agent" };
      const a = await _getAgent(profileId, agentId);
      if (!a || a.ok === false) {
        return { ok: false, reason: a && a.reason ? a.reason : "agent-not-found" };
      }
      let plan = null;
      if (typeof a.plan_json === "string" && a.plan_json.length > 0) {
        try { plan = JSON.parse(a.plan_json); } catch { plan = null; }
      }
      return { ok: true, plan, state: a.state };
    },
  };
}

/**
 * `/review` — re-render the plan AND the latest status. Same shape as
 * /plan but tagged so the renderer can show "review" framing in the UI.
 */
function buildReviewCommand() {
  return {
    id: "review",
    name: "review",
    description: "Re-render the plan and current run status.",
    args: [],
    async run(profileId, projectId, args, ctx) {
      const agentId = ctx && typeof ctx.agentId === "number" ? ctx.agentId : null;
      if (!_getAgent || !_getRun) return { ok: false, reason: "commands-not-wired" };
      if (agentId == null) return { ok: false, reason: "no-active-agent" };
      const a = await _getAgent(profileId, agentId);
      if (!a || a.ok === false) {
        return { ok: false, reason: a && a.reason ? a.reason : "agent-not-found" };
      }
      const run = _getRun(agentId);
      let plan = null;
      if (typeof a.plan_json === "string" && a.plan_json.length > 0) {
        try { plan = JSON.parse(a.plan_json); } catch { plan = null; }
      }
      return {
        ok: true,
        plan,
        state: a.state,
        run: run ? { runId: run.runId, state: run.state } : null,
      };
    },
  };
}

/**
 * `/test` — invoke the test_run tool. test_run is NOT approval-required,
 * so the dispatcher passes no token. The caller (renderer) MAY pass a
 * `command` + `argv` via args; otherwise the project-default test command
 * is inferred (or test_run returns its own invalid-input envelope).
 */
function buildTestCommand() {
  return {
    id: "test",
    name: "test",
    description: "Run the project's test command (test_run tool).",
    args: [
      { name: "command", required: false, description: "Executable name (default: infer)" },
      { name: "argv", required: false, description: "Optional argv list (space-separated)" },
    ],
    async run(profileId, projectId, args, ctx) {
      if (!_invokeTool) return { ok: false, reason: "commands-not-wired" };
      const input = {};
      if (args && args[0]) input.command = args[0];
      if (args && args.length > 1) input.argv = args.slice(1);
      const r = await _invokeTool("test_run", input, {
        profileId,
        projectId,
        agentId: ctx && typeof ctx.agentId === "number" ? ctx.agentId : null,
      });
      return r;
    },
  };
}

/**
 * `/explain` — fetch the most recent error/role=error message and return
 * its content for the renderer to surface as a chat bubble. If no
 * error message exists, return ok:false with a "no-error-found" reason.
 */
function buildExplainCommand() {
  return {
    id: "explain",
    name: "explain",
    description: "Open the most recent error message in a chat bubble.",
    args: [],
    async run(profileId, projectId, args, ctx) {
      const agentId = ctx && typeof ctx.agentId === "number" ? ctx.agentId : null;
      if (!_listMessages) return { ok: false, reason: "commands-not-wired" };
      if (agentId == null) return { ok: false, reason: "no-active-agent" };
      const r = await _listMessages(profileId, agentId);
      if (!r || r.ok === false) {
        return { ok: false, reason: r && r.reason ? r.reason : "list-failed" };
      }
      const msgs = Array.isArray(r.messages) ? r.messages : [];
      // Walk newest -> oldest looking for the first error-class message.
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!m) continue;
        const isError = m.role === "error"
          || (m.payload_json && /error|fail/i.test(String(m.payload_json)));
        if (isError) {
          return { ok: true, message: m };
        }
      }
      return { ok: false, reason: "no-error-found" };
    },
  };
}

/**
 * `/fix` — re-dispatch a coder sub-agent. The dispatcher returns
 * ok:false if there is no active parent agent to re-dispatch from, or
 * if the delegate_coder tool has not been wired. We deliberately do NOT
 * bypass the delegate tool's own approval/validation layer: commands
 * are entry points, not privileged surfaces.
 */
function buildFixCommand() {
  return {
    id: "fix",
    name: "fix",
    description: "Re-dispatch a coder sub-agent with the failure context.",
    args: [
      { name: "objective", required: false, description: "Optional override objective" },
    ],
    async run(profileId, projectId, args, ctx) {
      const agentId = ctx && typeof ctx.agentId === "number" ? ctx.agentId : null;
      if (!_invokeTool) return { ok: false, reason: "commands-not-wired" };
      if (agentId == null) return { ok: false, reason: "no-active-agent" };
      if (!_listMessages) return { ok: false, reason: "commands-not-wired" };
      const msgs = await _listMessages(profileId, agentId);
      if (!msgs || msgs.ok === false) {
        return { ok: false, reason: msgs && msgs.reason ? msgs.reason : "list-failed" };
      }
      // Pull the most recent error as the failure context. If none,
      // fall back to the last user message.
      const arr = Array.isArray(msgs.messages) ? msgs.messages : [];
      let lastError = null;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] && arr[i].role === "error") { lastError = arr[i]; break; }
      }
      const failure = lastError || arr[arr.length - 1] || null;
      const objective = (args && args[0])
        ? args.join(" ")
        : (failure && failure.content ? `Fix: ${failure.content}` : "Investigate and fix the last failure");
      const r = await _invokeTool("delegate_coder", { objective, step_id: `cmd-fix-${Date.now()}` }, {
        profileId,
        projectId,
        agentId,
      });
      return r;
    },
  };
}

/**
 * `/commit` — git add . + git commit. We use the existing exec_run tool
 * so approval semantics are preserved (exec_run is APPROVAL_REQUIRED —
 * see security.js APPROVAL_REQUIRED set). The command runs the two
 * invocations as separate tool calls; the second one needs a fresh
 * approval token (so the renderer must surface the dialog). We DO NOT
 * bypass approval: if exec_run is not in APPROVAL_REQUIRED, we still
 * pre-check (defense-in-depth) and return ok:false otherwise.
 */
function buildCommitCommand() {
  return {
    id: "commit",
    name: "commit",
    description: "git add . + git commit (requires exec_run approval).",
    args: [
      { name: "message", required: false, description: "Optional commit message" },
    ],
    async run(profileId, projectId, args, ctx) {
      if (!_invokeTool) return { ok: false, reason: "commands-not-wired" };
      // Pre-check: shell_git_status must succeed. If we cannot even
      // read git status, refuse — we are not in a git repo (or git is
      // not installed). This is the "shell_git_status-failed" reason
      // the test suite asserts.
      const status = await _invokeTool("shell_git_status", {}, {
        profileId,
        projectId,
        agentId: ctx && typeof ctx.agentId === "number" ? ctx.agentId : null,
      });
      if (!status || status.ok === false) {
        return {
          ok: false,
          reason: "shell_git_status-failed",
          detail: status && status.error ? status.error : null,
        };
      }
      // exec_run is APPROVAL_REQUIRED by security.js; the dispatcher
      // MUST present the dialog to the user. We do not auto-approve.
      // The two invocations are sent separately so each gets its own
      // approval token.
      const message = (args && args[0]) ? args.join(" ") : "Apply Project Mode changes";
      const addResult = await _invokeTool("exec_run", {
        command: "git",
        argv: ["add", "."],
      }, {
        profileId,
        projectId,
        agentId: ctx && typeof ctx.agentId === "number" ? ctx.agentId : null,
      });
      if (!addResult || addResult.ok === false) {
        return { ok: false, step: "add", reason: "exec_run-failed", detail: addResult };
      }
      const commitResult = await _invokeTool("exec_run", {
        command: "git",
        argv: ["commit", "-m", message],
      }, {
        profileId,
        projectId,
        agentId: ctx && typeof ctx.agentId === "number" ? ctx.agentId : null,
      });
      if (!commitResult || commitResult.ok === false) {
        return { ok: false, step: "commit", reason: "exec_run-failed", detail: commitResult };
      }
      return { ok: true, add: addResult, commit: commitResult };
    },
  };
}

/**
 * `/cancel` — call cancelAgent(agentId). No-op (not-running) if there
 * is no active run.
 */
function buildCancelCommand() {
  return {
    id: "cancel",
    name: "cancel",
    description: "Cancel the running agent (cancelAgent).",
    args: [],
    async run(profileId, projectId, args, ctx) {
      const agentId = ctx && typeof ctx.agentId === "number" ? ctx.agentId : null;
      if (!_cancelAgent) return { ok: false, reason: "commands-not-wired" };
      if (agentId == null) return { ok: false, reason: "no-active-agent" };
      return _cancelAgent(agentId);
    },
  };
}

// ---- registration ---------------------------------------------------------

/**
 * Add a command to the registry. `cmd` must be
 * `{ id, name, description, args?, run }`. Re-registering with the
 * same id replaces the previous one (last-write-wins).
 */
function register(cmd) {
  if (!cmd || typeof cmd.id !== "string" || !cmd.id) return;
  if (typeof cmd.name !== "string" || !cmd.name) cmd.name = cmd.id;
  if (typeof cmd.description !== "string") cmd.description = "";
  if (!Array.isArray(cmd.args)) cmd.args = [];
  if (typeof cmd.run !== "function") return;
  registry.set(cmd.id, cmd);
}

/**
 * Remove a command. Returns true if it existed.
 */
function unregister(id) {
  return registry.delete(id);
}

/**
 * Enumerate every registered command as a safe metadata array (no
 * `run` function — those stay in the main process).
 */
function list() {
  return [...registry.values()].map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    args: Array.isArray(c.args) ? c.args.map((a) => ({ ...a })) : [],
  }));
}

/**
 * Parse a "/cmd …" line and dispatch. The dispatcher never throws;
 * every failure mode is returned as a structured envelope.
 */
async function run(profileId, projectId, commandLine, ctx) {
  const parsed = parseCommandLine(commandLine);
  if (!parsed) return { ok: false, reason: "invalid-command-line" };
  const cmd = registry.get(parsed.name);
  if (!cmd) return { ok: false, reason: "unknown-command", name: parsed.name };
  try {
    return await cmd.run(profileId, projectId, parsed.args, ctx || {});
  } catch (e) {
    return { ok: false, reason: "command-threw", message: String(e && e.message || e) };
  }
}

// ---- built-in set ---------------------------------------------------------

/**
 * Register the 7 built-in commands. Idempotent. Called once at IPC
 * register time; tests can call it on a fresh registry.
 */
function registerBuiltins() {
  for (const c of [
    buildPlanCommand(),
    buildReviewCommand(),
    buildTestCommand(),
    buildExplainCommand(),
    buildFixCommand(),
    buildCommitCommand(),
    buildCancelCommand(),
  ]) {
    register(c);
  }
}

// ---- exports --------------------------------------------------------------

export const Commands = {
  register,
  unregister,
  list,
  run,
  parseCommandLine,
  configureCommands,
  registerBuiltins,
  // exposed for tests
  _resetForTests() {
    registry.clear();
    _invokeTool = null;
    _cancelAgent = null;
    _listMessages = null;
    _getAgent = null;
    _getRun = null;
  },
};
