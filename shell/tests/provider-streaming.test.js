// Project Mode — provider SSE streaming regression tests (Phase 11).
//
// These encode the two live-provider findings from the first real
// OpenAI-compatible run (GATES-PHASE11 G1/G3):
//
//   1. OpenAI-compatible servers stream tool calls as FRAGMENTS keyed
//      by `index` (id/name on the first chunk, `arguments` appended
//      across many chunks). The provider must accumulate them and emit
//      ONE complete tool_call event per call, BEFORE the finish event —
//      the agent loop executes whatever tool_call events it receives.
//
//   2. Usage is only included in streaming mode when the request body
//      carries `stream_options: { include_usage: true }`. Providers
//      that reject the field (HTTP 400) must be retried once without
//      it rather than failing the whole call.
//
// The wire is simulated with an in-memory ReadableStream of SSE text;
// no network access, no credentials.

import test from "node:test";
import assert from "node:assert/strict";

import { createOpenAiProvider, joinUrl } from "../src/services/agent/provider.js";

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chatChunk(delta, finishReason = null, usage = null) {
  const payload = { id: "chatcmpl-test", choices: [{ index: 0, delta, finish_reason: finishReason }] };
  if (usage) payload.usage = usage;
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function makeProvider(chunks, { captureBody } = {}) {
  const fetchImpl = async (url, init) => {
    if (captureBody) captureBody.push({ url, body: JSON.parse(init.body) });
    return sseResponse(chunks);
  };
  return createOpenAiProvider({
    endpoint: "https://mock.local",
    apiKey: "test-key-not-a-secret",
    model: "test-model",
    fetchImpl,
  });
}

async function collect(provider, { messages, tools } = {}) {
  const events = [];
  for await (const ev of provider.streamChat({
    messages: messages || [{ role: "user", content: "hi" }],
    tools,
    signal: undefined,
  })) {
    events.push(ev);
  }
  return events;
}

test("provider: fragmented tool_call deltas are accumulated into ONE complete event before finish", async () => {
  // Wire shape produced by real OpenAI-compatible servers: name arrives
  // whole on the first fragment, arguments stream in pieces, id only on
  // the first fragment. Two parallel tool calls interleaved by index.
  const chunks = [
    chatChunk({ tool_calls: [{ index: 0, id: "call-A", function: { name: "fs_read", arguments: '{"pa' } }] }),
    chatChunk({ tool_calls: [{ index: 1, id: "call-B", function: { name: "inspect_project", arguments: '{"jso' } }] }),
    chatChunk({ tool_calls: [{ index: 0, function: { arguments: 'th": "src/loop.js"}' } }] }),
    chatChunk({ tool_calls: [{ index: 1, function: { arguments: 'n_only": true}' } }] }),
    chatChunk({}, "tool_calls"),
    "data: [DONE]\n\n",
  ];
  const events = await collect(makeProvider(chunks));

  const toolCalls = events.filter((e) => e.type === "tool_call");
  assert.equal(toolCalls.length, 2, `expected 2 complete tool calls, got ${JSON.stringify(toolCalls)}`);
  const a = toolCalls.find((t) => t.name === "fs_read");
  const b = toolCalls.find((t) => t.name === "inspect_project");
  assert.ok(a, "fs_read call must be present with a complete name");
  assert.equal(a.id, "call-A");
  assert.equal(a.args, '{"path": "src/loop.js"}', `args must be the concatenation of fragments, got ${a.args}`);
  assert.ok(b, "inspect_project call must be present");
  assert.equal(b.args, '{"json_only": true}');

  // Ordering: every tool_call event must precede the finish event.
  const finishIdx = events.findIndex((e) => e.type === "finish");
  assert.ok(finishIdx > -1, "finish event must be present");
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === "tool_call") assert.ok(i < finishIdx, "tool_call must precede finish");
  }
  assert.equal(events[finishIdx].reason, "tool_calls");

  // Exactly one finish event (no duplicates from [DONE] + finish_reason).
  assert.equal(events.filter((e) => e.type === "finish").length, 1);
});

