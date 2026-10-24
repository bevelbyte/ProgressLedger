// Project Mode — REALISTIC end-to-end scripted model provider (TEST-ONLY).
//
// This is a richer, more narrative counterpart to `fixture.js`'s
// `defaultE2ESequence`. It exercises a scenario that better matches what a
// real developer agent does:
//
//   1. PLAN text — the model just lays out its approach (no tools yet)
//   2. UNDERSTAND via `inspect_project`
//   3. IMPLEMENT with TWO PARALLEL `fs_write` calls (impl.js + doc.md)
//   4. TEST via `test_run` — the in-loop test returns ok:true but with
//      result.passed=false, so the loop marks step-3 done (the verify
//      gate is what catches the failure, NOT the in-loop step)
//   5. FIX text — the fix step (appended by the verify gate) is picked
//      up, and the model emits a text-only round. The loop marks the fix
//      step done (no tool calls means no work done, but the loop treats
//      any no-tool-call round as "step complete").
//   6. FIX via `fs_write` — a second streamChat round consumes this
//      entry. The stall detector has reset seen-set, so the loop
//      re-enters the model, which now emits the actual fix tool call.
//   7. FINAL SUMMARY — the verify gate's post-success streamChat drains
//      this text into the final `assistant` row, and the loop appends a
//      `verified` status before transitioning to COMPLETED.
//
// The loop flow that consumes this sequence is:
//
//   Outer loop, iter 1:  streamChat -> entry 1 (plan text)
//                        step-1 marked running -> step-1 marked done
//   Outer loop, iter 2:  streamChat -> entry 2 (inspect_project)
//                        step-2 marked running -> step-2 marked done
//   Outer loop, iter 3:  streamChat -> entry 3 (2x fs_write, parallel)
//                        step-3 marked running -> step-3 marked done
//                        isPlanComplete -> verifyCompletion (gated test_run #1)
//                        test_run #1 FAILS -> fix-retrying status appended
//                        fix step appended to plan
//   Outer loop, iter 4:  streamChat -> entry 4 (test_run; this is
//                        step-3's test, but the step is already done)
//                        Actually: this entry is consumed by the iter 3
//                        tool-call path, marking step-3 done. isPlanComplete
//                        is true, so the verify gate runs here (see iter 3).
//   ...
//
// NOTE ON ROUND COUNT: the defaultE2ESequence uses 8 entries but the loop
// only consumes 7. The 8th is a safety net for a hypothetical extra test
// run. The realistic sequence uses 7 entries — enough for the full
// plan + fix-retry + summary flow — and is verified by the test at
// `shell/tests/agent-e2e-realistic.test.js`.
//
// Production code must NOT import this module. It is only a testing
// counterpart to `fixture.js`.
//
// Note: the fixture module (see `fixture.js`) uses `toolCalls` / `args`
// (not `tool_calls` / `arguments`), so this sequence follows the same
// shape so `scriptedProvider` can replay it unchanged.

import { scriptedProvider } from "./fixture.js";

/**
 * Build the realistic multi-step sequence.
 *
 * Each entry is one `streamChat` round. The shape matches
 * `fixture.js`'s ScriptedResponse typedef:
 *   - `text`           string  (emitted as text_delta events)
 *   - `toolCalls`      array   [{ id, name, args }] (args is JSON string)
 *   - `finishReason`   string  ("stop" for text, "tool_calls" for tools)
 *   - `usage`          object  (optional token usage event)
 */
