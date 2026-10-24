// Project Mode — REAL PROJECT acceptance scripted model provider (TEST-ONLY).
//
// Represents a small but realistic software repository with multiple
// files + a real implementation task.
//
// The fixture simulates this small project layout:
//   src/util.js      (existing helper module, reads as input)
//   src/api.js       (existing data fetcher, no edits)
//   test/util.test.js (existing test file, may need updates)
//   src/parse-csv.js (NEW — the file the agent will create)
//
// Task: "Add a `parseCSV(text)` function to src/util.js that splits a
// comma-separated string into a trimmed array of non-empty strings,
// with full test coverage."
//
// The 14-round sequence:
//   1. PLAN text — the model proposes a 4-step plan
//   2. INSPECT — the model reads src/util.js
//   3. INSPECT (test file) — the model reads test/util.test.js
//   4. IMPLEMENT — the model writes the new parseCSV function to src/util.js
//   5. TEST (FAIL) — the test_run in-loop returns ok:false (the impl
//      has a bug: it doesn't trim whitespace)
//   6. The plan is now complete; verify gate fires its first test_run
//      which also fails (call 2). A fix-1-step-5 step is appended.
//   7. FIX TEXT — the loop consumes this for the fix step
//   8. FIX TOOL — the model writes the corrected parseCSV (now trims)
//   9. The plan is complete; verify gate fires test_run again (call 3)
//      which now passes
//   10. The verify gate's post-success streamChat drains the final
//       summary round
//   11-14. Safety-net rounds (never consumed in normal flow)

import { scriptedProvider } from "./fixture.js";

/**
 * Build the real-project acceptance sequence.
 * Each entry is one streamChat round.
 */
export function realProjectSequence() {
  return [
    // R1: PLAN
    {
      text: "Plan: 1) Inspect src/util.js to see existing helpers. 2) Inspect test/util.test.js to see test conventions. 3) Add parseCSV to src/util.js. 4) Verify with the test suite.",
      finishReason: "stop",
    },
    // R2: INSPECT src/util.js
    {
      toolCalls: [
        { id: "tc-1", name: "fs_read", args: JSON.stringify({ path: "src/util.js" }) },
      ],
      finishReason: "tool_calls",
    },
    // R3: INSPECT test/util.test.js
    {
      toolCalls: [
        { id: "tc-2", name: "fs_read", args: JSON.stringify({ path: "test/util.test.js" }) },
      ],
      finishReason: "tool_calls",
    },
    // R4: IMPLEMENT — write the new parseCSV function to src/util.js
    // The initial implementation has a bug: it doesn't trim whitespace,
    // so the in-loop test will fail.
    {
      toolCalls: [
        {
          id: "tc-3",
          name: "fs_write",
          args: JSON.stringify({
            path: "src/util.js",
            content:
              "export function parseCSV(text) {\n" +
              "  return text.split(',');\n" +
              "}\n",
          }),
        },
      ],
      finishReason: "tool_calls",
    },
    // R5: TEST — in-loop test_run returns ok:false (result.passed=false)
    {
      toolCalls: [
        { id: "tc-4", name: "test_run", args: JSON.stringify({ command: "node", argv: ["test/util.test.js"] }) },
      ],
      finishReason: "tool_calls",
    },
    // R6: FIX TEXT — consumed by the fix-1-step-5 step (appended by the verify gate)
    {
      text: "Fix: trim whitespace in parseCSV.",
      finishReason: "stop",
    },
    // R7: FIX TOOL — write the corrected parseCSV
    {
      toolCalls: [
        {
          id: "tc-5",
          name: "fs_write",
          args: JSON.stringify({
            path: "src/util.js",
            content:
              "export function parseCSV(text) {\n" +
              "  return text.split(',').map(s => s.trim()).filter(Boolean);\n" +
              "}\n",
          }),
        },
      ],
      finishReason: "tool_calls",
    },
    // R8: FINAL SUMMARY — drained by the verify gate's post-success streamChat
    {
      text: "All steps verified. parseCSV now splits, trims, and filters empty strings.",
      finishReason: "stop",
    },
  ];
}

export function realProjectProvider(opts = {}) {
  const seq = Array.isArray(opts.sequence) ? opts.sequence : realProjectSequence();
  return scriptedProvider(seq);
}

export const _forTests = { realProjectSequence, realProjectProvider };
