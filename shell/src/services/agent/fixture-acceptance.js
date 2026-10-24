// Project Mode — ACCEPTANCE end-to-end scripted model provider (TEST-ONLY).
//
// This fixture exercises a realistic development task that requires
// genuine multi-step reasoning:
//
//   Task: "Add a `count_lines` tool to the project that counts non-empty
//   lines in a given file."
//
// The 10-round sequence covers:
//   1. PLAN text — the model lays out a 4-step approach (no tools yet)
//   2. UNDERSTAND via `inspect_project`
//   3. IMPLEMENT with TWO PARALLEL `fs_write` calls (core + CLI wrapper)
//   4. WRITE TESTS with TWO PARALLEL `fs_write` calls (unit + integration)
//   5. TEST via `test_run` — the in-loop test returns ok:true but with
//      result.passed=false. The verify gate's first run also fails, so a
//      `fix-1-step-4` step is appended and the loop re-enters PLANNING.
//   6. FIX-STEP consumes this test_run round (call 2). The tool envelope
//      is ok:true so the fix step is marked done. The gate's second run
//      (call 3) passes.
//   7. The verify gate's post-success streamChat drains this text entry
//      into the final `assistant` row, and the loop appends a `verified`
//      status before transitioning to COMPLETED.
//   8-10. Safety-net rounds (never consumed in the normal flow, but
//      present so a runaway loop terminates gracefully).
//
// The loop flow that consumes this sequence:
//
//   Outer iter 1:  streamChat -> R1 (plan text)       -> step-1 done
//   Outer iter 2:  streamChat -> R2 (inspect)          -> step-2 done
//   Outer iter 3:  streamChat -> R3 (2x fs_write)      -> step-3 done
//   Outer iter 4:  streamChat -> R4 (2x fs_write)      -> step-4 done
//                  isPlanComplete -> verify gate call 1 FAILS
//                  fix-retrying status + fix-1-step-4 appended
//   Outer iter 5:  streamChat -> R5 (test_run + text)  -> fix step done
//                  isPlanComplete -> verify gate call 3 PASSES
//                  gate drains R6 text as final summary
//                  verified status appended -> COMPLETED
//
// Production code must NOT import this module. It is only a testing
// counterpart to `fixture.js` and `fixture-realistic.js`.

import { scriptedProvider } from "./fixture.js";

/**
 * Build the acceptance multi-step sequence.
 *
 * Each entry is one `streamChat` round. The shape matches
 * `fixture.js`'s ScriptedResponse typedef:
 *   - `text`           string  (emitted as text_delta events)
 *   - `toolCalls`      array   [{ id, name, args }] (args is JSON string)
 *   - `finishReason`   string  ("stop" for text, "tool_calls" for tools)
 *   - `usage`          object  (optional token usage event)
 */