test("provider: single-chunk complete tool calls still work (back-compat)", async () => {
  const chunks = [
    chatChunk({ tool_calls: [{ index: 0, id: "call-1", function: { name: "fs_list", arguments: "{}" } }] }),
    chatChunk({}, "tool_calls"),
    "data: [DONE]\n\n",
  ];
  const events = await collect(makeProvider(chunks));
  const toolCalls = events.filter((e) => e.type === "tool_call");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, "fs_list");
  assert.equal(toolCalls[0].args, "{}");
  assert.equal(events.filter((e) => e.type === "finish").length, 1);
});

test("provider: text-embedded <tool_call> blocks are extracted into real tool_call events", async () => {
  // Phase 11 live finding: some OpenAI-compatible models emit tool
  // calls as TEXT in <tool_call>{...}</tool_call> blocks (their own
  // key conventions) instead of native delta.tool_calls. The provider
  // must convert them so the agent loop can execute them.
  const chunks = [
    chatChunk({ content: "Let me check that. " }),
    chatChunk({ content: "<tool_call>{\"tool\": \"fs_read\", \"param" }),
    chatChunk({ content: "eters\": {\"path\": \"src/a.js\"}}</tool_call>" }),
    chatChunk({}, "stop"),
    "data: [DONE]\n\n",
  ];
  const events = await collect(makeProvider(chunks));
  const toolCalls = events.filter((e) => e.type === "tool_call");
  assert.equal(toolCalls.length, 1, `expected 1 extracted call, got ${JSON.stringify(toolCalls)}`);
  assert.equal(toolCalls[0].name, "fs_read");
  assert.equal(JSON.parse(toolCalls[0].args).path, "src/a.js");
  // Prose before the block is still streamed as text (joined deltas).
  const streamedText = events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
  assert.ok(streamedText.includes("Let me check"), `prose must stream, got: ${streamedText}`);
  // The pseudo-syntax must NOT reach the loop as raw text (it is
  // stripped from the frozen tail; the prose part remains).
  const allText = events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
  assert.ok(!allText.includes("<tool_call>"), `tag must be stripped from text, got: ${allText}`);
  // Ordering: tool_call precedes finish.
  const finishIdx = events.findIndex((e) => e.type === "finish");
  assert.ok(events.findIndex((e) => e.type === "tool_call") < finishIdx);
});

test("provider: plain text without tool-call tags streams and finishes normally", async () => {
  const chunks = [
    chatChunk({ content: "Just an answer." }),
    chatChunk({}, "stop"),
    "data: [DONE]\n\n",
  ];
  const events = await collect(makeProvider(chunks));
  const allText = events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
  assert.equal(allText, "Just an answer.");
  assert.equal(events.filter((e) => e.type === "tool_call").length, 0);
  assert.equal(events.filter((e) => e.type === "finish").length, 1);
});

test("provider: request carries stream_options.include_usage; usage event is emitted", async () => {
  const captured = [];
  const chunks = [
    chatChunk({ content: "He" }),
    chatChunk({ content: "llo" }, "stop", { prompt_tokens: 12, completion_tokens: 34 }),
    "data: [DONE]\n\n",
  ];
  const provider = makeProvider(chunks, { captureBody: captured });
  const events = await collect(provider);

  assert.equal(captured.length, 1, "one request");
  assert.equal(captured[0].url, joinUrl("https://mock.local", "/v1/chat/completions"));
  assert.deepEqual(captured[0].body.stream_options, { include_usage: true });

  const usage = events.filter((e) => e.type === "usage");
  assert.equal(usage.length, 1);
  assert.equal(usage[0].inputTokens, 12);
  assert.equal(usage[0].outputTokens, 34);
});

