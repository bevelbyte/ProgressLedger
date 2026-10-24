// Project Mode â€” tool security model.
//
// Phase 5: permissions, approval tokens, schema validation.
//
// The renderer is sandboxed (contextIsolation: true, nodeIntegration: false,
// sandbox: true). It cannot reach the filesystem or child_process directly.
// Every privileged operation goes through this layer via IPC. The "security"
// here is not the sandbox itself â€” that is enforced by the BrowserWindow
// configuration. This file exists to:
//   - classify tools into a small set of permissions the UI can show;
//   - gate the dangerous tools behind a user-approval flow (the UI shows a
//     dialog; we hand back a short-lived token);
//   - validate inputs against the tool's hand-rolled JSON-Schema subset.
//
// Approval tokens are NOT the security boundary. They exist so the
// renderer can confirm "the user clicked Approve" without us writing a
// real auth system. The sandbox is the boundary.

import path from "node:path";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";

// ---- permissions ----------------------------------------------------------

export const PERMISSIONS = Object.freeze({
  READ: "READ",
  WRITE: "WRITE",
  EXECUTE: "EXECUTE",
  NETWORK: "NETWORK",
  DESTRUCTIVE: "DESTRUCTIVE",
});

// Tools that require explicit user approval before they can run. The
// approval flow is:
//   1. Renderer calls `project:invoke-tool` with { toolName, input }.
//   2. Main process sees the tool is in this set and returns
//      { ok: false, requiresApproval: { tool, input, permission } }.
//   3. Renderer shows a dialog. On Approve, the renderer calls
//      `project:approve-and-invoke` with the same { toolName, input }
//      plus an `approvalToken` we mint through `project:approve`.
//   4. Main process checks the token (in-memory, 60s TTL) and runs.
//
// `fs_write` is gated because a Project Mode agent writing files
// arbitrarily inside the project is the destructive surface worth a
// confirmation. `exec_run` is the biggest one â€” arbitrary shell. The
// git_* tools are READ-ONLY so they do not need approval.
//
// The `delegate_*` tools are NETWORK-class (they may spawn additional
// model contexts), but they are deliberately NOT in APPROVAL_REQUIRED:
// once the user has started a Project Mode agent, spawning a sub-agent
// to handle a step is an internal continuation of the same workflow.
// Requiring approval per sub-agent would defeat the purpose of delegation
// and add a click-per-step UX tax. They are still permission-classed
// NETWORK so the UI can surface a one-time hint at session start.
export const APPROVAL_REQUIRED = new Set([
  "exec_run",
  "fs_write",
  "test_run",
  "build_run",
  // The legacy browser_* names are now READ-only compatibility refusals:
  // their registered tools return feature-not-supported without any browser
  // side effect, so they must not prompt for approval before refusing.
]);

/**
 * Static tools retain the explicit approval contract above. Runtime tools
 * (notably MCP bridges) cannot be enumerated in that set, so any dynamic tool
 * whose declared capability is not READ is approval-gated as well. This keeps
 * a remote tool from becoming an approval bypass merely because it was
 * discovered after startup.
 */
export function requiresToolApproval(toolName, tool) {
  return APPROVAL_REQUIRED.has(toolName) || (
    typeof toolName === "string" && toolName.startsWith("mcp_") &&
    tool && tool.permission !== PERMISSIONS.READ
  );
}

