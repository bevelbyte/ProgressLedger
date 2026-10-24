// Project Mode — TEST-ONLY scripted model provider.
//
// This module is a deterministic, network-free provider that REPLAYS a
// pre-defined sequence of model responses. It exists purely so that the
// end-to-end agent flow (GOAL -> UNDERSTAND -> PLAN -> TOOLS ->
// IMPLEMENT -> TEST -> FAILURE -> RECOVERY -> VERIFY -> COMPLETE ->
// REPORT) can be exercised without a real LLM endpoint.
//
// PRODUCTION PATH: do NOT use this provider. The production default in
// `loop.js` is `createOpenAiProvider` / `createMockProvider`. This
// fixture is exported under an `_internal` name and a `_forTests`
// re-export so production callers cannot pick it up by accident.
//
// Shape of a scripted response (one entry in the sequence):
//
//   {
//     text?: string,                 // accumulated text delta(s)
//     toolCalls?: Array<{ id, name, args }>,  // tool calls to emit
//     finishReason?: string,         // default "stop" if no tool calls,
//                                    // "tool_calls" if toolCalls present
//     usage?: { inputTokens, outputTokens }, // optional usage event
//   }
//
// The scripted provider replays these entries in order, one per
// `streamChat` call from the agent loop. After the final entry, every
// subsequent `streamChat` call emits a synthetic finish-only response
// (so a runaway loop terminates gracefully).
//
// The test layer (tests/agent-e2e.test.js) wires this provider together
// with a fake `core` and a script of tool results to walk the full
// multi-step loop end-to-end.

/**
 * @typedef {Object} ScriptedResponse
 * @property {string} [text]
 * @property {Array<{id:string,name:string,args:string}>} [toolCalls]
 * @property {string} [finishReason]
 * @property {{inputTokens:number,outputTokens:number}} [usage]
 */

/**
 * Build a scripted provider. The returned object satisfies the
 * `{ streamChat }` shape the agent loop expects.
 *
 * @param {ScriptedResponse[]} scriptedSequence
 * @returns {{
 *   streamChat: (opts?: object) => AsyncGenerator<object>,
 *   _internal: true,
 *   _getRound: () => number,
 * }}
 */
export function scriptedProvider(scriptedSequence) {
  const seq = Array.isArray(scriptedSequence) ? scriptedSequence : [];
  let round = 0;
  const prov = {
    async *streamChat(_opts = {}) {
      round += 1;
      const entry = seq[round - 1];
      if (!entry) {
        // Past the end of the script: emit a no-op finish so any
        // accidental additional loop iteration terminates gracefully.
        yield { type: "finish", reason: "stop" };
        return;
      }
      const { text = "", toolCalls = [], finishReason, usage } = entry;
      // Tool calls first so the loop wires them up before any text.
      for (const tc of toolCalls) {
        yield { type: "tool_call", id: tc.id, name: tc.name, args: tc.args };
      }
      if (typeof text === "string" && text.length > 0) {
        // Split into two deltas to exercise streaming aggregation,
        // matching the real provider's behavior.
        const mid = Math.max(1, Math.floor(text.length / 2));
        yield { type: "text_delta", delta: text.slice(0, mid) };
        yield { type: "text_delta", delta: text.slice(mid) };
      }
      // Emit a usage event for every text-only round so the loop's
      // budget-tracking path is exercised, matching the real provider
      // (createMockProvider also emits usage unconditionally). When the
      // script author supplies explicit usage, prefer that; otherwise
      // emit a small synthetic delta so the loop always sees one.
      const hasUsage = usage && typeof usage === "object";
      if (!hasUsage && text.length > 0 && toolCalls.length === 0) {
        yield { type: "usage", inputTokens: 11, outputTokens: 22 };
      } else if (hasUsage) {
        yield {
          type: "usage",
          inputTokens: Number(usage.inputTokens || 0),
          outputTokens: Number(usage.outputTokens || 0),
        };
      }
      const reason = typeof finishReason === "string" && finishReason.length > 0
        ? finishReason
        : (toolCalls.length > 0 ? "tool_calls" : "stop");
      yield { type: "finish", reason };
    },
    // Marker: this is a test-only fixture; production code should not
    // import this module. The `loop.js` production default ignores
    // fixtures by checking for `_internal === true` on any passed-in
    // provider.
    _internal: true,
    _getRound() {
      return round;
    },
  };
  return prov;
}

