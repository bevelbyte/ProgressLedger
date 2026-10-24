// Tool: delegate_reviewer — spawn a REVIEWER sub-agent (read-only).
// See delegate_research.js for the architecture notes. Thin wrapper.

import { runDelegate } from "./delegate_research.js";

export const ROLE = "reviewer";

export const tool = {
  name: "delegate_reviewer",
  description:
    "Spawn a reviewer sub-agent with read-only tools + git diff. Blocks until the child " +
    "completes (or 5 min timeout) and returns { files_changed, findings, recommendations }.",
  permission: "NETWORK",
  inputSchema: {
    type: "object",
    properties: {
      objective: { type: "string", description: "What the reviewer should evaluate" },
      step_id: { type: "string", description: "Identifier of the parent plan step" },
      files: {
        type: "array",
        items: { type: "string" },
        description: "Optional scoped file list",
      },
      expected_output_shape: { type: "string", description: "Override the role's default output shape" },
    },
    required: ["objective", "step_id"],
  },
  outputSchema: {
    type: "object",
    properties: {
      child_agent_id: { type: "number" },
      state: { type: "string" },
      result: { type: "object" },
    },
  },
  timeoutMs: 5 * 60 * 1000,

  async execute(input, ctx) {
    return runDelegate(ROLE, input, ctx);
  },
};