export function acceptanceSequence() {
  return [
    // Round 1: PLAN — the model describes its approach. No tool calls.
    {
      text: "Plan: 1) Inspect the project structure. 2) Implement count_lines tool (core module + CLI wrapper in parallel). 3) Write tests (unit + integration in parallel). 4) Run the test suite. 5) Fix any failures and re-verify.",
      finishReason: "stop",
    },
    // Round 2: UNDERSTAND — the model asks to inspect the project.
    {
      toolCalls: [
        {
          id: "tc-1",
          name: "inspect_project",
          args: JSON.stringify({}),
        },
      ],
      finishReason: "tool_calls",
    },
    // Round 3: IMPLEMENT — TWO PARALLEL `fs_write` calls: core module
    // and CLI wrapper. The core has a deliberate edge-case bug:
    // countLines('') returns 1 because ''.split('\n') yields [''].
    {
      toolCalls: [
        {
          id: "tc-2",
          name: "fs_write",
          args: JSON.stringify({
            path: "count_lines.js",
            content: "// count_lines — core implementation\nexport function countLines(content) { return content.split('\\n').length; }\n",
          }),
        },
        {
          id: "tc-3",
          name: "fs_write",
          args: JSON.stringify({
            path: "count_lines.cli.js",
            content: "// count_lines — CLI wrapper\nconst { countLines } = require('./count_lines.js');\nconst input = require('fs').readFileSync(0, 'utf-8');\nconsole.log(countLines(input));\n",
          }),
        },
      ],
      finishReason: "tool_calls",
    },
    // Round 4: WRITE TESTS — TWO PARALLEL `fs_write` calls: unit test
    // (catches the empty-string bug) and integration test.
    {
      toolCalls: [
        {
          id: "tc-4",
          name: "fs_write",
          args: JSON.stringify({
            path: "count_lines.test.js",
            content: "// count_lines — unit tests\nconst { countLines } = require('./count_lines.js');\n// Expects 0 for empty string but the buggy impl returns 1\nif (countLines('') !== 0) { console.error('FAIL: empty string -> ' + countLines('')); process.exit(1); }\nif (countLines('hello') !== 1) { console.error('FAIL'); process.exit(1); }\nif (countLines('a\\nb\\nc') !== 3) { console.error('FAIL'); process.exit(1); }\nconsole.log('PASS');\n",
          }),
        },
        {
          id: "tc-5",
          name: "fs_write",
          args: JSON.stringify({
            path: "count_lines.integration.test.js",
            content: "// count_lines — integration test\nconst { execSync } = require('child_process');\nconst output = execSync('node count_lines.cli.js', { input: 'line1\\nline2\\nline3\\n' }).toString().trim();\nif (output !== '3') { console.error('FAIL: expected 3, got ' + output); process.exit(1); }\nconsole.log('INTEGRATION PASS');\n",
          }),
        },
      ],
      finishReason: "tool_calls",
    },
    // Round 5: RUN TESTS + DIAGNOSE — the model runs the test suite.
    // The tool returns ok:true / passed:false so the loop marks the
    // fix step done (anyToolFailed stays false). The text delta carries
    // the model's diagnosis of the bug.
    {
      toolCalls: [
        {
          id: "tc-6",
          name: "test_run",
          args: JSON.stringify({
            command: "node",
            argv: ["-e", "process.exit(1)"],
          }),
        },
      ],
      text: "Tests fail. countLines('') returns 1 because ''.split('\\n') yields [''], not []. The fix is to handle empty input explicitly and filter blank lines.",
      finishReason: "tool_calls",
    },
    // Round 6: FINAL SUMMARY — consumed by the verify gate's post-success
    // streamChat. This is the message the renderer surfaces as the
    // agent's REPORT. The assertion `lastAssistant contains
    // 'All steps verified'` is anchored on this text.
    {
      text: "All steps verified. count_lines tool implemented, tested, and fixed. The empty-string edge case is now handled correctly. 4 steps + 1 fix. Plan complete.",
      finishReason: "stop",
    },
    // Round 7: FIX (safety net) — never consumed in the normal flow.
    // Present so a runaway loop has a fix tool call to execute.
    {
      toolCalls: [
        {
          id: "tc-7",
          name: "fs_write",
          args: JSON.stringify({
            path: "count_lines.js",
            content: "// count_lines — core implementation (fixed)\nexport function countLines(content) { if (!content || content.trim() === '') return 0; return content.split('\\n').filter(line => line.trim() !== '').length; }\n",
          }),
        },
      ],
      finishReason: "tool_calls",
    },
    // Round 8: RE-RUN TESTS (safety net) — never consumed.
    {
      toolCalls: [
        {
          id: "tc-8",
          name: "test_run",
          args: JSON.stringify({
            command: "node",
            argv: ["-e", "process.exit(0)"],
          }),
        },
      ],
      finishReason: "tool_calls",
    },
    // Round 9: EXTRA (safety net) — never consumed.
    {
      toolCalls: [
        {
          id: "tc-9",
          name: "test_run",
          args: JSON.stringify({
            command: "node",
            argv: ["-e", "process.exit(0)"],
          }),
        },
      ],
      finishReason: "tool_calls",
    },
    // Round 10: EXTRA (safety net) — never consumed.
    {
      text: "Plan complete. All steps verified and tests passing.",
      finishReason: "stop",
    },
  ];
}

/**
 * Build a scripted provider wired to the acceptance sequence.
 *
 * @param {{ sequence?: Array<object> }} [opts]
 * @returns {{ streamChat: Function, _internal: true, _getRound: () => number }}
 */
export function acceptanceProvider(opts = {}) {
  const seq = Array.isArray(opts.sequence) ? opts.sequence : acceptanceSequence();
  return scriptedProvider(seq);
}

// Test-only re-export marker.
export const _forTests = {
  acceptanceSequence,
  acceptanceProvider,
};
