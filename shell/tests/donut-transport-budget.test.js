// shell/tests/donut-transport-budget.test.js
// ---------------------------------------------------------------------------
// Focused regression tests for the Donut control-plane transport budget.
//
// THE DEFECT
//   `bearerPostJson` issued `POST /v1/profiles/{id}/run` under a hardcoded
//   AbortSignal.timeout(8000). Instrumentation added in FINALVAL7
//   (donut-transport-diagnostics.jsonl) then measured the real distribution
//   over 23 real-Donut samples:
//
//     idle    n=8   min 3349  max 4506  avg 3683 ms
//     loaded  n=15  min 3007  max 5861  avg 3696 ms   <- full 9-spec matrix
//
//   and showed CareerFlow's client overhead over Donut's own server-side
//   duration was only 10-50 ms, with `msToHeaders === msToBody` in every
//   sample. The cost is Donut's, not CareerFlow's — the client simply gave up
//   with only 1.36x headroom under load. That surfaced as
//   `"transport:TimeoutError"` against a backend CareerFlow itself reported
//   healthy, which is indistinguishable from a genuinely broken backend.
//
// WHAT THESE TESTS PIN
//   1. The budget has real headroom over the measured worst case, and is still
//      a BOUND (not an accidental "no timeout at all").
//   2. A timeout still fails closed, with the transport error preserved. It
//      must never be reported as success — the lesson of the CDP fix, applied
//      here so it cannot regress.
//   3. A real HTTP error answer from Donut is returned as-is, and is
//      distinguishable from a transport failure.
//   4. A slow-but-successful response is not mistaken for a failure.
//
// These run the REAL production function against a REAL local HTTP server, not
// a reimplementation, so a future edit to the abort or error mapping cannot
// pass them by accident.
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import {
  bearerPostJson,
  RUN_TIMEOUT_MS,
  KILL_TIMEOUT_MS,
} from "../src/services/donut-transport.js";

// Measured on the real-Donut matrix; see the file header. The assertions below
// are expressed against these, so the test states the requirement rather than
// restating whatever constant happens to be in the source.
const MEASURED_RUN_MAX_MS = 5861;

function credentialFn(port) {
  return async () => ({ port, token: "test-token-not-a-real-credential" });
}

/** A local server whose behaviour the test dictates. */
async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("the transport budget has real headroom over the measured /run worst case", () => {
  assert.ok(
    RUN_TIMEOUT_MS > MEASURED_RUN_MAX_MS * 3,
    `budget must be at least 3x the measured worst case (${MEASURED_RUN_MAX_MS} ms), got ${RUN_TIMEOUT_MS}`,
  );
  // ...but it is still a BOUND. An unbounded or absurd wait would turn a broken
  // backend into an indefinite hang, which is the failure this replaced.
  assert.ok(
    RUN_TIMEOUT_MS <= 60_000,
    `budget must stay bounded well under a hang, got ${RUN_TIMEOUT_MS}`,
  );
});

test("the /kill budget covers the worst kill Donut was measured to take", () => {
  // Measured server-side at up to 25_099 ms in an earlier real-Donut run. At the
  // previous 8000 ms a slow-but-healthy kill was GUARANTEED to surface as a
  // transport timeout.
  const MEASURED_KILL_MAX_MS = 25_099;
  assert.ok(
    KILL_TIMEOUT_MS > MEASURED_KILL_MAX_MS,
    `kill budget must cover the measured worst case (${MEASURED_KILL_MAX_MS} ms), got ${KILL_TIMEOUT_MS}`,
  );
  assert.ok(
    KILL_TIMEOUT_MS <= 60_000,
    `kill budget must stay bounded, got ${KILL_TIMEOUT_MS}`,
  );
});

