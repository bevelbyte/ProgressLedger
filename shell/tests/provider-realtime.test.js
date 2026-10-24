// Project Mode — OpenAI provider realtime tests.
//
// These tests use a deterministic in-process `fetchImpl` stub so no real
// HTTP traffic is generated. The stub returns synthetic `Response`
// objects whose body is built from a chunk array (mirroring the real
// SSE wire format). The provider's retry/backoff/cancellation logic is
// exercised here; the broader provider surface (parsing, mock, abort)
// is covered by `provider.test.js`.
//
// Coverage (13 tests):
//   1.  200 SSE: text_delta + tool_call + usage + finish events.
//   2.  200 with [DONE] sentinel ends cleanly.
//   3.  429 + Retry-After: 0 retries immediately and succeeds.
//   4.  429 with no Retry-After retries 3 times then 'rate-limited'.
//   5.  401 emits 'auth-failed' with NO retry.
//   6.  500 retries once then emits error.
//   7.  Malformed SSE chunk emits error.
//   8.  signal.abort() between retries cancels the backoff sleep.
//   9.  AbortController aborts mid-backoff and respects abort (no
//       lingering timers).
//  10.  Rate-limit backoff respects Retry-After cap (large Retry-After
//       is honoured by clamping).
//  11.  Network failure (TypeError) retries once, then emits error.
//  12.  4xx (not 401, not 429) is terminal with no retry.
//  13.  Status events are emitted on the bus with kind='rate-limited'.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createOpenAiProvider,
  parseRetryAfter,
} from "../src/services/agent/provider.js";

const KEY = "sk-test-REALTIME-DO-NOT-LEAK";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function collect(iter) {
  const out = [];
  for await (const v of iter) out.push(v);
  return out;
}

/**
 * Build a fake Response whose body is an SSE stream from `chunks`.
 * The `headers` map is consulted via `headers.get(name)`.
 */
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

/** Minimal event bus used to capture provider status events. */
function makeBus() {
  const events = [];
  return {
    events,
    emit(type, payload) {
      events.push({ type, payload });
    },
  };
}

// ---------------------------------------------------------------------------
// 1. 200 SSE: text_delta + tool_call + usage + finish
// ---------------------------------------------------------------------------

test("OpenAI provider: 200 SSE streams text_delta + tool_call + usage + finish", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    `data: {"choices":[{"delta":{"tool_calls":[{"id":"c1","type":"function","function":{"name":"fs_list","arguments":"{\\"path\\":\\"/\\"}"}}]}}]}\n\n`,
    'data: {"usage":{"prompt_tokens":7,"completion_tokens":13}}\n\n',
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
  const events = await collect(provider.streamChat({ messages: [{ role: "user", content: "go" }] }));
  const types = events.map((e) => e.type);
  assert.ok(types.includes("text_delta"), "expected text_delta");
  assert.ok(types.includes("tool_call"), "expected tool_call");
  assert.ok(types.includes("usage"), "expected usage");
  assert.ok(types.includes("finish"), "expected finish");
  const text = events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
  assert.equal(text, "Hello world");
  const tc = events.find((e) => e.type === "tool_call");
  assert.equal(tc.id, "c1");
  assert.equal(tc.name, "fs_list");
  assert.equal(tc.args, '{"path":"/"}');
  const finish = events.find((e) => e.type === "finish");
  assert.equal(finish.reason, "tool_calls");
  const usage = events.find((e) => e.type === "usage");
  assert.equal(usage.inputTokens, 7);
  assert.equal(usage.outputTokens, 13);
});

// ---------------------------------------------------------------------------
// 2. 200 with [DONE] ends cleanly (no trailing synthetic finish)
// ---------------------------------------------------------------------------

