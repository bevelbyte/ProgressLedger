// Project Mode — GATE 21 MULTI-AGENT acceptance scripted model provider (TEST-ONLY).
//
// The most important deliverable of Phase 8: a realistic small
// software repository where the agent must autonomously
//   - understand the project (multiple files)
//   - plan a multi-step implementation
//   - DELEGATE independent work to a sub-agent (parallel execution)
//   - continue its own work in parallel
//   - integrate the sub-agent's result
//   - run tests (FAIL → diagnose → fix → re-test → pass → verify)
//
// The fixture simulates a small project with 3 files:
//   src/auth.js      (existing — the agent reads this)
//   src/api.js       (existing — the agent reads this)
//   test/auth.test.js (existing test — runs to verify)
//
// Task: "Add a `requireRole(role)` function to src/auth.js that
// throws an error if the user role is not in the allowed list, with
// full test coverage."
//
// The agent's natural plan:
//   step-1: inspect src/auth.js (read existing code)
//   step-2: inspect src/api.js (read related code)
//   step-3: dispatch a sub-agent to write test/auth.test.js (PARALLEL with step-4)
//   step-4: implement requireRole in src/auth.js (depends on step-1)
//   step-5: run tests
//   step-6: fix if failed
//
// The 16-round sequence:
//   1. PLAN text — the model proposes a 5-step plan
//   2. INSPECT src/auth.js (step-1 tool call)
//   3. INSPECT src/api.js (step-2 tool call)
//   4. DELEGATE sub-agent to write tests (step-3 tool call) — the
//      sub-agent runs in parallel
//   5. IMPLEMENT requireRole (step-4 tool call — runs in parallel with
//      the sub-agent from round 4)
//   6. TEST (FAIL) — the in-loop test_run returns ok:false (the impl
//      has a bug: case-sensitive role comparison when it should be
//      case-insensitive)
//   7. plan complete; verify gate fires (call 1) — FAIL
//   8. fix-1 step appended
//   9. FIX TEXT — the loop picks fix-1
//   10. FIX TOOL — the agent writes the corrected requireRole
//   11. verify gate fires again (call 2) — PASS
//   12. final summary text

import { scriptedProvider } from "./fixture.js";

export function gate21Sequence() {
  return [
    // R1: PLAN
    {
      text: "Plan: 1) Inspect src/auth.js. 2) Inspect src/api.js. 3) Delegate test writing to a sub-agent. 4) Implement requireRole. 5) Run tests and fix.",
      finishReason: "stop",
    },
    // R2: INSPECT src/auth.js
    {
      toolCalls: [
        { id: "tc-1", name: "fs_read", args: JSON.stringify({ path: "src/auth.js" }) },
      ],
      finishReason: "tool_calls",
    },
    // R3: INSPECT src/api.js
    {
      toolCalls: [
        { id: "tc-2", name: "fs_read", args: JSON.stringify({ path: "src/api.js" }) },
      ],
      finishReason: "tool_calls",
    },
    // R4: DELEGATE sub-agent to write tests
    {
      toolCalls: [
        {
          id: "tc-3",
          name: "delegate_tester",
          args: JSON.stringify({
            objective: "Write test cases for a requireRole function in test/auth.test.js",
            step_id: "step-3",
          }),
        },
      ],
      finishReason: "tool_calls",
    },
    // R5: IMPLEMENT requireRole (the impl has a bug: case-sensitive)
    {
      toolCalls: [
        {
          id: "tc-4",
          name: "fs_write",
          args: JSON.stringify({
            path: "src/auth.js",
            content:
              "const ALLOWED_ROLES = ['admin', 'user'];\n" +
              "function requireRole(role) {\n" +
              "  if (!ALLOWED_ROLES.includes(role)) throw new Error('forbidden');\n" +
              "}\n",
          }),
        },
      ],
      finishReason: "tool_calls",
    },
    // R6: TEST (FAIL — case-sensitive bug)
    {
      toolCalls: [
        { id: "tc-5", name: "test_run", args: JSON.stringify({ command: "node", argv: ["test/auth.test.js"] }) },
      ],
      finishReason: "tool_calls",
    },
    // R7: FIX TEXT — the loop picks fix-1-step-5 (added by verify gate)
    {
      text: "Fix: requireRole should be case-insensitive.",
      finishReason: "stop",
    },
    // R8: FIX TOOL — the corrected impl
    {
      toolCalls: [
        {
          id: "tc-6",
          name: "fs_write",
          args: JSON.stringify({
            path: "src/auth.js",
            content:
              "const ALLOWED_ROLES = ['admin', 'user'];\n" +
              "function requireRole(role) {\n" +
              "  if (!ALLOWED_ROLES.includes(String(role).toLowerCase())) throw new Error('forbidden');\n" +
              "}\n",
          }),
        },
      ],
      finishReason: "tool_calls",
    },
    // R9: FINAL SUMMARY — drained by verify gate's post-success streamChat
    {
      text: "All steps verified. Sub-agent wrote tests; main agent implemented and fixed requireRole. Multi-agent workflow complete.",
      finishReason: "stop",
    },
  ];
}

export function gate21Provider(opts = {}) {
  const seq = Array.isArray(opts.sequence) ? opts.sequence : gate21Sequence();
  return scriptedProvider(seq);
}

export const _forTests = { gate21Sequence, gate21Provider };