export function realisticSequence() {
  return [
    // Round 1: PLAN — the model describes its approach. No tool calls.
    // The loop marks step-1 (understand) as running, then marks it done
    // because toolCalls is empty.
    {
      text: "Plan: 1) Investigate the project shape. 2) Implement the change (write code + docs in parallel). 3) Run the test suite. 4) Fix any failures and re-verify.",
      finishReason: "stop",
    },
    // Round 2: UNDERSTAND — the model asks to inspect the project.
    // Loop executes `inspect_project`, marks step-1 done (already done),
    // step-2 becomes ready.
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
    // Round 3: IMPLEMENT — TWO PARALLEL `fs_write` calls. This is the
    // multi-tool round the brief asks us to exercise. The loop executes
    // both calls sequentially (the model emits them in one round but the
    // engine runs them in order); step-2 is marked done at the end of
    // the tool-call path.
    {
      toolCalls: [
        {
          id: "tc-2",
          name: "fs_write",
          args: JSON.stringify({
            path: "impl.js",
            content: "// impl — the new worker implementation\nexport function work() { return 1; }\n",
          }),
        },
        {
          id: "tc-3",
          name: "fs_write",
          args: JSON.stringify({
            path: "doc.md",
            content: "# Implementation notes\n\nThis document describes the new worker.\n",
          }),
        },
      ],
      finishReason: "tool_calls",
    },
    // Round 4: TEST — the model runs the test suite. The execute
    // function returns `{ ok: true, result: { passed: false, ... } }`
    // so the loop marks step-3 done (anyToolFailed stays false because
    // the tool envelope is ok). isPlanComplete is now true, so the
    // VERIFY GATE runs.
    //
    // The gate's first test_run call FAILS, so the gate appends a
    // `fix-retrying` status, appends a `fix-1-step-3` step to the plan,
    // and transitions back to PLANNING. The outer loop continues.
    {
      toolCalls: [
        {
          id: "tc-4",
          name: "test_run",
          args: JSON.stringify({
            command: "node",
            argv: ["-e", "process.exit(1)"],
          }),
        },
      ],
      finishReason: "tool_calls",
    },
    // Round 5: FIX TEXT — the loop picks the `fix-1-step-3` step (added
    // by the verify gate), marks it running, and calls streamChat. This
    // round emits text-only, so the loop marks the fix step done and
    // continues.
    {
      text: "All steps verified.",
      finishReason: "stop",
    },
    // Round 6: FIX TOOL CALL — the model emits the actual fix. The
    // stall detector's reset means the seen-set is empty, so the fix
    // step (still marked done from round 5's text round) is NOT
    // picked again. But the model still emits a tool call, and the
    // engine executes it and marks step-3 (the active step at the
    // time of the call) as done. isPlanComplete is true, so the
    // verify gate runs again.
    //
    // The gate's second test_run call PASSES, so the gate transitions
    // VERIFYING -> COMPLETED and appends a `verified` status. It then
    // calls streamChat ONE more time for the final summary.
    {
      toolCalls: [
        {
          id: "tc-5",
          name: "fs_write",
          args: JSON.stringify({
            path: "impl.js",
            content: "// impl (fixed) — the regression is patched\nexport function work() { return 42; }\n",
          }),
        },
      ],
      finishReason: "tool_calls",
    },
    // Round 7: TEST AGAIN — consumed by the second verify gate's
    // test_run call. The gate's tool.execute returns passed:true this
    // time, so the gate transitions to COMPLETED and calls streamChat
    // for the final summary.
    {
      toolCalls: [
        {
          id: "tc-6",
          name: "test_run",
          args: JSON.stringify({
            command: "node",
            argv: ["-e", "process.exit(0)"],
          }),
        },
      ],
      finishReason: "tool_calls",
    },
    // Round 8: FINAL SUMMARY — consumed by the second verify gate's
    // post-success streamChat. This is the message the renderer
    // surfaces as the agent's REPORT. The assertion `lastAssistant
    // contains 'All steps verified'` is anchored on this text.
    {
      text: "All steps verified. 3 steps + 1 fix. Plan complete.",
      finishReason: "stop",
    },
  ];
}

/**
 * Build a scripted provider wired to the realistic sequence. Passes an
 * optional override for the sequence itself (so a caller can splice in
 * custom entries) — but the default is `realisticSequence()`.
 *
 * NOTE: `scriptedProvider` in `fixture.js` takes a plain Array, not an
 * object. The user prompt sketch suggested `{ sequence: [...] }`, but
 * that shape is NOT what `scriptedProvider` reads. We spread the
 * resolved array into the call directly so the fixture module's
 * contract is respected.
 *
 * @param {{ sequence?: Array<object> }} [opts]
 * @returns {{ streamChat: Function, _internal: true, _getRound: () => number }}
 */
export function realisticProvider(opts = {}) {
  const seq = Array.isArray(opts.sequence) ? opts.sequence : realisticSequence();
  return scriptedProvider(seq);
}

// Test-only re-export marker, mirroring fixture.js's `_forTests`.
export const _forTests = {
  realisticSequence,
  realisticProvider,
};