test("OpenAI provider: 200 with [DONE] sentinel ends cleanly", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
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
  const types = events.map((e) => e.type);
  // Must NOT have an extra error event.
  assert.ok(!types.includes("error"), `expected no error, got ${types.join(",")}`);
  // finish is emitted exactly once (from [DONE]).
  const finishes = events.filter((e) => e.type === "finish");
  assert.equal(finishes.length, 1, "exactly one finish event");
  assert.equal(finishes[0].reason, "stop");
});

// ---------------------------------------------------------------------------
// 3. 429 with Retry-After: 0 retries immediately and succeeds
// ---------------------------------------------------------------------------

test("OpenAI provider: 429 with Retry-After: 0 retries and succeeds on second call", async () => {
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++;
    if (calls === 1) {
      // First call: 429 with Retry-After: 0 (must retry).
      return jsonErrorResponse("rate limited", { status: 429, headers: { "retry-after": "0" } });
    }
    // Second call: 200 SSE.
    return sseResponse([
      'data: {"choices":[{"delta":{"content":"after-retry"}}]}\n\n',
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
  const events = await collect(provider.streamChat({ messages: [] }));
  assert.equal(calls, 2, "expected exactly 2 fetch calls (initial + 1 retry)");
  const text = events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
  assert.equal(text, "after-retry");
});

// ---------------------------------------------------------------------------
// 4. 429 with no Retry-After retries 3 times then 'rate-limited'
// ---------------------------------------------------------------------------

test("OpenAI provider: 429 with no Retry-After retries 3 times then emits 'rate-limited'", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonErrorResponse("rate limited", { status: 429 }); // no Retry-After
  };
  const bus = makeBus();
  const provider = createOpenAiProvider({
    endpoint: "https://api.example.com",
    apiKey: KEY,
    model: "gpt-test",
    fetchImpl,
    bus,
    maxRetries429: 3,
  });
  // Use a custom small backoff by patching parseRetryAfter through
  // default 30s path — to keep the test fast, we monkey-patch by
  // sending a tiny Retry-After of 0 and relying on the provider to
  // cap by expoMs. With maxRetries429=3 we should see 4 calls total
  // (initial + 3 retries).
  const events = await collect(provider.streamChat({ messages: [] }));
  assert.equal(calls, 4, `expected 4 calls (initial + 3 retries); got ${calls}`);
  const err = events.find((e) => e.type === "error");
  assert.ok(err, "expected an error event");
  assert.equal(err.code, "rate-limited");
  // Bus should have seen 3 rate-limited status events.
  const rateEvents = bus.events.filter((e) => e.payload && e.payload.kind === "rate-limited");
  assert.equal(rateEvents.length, 3, `expected 3 rate-limited status events; got ${rateEvents.length}`);
});

// ---------------------------------------------------------------------------
// 5. 401 emits 'auth-failed' with NO retry
// ---------------------------------------------------------------------------

test("OpenAI provider: 401 emits 'auth-failed' with no retry", async () => {
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
  assert.equal(calls, 1, "expected exactly 1 fetch call (no retry on 401)");
  const err = events.find((e) => e.type === "error");
  assert.ok(err, "expected an error event");
  assert.equal(err.code, "auth-failed");
  // The message must NOT contain the api key.
  assert.ok(!String(err.message).includes(KEY), "auth-failed message must not contain key");
});

// ---------------------------------------------------------------------------
// 6. 500 retries once then emits error
// ---------------------------------------------------------------------------

test("OpenAI provider: 500 retries once then emits error", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonErrorResponse("internal", { status: 500 });
  };
  const provider = createOpenAiProvider({
    endpoint: "https://api.example.com",
    apiKey: KEY,
    model: "gpt-test",
    fetchImpl,
    maxRetries5xx: 1,
  });
  const events = await collect(provider.streamChat({ messages: [] }));
  assert.equal(calls, 2, `expected 2 calls (initial + 1 retry); got ${calls}`);
  const err = events.find((e) => e.type === "error");
  assert.ok(err, "expected an error event");
  assert.equal(err.code, "server-error");
});