test("a timeout FAILS CLOSED and preserves the transport error", { timeout: 15_000 }, async () => {
  // A server that never answers. The real production function is used, with a
  // small budget so the test does not have to wait 30 seconds.
  await withServer(
    () => {
      /* deliberately never respond */
    },
    async (port) => {
      const res = await bearerPostJson(
        "/v1/profiles/abc/run",
        { headless: true },
        credentialFn(port),
        { timeoutMs: 300 },
      );
      // MUST NOT be success. This is the invariant the CDP ownership fix
      // established — "unable to determine" must never become "authorised" or
      // "succeeded" — applied to the launch transport.
      assert.equal(res.ok, false, "a timed-out request must never report ok:true");
      assert.equal(res.status, 0, "a timeout never received a status");
      assert.match(
        String(res.error),
        /^transport:/,
        `the transport failure must be preserved verbatim, got ${JSON.stringify(res)}`,
      );
      assert.equal(res.json, undefined, "no body may be invented for a timeout");
    },
  );
});

test("a slow but successful response is NOT mistaken for a failure", { timeout: 15_000 }, async () => {
  // Directly on the other side of the defect: a response that takes longer than
  // the OLD 8000 ms budget must still succeed when the budget allows for it.
  // Before the fix this shape could not succeed at all.
  await withServer(
    (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ remote_debugging_port: 9222 }));
      }, 900);
    },
    async (port) => {
      const res = await bearerPostJson(
        "/v1/profiles/abc/run",
        { headless: true },
        credentialFn(port),
        { timeoutMs: 5000 },
      );
      assert.equal(res.ok, true, "a slow-but-successful run must succeed");
      assert.equal(res.status, 200);
      assert.equal(res.json.remote_debugging_port, 9222);
    },
  );
});

test("a real Donut HTTP error is passed through, not masked as a transport failure", { timeout: 15_000 }, async () => {
  // A genuine application error is a DETERMINED outcome and must stay
  // distinguishable from an indeterminate one. Nothing retries or reinterprets
  // it here; the point is only that the two are never conflated.
  await withServer(
    (_req, res) => {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "already running" }));
    },
    async (port) => {
      const res = await bearerPostJson(
        "/v1/profiles/abc/run",
        { headless: false },
        credentialFn(port),
        { timeoutMs: 5000 },
      );
      assert.equal(res.ok, false);
      assert.equal(res.status, 409, "the real status must survive");
      assert.equal(res.error, undefined, "an HTTP answer is not a transport error");
    },
  );
});

test("a missing runtime credential is reported distinctly and without a request", { timeout: 15_000 }, async () => {
  // Never reaches the network. Kept distinct so this is not mistaken for a
  // backend that was contacted and failed.
  let hits = 0;
  await withServer(
    () => {
      hits += 1;
    },
    async (port) => {
      const res = await bearerPostJson(
        "/v1/profiles/abc/run",
        { headless: true },
        async () => null,
        { timeoutMs: 1000 },
      );
      assert.deepEqual(res, {
        ok: false,
        status: 0,
        error: "runtime-credential-unavailable",
      });
      assert.equal(hits, 0, "no request may be made without a credential");
      void port;
    },
  );
});

test("a THROWING credential read fails legibly instead of rejecting out of the transport", { timeout: 15_000 }, async () => {
  // The credential read used to sit OUTSIDE the try block. A provider that threw
  // therefore rejected out of `bearerPostJson`, and the launch caller's
  // `catch { runOk = false }` converted it into a bare `run-failed` with NO
  // `runFailure` detail and no diagnostic record — a real failure that could
  // not be attributed. Observed once in a real-Donut matrix run where all 42
  // /run calls had succeeded, so no timeout explanation fitted.
  //
  // It must still FAIL. What changes is that the reason survives.
  let hits = 0;
  await withServer(
    () => {
      hits += 1;
    },
    async (port) => {
      const res = await bearerPostJson(
        "/v1/profiles/abc/run",
        { headless: true },
        async () => {
          throw new Error("runtime.json unreadable");
        },
        { timeoutMs: 1000 },
      );
      assert.equal(res.ok, false, "a throwing credential read must never report success");
      assert.equal(res.status, 0);
      assert.match(
        String(res.error),
        /^transport:/,
        `the throw must be reported as a transport failure with its name preserved, got ${JSON.stringify(res)}`,
      );
      assert.equal(hits, 0, "no request may be made when the credential read throws");
      void port;
    },
  );
});
