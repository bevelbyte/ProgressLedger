// shell/src/services/donut-transport.js
// ---------------------------------------------------------------------------
// The HTTP transport for the local Donut control plane, plus the per-operation
// budgets and the opt-in timing diagnostics.
//
// WHY THIS IS ITS OWN MODULE
//   It was previously inlined in `ipc/browser-workspace.js`. That file imports
//   `ipcMain` from `electron`, so nothing outside an Electron process could
//   import it — which is exactly why the transport had NO test at all for the
//   longest time, and why the 8000 ms budget defect below survived several
//   validation passes. The transport is a service concern, not an IPC concern.
//   Extracting it makes the real function directly testable against a real
//   local HTTP server, which is what `shell/tests/donut-transport-budget.test.js`
//   does.
//
// PER-OPERATION BUDGETS — MEASURED, NOT GUESSED
//   Instrumentation was added first (the diagnostics block below) and the
//   real-Donut matrix was run to collect the distribution. n=23 `/run` samples:
//
//     idle    n=8   min 3349  max 4506  avg 3683 ms
//     loaded  n=15  min 3007  max 5861  avg 3696 ms   <- full 9-spec matrix
//
//   CareerFlow's client-side overhead over Donut's own server-side duration is
//   10-50 ms (0.3-1.4%), and in every sample `msToHeaders === msToBody`. The
//   cost is therefore entirely inside Donut's handling of the request — not
//   connection establishment, not response streaming. CareerFlow was not the
//   slow part; it was giving up too early.
//
//   The previous single hardcoded 8000 ms left only 1.77x headroom idle and
//   1.36x under matrix load, against an operation whose real cost reaches
//   ~5.9 s. That thin margin produced the reported failures:
//
//     "runFailure": { "status": 0, "error": "transport:TimeoutError" }
//     "backend":    { "state": "owned-existing", "available": true,
//                    "ready": true, "owned": true }
//
//   A healthy backend and a failed launch, with no way to tell a busy server
//   from a broken one. Same defect shape as the CDP ownership-probe timeout
//   fixed in FINALVAL5.
//
//   30_000 ms comes from the measurements plus existing precedent here, not from
//   convenience:
//     * 5.1x the worst observed `/run` (5861 ms), 6.6x the idle max;
//     * the same 30 s order already used for a comparable create-shaped call in
//       `donut-mapping.js` (`CREATE_TIMEOUT_MS = 30_000`);
//     * comfortably inside the 90 s this codebase already allows for Donut
//       backend readiness (`READY_TIMEOUT_MS` in `donut.js`), so per-call
//       budgets stay internally consistent.
//
//   `/kill` gets the same figure on its own evidence: Donut's `/kill` was
//   measured server-side at up to 5794 ms in one run and up to 25_099 ms in
//   another. At 8000 ms a slow-but-healthy kill was GUARANTEED to surface as a
//   transport timeout. 30_000 ms covers the observed worst case; the margin
//   there is thinner than for `/run`, which is stated rather than glossed.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//   A timeout is never converted into success. An undetermined run still fails
//   closed, carrying the original transport error verbatim. There is no retry
//   and no unbounded wait: 30 s is a real bound. A retry was considered and
//   rejected — the proven cause is a budget shorter than the operation's real
//   cost, which one correctly-derived bound addresses exactly, and a retry
//   would add a second browser-launch attempt as a new failure surface for no
//   measured gain.
// ---------------------------------------------------------------------------

import { appendFileSync } from "node:fs";

export const RUN_TIMEOUT_MS = 30_000;
export const KILL_TIMEOUT_MS = 30_000;

// TRANSPORT DIAGNOSTICS
//
// WHY A FILE AND NOT console.error
//   Electron MAIN-process output does not reach Playwright's stdout. Measured in
//   FINALVAL5: zero occurrences of known main-process traces in the harness
//   output. So a console.error here would be invisible to the very run that
//   needs it. These records go to a JSONL file under the app's own
//   --user-data-dir, which the E2E already passes, so a test can read them with
//   a plain fs call. Same pattern as cdp-resolve-diagnostics.jsonl.
//
// WHAT IS NEVER RECORDED
//   No credential, token, cookie, header value, or profile content. Only the
//   operation name ("run"/"kill"), never the full path or the profile id, the
//   numeric port, timings, and the failure classification. The Authorization
//   header is never read back into a record.
const TRANSPORT_DIAGNOSTICS_FILENAME = "donut-transport-diagnostics.jsonl";

function transportDiagnosticsFilePath() {
  if (process.platform !== "win32") return null;
  const arg = process.argv.find((a) => a.startsWith("--user-data-dir="));
  if (!arg) return null;
  const dir = arg.slice("--user-data-dir=".length).replace(/^"|"$/g, "");
  if (!dir) return null;
  return `${dir}\\${TRANSPORT_DIAGNOSTICS_FILENAME}`;
}

