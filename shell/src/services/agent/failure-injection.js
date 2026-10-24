// Project Mode — TEST-ONLY failure injection provider.
//
// This module provides a deterministic, network-free provider that can
// be configured to emit specific error events or tool-call sequences.
// It exists so the agent loop's error-handling paths can be exercised
// without a real LLM endpoint, real network, or real filesystem access.
//
// PRODUCTION PATH: do NOT use this provider. The production default in
// `loop.js` is `createOpenAiProvider` / `createMockProvider`.

export function createFailureInjectionProvider() {
  let script = [];
  let round = 0;

  const provider = {
    async *streamChat(_opts) {
      round += 1;
      const entry = script[round - 1];

      if (!entry) {
        yield { type: "finish", reason: "stop" };
        return;
      }

      if (entry.error) {
        yield {
          type: "error",
          code: entry.error.code,
          message: entry.error.message,
        };
        return;
      }

      if (Array.isArray(entry.toolCalls)) {
        for (let i = 0; i < entry.toolCalls.length; i++) {
          const tc = entry.toolCalls[i];
          yield {
            type: "tool_call",
            id: typeof tc.id === "string" ? tc.id : ("tc-" + round),
            name: tc.name,
            args: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args || {}),
          };
        }
      }

      if (typeof entry.text === "string" && entry.text.length > 0) {
        const mid = Math.max(1, Math.floor(entry.text.length / 2));
        yield { type: "text_delta", delta: entry.text.slice(0, mid) };
        yield { type: "text_delta", delta: entry.text.slice(mid) };
      }

      if (entry.usage) {
        yield {
          type: "usage",
          inputTokens: Number(entry.usage.inputTokens || 10),
          outputTokens: Number(entry.usage.outputTokens || 5),
        };
      } else if (typeof entry.text === "string" && entry.text.length > 0 && (!entry.toolCalls || entry.toolCalls.length === 0)) {
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      }

      const reason = typeof entry.finishReason === "string" && entry.finishReason.length > 0
        ? entry.finishReason
        : (entry.toolCalls && entry.toolCalls.length > 0 ? "tool_calls" : "stop");
      yield { type: "finish", reason };
    },

    _script(entries) {
      script = Array.isArray(entries) ? entries : [];
      round = 0;
      return provider;
    },

    providerTimeout() {
      script = [{
        error: {
          code: "provider-timeout",
          message: "provider request timed out after 30000ms",
        },
      }];
      round = 0;
      return provider;
    },

    providerMalformedResponse() {
      script = [{
        error: {
          code: "malformed-response",
          message: "provider returned unparseable response",
        },
      }];
      round = 0;
      return provider;
    },

    toolReturnsError(cfg) {
      const c = cfg || {};
      script = [
        {
          toolCalls: [{
            id: c.toolCallId || "tc-1",
            name: c.toolName || "fs_read",
            args: c.toolArgs || {},
          }],
        },
        { text: c.recoveryText || "The tool failed. Adjusting approach." },
        { text: c.finalText || "All steps verified." },
      ];
      round = 0;
      return provider;
    },

    mcpServerDown(cfg) {
      const c = cfg || {};
      script = [
        {
          toolCalls: [{
            id: c.toolCallId || "tc-1",
            name: c.toolName || "mcp_call",
            args: c.toolArgs || {},
          }],
        },
        { text: c.recoveryText || "MCP server unavailable. Continuing with alternatives." },
        { text: c.finalText || "All steps verified." },
      ];
      round = 0;
      return provider;
    },

    subAgentCrash(cfg) {
      const c = cfg || {};
      script = [
        {
          toolCalls: [{
            id: c.toolCallId || "tc-1",
            name: "delegate_research",
            args: c.toolArgs || { objective: "research this topic", step_id: "step-1" },
          }],
        },
        { text: c.finalText || "Sub-agent crashed; completed independently." },
      ];
      round = 0;
      return provider;
    },

    filesystemError(cfg) {
      const c = cfg || {};
      script = [
        {
          toolCalls: [{
            id: c.toolCallId || "tc-1",
            name: "fs_write",
            args: c.toolArgs || { path: "/tmp/cf-failure-test/file.js", content: "// test" },
          }],
        },
        { text: c.recoveryText || "Filesystem operation failed. Adjusting plan." },
        { text: c.finalText || "All steps verified." },
      ];
      round = 0;
      return provider;
    },

    testFailure(cfg) {
      const c = cfg || {};
      script = [
        { text: c.completionText || "All implementation steps are complete." },
        { text: c.fixText || "Applied fix for the test failure." },
        { text: c.finalText || "All steps verified and complete." },
      ];
      round = 0;
      return provider;
    },

    appRestart() {
      script = [
        { text: "Resuming work from the last checkpoint." },
        { text: "All steps completed after restart." },
      ];
      round = 0;
      return provider;
    },

    _getRound() {
      return round;
    },
  };

  return provider;
}