const FORBIDDEN_COMMANDS = new Set(["bash", "sh", "zsh", "fish", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "python", "python3", "python.exe", "python3.exe", "perl", "ruby", "deno", "bun", "node", "node.exe"]);
const APPROVED_PROJECT_COMMANDS = new Set(["npm", "npm.cmd", "npx", "npx.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "cargo", "cargo.exe", "pytest", "pytest.exe", "go", "go.exe", "dotnet", "dotnet.exe", "mvn", "mvn.cmd", "gradle", "gradle.bat", "gradlew", "gradlew.bat", "make", "make.exe", "git", "git.exe"]);
export function validateProjectCommand(command) {
  if (typeof command !== "string" || !command.trim()) return { ok: false, error: { code: "invalid-input", message: "command is required" } };
  const value = command.trim();
  const base = value.replace(/^.*[/\\\\]/, "").toLowerCase();
  const hasPath = /[/\\\\]/.test(value) || /^[a-zA-Z]:/.test(value);
  if (hasPath || FORBIDDEN_COMMANDS.has(base) || !APPROVED_PROJECT_COMMANDS.has(base)) {
    return { ok: false, error: { code: "permission-denied", message: "command is not an approved project command" } };
  }
  return { ok: true };
}

// Human-readable permission labels + descriptions for the UI.
export const PERMISSION_INFO = Object.freeze({
  READ: {
    label: "Read",
    description: "Read files or repository metadata. No mutations.",
  },
  WRITE: {
    label: "Write",
    description: "Modify files inside the project root.",
  },
  EXECUTE: {
    label: "Execute",
    description: "Run shell commands, tests, or builds inside the project root.",
  },
  NETWORK: {
    label: "Network",
    description: "Make outbound network requests.",
  },
  DESTRUCTIVE: {
    label: "Destructive",
    description: "Irreversible action (delete repo, force push, etc).",
  },
});

// ---- approval tokens ------------------------------------------------------

// In-memory token table. NOT a security boundary â€” the sandbox is.
const tokens = new Map(); // token -> { toolName, input, expiresAt }

/** How long an approval token stays valid. */
export const APPROVAL_TOKEN_TTL_MS = 60_000;

/** Mint a new approval token bound to a (toolName, input, ownership scope) tuple. */
export function mintApprovalToken(toolName, input, scope = null) {
  const token = randomBytes(16).toString("hex");
  tokens.set(token, {
    toolName,
    input,
    scope: normalizeApprovalScope(scope),
    expiresAt: Date.now() + APPROVAL_TOKEN_TTL_MS,
  });
  return token;
}

/**
 * Consume an approval token. Returns true iff the token exists, has not
 * expired, and matches the requested (toolName, input, ownership scope). Expired tokens
 * are purged on the way through. Single-use semantics: a successful
 * consume deletes the token.
 */
export function consumeApprovalToken(token, toolName, input, scope = null) {
  if (typeof token !== "string" || token.length === 0) return false;
  const rec = tokens.get(token);
  if (!rec) return false;
  if (rec.expiresAt < Date.now()) {
    tokens.delete(token);
    return false;
  }
  if (rec.toolName !== toolName) return false;
  if (!sameInput(rec.input, input)) return false;
  if (!sameInput(rec.scope, normalizeApprovalScope(scope))) return false;
  tokens.delete(token);
  return true;
}

function normalizeApprovalScope(scope) {
  if (!scope || typeof scope !== "object") return null;
  const { profileId, projectId, agentId } = scope;
  if (![profileId, projectId, agentId].every(Number.isInteger)) return null;
  return { profileId, projectId, agentId };
}

/** Drop every expired token. Exposed for tests. */
export function purgeExpiredApprovalTokens(now = Date.now()) {
  for (const [k, v] of tokens) {
    if (v.expiresAt < now) tokens.delete(k);
  }
  return tokens.size;
}

/** Clear all tokens. Exposed for tests. */
export function _resetApprovalTokens() {
  tokens.clear();
}

function sameInput(a, b) {
  // Loose deep equality sufficient for our payloads (paths, strings,
  // numbers, booleans, arrays of those). Anything exotic and the token
  // is rejected â€” that's a feature.
  try {
    return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
  } catch {
    return false;
  }
}

function stable(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(stable);
  const out = {};
  for (const k of Object.keys(v).sort()) out[k] = stable(v[k]);
  return out;
}

// ---- input validation -----------------------------------------------------
//
// We don't pull in Ajv. The schema we accept is the tiny subset we
// actually use: { type: 'object', properties: {...}, required: [...],
// additionalProperties?: bool }. Property types are 'string' | 'number'
// | 'integer' | 'boolean' | 'array' | 'object', with optional `enum`.

/**
 * Validate `input` against a minimal JSON-Schema-like definition.
 * Returns { ok: true } or { ok: false, error: { code, message } }.
 */
export function validateInputAgainstSchema(schema, input) {
  if (!schema || typeof schema !== "object") {
    return { ok: true };
  }
  if (schema.type === "object") {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return err("invalid-input", "input must be an object");
    }
    const props = schema.properties || {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!(key in input)) {
        return err("invalid-input", `missing required field: ${key}`);
      }
    }
    const additional = schema.additionalProperties !== false;
    for (const [k, v] of Object.entries(input)) {
      const sub = props[k];
      if (!sub) {
        if (!additional) {
          return err("invalid-input", `unexpected field: ${k}`);
        }
        continue;
      }
      const r = validateValue(sub, v);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  // Top-level non-object schemas (rare). Fall through to single-value.
  return validateValue(schema, input);
}

function validateValue(schema, value) {
  if (!schema || typeof schema !== "object") return { ok: true };

  // enum
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      return err("invalid-input", `value not in enum: ${JSON.stringify(value)}`);
    }
  }

  const t = schema.type;
  if (t === "string") {
    if (typeof value !== "string") return err("invalid-input", "expected string");
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      return err("invalid-input", "string too short");
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      return err("invalid-input", "string too long");
    }
  } else if (t === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return err("invalid-input", "expected number");
    }
  } else if (t === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return err("invalid-input", "expected integer");
    }
  } else if (t === "boolean") {
    if (typeof value !== "boolean") return err("invalid-input", "expected boolean");
  } else if (t === "array") {
    if (!Array.isArray(value)) return err("invalid-input", "expected array");
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return err("invalid-input", "array too short");
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return err("invalid-input", "array too long");
    }
    if (schema.items && typeof schema.items === "object") {
      for (let i = 0; i < value.length; i++) {
        const r = validateValue(schema.items, value[i]);
        if (!r.ok) return r;
      }
    }
  } else if (t === "object") {
    return validateInputAgainstSchema(schema, value);
  }
  return { ok: true };
}

