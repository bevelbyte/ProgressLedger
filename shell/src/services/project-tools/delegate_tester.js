// Tool: delegate_tester — spawn a TESTER sub-agent. See
// delegate_research.js for the architecture notes. Thin wrapper.

import { runDelegate } from "./delegate_research.js";

export const ROLE = "tester";

export const tool = {
  name: "delegate_tester",
  description:
    "Spawn a tester sub-agent with read+git+test_run tools. Blocks until the child completes " +
    "(or 5 min timeout) and returns { exit_code, stdout_tail, stderr_tail, passed }.",
  permission: "NETWORK",
  inputSchema: {
    type: "object",
    properties: {
      objective: { type: "string", description: "What the tester should verify" },
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