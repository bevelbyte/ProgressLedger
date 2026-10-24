// Project Mode — GATE 3: Real LLM provider audit + edge cases.
//
// This file audits the OpenAI-compatible provider against the GATE 3
// brief. Every test uses an injected `fetchImpl` so no real network
// traffic is generated. The provider's retry/backoff/cancellation and
// SSE-parsing logic is exercised deterministically.
//
// Coverage (8 tests):
//   1. Endpoint + Auth: POST to <endpoint>/v1/chat/completions with
//      Authorization: Bearer <key>.
//   2. Streaming: text_delta events arrive in order and accumulate to
//      the original text.
//   3. Tool calls: a tool_call event with name + JSON args is parsed.
//   4. Messages passthrough: tool_result + continuation messages are
//      included verbatim in the request body.
//   5. 429: after exhausting retries, emits code='rate-limited'.
//   6. 401: emits code='auth-failed' with exactly one fetch call.
//   7. 5xx: retries once then emits code='server-error'.
//   8. Timeout: AbortSignal.timeout cancels the request promptly.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createOpenAiProvider,
} from "../src/services/agent/provider.js";

const KEY = "sk-test-GATE3-DO-NOT-LEAK";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Convert an async iterable to an array. */
async function collect(iter) {
  const out = [];
  for await (const v of iter) out.push(v);
  return out;
}

/** Build a fake Response whose body is an SSE stream from `chunks`. */
function sseResponse(chunks, { status = 200, headers = {} } = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[i++];
      if (chunk == null) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunk));
      await new Promise((r) => setImmediate(r));
    },
  });
  const headersMap = new Map(Object.entries(headers));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k) => (headersMap.has(k) ? headersMap.get(k) : null),
    },
    body: stream,
    async text() {
      return chunks.join("");
    },
  };
}

