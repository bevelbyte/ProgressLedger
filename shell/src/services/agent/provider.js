// Project Mode — model provider abstraction.
//
// Two providers live here:
//
//   - createOpenAiProvider: an OpenAI-compatible /v1/chat/completions
//     client. Streams via SSE, yields text_delta / tool_call / usage /
//     finish / error events. Honours an externally-supplied AbortSignal.
//     The credential is read FRESH on every call so a rotated key is
//     picked up without restarting.
//
//     Production behaviour:
//       * HTTP 200 + SSE: streamed events.
//       * HTTP 401: emits { type: 'error', code: 'auth-failed' }.
//         NO retry.
//       * HTTP 429: parse Retry-After. If absent, default to 30s. Retry
//         up to 3 times with exponential backoff (1s, 2s, 4s) capped by
//         Retry-After. AbortSignal aborts the backoff sleep. Emits a
//         status event on the (optional) bus. On exhaustion, emits
//         { type: 'error', code: 'rate-limited' }.
//       * HTTP 5xx: one retry with 1s backoff, then error.
//       * HTTP 4xx (not 401, not 429): no retry; error.
//       * Network failure (TypeError): one retry, 1s backoff, then error.
//
//   - createMockProvider: a deterministic, network-free double. Used by
//     the agent loop in tests and as a safe fallback when no key is
//     configured.
//
// SECURITY
// --------
// The OpenAI provider's `apiKey` argument is captured into the request
// Authorization header but is NEVER serialised into error messages, log
// lines, or thrown exceptions. Tests pin this.
//
// The credential value is read FRESH on every call. We do NOT cache the
// key inside the provider, so a rotated key is picked up without restart.

import { Audit } from "../audit/index.js";
// ---------------------------------------------------------------------------
// Provider health metrics (in-memory)
// ---------------------------------------------------------------------------
//
// A tiny per-provider counter store that backs the renderer's ProviderHealth
// panel. Keys are derived from endpoint + model and NEVER contain the apiKey
// (same rule as the audit block below). Latencies are kept in a bounded ring
// buffer so the store cannot grow without limit. Nothing here touches the
// agent loop: recording happens inside createOpenAiProvider's existing
// streamChat wrapper (latency / outcome) and in its 429 branch (last429).

const PROVIDER_HEALTH_RING = 100;
const providerHealth = new Map(); // key -> stats

function providerHealthKey(name) {
  return String(name || "unnamed");
}

function providerHealthStats(key) {
  let s = providerHealth.get(key);
  if (!s) {
    s = { key, requests: 0, success: 0, errors: 0, latencies: [], last429: null };
    providerHealth.set(key, s);
  }
  return s;
}

/**
 * Human-readable label for a provider key. The apiKey is never involved.
 * Exported for tests.
 *
 * @param {{endpoint?: string, model?: string}} p
 * @returns {string} e.g. "api.openai.com · gpt-4o-mini"
 */