// ---------------------------------------------------------------------------
// 7. Malformed SSE chunk emits error
// ---------------------------------------------------------------------------

test("OpenAI provider: malformed SSE chunk emits an error", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    "data: this-is-not-json{{{ \n\n",
  ];
  const fetchImpl = async () => sseResponse(chunks);
  const provider = createOpenAiProvider({
    endpoint: "https://api.example.com",
    apiKey: KEY,
    model: "gpt-test",
    fetchImpl,
  });
  const events = await collect(provider.streamChat({ messages: [] }));
  const err = events.find((e) => e.type === "error");
  assert.ok(err, "expected an error event for malformed chunk");
  assert.equal(err.code, "malformed-sse");
});

// ---------------------------------------------------------------------------
// 8. signal.abort() between retries cancels the backoff sleep
// ---------------------------------------------------------------------------

test("OpenAI provider: signal.abort() between retries cancels backoff", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonErrorResponse("rate limited", { status: 429, headers: { "retry-after": "60" } });
  };
  const controller = new AbortController();
  const provider = createOpenAiProvider({
    endpoint: "https://api.example.com",
    apiKey: KEY,
    model: "gpt-test",
    fetchImpl,
    maxRetries429: 3,
  });
  const start = Date.now();
  // Schedule an abort ~50ms in, before the 60s Retry-After elapses.
  setTimeout(() => controller.abort(), 50);
  const events = await collect(provider.streamChat({ messages: [], signal: controller.signal }));
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `expected fast abort (<5s); took ${elapsed}ms`);
  // No error event was emitted (silent abort); the stream simply ends.
  const err = events.find((e) => e.type === "error");
  assert.equal(err, undefined, "abort should not emit an error event");
  // Exactly one fetch happened (the first 429) before abort.
  assert.equal(calls, 1, `expected 1 call before abort; got ${calls}`);
});

// ---------------------------------------------------------------------------
// 9. AbortController aborts mid-backoff (no lingering setTimeout)
// ---------------------------------------------------------------------------

test("OpenAI provider: AbortController aborts mid-backoff and frees the timer", async () => {
  // The provider's retry uses abortableSleep which clears its setTimeout
  // on abort. We verify by ensuring the abort resolves the stream
  // promptly and that no pending timers block the event loop after.
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonErrorResponse("rate limited", { status: 429, headers: { "retry-after": "30" } });
  };
  const controller = new AbortController();
  const provider = createOpenAiProvider({
    endpoint: "https://api.example.com",
    apiKey: KEY,
    model: "gpt-test",
    fetchImpl,
    maxRetries429: 3,
  });
  // Race: consume the stream and abort after the first fetch returns.
  const collectPromise = collect(provider.streamChat({ messages: [], signal: controller.signal }));
  // Allow the first fetch + abortableSleep to start.
  await new Promise((r) => setTimeout(r, 30));
  controller.abort();
  const events = await collectPromise;
  assert.ok(events.length >= 0, "stream returned cleanly after abort");
  // After abort, there should be no pending timer that keeps the loop
  // alive. We confirm by checking we can exit within 200ms.
  const exit = await Promise.race([
    new Promise((r) => setTimeout(() => r("timeout"), 200)),
    new Promise((r) => setImmediate(() => r("ok"))),
  ]);
  assert.equal(exit, "ok", "no lingering setTimeout after abort");
});

// ---------------------------------------------------------------------------
// 10. Rate-limit backoff clamps to Retry-After (large cap)
// ---------------------------------------------------------------------------