function err(code, message) {
  return { ok: false, error: { code, message } };
}

// ---- invocation validation ------------------------------------------------

/**
 * Validate a renderer-initiated tool invocation. Returns { ok, error? }.
 * Does NOT run the tool â€” that's the IPC layer's job.
 */
export function validateToolInvocation(toolName, input, registry) {
  if (typeof toolName !== "string" || !toolName) {
    return { ok: false, error: { code: "invalid-input", message: "toolName is required" } };
  }
  const tool = registry && registry.getTool ? registry.getTool(toolName) : null;
  if (!tool) {
    return { ok: false, error: { code: "tool-not-supported", message: `unknown tool: ${toolName}` } };
  }
  if (!PERMISSIONS[tool.permission]) {
    return { ok: false, error: { code: "invalid-input", message: `bad permission on tool ${toolName}` } };
  }
  const inputResult = validateInputAgainstSchema(tool.inputSchema, input);
  if (!inputResult.ok) return inputResult;
  return { ok: true };
}

// ---- path sandbox ---------------------------------------------------------

/**
 * Resolve `candidate` against `projectRoot` and assert it stays inside.
 * Returns the absolute resolved path on success, or an error envelope.
 *
 * `candidate` may be absolute (we accept it as-is and verify) or relative
 * (we resolve it relative to projectRoot).
 */
export function assertInsideProjectRoot(candidate, projectRoot) {
  if (!candidate || typeof candidate !== "string") {
    return { ok: false, error: { code: "invalid-input", message: "path is required" } };
  }
  if (!projectRoot || typeof projectRoot !== "string") {
    return { ok: false, error: { code: "invalid-input", message: "projectRoot is required" } };
  }
  const absRoot = canonicalizeExistingPath(path.resolve(projectRoot));
  if (!absRoot) {
    return { ok: false, error: { code: "invalid-input", message: "projectRoot does not exist" } };
  }
  const absCandidate = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(absRoot, candidate);

  // Lexical containment is not sufficient on Windows: a symlink/junction/
  // reparse point inside the project can redirect an apparently-contained
  // path outside the project root. Canonicalize the existing portion before
  // applying the containment test. For a path that does not exist yet (for
  // example a new fs_write target), canonicalize its nearest existing parent
  // and append only the non-existent suffix.
  const canonicalCandidate = canonicalizePathWithExistingAncestor(absCandidate);
  if (!canonicalCandidate) {
    return { ok: false, error: { code: "path-outside-project", message: "path cannot be safely resolved" } };
  }

  const canonicalRootWithSep = process.platform === "win32"
    ? ensureTrailingSepWin(absRoot).toLowerCase()
    : absRoot + path.sep;
  const canonicalCandidateWithSep = process.platform === "win32"
    ? ensureTrailingSepWin(canonicalCandidate).toLowerCase()
    : canonicalCandidate + path.sep;

  if (canonicalCandidate === absRoot) return { ok: true, path: canonicalCandidate };
  if (!canonicalCandidateWithSep.startsWith(canonicalRootWithSep)) {
    return { ok: false, error: { code: "path-outside-project", message: "path resolves outside project root" } };
  }
  return { ok: true, path: canonicalCandidate };
}

function canonicalizeExistingPath(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

function canonicalizePathWithExistingAncestor(absPath) {
  let cursor = absPath;
  const suffix = [];
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const canonicalBase = canonicalizeExistingPath(cursor);
  if (!canonicalBase) return null;
  return suffix.reduce((current, segment) => path.join(current, segment), canonicalBase);
}

function ensureTrailingSepWin(p) {
  return p.endsWith("\\") ? p : p + "\\";
}
