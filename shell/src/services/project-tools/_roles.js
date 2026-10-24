// Sub-agent role configuration.
//
// The 4 specialized sub-agents (researcher / coder / tester / reviewer)
// each have:
//   - a system prompt prepended to the child's objective,
//   - a scoped tool allow-list (the registry filters by name),
//   - a default expected_output_shape that the child is told to return.
//
// This file is the single source of truth for these definitions. The
// delegate_* tool files reference ROLE_PROMPTS / ROLE_TOOLS /
// ROLE_OUTPUT_SHAPE to compose the child objective that pmCreateAgent
// stores on the new pm_agents row.
//
// IMPORTANT: this file exists in the shell only. The Rust pm_agents
// schema is unchanged — the role is encoded in the child's objective
// string and the parent/child relationship in the parent's plan_json.

export const ROLE_PROMPTS = Object.freeze({
  researcher:
    "You are a research sub-agent. Inspect the project (inspect_project, fs_list, " +
    "fs_read, fs_search) and gather facts. Do NOT modify files. Return a concise " +
    "structured report of what you found that the parent agent can act on.",
  coder:
    "You are a coding sub-agent. You may read and modify files (fs_write) inside " +
    "the project root and inspect git state (shell_git_status, shell_git_diff). " +
    "Make focused, minimal edits. Return a summary of files_changed and the " +
    "rationale for each change.",
  tester:
    "You are a test sub-agent. Run the project's test suite via test_run. Return " +
    "{ exit_code, stdout_tail, stderr_tail, passed } so the parent can decide " +
    "whether the change is safe to merge.",
  reviewer:
    "You are a code-review sub-agent. Read-only: inspect_project, fs_list, " +
    "fs_read, fs_search, shell_git_diff. Do NOT modify files. Return " +
    "{ files_changed, findings, recommendations }.",
});

// Scoped tool allow-lists per role. Names must match entries in
// shell/src/services/project-tools/index.js. The child loop filters its
// model-visible tool set by these names so a researcher, for example,
// cannot call fs_write even if the parent could.
export const ROLE_TOOLS = Object.freeze({
  researcher: ["fs_list", "fs_read", "fs_search", "inspect_project"],
  coder: [
    "fs_list",
    "fs_read",
    "fs_search",
    "fs_write",
    "shell_git_status",
    "shell_git_diff",
    "inspect_project",
  ],
  tester: [
    "fs_list",
    "fs_read",
    "fs_search",
    "shell_git_status",
    "shell_git_diff",
    "test_run",
    "inspect_project",
  ],
  reviewer: [
    "fs_list",
    "fs_read",
    "fs_search",
    "shell_git_diff",
    "shell_git_log",
    "inspect_project",
  ],
});

// Default expected output shape — passed to the child in its objective
// so the model returns a structured result the parent can consume.
export const ROLE_OUTPUT_SHAPE = Object.freeze({
  researcher:
    "{ summary: string, findings: [...], cited_files: [...] }",
  coder:
    "{ files_changed: [...], summary: string, notes: string }",
  tester:
    "{ exit_code: number, stdout_tail: string, stderr_tail: string, passed: bool }",
  reviewer:
    "{ files_changed: [...], findings: string, recommendations: [...] }",
});

// All known role names. Used to validate input on the delegate_* tools.
export const ROLES = Object.freeze(["researcher", "coder", "tester", "reviewer"]);

// Architectural cap: a parent may have at most this many in-flight
// sub-agents. A 4th delegate_* call returns
// { ok: false, error: { code: 'too-many-concurrent-subagents' } }.
export const MAX_CONCURRENT_SUBAGENTS = 3;

// Names of every delegate_* tool. The child loop filters these out of
// its own model-visible tool set as the recursion guard.
export const DELEGATE_TOOL_NAMES = Object.freeze([
  "delegate_research",
  "delegate_coder",
  "delegate_tester",
  "delegate_reviewer",
]);

/**
 * Build the child objective string. We embed role + step + files +
 * expected output shape so the existing pmCreateAgent(projectId,
 * objective) signature is unchanged.
 *
 * The structure is a single plain-text brief; the child loop's system
 * prompt pre-pends the role prompt and the runtime enforces the tool
 * allow-list. Storing it as plain text (not JSON) keeps the schema
 * migration-free and is robust to whitespace.
 */
export function buildChildObjective(role, { objective, stepId, files, expectedOutputShape }) {
  if (!ROLES.includes(role)) {
    throw new Error(`unknown role: ${role}`);
  }
  const shape = expectedOutputShape || ROLE_OUTPUT_SHAPE[role];
  const fileList = Array.isArray(files) && files.length > 0
    ? files.map((f) => `- ${f}`).join("\n")
    : "(none specified)";
  return [
    `[role] ${role}`,
    `[step] ${stepId || "unspecified"}`,
    `[expected_output_shape] ${shape}`,
    `[files]`,
    fileList,
    `[objective]`,
    objective || "",
  ].join("\n");
}