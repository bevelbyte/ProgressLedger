// Tool: delegate_coder — spawn a CODER sub-agent and wait for it to
// finish. See delegate_research.js for the full architecture + the
// plan_json schema workaround. This file is a thin wrapper that points
// the executor at the shared `runDelegate(role, ...)` helper.

import { runDelegate } from "./delegate_research.js";

export const ROLE = "coder";

export const tool = {
  name: "delegate_coder",
  description:
    "Spawn a coder sub-agent with read+write+git tools. Blocks until the child completes " +
    "(or 5 min timeout) and returns its final assistant message.",
  permission: "NETWORK",
  inputSchema: {
    type: "object",
    properties: {
      objective: { type: "string", description: "What the coder should implement" },
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