test("provider: HTTP 400 on stream_options retries once WITHOUT the field", async () => {
  const captured = [];
  const calls = { n: 0 };
  const fetchImpl = async (url, init) => {
    calls.n += 1;
    captured.push(JSON.parse(init.body));
    if (calls.n === 1) {
      return new Response(JSON.stringify({ error: { message: "Unknown field: stream_options" } }), { status: 400 });
    }
    return sseResponse([
      chatChunk({ content: "ok" }, "stop"),
      "data: [DONE]\n\n",
    ]);
  };
  const provider = createOpenAiProvider({
    endpoint: "https://mock.local",
    apiKey: "test-key-not-a-secret",
    model: "test-model",
    fetchImpl,
  });
  const events = await collect(provider);

  assert.equal(calls.n, 2, `expected a retry, got ${calls.n} attempts`);
  assert.ok(captured[0].stream_options, "first attempt carries stream_options");
  assert.equal(captured[1].stream_options, undefined, "second attempt drops stream_options");
  assert.ok(events.some((e) => e.type === "text_delta" && e.delta === "ok"));
  assert.equal(events.filter((e) => e.type === "error").length, 0, "no error events after the fallback");
});

test("provider: XML-style blocks whose tag is a DECLARED tool name are extracted (validated, not guessed)", async () => {
  // Phase 11 live finding: weak-function-calling models emit
  // <tool_name><param>value</param></tool_name> XML. The provider only
  // accepts tags matching the DECLARED tool list — prose with unknown
  // tags is left as text.
  const chunks = [
    chatChunk({ content: "Searching now.\n<fs_search>\n<pattern>MARKER-XK-42</pattern>\n</fs_search>" }),
    chatChunk({}, "tool_calls"),
    "data: [DONE]\n\n",
  ];
  const tools = [
    { type: "function", function: { name: "fs_search", description: "search", parameters: { type: "object" } } },
    { type: "function", function: { name: "fs_read", description: "read", parameters: { type: "object" } } },
  ];
  const events = await collect(makeProvider(chunks), { tools });
  const toolCalls = events.filter((e) => e.type === "tool_call");
  assert.equal(toolCalls.length, 1, `expected the fs_search XML call, got ${JSON.stringify(toolCalls)}`);
  assert.equal(toolCalls[0].name, "fs_search");
  assert.equal(JSON.parse(toolCalls[0].args).pattern, "MARKER-XK-42");
  const streamedText = events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
  assert.ok(!streamedText.includes("<fs_search>"), "XML block must be stripped from text");
  assert.ok(streamedText.includes("Searching now."), "prose before the block must stream");
});

test("provider: unknown XML tags are NOT tool calls (left as prose)", async () => {
  const chunks = [
    chatChunk({ content: "Compare <b>bold</b> and <i>italic</i> HTML in docs." }),
    chatChunk({}, "stop"),
    "data: [DONE]\n\n",
  ];
  const tools = [{ type: "function", function: { name: "fs_read", description: "read", parameters: { type: "object" } } }];
  const events = await collect(makeProvider(chunks), { tools });
  assert.equal(events.filter((e) => e.type === "tool_call").length, 0, "no tool calls from unknown tags");
  const text = events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
  assert.ok(text.includes("<b>bold</b>"), "unknown-tag prose must pass through");
});

test("provider: OpenAI tool_calls ENVELOPE in text is extracted (standard wire shape)", async () => {
  const chunks = [
    chatChunk({ content: '{"tool_calls": [{"id": "search_1", "type": "function", "function": {"name": "fs_search", "arguments": {"pattern": "MARKER"}}}]}' }),
    chatChunk({}, "stop"),
    "data: [DONE]\n\n",
  ];
  const events = await collect(makeProvider(chunks));
  const toolCalls = events.filter((e) => e.type === "tool_call");
  assert.equal(toolCalls.length, 1, `expected the envelope call, got ${JSON.stringify(toolCalls)}`);
  assert.equal(toolCalls[0].name, "fs_search");
  assert.equal(toolCalls[0].id, "search_1");
  assert.equal(JSON.parse(toolCalls[0].args).pattern, "MARKER");
  const allText = events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
  assert.ok(!allText.includes("tool_calls"), "envelope must be stripped from text");
});

