# CareerFlow CDP Authentication Boundary

## R6 production usage disposition — 2026-10-11

**Production Donut control disposition:** CareerFlow does not use the custom CDP/DevTools transport to control Donut. `shell/src/ipc/index.js` no longer registers `shell/src/ipc/cdp.js`, and `shell/src/preload.cjs` no longer exposes the direct `cdp:*` renderer API. The registered `browser-workspace:*` compatibility IPC returns `feature-not-supported`; production workspace handlers no longer construct CDP adapters or query/focus foreign HWND/PID state. The Research/Browser Manager UI no longer claims live Donut tabs, page inspection, screenshots, or operator page activity.

The official Donut Browser Manager REST path for explicit profile opening and shortcut URL opening remains separate in `shell/src/ipc/browser-manager.js` and the `donut-manager.js` service. The CareerFlow-owned embedded browser stays separate: `shell/src/services/browser/host.js` owns its `WebContentsView`; direct serial Electron acceptance `npx playwright test e2e/browser-page.spec.js --workers=1` passed 4/4 with Donut absent, and the updated `e2e/browser-workspace.spec.js` passed 1/1 validating supported Browser Manager calls and explicit unsupported page-control refusal.

`npm run check:cdp-boundary` is unchanged and passes. Its internal checks still describe the legacy CDP transport and its raw-WebSocket authentication defect; rule 6 is vacuously satisfied because the provider-seam directory is absent. The retained source files `shell/src/ipc/cdp.js`, `shell/src/services/cdp-adapter.js`, `shell/src/services/cdp-session.js`, and `shell/src/services/browser-workspace.js` are not wired into production entry points; they remain for historical/unit-test assertions pending a separately authorized checker/source cleanup. **Do not reinterpret this as the raw same-user unauthenticated WebSocket becoming secure. Its status remains BLOCKED.**
## Current security boundary

CareerFlow's `shell/src/services/cdp-adapter.js` authenticates the Donut HTTP API with the runtime bearer credential, then discovers the browser's DevTools endpoint from the profile's `remote_debugging_port` and `/json/version`. The final CDP transport is a raw WebSocket created as `new WebSocket(wsUrl)`.

The WebSocket URL is constrained to loopback, the expected debugger port, and the `/devtools/browser/<id>` or `/devtools/page/<id>` pathname allowlist; target ownership is checked before target operations. Those checks constrain where CareerFlow connects; they do **not** authenticate the HTTP Upgrade request.

## External contract evidence

The inspected DonutBrowser-Integration source launches the browser/Wayfern process with `--remote-debugging-port=<port>`. Its Wayfern process environment may receive `WAYFERN_TOKEN`, but the inspected code uses that token for Wayfern/cloud fingerprint authorization; it is not an authentication mechanism on the local DevTools WebSocket listener.

The Donut API's bearer `auth_middleware` protects `/v1` HTTP routes. That middleware authenticates HTTP requests carrying `Authorization: Bearer ...`; it does not establish authentication for the separate Chromium/Wayfern DevTools listener exposed on the browser's remote-debugging port.

The Donut integration's own CDP client connects directly with `new WebSocket(target.webSocketDebuggerUrl)`, consistent with a raw DevTools listener rather than an authenticated CareerFlow-specific WebSocket protocol.

## Consequence

A same-user local process that can reach the browser's loopback debugger port can attempt the raw WebSocket handshake without possessing CareerFlow's API bearer token. CareerFlow's loopback, port, PID, profile, data-root, and target-ownership checks cannot change that transport-level fact.

A CareerFlow-only fix would require an authenticated transport boundary in front of the raw DevTools listener (for example, an authenticated local proxy whose upstream connection is kept private) or an upstream browser/CDP listener that itself authenticates the WebSocket upgrade. The current external contract does not provide the latter, and CareerFlow must not modify `DonutBrowser-Integration` to manufacture it.

Therefore the raw same-user unauthenticated DevTools WebSocket remains classified **`BLOCKED`** for the CareerFlow security gate. The existing ownership checks are defense-in-depth and must not be described as WebSocket authentication.

The real-browser Headless acceptance test also performs a direct WebSocket connection to the exact live target URL without supplying an authentication header and observes the connection opening. This is direct runtime evidence that CareerFlow-side API authentication and endpoint ownership checks do not authenticate the underlying DevTools Upgrade boundary.

## Feasibility assessment of CareerFlow-only mitigations (2026-09-17)

The available Chromium launch-contract knobs were investigated read-only against the
DonutBrowser-Integration source to determine whether CareerFlow can close the raw
WebSocket gap without modifying Donut:

| Option | Verdict | Reason |
| --- | --- | --- |
| Launch with `--remote-debugging-pipe` instead of `--remote-debugging-port` | Not available | The DevTools socket fd pair must be inherited by the browser process at spawn time. Donut spawns Wayfern itself (`browser_runner.rs` / `wayfern_manager.rs`); CareerFlow never spawns the browser, so it cannot pass inherited stdio fds 3/4 into Donut's child. Donut's launch path also has no pipe mode. |
| `--remote-debugging-address` hardening | Already in place upstream | Donut already pins `--remote-debugging-address=127.0.0.1`. CareerFlow relies on this, but it does not authenticate. |
| Chromium 111+ `--remote-allow-origins` | Not an auth control | It restricts the `Origin` header of DevTools HTTP clients; it does not authenticate WebSocket upgrades, and the raw-handshake evidence shows the listener accepts connections with no auth header at all. |
| Per-process loopback firewall rule scoped to CareerFlow.exe | Not available | Windows Firewall (WFAS) rules cannot bind a loopback listener to a specific *client* process; loopback traffic bypasses WFP connect filtering for same-host connections. |
| CareerFlow-owned authenticated local CDP proxy in front of the raw listener | Does not close the gap | The upstream DevTools TCP port itself would remain reachable by any same-user process. A proxy only authenticates CareerFlow's own client leg; it cannot make the raw browser port disappear, and CareerFlow cannot re-bind or hide Donut's listener. |
| Named-pipe / broker-mediated control instead of CDP | Out of contract | CareerFlow's browser automation surface is defined by the Donut HTTP + CDP contract; there is no named-pipe channel in the external runtime. |

Conclusion: every transport-level mechanism that could authenticate the raw DevTools
Upgrade handshake requires changes on the browser-launch side (Donut) or in the
browser runtime itself. The gap is **externally blocked** by the current Donut
contract, not by missing CareerFlow implementation.

## CareerFlow-owned structural controls (regression-pinned)

`scripts/check-cdp-auth-boundary.mjs` (part of `npm test` via `check:cdp-boundary`)
statically pins the boundary so it cannot silently regress:

1. exactly one production `new WebSocket(` construction, inside
   `shell/src/services/cdp-adapter.js`;
2. the pre-connect validation chain in the adapter (loopback host allowlist,
   expected debugger port, `/devtools/{browser,page}/<id>` pathname allowlist,
   immediate endpoint-identity re-resolution whose result must exactly match the
   URL about to be opened);
3. the renderer/preload surface exposes no WebSocket primitive, no
   `webSocketDebuggerUrl`, no port/host/token parameters.

## Required resolution for a future fix

A valid fix must prove, at the actual HTTP Upgrade boundary:

1. an unauthenticated direct handshake is rejected;
2. an authorized CareerFlow handshake succeeds;
3. a wrong token is rejected;
4. a wrong profile/runtime cannot be used;
5. a wrong debugger port cannot be used; and
6. the authenticated transport preserves target/profile ownership boundaries.

No CDP metadata, loopback restriction, process ownership check, or post-connect CDP command is sufficient evidence for item 1.