/**
 * The 6-step scripted sequence used by the end-to-end test. Each step
 * mirrors one `streamChat` round in the agent loop:
 *
 *   1. PLAN — model emits text describing a 3-step plan (no tool calls).
 *   2. UNDERSTAND — model emits an `inspect_project` tool call.
 *   3. IMPLEMENT — model emits an `fs_write` tool call.
 *   4. TEST — model emits a `test_run` tool call.
 *   5. COMPLETE — model emits the final summary text and stops.
 *   6. SAFETY — the verification gate may invoke another round if a fix
 *      step is required. We include a "fix" round for the failure /
 *      recovery leg of the loop.
 *
 * The first invocation runs the GOAL -> UNDERSTAND -> IMPLEMENT path.
 * Then the verification gate's first run fails (scripted to return
 * test-failed). The loop inserts a fix step, re-enters planning, and
 * the model emits `fs_write` again (round 6). A second test_run
 * returns test-passed, verification emits `verified`, and the loop
 * transitions to `completed`.
 *
 * The fixture's tool result layer is supplied by the test, not by this
 * module.
 */
export function defaultE2ESequence() {
  return [
    // 1) PLAN — model returns a plan in text.
    {
      text: "Plan: 1) Understand repo shape. 2) Implement change. 3) Run tests.",
      finishReason: "stop",
    },
    // 2) UNDERSTAND — model asks to inspect the project.
    {
      toolCalls: [
        { id: "tc-1", name: "inspect_project", args: JSON.stringify({}) },
      ],
      finishReason: "tool_calls",
    },
    // 3) IMPLEMENT — model writes a file.
    {
      toolCalls: [
        { id: "tc-2", name: "fs_write", args: JSON.stringify({ path: "/tmp/e2e/fixture.js", content: "// generated by e2e\n" }) },
      ],
      finishReason: "tool_calls",
    },
    // 4) TEST — model runs the tests.
    {
      toolCalls: [
        { id: "tc-3", name: "test_run", args: JSON.stringify({ command: "node", argv: ["-e", "process.exit(1)"] }) },
      ],
      finishReason: "tool_calls",
    },
    // 5) COMPLETE — final summary text emitted AFTER verify-gate
    // success. The fix-retry round (the post-failure re-entry into
    // PLANNING) consumes this round as a text-only reply from the
    // model: no tool calls, so the loop marks the fix step done,
    // re-runs the verification gate (which now passes), and emits
    // the final summary to the test as `lastAssistant`. The text
    // starts with "All steps verified." to match the main test's
    // assertion at `shell/tests/agent-e2e.test.js:318`.
    {
      text: "All steps verified.",
      finishReason: "stop",
    },
    // 6) FIX — verification failed (scripted); the loop appends a
    // fix-N-<id> step and re-enters planning. The model fixes the file.
    {
      toolCalls: [
        { id: "tc-4", name: "fs_write", args: JSON.stringify({ path: "/tmp/e2e/fixture.js", content: "// fixed\n" }) },
      ],
      finishReason: "tool_calls",
    },
    // 7) TEST again — model re-runs the tests; this round returns
    // passed (scripted).
    {
      toolCalls: [
        { id: "tc-5", name: "test_run", args: JSON.stringify({ command: "node", argv: ["-e", "process.exit(0)"] }) },
      ],
      finishReason: "tool_calls",
    },
    // 8) DONE — final summary after fix. The verification gate runs
    // again and now passes.
    {
      text: "All steps verified.",
      finishReason: "stop",
    },
  ];
}

// Test-only re-export. Production callers should NOT use this name.
// The `loop.js` production default never touches this module.
export const _forTests = {
  scriptedProvider,
  defaultE2ESequence,
};