test("provider: tool_calls envelope WITHOUT function wrapper is extracted", async () => {
  const chunks = [
    chatChunk({ content: '{"tool_calls": [{"name": "fs_read", "arguments": {"path": "x.js"}}]}' }),
    chatChunk({}, "stop"),
    "data: [DONE]\n\n",
  ];
  const events = await collect(makeProvider(chunks));
  const toolCalls = events.filter((e) => e.type === "tool_call");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, "fs_read");
  assert.equal(JSON.parse(toolCalls[0].args).path, "x.js");
});

// ---------------------------------------------------------------------------
// Phase 13 — transient empty-body 400 retry (bounded)
// ---------------------------------------------------------------------------
//
// Live evidence (Phase 12 runs 4-6, PROGRESSLEDGER_V2_DEBUG_HTTP_DIR dumps):
// b.ai intermittently returns HTTP 400 with an EMPTY body for provably
// well-formed requests (identical shapes succeed on other runs). A
// genuine malformed-request 400 carries a JSON error body. The provider
// therefore retries an empty-body 400 ONCE with the identical request;
// every other 4xx stays terminal.

function statusResponse(status, bodyText) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      if (bodyText) controller.enqueue(encoder.encode(bodyText));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": "application/json" } });
}

function makeStatusProvider(responses, { captureBodies } = {}) {
  let call = 0;
  const fetchImpl = async (url, init) => {
    const n = call++;
    if (captureBodies) captureBodies.push(JSON.parse(init.body));
    return responses[Math.min(n, responses.length - 1)]();
  };
  return createOpenAiProvider({
    endpoint: "https://mock.local",
    apiKey: "test-key-not-a-secret",
    model: "test-model",
    fetchImpl,
  });
}

const okStream = () => sseResponse([
  chatChunk({ content: "recovered" }),
  chatChunk({}, "stop"),
  "data: [DONE]\n\n",
]);

test("provider: empty-body 400 is retried once with the identical request and succeeds", { timeout: 15_000 }, async () => {
  const bodies = [];
  const provider = makeStatusProvider([() => statusResponse(400, ""), okStream], { captureBodies: bodies });
  const events = await collect(provider);
  const err = events.find((e) => e.type === "error");
  assert.equal(err, undefined, `no error expected, got ${JSON.stringify(err)}`);
  const text = events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
  assert.match(text, /recovered/);
  assert.equal(bodies.length, 2, "exactly one retry");
  assert.deepEqual(bodies[0], bodies[1], "the retried request must be byte-identical");
});

test("provider: empty-body 400 retries only once — a second one is terminal", { timeout: 15_000 }, async () => {
  const bodies = [];
  const provider = makeStatusProvider([() => statusResponse(400, ""), () => statusResponse(400, "")], { captureBodies: bodies });
  const events = await collect(provider);
  const err = events.find((e) => e.type === "error");
  assert.ok(err, "terminal error expected");
  assert.equal(err.code, "http-error");
  assert.match(err.message, /HTTP 400/);
  assert.equal(bodies.length, 2, "one bounded retry, no more");
});

test("provider: 400 WITH a body (genuine malformed request) is terminal with no retry", { timeout: 15_000 }, async () => {
  const bodies = [];
  const provider = makeStatusProvider([() => statusResponse(400, '{"error":{"message":"invalid model"}}')], { captureBodies: bodies });
  const events = await collect(provider);
  const err = events.find((e) => e.type === "error");
  assert.ok(err, "terminal error expected");
  assert.equal(err.code, "http-error");
  assert.match(err.message, /invalid model/);
  assert.equal(bodies.length, 1, "no retry for a genuine malformed request");
});