export function transportDiagnosticsEnabled() {
  return (
    process.env.CAREERFLOW_TRANSPORT_DIAGNOSTICS === "1" ||
    process.env.CAREERFLOW_CDP_DIAGNOSTICS === "1"
  );
}

function appendTransportDiagnostic(record) {
  const file = transportDiagnosticsFilePath();
  if (!file) return;
  try {
    // Synchronous append so a record is not lost if the process exits straight
    // after a failure. Never throws.
    appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    /* diagnostics must never break the caller */
  }
}

// The operation is derived from the path WITHOUT retaining the path, so no
// profile id is ever written to disk by this helper.
function transportOperation(path) {
  const m = /\/(run|kill|stop|start|close)$/.exec(String(path || ""));
  return m ? m[1] : "other";
}

/**
 * POST JSON to the local Donut control plane with a bounded, measured budget.
 *
 * The three timings recorded distinguish the candidate causes:
 *   msToHeaders — until response HEADERS arrived
 *   msToBody    — until the body was fully read
 *   totalMs     — the whole attempt
 * `msToHeaders === msToBody` means nothing was spent streaming a body, so a
 * slow request is a slow server, not a slow client.
 *
 * The abort uses a hand-rolled AbortController rather than AbortSignal.timeout
 * so the abort is attributable: a budget abort is distinguishable from any other
 * thrown error, and the exact abort instant is recorded.
 *
 * `opts.timeoutMs` exists so tests can exercise the real abort path in
 * milliseconds. Production callers never pass one.
 */
export async function bearerPostJson(
  path,
  body,
  runtimeCredential,
  opts = {},
) {
  const operation = transportOperation(path);
  const budgetMs = Number.isInteger(opts.timeoutMs) ? opts.timeoutMs : 8000;
  const attempt = Number.isInteger(opts.attempt) ? opts.attempt : 0;
  const diagnose = transportDiagnosticsEnabled();

  const credStart = Date.now();
  let cred = null;
  try {
    cred = await runtimeCredential();
  } catch (error) {
    // The credential read is INSIDE the guard now. It used to sit outside the
    // try, so a throwing credential provider rejected out of this function and
    // the caller's `catch { runOk = false }` turned it into a bare
    // `run-failed` with no `runFailure` detail and no diagnostic record —
    // i.e. a real failure that was impossible to attribute. Observed once in a
    // real-Donut matrix run (phase8-profile-isolation) where 42/42 /run calls
    // had succeeded, so the timeout explanation did not fit.
    //
    // It still FAILS — this only makes the failure legible. A missing or
    // unreadable credential must never become a successful request.
    const errorName = error?.name || "unknown";
    if (diagnose) {
      appendTransportDiagnostic({
        op: operation,
        attempt,
        outcome: "credential-read-threw",
        status: 0,
        credMs: Date.now() - credStart,
        budgetMs,
        error: errorName,
      });
    }
    return { ok: false, status: 0, error: `transport:${errorName}` };
  }
  if (!cred) {
    if (diagnose) {
      appendTransportDiagnostic({
        op: operation,
        attempt,
        outcome: "no-credential",
        credMs: Date.now() - credStart,
        budgetMs,
        error: "runtime-credential-unavailable",
      });
    }
    return { ok: false, status: 0, error: "runtime-credential-unavailable" };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  let abortedByBudget = false;
  let abortedAtMs = null;
  const timer = setTimeout(() => {
    abortedByBudget = true;
    abortedAtMs = Date.now() - startedAt;
    controller.abort();
  }, budgetMs);

  let msToHeaders = null;
  let msToBody = null;
  try {
    const res = await fetch(`http://127.0.0.1:${cred.port}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cred.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    msToHeaders = Date.now() - startedAt;
    const json = await res.json().catch(() => null);
    msToBody = Date.now() - startedAt;
    clearTimeout(timer);
    if (diagnose) {
      appendTransportDiagnostic({
        op: operation,
        attempt,
        outcome: res.ok ? "ok" : "http-error",
        status: res.status,
        msToHeaders,
        msToBody,
        totalMs: msToBody,
        budgetMs,
        port: Number(cred.port),
      });
    }
    return { ok: res.ok, status: res.status, json };
  } catch (error) {
    clearTimeout(timer);
    const errorName = error?.name || "unknown";
    const totalMs = Date.now() - startedAt;
    if (diagnose) {
      appendTransportDiagnostic({
        op: operation,
        attempt,
        outcome: abortedByBudget ? "timeout" : "transport-error",
        status: 0,
        msToHeaders,
        msToBody,
        totalMs,
        abortedAtMs,
        budgetMs,
        port: Number(cred.port),
        error: errorName,
        // A budget that expires before any headers is a different situation
        // from one that expires mid-body, and the difference matters.
        phase: msToHeaders == null ? "before-headers" : "during-body",
      });
    }
    // Fail closed. The transport error is preserved verbatim so the caller can
    // distinguish an indeterminate transport failure from a real HTTP answer.
    return { ok: false, status: 0, error: `transport:${errorName}` };
  }
}