/** A plain non-streaming JSON response (e.g. an error body). */
function jsonErrorResponse(body, { status = 500, headers = {} } = {}) {
  const headersMap = new Map(Object.entries(headers));
  return {
    ok: false,
    status,
    headers: {
      get: (k) => (headersMap.has(k) ? headersMap.get(k) : null),
    },
    body: null,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Endpoint + Authentication
// ---------------------------------------------------------------------------

test("GATE 3: endpoint constructs /v1/chat/completions and sets Bearer token", async () => {
  let capturedUrl = null;
  let capturedAuth = null;
  const fetchImpl = async (url, init) => {
    capturedUrl = url;
    const hdrs = init.headers || {};
    capturedAuth = hdrs.Authorization || hdrs.authorization || "";
    return sseResponse([
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  };
  const provider = createOpenAiProvider({
    endpoint: "https://api.openai.com",
    apiKey: KEY,
    model: "gpt-4o-mini",
    fetchImpl,
  });
  await collect(provider.streamChat({ messages: [{ role: "user", content: "hi" }] }));

  assert.equal(
    capturedUrl,
    "https://api.openai.com/v1/chat/completions",
    "URL must be endpoint + /v1/chat/completions",
  );
  assert.equal(
    capturedAuth,
    `Bearer ${KEY}`,
    "Authorization header must be Bearer <apiKey>",
  );
});

// ---------------------------------------------------------------------------
// 2. Streaming — text_delta in order, accumulated
// ---------------------------------------------------------------------------

test("GATE 3: streaming text_delta events arrive in order and accumulate", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const fetchImpl = async () => sseResponse(chunks);
  const provider = createOpenAiProvider({
    endpoint: "https://api.example.com",
    apiKey: KEY,
    model: "gpt-test",
    fetchImpl,
  });
  const events = await collect(provider.streamChat({ messages: [] }));
  const textEvents = events.filter((e) => e.type === "text_delta");
  assert.ok(textEvents.length > 0, "expected text_delta events");
  const accumulated = textEvents.map((e) => e.delta).join("");
  assert.equal(accumulated, "Hello world!", "deltas must accumulate in order");
  // Verify order is preserved (no reordering).
  assert.equal(textEvents[0].delta, "Hello");
  assert.equal(textEvents[textEvents.length - 1].delta, "!");
  const finish = events.find((e) => e.type === "finish");
  assert.ok(finish, "expected a finish event");
  assert.equal(finish.reason, "stop");
});

// ---------------------------------------------------------------------------
// 3. Tool calls — name + JSON args parsed
// ---------------------------------------------------------------------------

test("GATE 3: tool_call event parsed with name and JSON arguments", async () => {
  const args = JSON.stringify({ city: "Paris", days: 3 });
  const chunks = [
    `data: ${JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            id: "call_abc",
            type: "function",
            function: { name: "search_flights", arguments: args },
          }],
        },
      }],
    })}\n\n`,
    'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const fetchImpl = async () => sseResponse(chunks);
  const provider = createOpenAiProvider({
    endpoint: "https://api.example.com",
    apiKey: KEY,
    model: "gpt-test",
    fetchImpl,
  });
  const events = await collect(provider.streamChat({ messages: [] }));
  const tc = events.find((e) => e.type === "tool_call");
  assert.ok(tc, `expected tool_call in ${events.map((e) => e.type).join(",")}`);
  assert.equal(tc.id, "call_abc");
  assert.equal(tc.name, "search_flights");
  assert.equal(tc.args, args, "args must be the raw JSON string");
  // Args should parse back to the original object.
  const parsed = JSON.parse(tc.args);
  assert.deepEqual(parsed, { city: "Paris", days: 3 });
  const finish = events.find((e) => e.type === "finish");
  assert.equal(finish.reason, "tool_calls");
});

// ---------------------------------------------------------------------------
// 4. Messages passthrough — tool_result + continuation
// ---------------------------------------------------------------------------

test("GATE 3: tool_result and continuation messages are included in request body", async () => {
  let capturedBody = null;
  const fetchImpl = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return sseResponse([
      'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  };
  const provider = createOpenAiProvider({
    endpoint: "https://api.example.com",
    apiKey: KEY,
    model: "gpt-test",
    fetchImpl,
  });

  // A conversation with user -> assistant -> tool_call -> tool_result -> assistant.
  const messages = [
    { role: "user", content: "Find flights to Paris" },
    { role: "assistant", content: "Let me search." },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_abc", type: "function", function: { name: "search_flights", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "call_abc", content: '{"flights":["AA100"]}' },
    { role: "user", content: "Book the first one" },
  ];

  await collect(provider.streamChat({ messages }));

  assert.ok(capturedBody, "expected the request body to be captured");
  assert.ok(Array.isArray(capturedBody.messages), "body.messages must be an array");
  assert.equal(capturedBody.messages.length, messages.length, "all messages must be forwarded");
  // Every original message must appear in the same order.
  for (let i = 0; i < messages.length; i++) {
    assert.equal(capturedBody.messages[i].role, messages[i].role, `message ${i} role must match`);
    if (messages[i].content !== undefined) {
      assert.equal(capturedBody.messages[i].content, messages[i].content, `message ${i} content must match`);
    }
    if (messages[i].tool_call_id !== undefined) {
      assert.equal(capturedBody.messages[i].tool_call_id, messages[i].tool_call_id, `message ${i} tool_call_id must match`);
    }
  }
  // The tool result (role=tool) must be present.
  const toolResult = capturedBody.messages.find((m) => m.role === "tool");
  assert.ok(toolResult, "tool_result message must be in the request");
  assert.equal(toolResult.tool_call_id, "call_abc");
});

// ---------------------------------------------------------------------------
// 5. 429 — rate-limited after exhausting retries
// ---------------------------------------------------------------------------

test("GATE 3: 429 exhausts retries and emits rate-limited error", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonErrorResponse("rate limited", { status: 429 }); // no Retry-After
  };
  const provider = createOpenAiProvider({
    endpoint: "https://api.example.com",
    apiKey: KEY,
    model: "gpt-test",
    fetchImpl,
    maxRetries429: 3,
  });
  const events = await collect(provider.streamChat({ messages: [] }));
  // Initial + 3 retries = 4 calls.
  assert.equal(calls, 4, `expected 4 fetch calls; got ${calls}`);
  const err = events.find((e) => e.type === "error");
  assert.ok(err, "expected an error event");
  assert.equal(err.code, "rate-limited", "error code must be rate-limited");
});

// ---------------------------------------------------------------------------
// 6. 401 — auth-failed, terminal (no retry)
// ---------------------------------------------------------------------------

test("GATE 3: 401 emits auth-failed with no retry", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonErrorResponse("invalid api key", { status: 401 });
  };
  const provider = createOpenAiProvider({
    endpoint: "https://api.example.com",
    apiKey: KEY,
    model: "gpt-test",
    fetchImpl,
  });
  const events = await collect(provider.streamChat({ messages: [] }));
  assert.equal(calls, 1, "expected exactly 1 fetch call (401 is terminal)");
  const err = events.find((e) => e.type === "error");
  assert.ok(err, "expected an error event");
  assert.equal(err.code, "auth-failed", "error code must be auth-failed");
  // The key must NEVER appear in the error message.
  assert.ok(!String(err.message).includes(KEY), "auth-failed message must not leak the apiKey");
});

// ---------------------------------------------------------------------------
// 7. 5xx — retries once then server-error
// ---------------------------------------------------------------------------

test("GATE 3: 500 retries once then emits server-error", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonErrorResponse("internal server error", { status: 500 });
  };
  const provider = createOpenAiProvider({
    endpoint: "https://api.example.com",
    apiKey: KEY,
    model: "gpt-test",
    fetchImpl,
    maxRetries5xx: 1,
  });
  const events = await collect(provider.streamChat({ messages: [] }));
  assert.equal(calls, 2, `expected 2 fetch calls (initial + 1 retry); got ${calls}`);
  const err = events.find((e) => e.type === "error");
  assert.ok(err, "expected an error event");
  assert.equal(err.code, "server-error", "error code must be server-error");
  // The key must NEVER appear in the error message.
  assert.ok(!String(err.message).includes(KEY), "server-error message must not leak the apiKey");
});