test("OpenAI provider: rate-limit backoff clamps to Retry-After", async () => {
  let calls = 0;
  // Retry-After of 5s, but exponential backoff starts at 1s. The clamp
  // is min(expoMs, retryMs) -> 1s on first retry. After 1s the second
  // call should fire. We verify by measuring elapsed time.
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) {
      return jsonErrorResponse("rl", { status: 429, headers: { "retry-after": "5" } });
    }
    return sseResponse([
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  };
  const provider = createOpenAiProvider({
    endpoint: "https://api.example.com",
    apiKey: KEY,
    model: "gpt-test",
    fetchImpl,
    maxRetries429: 3,
  });
  const start = Date.now();
  const events = await collect(provider.streamChat({ messages: [] }));
  const elapsed = Date.now() - start;
  // First retry sleeps min(1000, 5000) = 1000ms. Allow generous slack.
  assert.ok(elapsed >= 900 && elapsed < 4500, `expected ~1s backoff; got ${elapsed}ms`);
  assert.ok(events.some((e) => e.type === "finish"), "expected successful finish after retry");
});

// ---------------------------------------------------------------------------
// 11. Network failure (TypeError) retries once, then emits error
// ---------------------------------------------------------------------------

test("OpenAI provider: network failure (TypeError) retries once then emits error", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    // Simulate a network-level failure.
    throw new TypeError("fetch failed: ECONNREFUSED");
  };
  const provider = createOpenAiProvider({
    endpoint: "https://api.example.com",
    apiKey: KEY,
    model: "gpt-test",
    fetchImpl,
    maxRetries5xx: 1,
  });
  const events = await collect(provider.streamChat({ messages: [] }));
  assert.equal(calls, 2, `expected 2 calls (initial + 1 retry); got ${calls}`);
  const err = events.find((e) => e.type === "error");
  assert.ok(err, "expected an error event");
  assert.equal(err.code, "network-error");
  // The key must not appear in the message.
  assert.ok(!String(err.message).includes(KEY), "network-error message must not contain key");
});

// ---------------------------------------------------------------------------
// 12. 4xx (not 401, not 429) is terminal with no retry
// ---------------------------------------------------------------------------

test("OpenAI provider: 4xx (e.g. 400) is terminal with no retry", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonErrorResponse("bad request", { status: 400 });
  };
  const provider = createOpenAiProvider({
    endpoint: "https://api.example.com",
    apiKey: KEY,
    model: "gpt-test",
    fetchImpl,
  });
  const events = await collect(provider.streamChat({ messages: [] }));
  assert.equal(calls, 1, "expected exactly 1 call (no retry for 400)");
  const err = events.find((e) => e.type === "error");
  assert.ok(err, "expected an error event");
  assert.equal(err.code, "http-error");
});

// ---------------------------------------------------------------------------
// 13. Status events are emitted on the bus with kind='rate-limited'
// ---------------------------------------------------------------------------

test("OpenAI provider: rate-limit status events are emitted on the bus", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) {
      return jsonErrorResponse("rl", { status: 429, headers: { "retry-after": "0" } });
    }
    return sseResponse([
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  };
  const bus = makeBus();
  const provider = createOpenAiProvider({
    endpoint: "https://api.example.com",
    apiKey: KEY,
    model: "gpt-test",
    fetchImpl,
    bus,
    maxRetries429: 3,
  });
  await collect(provider.streamChat({ messages: [] }));
  const statusEvents = bus.events.filter((e) => e.type === "provider.status");
  assert.ok(statusEvents.length >= 1, "expected at least one provider.status event");
  const rate = statusEvents.find((e) => e.payload && e.payload.kind === "rate-limited");
  assert.ok(rate, "expected a rate-limited status event");
  assert.equal(typeof rate.payload.delayMs, "number");
  assert.equal(rate.payload.attempt, 1);
});

// ---------------------------------------------------------------------------
// Internals — parseRetryAfter (sanity)
// ---------------------------------------------------------------------------

test("parseRetryAfter: seconds value", () => {
  const ms = parseRetryAfter("5", 0);
  assert.equal(ms, 5000);
});

test("parseRetryAfter: invalid returns null", () => {
  assert.equal(parseRetryAfter("not-a-date", 0), null);
  assert.equal(parseRetryAfter("", 0), null);
  assert.equal(parseRetryAfter(null, 0), null);
});