export function providerHealthName({ endpoint, model } = {}) {
  const raw = String(endpoint || "").replace(/\/+$/, "");
  // Strip the URL scheme, then take the host — splitting on "/" alone
  // would yield "https:" from "https://api.openai.com".
  const noScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const host = noScheme.split(/[/:?#]/)[0] || "openai";
  return `${host} · ${String(model || "unknown")}`;
}

/**
 * Record the outcome of one completed streamChat call.
 *
 * @param {object} p
 * @param {string} p.name        provider key (see providerHealthName)
 * @param {boolean} p.ok         true when the call finished without an error event
 * @param {number} [p.latencyMs] wall-clock ms for the call
 * @param {string} [p.status]    result code; "rate-limited" also stamps last429
 */
export function recordProviderRequest({ name, ok, latencyMs, status = null } = {}) {
  const s = providerHealthStats(providerHealthKey(name));
  s.requests += 1;
  if (ok) s.success += 1;
  else s.errors += 1;
  if (typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0) {
    s.latencies.push(latencyMs);
    if (s.latencies.length > PROVIDER_HEALTH_RING) s.latencies.shift();
  }
  if (status === "rate-limited") s.last429 = Date.now();
  return s;
}

/**
 * Stamp a 429 that was observed mid-call (before any retry succeeded), so
 * the panel shows it even when the call eventually recovered.
 */
export function recordProvider429({ name } = {}) {
  const s = providerHealthStats(providerHealthKey(name));
  s.last429 = Date.now();
  return s;
}

/**
 * Snapshot of every provider seen so far, sorted by name.
 *
 * @returns {Array<{name:string,requests:number,success:number,errors:number,errorRate:number,avgLatencyMs:(number|null),last429:(number|null)}>}
 */
export function getProviderHealth() {
  const out = [];
  for (const s of providerHealth.values()) {
    out.push({
      name: s.key,
      requests: s.requests,
      success: s.success,
      errors: s.errors,
      errorRate: s.requests > 0 ? s.errors / s.requests : 0,
      avgLatencyMs: s.latencies.length > 0
        ? Math.round(s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length)
        : null,
      last429: s.last429,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Test helper — clears the in-memory store. Production code never calls it.
export function resetProviderHealthForTests() {
  providerHealth.clear();
}

/**
 * @typedef {Object} ToolDef
 * @property {'function'} type
 * @property {{name: string, description: string, parameters: object}} function
 *
 * @typedef {Object} ChatMessage
 * @property {string} role
 * @property {string} [content]
 *
 * @typedef {Object} ChatEventTextDelta
 * @property {'text_delta'} type
 * @property {string} delta
 *
 * @typedef {Object} ChatEventToolCall
 * @property {'tool_call'} type
 * @property {string} id
 * @property {string} name
 * @property {string} args
 *
 * @typedef {Object} ChatEventUsage
 * @property {'usage'} type
 * @property {number} inputTokens
 * @property {number} outputTokens
 *
 * @typedef {Object} ChatEventFinish
 * @property {'finish'} type
 * @property {'stop'|'length'|'tool_calls'|'error'} reason
 *
 * @typedef {Object} ChatEventError
 * @property {'error'} type
 * @property {string} code
 * @property {string} message
 *
 * @typedef {ChatEventTextDelta|ChatEventToolCall|ChatEventUsage|ChatEventFinish|ChatEventError} ChatEvent
 */

/**
 * Build an OpenAI-compatible streaming chat provider.
 *
 * @param {object} opts
 * @param {string} opts.endpoint   base URL, NO trailing slash. e.g. "https://api.openai.com"
 * @param {string} opts.apiKey     bearer token. NEVER logged.
 * @param {string} opts.model      model name, e.g. "gpt-4o-mini"
 * @param {typeof fetch} [opts.fetchImpl]  injectable for tests; defaults to global fetch
 * @param {object} [opts.bus]      optional event bus. When provided, the
 *                                 provider emits `provider.status` events
 *                                 during rate-limit backoff so the
 *                                 renderer can show a user-visible message.
 * @param {number} [opts.maxRetries429=3]   max retries on 429
 * @param {number} [opts.maxRetries5xx=1]   max retries on 5xx / network
 * @returns {{ streamChat(opts: { messages: ChatMessage[], tools?: ToolDef[], signal?: AbortSignal }): AsyncIterable<ChatEvent> }}
 */
export function createOpenAiProvider({
  endpoint,
  apiKey,
  model,
  fetchImpl,
  bus = null,
  maxRetries429 = 3,
  maxRetries5xx = 1,
} = {}) {
  if (typeof endpoint !== "string" || !endpoint) throw new Error("provider: endpoint required");
  if (typeof apiKey !== "string") throw new Error("provider: apiKey required");
  if (typeof model !== "string" || !model) throw new Error("provider: model required");
  const doFetch = typeof fetchImpl === "function" ? fetchImpl : (...a) => fetch(...a);
  const healthName = providerHealthName({ endpoint, model });

  function emitStatus(type, payload) {
    try {
      if (bus && typeof bus.emit === "function") {
        bus.emit(type, payload);
      }
    } catch (_e) {
      // best-effort: a broken bus must not crash the provider
    }
  }

  return {
    /**
     * Stream a chat completion. Yields ChatEvent values until the
     * upstream sends [DONE], the connection errors, or the supplied
     * AbortSignal fires.
     */
    async *streamChat({ messages, tools, signal } = {}) {
      // Audit: provider call start. Tokens-out is finalised on end.
      // The apiKey is NEVER logged; only the endpoint + model appear in
      // `detail`. The audit log never throws — failures are swallowed
      // by Audit.log().
      const providerStartedAt = Date.now();
      let providerTokensOut = 0;
      let providerResult = "ok";
      const msgCount = Array.isArray(messages) ? messages.length : 0;
      Audit.log({
        event: "provider.call",
        profileId: null,
        projectId: null,
        agentId: null,
        tool: "streamChat",
        input_summary: `${model} ${msgCount} msg`,
        result: null,
        durationMs: null,
        detail: `endpoint=${endpoint} model=${model} messages=${msgCount}`,
      });
      try {
        const inner = streamChatBody({
          messages,
          tools,
          signal,
          endpoint,
          apiKey,
          model,
          doFetch,
          bus,
          maxRetries429,
          maxRetries5xx,
          emitStatus,
          recordProvider429,
          healthName,
          abortableSleep,
          safeText,
          truncate,
          parseSseEvent,
          DONE,
        });
        for await (const ev of inner) {
          if (ev && ev.type === "usage") {
            if (typeof ev.outputTokens === "number") providerTokensOut += ev.outputTokens;
          }
          if (ev && ev.type === "error") {
            providerResult = typeof ev.code === "string" ? ev.code : "fail";
          }
          yield ev;
        }
      } catch (e) {
        providerResult = e && e.name === "AbortError" ? "denied" : "fail";
        throw e;
      } finally {
        // Provider health: record every completed call except aborts
        // (a user cancel is not a provider fault).
        if (providerResult !== "denied") {
          recordProviderRequest({
            name: healthName,
            ok: providerResult === "ok",
            latencyMs: Date.now() - providerStartedAt,
            status: providerResult,
          });
        }
        Audit.log({
          event: "provider.call",
          profileId: null,
          projectId: null,
          agentId: null,
          tool: "streamChat",
          input_summary: `${model} ${msgCount} msg`,
          result: providerResult,
          durationMs: Date.now() - providerStartedAt,
          detail: `endpoint=${endpoint} model=${model} tokensOut=${providerTokensOut}`,
        });
      }
    },
  };
}

/**
 * streamChat body, factored out so the public streamChat() can wrap it
 * with audit logging + token counting without duplicating the retry +
 * SSE machinery. Returns an async iterable of ChatEvent values.
 */
async function* streamChatBody({
  messages,
  tools,
  signal,
  endpoint,
  apiKey,
  model,
  doFetch,
  maxRetries429,
  maxRetries5xx,
  emitStatus,
  recordProvider429,
  healthName,
  abortableSleep,
  safeText,
  truncate,
  parseSseEvent,
  DONE,
}) {
  const url = buildChatCompletionsUrl(endpoint);
  const body = {
    model,
    stream: true,
    messages: Array.isArray(messages) ? messages : [],
    // OpenAI-compatible servers only include the usage block in
    // streaming mode when this option is set (Phase 11 live finding:
    // without it the loop's token accounting stays at 0). Servers that
    // predate the field ignore it; if a provider rejects it we fall
    // back to a body without it and retry once.
    stream_options: { include_usage: true },
  };
  if (Array.isArray(tools) && tools.length > 0) body.tools = tools;

  // ----- Retry orchestration -----------------------------------------
  // The HTTP request is attempted up to N+1 times: the initial call
  // plus `maxRetries` retries. Retries are only triggered by:
  //   * HTTP 429 (rate limited)        -> up to maxRetries429
  //   * HTTP 5xx                       -> up to maxRetries5xx
  //   * Network failure (TypeError)    -> up to maxRetries5xx
  //   * Empty-body HTTP 400 (transient, see other-4xx branch) -> once
  // 401 / other 4xx / parse errors / abort are terminal.
  let attempt429 = 0;
  let attempt5xx = 0;
  let attemptTransient400 = 0;
  let text400 = null; // body text of a 400 response, read at most once
  let streamOptionsFallback = false;
  let res = null;
  let status = 0;

  while (true) {
text400 = null; // fresh response each attempt — never reuse a stale body
try {
  const reqBody = streamOptionsFallback ? { ...body } : body;
  if (streamOptionsFallback) delete reqBody.stream_options;
  res = await doFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(reqBody),
    signal,
  });
  status = res ? res.status : 0;
} catch (e) {
  // AbortError: silent. Network/HTTP-level: yield an error event.
  if (e && (e.name === "AbortError" || e.code === 20)) {
    return;
  }
  // Network failure. Decide retry.
  status = 0;
  if (attempt5xx < maxRetries5xx) {
    attempt5xx++;
    emitStatus("provider.status", {
      kind: "retry",
      reason: "network-error",
      attempt: attempt5xx,
      delayMs: 1000,
    });
    const slept = await abortableSleep(1000, signal);
    if (slept.aborted) return;
    continue;
  }
  yield {
    type: "error",
    code: "network-error",
    message: String(e && e.message || e),
  };
  return;
}

// ---- status-based retry decisions --------------------------------
if (res && res.ok) break; // 2xx — proceed to stream body

// A 400 that explicitly rejects stream_options: retry once without it
// so usage-less (but otherwise functional) backends still work. Any
// OTHER 400 stays terminal per the 4xx contract.
if (status === 400 && !streamOptionsFallback && body.stream_options) {
  let mentionsStreamOptions = false;
  try {
    // Read the body ONCE — a second res.text() after consumption
    // returns "" and would make a genuine malformed 400 look like a
    // transient empty-body 400 (Phase 13 finding).
    if (text400 === null) text400 = await safeText(res);
    mentionsStreamOptions = /stream_options/i.test(text400 || "");
  } catch (_e) { mentionsStreamOptions = false; }
  if (mentionsStreamOptions) {
    streamOptionsFallback = true;
    try { if (res && res.body) await res.body.cancel(); } catch (_e) { /* best effort */ }
    continue;
  }
}

// 401: terminal
if (status === 401) {
  const text = await safeText(res);
  const snippet = text ? truncate(text, 200) : "";
  yield {
    type: "error",
    code: "auth-failed",
    message: `provider HTTP 401${snippet ? `: ${snippet}` : ""}`,
  };
  return;
}

// 429: rate limited, exponential backoff
if (status === 429) {
  // Stamp the 429 immediately so the health panel sees it even when a
  // later retry succeeds.
  if (typeof recordProvider429 === "function") recordProvider429({ name: healthName });
  if (attempt429 >= maxRetries429) {
    const text = await safeText(res);
    yield {
      type: "error",
      code: "rate-limited",
      message: `provider HTTP 429 after ${attempt429} retries`,
    };
    return;
  }
  attempt429++;
  const headerVal = res.headers && typeof res.headers.get === "function"
    ? res.headers.get("retry-after")
    : null;
  let retryMs = parseRetryAfter(headerVal);
  if (retryMs == null) retryMs = 30000; // default per brief
  // Exponential backoff: 1s, 2s, 4s, ... capped by Retry-After.
  const expoMs = Math.min(1000 * Math.pow(2, attempt429 - 1), retryMs);
  emitStatus("provider.status", {
    kind: "rate-limited",
    reason: "http-429",
    attempt: attempt429,
    delayMs: expoMs,
  });
  const slept = await abortableSleep(expoMs, signal);
  if (slept.aborted) return;
  // Drain the body of the 429 response to free the socket.
  try { if (res && res.body) await res.body.cancel(); } catch (_e) { /* best effort */ }
  continue;
}

// 5xx: one retry
if (status >= 500 && status < 600) {
  if (attempt5xx < maxRetries5xx) {
    attempt5xx++;
    emitStatus("provider.status", {
      kind: "retry",
      reason: "http-5xx",
      attempt: attempt5xx,
      delayMs: 1000,
      status,
    });
    const slept = await abortableSleep(1000, signal);
    if (slept.aborted) return;
    try { if (res && res.body) await res.body.cancel(); } catch (_e) { /* best effort */ }
    continue;
  }
  const text = await safeText(res);
  const snippet = text ? truncate(text, 200) : "";
  yield {
    type: "error",
    code: "server-error",
    message: `provider HTTP ${status}${snippet ? `: ${snippet}` : ""}`,
  };
  return;
}

// Other 4xx: terminal — with ONE bounded exception. Phase 12/13 live
// evidence: b.ai intermittently returns HTTP 400 with an EMPTY body for
// provably well-formed requests (captured via PROGRESSLEDGER_V2_DEBUG_HTTP_DIR;
// identical shapes succeed on retry), i.e. load-dependent transients.
// A genuine malformed-request 400 carries a JSON error body, so the
// empty-body 400 is the discriminator. Retry the identical request ONCE
// after a short abortable backoff; the stream has not started at this
// point, so the retry is safe. Everything else stays terminal.
const text = status === 400
  ? (text400 === null ? await safeText(res) : text400)
  : await safeText(res);
if (status === 400 && !text && attemptTransient400 < 1) {
  attemptTransient400++;
  emitStatus("provider.status", { kind: "retry", reason: "transient-400", attempt: attemptTransient400, delayMs: 1000 });
  const slept = await abortableSleep(1000, signal);
  if (slept.aborted) return;
  try { if (res && res.body) await res.body.cancel(); } catch (_e) { /* best effort */ }
  continue;
}
const snippet = text ? truncate(text, 200) : "";
yield {
  type: "error",
  code: "http-error",
  message: `provider HTTP ${status}${snippet ? `: ${snippet}` : ""}`,
};
return;
  }

  // ----- 2xx — consume the SSE stream --------------------------------
  if (!res || !res.ok) {
// Defensive: should not be reachable because we `break` only on ok.
yield { type: "error", code: "stream-error", message: "no response" };
return;
  }

  const reader = res.body && typeof res.body.getReader === "function" ? res.body.getReader() : null;
  if (!reader) {
yield { type: "error", code: "stream-error", message: "response has no readable body" };
return;
  }

  const decoder = new TextDecoder("utf-8");
  let buf = "";
  // Phase 11 (live finding): OpenAI-compatible servers stream tool
  // calls as FRAGMENTS — `delta.tool_calls[i]` carries an `index`, an
  // id/name on the first fragment, and incremental `arguments` pieces
  // across many chunks. Yielding per fragment produced broken
  // tool_call events (empty name, partial JSON args). Accumulate by
  // index and emit each COMPLETE call right before the finish event.
  // Phase 11 (live finding): weak-function-calling models invent text
  // formats for tool calls (<tool_call> JSON, bare JSON, or XML whose
  // tag IS the tool name). The declared tool list lets the accumulator
  // validate XML blocks against known tools — no false positives.
  const toolNames = (Array.isArray(tools) ? tools : [])
    .map((t) => t && t.function && t.function.name)
    .filter((n) => typeof n === "string" && n.length > 0);
  const sse = createSseAccumulator(signal, toolNames);
  try {
    let streamEnded = false;
    while (!streamEnded) {
      const { value, done: rdone } = await reader.read();
      if (rdone) break;
      buf += decoder.decode(value, { stream: true });
      // Process complete events (delimited by a blank line).
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const rawEvent = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const events = parseSseEvent(rawEvent);
        for (const ev of events) {
          for (const out of sse.feed(ev)) {
            if (out === DONE) { streamEnded = true; break; }
            yield out;
          }
          if (streamEnded) break;
        }
        if (streamEnded) break;
      }
    }
    // Drain any trailing partial event.
    if (!streamEnded && buf.trim().length > 0) {
      const events = parseSseEvent(buf);
      for (const ev of events) {
        for (const out of sse.feed(ev)) {
          if (out === DONE) { streamEnded = true; break; }
          yield out;
        }
        if (streamEnded) break;
      }
    }
    // Flush accumulated tool calls + the deferred finish event.
    for (const out of sse.flush()) {
      yield out;
    }
  } catch (e) {
    if (e && (e.name === "AbortError" || e.code === 20)) return;
    yield { type: "error", code: "stream-error", message: String(e && e.message || e) };
    return;
  }

  // If the upstream closed the stream without [DONE], emit a
  // synthetic finish so the agent loop knows we ended. flush() already
  // emitted a finish when the upstream sent one; only synthesize when
  // it did not.
  if (!sse.sawFinish) {
    yield { type: "finish", reason: "stop" };
  }
}

/**
 * Stateful SSE payload accumulator. `feed(data)` returns the array of
 * ChatEvent values to emit for one `data:` payload (plus DONE when the
 * stream must end); complete tool calls and the finish event are
 * deferred to `flush()` so the agent loop always sees
 * [tool_call*] -> [finish] in that order.
 */
/**
 * True when the first non-whitespace character of `s` is "{" — the
 * possible opening of a bare-JSON tool call.
 */
function startsWithBraceAt(s) {
  const m = s.match(/\S/);
  return m !== null && s[m.index] === "{";
}

/**
 * Parse candidate tool-call payload(s) — tagged block, fenced block, or
 * whole message. Returns an array of tool_call events. Accepts the
 * key conventions seen across OpenAI-compatible models — name|tool|
 * function.name for the tool and arguments|parameters|input|args for
 * the payload, plus the standard OpenAI response envelope
 * {"tool_calls":[{function:{name,arguments}}]} — deliberately not tied
 * to one model family.
 */
function parseToolCallObject(raw, startIndex) {
  let obj = null;
  try { obj = JSON.parse(String(raw || "").trim()); } catch (_e) { return []; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  // Standard OpenAI envelope: {"tool_calls": [{id?, function?: {name, arguments}}]}
  // Some models omit the function wrapper: {"tool_calls": [{name, arguments}]}.
  if (Array.isArray(obj.tool_calls)) {
    const out = [];
    for (const tc of obj.tool_calls) {
      const fn = (tc && tc.function) || tc;
      if (!fn || typeof fn.name !== "string" || !fn.name) continue;
      const a = fn.arguments;
      const args = typeof a === "string" ? a : JSON.stringify(a ?? {});
      out.push({ type: "tool_call", id: typeof tc.id === "string" && tc.id ? tc.id : `text-call-${startIndex + out.length + 1}`, name: fn.name, args });
    }
    return out;
  }
  const name = obj.name || obj.tool || (obj.function && obj.function.name) || "";
  if (!name) return [];
  let argsObj = obj.arguments ?? obj.parameters ?? obj.input ?? obj.args
    ?? (obj.function && (obj.function.arguments ?? obj.function.parameters)) ?? {};
  const args = typeof argsObj === "string" ? argsObj : JSON.stringify(argsObj ?? {});
  return [{ type: "tool_call", id: `text-call-${startIndex + 1}`, name: String(name), args }];
}

function createSseAccumulator(signal, toolNames = []) {
  const pendingToolCalls = new Map(); // index -> { id, name, args }
  const textParts = [];               // accumulated assistant text
  let emittedUpTo = 0;                // chars already streamed as text_delta
  let textFrozen = false;             // saw a tool-call opener: stop streaming text
  let finishEvent = null;
  const openers = ["<tool_call", ...toolNames.map((n) => "<" + n)];
  // Longest opener-prefix suffix holdback across all openers.
  const holdback = (s) => {
    let max = 0;
    for (const op of openers) {
      const m = Math.min(op.length - 1, s.length);
      for (let k = m; k > max; k--) {
        if (op.startsWith(s.slice(s.length - k))) { max = k; break; }
      }
    }
    return max;
  };
  const findOpener = (s, from) => {
    let best = -1;
    for (const op of openers) {
      const i = s.indexOf(op, from);
      if (i !== -1 && (best === -1 || i < best)) best = i;
    }
    return best;
  };
  const acc = {
    sawFinish: false,
    *feed(data) {
      if (data === "[DONE]") {
        acc.sawFinish = true;
        yield DONE;
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch (_e) {
        // Malformed line. We surface it as an error event so the agent
        // loop can stop. Tolerating silently would hide upstream bugs.
        acc.sawFinish = true;
        yield { type: "error", code: "malformed-sse", message: "could not parse SSE chunk as JSON" };
        yield DONE;
        return;
      }
      if (signal && signal.aborted) {
        acc.sawFinish = true;
        yield DONE;
        return;
      }

      const choice = parsed && parsed.choices && parsed.choices[0];
      if (choice) {
        const delta = choice.delta || {};
        if (typeof delta.content === "string" && delta.content.length > 0) {
          textParts.push(delta.content);
          // Freeze live text streaming at the first character that
          // could open a tool call (a "<tool_call" tag, a "<toolname"
          // XML block, or a leading "{" bare-JSON call). flush()
          // either extracts calls or re-emits the held text as prose.
          if (!textFrozen) {
            const full = textParts.join("");
            const trimmedIdx = full.search(/\S/);
            const braceIdx = startsWithBraceAt(full) ? trimmedIdx : -1;
            const tagIdx = findOpener(full, emittedUpTo);
            if (tagIdx !== -1 || braceIdx !== -1) {
              textFrozen = true;
              const freezeAt = tagIdx !== -1 && (braceIdx === -1 || tagIdx <= braceIdx)
                ? tagIdx
                : braceIdx;
              const slice = full.slice(emittedUpTo, freezeAt);
              emittedUpTo = freezeAt;
              if (slice.length > 0) yield { type: "text_delta", delta: slice };
            } else {
              const hold = holdback(full);
              const safeEnd = full.length - hold;
              if (safeEnd > emittedUpTo) {
                yield { type: "text_delta", delta: full.slice(emittedUpTo, safeEnd) };
                emittedUpTo = safeEnd;
              }
            }
          }
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const key = typeof tc.index === "number" ? tc.index : pendingToolCalls.size;
            const cur = pendingToolCalls.get(key) || { id: "", name: "", args: "" };
            if (typeof tc.id === "string" && tc.id) cur.id = tc.id;
            if (tc.function && typeof tc.function === "object") {
              if (typeof tc.function.name === "string") cur.name += tc.function.name;
              if (typeof tc.function.arguments === "string") cur.args += tc.function.arguments;
            }
            pendingToolCalls.set(key, cur);
          }
        }
      }
      // Usage is handled BEFORE the finish_reason check: some providers
      // attach the usage block to the same chunk that carries
      // finish_reason, others send it as its own final chunk (with
      // empty choices). Both shapes must yield a usage event.
      if (parsed && parsed.usage && typeof parsed.usage === "object") {
        yield {
          type: "usage",
          inputTokens: Number(parsed.usage.prompt_tokens || 0),
          outputTokens: Number(parsed.usage.completion_tokens || 0),
        };
      }
      if (choice && typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) {
        finishEvent = { type: "finish", reason: mapFinishReason(choice.finish_reason) };
        acc.sawFinish = true;
        yield DONE;
        return;
      }
    },
    *flush() {
      // 1) Any prose still held back (text frozen before a tool_call
      //    block, or the stream ended without one).
      const full = textParts.join("");
      const tail = full.slice(emittedUpTo);
      // 2) Extract text-embedded tool calls. Accepts the common
      //    conventions seen across OpenAI-compatible models
      //    (name|tool|function + arguments|parameters|input|args) —
      //    deliberately NOT tied to one model family.
      const textCalls = [];
      let prose = tail;
      const re = /<tool_call>\s*([\s\S]*?)(?:<\/tool_call>|$)/g;
      let m;
      while ((m = re.exec(tail)) !== null) {
        prose = prose.replace(m[0], "");
        for (const tc of parseToolCallObject(m[1], textCalls.length)) textCalls.push(tc);
      }
      // XML-style blocks whose TAG IS A DECLARED TOOL NAME
      // (<fs_search><pattern>x</pattern></fs_search>). Validated
      // against the declared tool list, so ordinary prose with angle
      // brackets can never trigger it. Child elements become
      // parameters; a JSON-only body is parsed directly.
      // Bare-JSON fallback (fenced ```json block or the ENTIRE message
      // being a tool-call object) runs only when no other call was
      // found, keeping false positives off ordinary prose.
      for (const name of toolNames) {
        const re2 = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g");
        while ((m = re2.exec(tail)) !== null) {
          prose = prose.replace(m[0], "");
          const inner = m[1];
          const args = {};
          const childRe = /<(\w+)>([\s\S]*?)<\/\1>/g;
          let cm;
          let matchedChild = false;
          while ((cm = childRe.exec(inner)) !== null) {
            matchedChild = true;
            const rawVal = cm[2].trim();
            let val;
            try { val = JSON.parse(rawVal); } catch (_e) { val = rawVal; }
            args[cm[1]] = val;
          }
          if (!matchedChild) {
            const t = inner.trim();
            if (t.startsWith("{")) {
              try { Object.assign(args, JSON.parse(t)); } catch (_e) { /* keep empty */ }
            }
          }
          textCalls.push({ type: "tool_call", id: `text-call-${textCalls.length + 1}`, name, args: JSON.stringify(args) });
        }
      }
      // Bare-JSON fallback (fenced ```json block or the ENTIRE held
      // text being a tool-call object): runs only when no other call
      // was found, keeping false positives off ordinary prose.
      if (textCalls.length === 0 && pendingToolCalls.size === 0) {
        const candidates = [];
        const fence = /```(?:json)?\s*([\s\S]*?)```/g;
        while ((m = fence.exec(tail)) !== null) candidates.push(m[1]);
        const trimmed = tail.trim();
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) candidates.push(trimmed);
        for (const c of candidates) {
          const tcs = parseToolCallObject(c, 0);
          if (tcs.length > 0) {
            for (const tc of tcs) textCalls.push(tc);
            prose = prose.replace(c, "");
            break;
          }
        }
      }
      if (prose.trim().length > 0) {
        yield { type: "text_delta", delta: prose };
      }
      // 3) Native tool calls first, then text-derived ones, then
      //    finish — the loop executes every tool_call event it gets.
      for (const tc of pendingToolCalls.values()) {
        if (tc.name || tc.args) {
          yield { type: "tool_call", id: tc.id, name: tc.name, args: tc.args };
        }
      }
      for (const tc of textCalls) {
        yield tc;
      }
      if (finishEvent) {
        yield finishEvent;
      } else {
        yield { type: "finish", reason: "stop" };
        acc.sawFinish = true;
      }
    },
  };
  return acc;
}

/**
 * A deterministic, network-free provider.
 *
 *   - `text` option controls the streamed reply (split into two
 *     text_delta events so the loop exercises streaming aggregation).
 *   - `toolCalls` option, when supplied, makes the FIRST streamChat
 *     call emit one tool_call event per entry followed by a
 *     finish(reason="tool_calls"). Subsequent calls behave like the
 *     default.
 */
export function createMockProvider(opts = {}) {
  const { toolCalls = null, text = "Hello world." } = opts || {};
  let round = 0;

  return {
    async *streamChat(_args = {}) {
      round += 1;
      if (toolCalls && round === 1) {
        for (const tc of toolCalls) {
          yield { type: "tool_call", id: tc.id, name: tc.name, args: tc.args };
        }
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      // Two text deltas to exercise streaming aggregation.
      const mid = Math.max(1, Math.floor(text.length / 2));
      yield { type: "text_delta", delta: text.slice(0, mid) };
      yield { type: "text_delta", delta: text.slice(mid) };
      yield { type: "usage", inputTokens: 11, outputTokens: 22 };
      yield { type: "finish", reason: "stop" };
    },
    _getRound() {
      return round;
    },
  };
}

// ---------------------------------------------------------------------------
// internals (exported for tests)
// ---------------------------------------------------------------------------

const DONE = Symbol("DONE");

/**
 * Parse a `Retry-After` header value. Accepts either:
 *   - seconds (integer)
 *   - HTTP-date
 * Returns a number of milliseconds. Returns null if unparseable.
 * Module-scope so tests can call it directly.
 */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (typeof value !== "string" || value.length === 0) return null;
  const trimmed = value.trim();
  // Numeric seconds?
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const secs = Number(trimmed);
    if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  }
  // HTTP-date
  const t = Date.parse(trimmed);
  if (Number.isFinite(t)) {
    const diff = t - nowMs;
    return diff > 0 ? diff : 0;
  }
  return null;
}

/**
 * Abortable sleep used between retries. Resolves when the timer fires
 * OR when `signal` aborts. Returns { aborted: boolean } so the caller
 * can detect whether the timer was preempted. Exported for tests.
 */
export function abortableSleep(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve({ aborted: false });
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve({ aborted: true });
      return;
    }
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({ aborted: false });
    }, ms);
    function onAbort() {
      clearTimeout(t);
      resolve({ aborted: true });
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Concatenate base + path with a single slash between them. */
export function joinUrl(base, path) {
  const b = String(base).replace(/\/+$/, "");
  const p = String(path).startsWith("/") ? path : "/" + path;
  return b + p;
}

/**
 * Build the chat-completions URL from a stored endpoint.
 *
 * The ProviderConfigPanel documents a BARE base URL (e.g.
 * `https://api.openai.com`) and the provider appends `/v1/chat/completions`.
 * However, a versioned base is the conventional form for OpenAI-compatible
 * providers — and users (and their tooling) commonly store it WITH the
 * version segment (`https://api.openai.com/v1`). Historically that became
 * `<base>/v1/v1/chat/completions`, i.e. HTTP 404 for a perfectly valid
 * credential, with no operator-visible cause.
 *
 * This is deliberately idempotent so both configured forms work:
 *   https://api.openai.com            -> .../v1/chat/completions
 *   https://api.openai.com/v1         -> .../v1/chat/completions
 *   https://host/v1/chat/completions  -> unchanged
 * Bare-host behavior is unchanged (existing gates depend on it).
 */
export function buildChatCompletionsUrl(endpoint) {
  const base = String(endpoint).replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return base + "/chat/completions";
  return base + "/v1/chat/completions";
}

/**
 * Parse a single SSE "event" block (the text between blank lines).
 * Returns an array of data payload strings, one per `data:` line.
 * Skips comment lines (": ...") and non-data lines.
 */
export function parseSseEvent(block) {
  const lines = String(block).split(/\r?\n/);
  let current = null;
  const datas = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue; // SSE comment
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      current = (current == null ? "" : current) + value;
    } else if (field === "event") {
      // ignored for our purposes; we only care about data
    }
  }
  if (current != null) datas.push(current);
  return datas;
}

function mapFinishReason(r) {
  if (r === "stop" || r === "length" || r === "tool_calls" || r === "error") return r;
  // OpenAI-compatible providers vary; default to "stop".
  return "stop";
}

async function safeText(res) {
  try {
    if (res && typeof res.text === "function") return await res.text();
  } catch (_e) {
    // best-effort
  }
  return "";
}

function truncate(s, n) {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n) + "...";
}