// ---------------------------------------------------------------------------
// 8. Timeout — AbortSignal.timeout cancels promptly
// ---------------------------------------------------------------------------

test("GATE 3: AbortSignal.timeout cancels the request promptly", async () => {
  let fetchStarted = false;
  // A fetch that never resolves on its own — the timeout must cancel it.
  const fetchImpl = async (_url, init) => {
    fetchStarted = true;
    // Hold the connection open until the signal aborts.
    return new Promise((resolve, reject) => {
      if (init.signal && init.signal.aborted) {
        const err = new Error("abort");
        err.name = "AbortError";
        reject(err);
        return;
      }
      init.signal.addEventListener("abort", () => {
        const err = new Error("abort");
        err.name = "AbortError";
        reject(err);
      }, { once: true });
    });
  };
  const provider = createOpenAiProvider({
    endpoint: "https://api.example.com",
    apiKey: KEY,
    model: "gpt-test",
    fetchImpl,
  });
  const start = Date.now();
  const signal = AbortSignal.timeout(50);
  const events = await collect(provider.streamChat({ messages: [], signal }));
  const elapsed = Date.now() - start;

  assert.ok(fetchStarted, "fetch must have been invoked");
  assert.ok(elapsed < 5000, `expected prompt cancellation (<5s); took ${elapsed}ms`);
  // On abort the provider returns silently — no error event, just an
  // empty (or truncated) event stream.
  const err = events.find((e) => e.type === "error");
  assert.equal(err, undefined, "abort should not emit an error event");
});
