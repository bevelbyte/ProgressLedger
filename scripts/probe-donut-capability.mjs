// Read-only capability probe against the OFFICIAL Donut installation.
//
// Purpose: build the CURRENT capability matrix for CareerFlow's browser path.
// This does NOT retry the failing stage repeatedly and does NOT attempt any
// licensing, entitlement or security bypass. It asks one question per endpoint
// and records the verbatim answer, so "blocked" is an attributed fact rather
// than a guess.
//
// CREDENTIAL CAVEAT (learned the hard way -- do not repeat the earlier mistake):
// this script derives its token from Donut's own DBAPI-v2 vault. On this machine
// `app_settings.json` has "api_token": null, and the vault path yields a token
// that Donut REJECTS with HTTP 401. `readLocalApiCredential()` still reports
// ok=true, so the app looks "connected" while actually being unauthorized.
// EVERY endpoint below therefore returned 401 and was ALREADY MISREAD ONCE as
// "licensing blocked / profile creation blocked". It was not. With a valid
// bearer token the same calls return 200 and a real remote_debugging_port.
//
// So: HTTP 401 means "our credential is wrong", NOT "the feature is blocked".
// Only a non-401 refusal (e.g. 402, 403 CLOUD_NOT_SIGNED_IN) is a real gate.
// Treat 401 as a credential defect to be fixed, never as a product limitation.
//
// The bearer token is never printed, logged or written to disk -- only the
// status code and a truncated body.

import { readLocalApiCredential } from "../shell/src/services/donut-credential.js";

const OUT = [];
function log(s) {
  OUT.push(s);
  console.log(s);
}

const cred = await readLocalApiCredential();
log(`credential ok=true port=${cred.port} (token never printed)`);
log("");

async function probe(label, method, path, body) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 25000);
  const started = Date.now();
  try {
    const init = {
      method,
      headers: { ...cred.authHeaders, "Content-Type": "application/json" },
      signal: ac.signal,
    };
    if (method !== "GET" && body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`http://127.0.0.1:${cred.port}${path}`, init);
    const text = await res.text();
    log(`${label.padEnd(34)} -> HTTP ${res.status}  ${text.slice(0, 150)}`);
    return { status: res.status, body: text };
  } catch (e) {
    log(`${label.padEnd(34)} -> ERROR ${e?.name}:${e?.message}`);
    return { status: 0 };
  } finally {
    clearTimeout(t);
    void started;
  }
}

log("== capability matrix (official Donut, this account) ==");
await probe("GET  /v1/profiles", "GET", "/v1/profiles");
await probe("GET  /v1/remote-hours", "GET", "/v1/remote-hours");
await probe("GET  /v1/remote-sessions", "GET", "/v1/remote-sessions");
await probe("POST /v1/profiles (create)", "POST", "/v1/profiles", {
  name: `cf-probe-${Date.now()}`,
  browser: "wayfern",
});
// /run against a non-existent profile. This separates "run is refused" from
// "the profile could not be created", which are different failures with
// different fixes.
await probe("POST /v1/profiles/<no-such>/run", "POST", "/v1/profiles/cf-probe-nonexistent/run", {});
await probe("GET  /v1/browsers", "GET", "/v1/browsers");
await probe("GET  /v1/subscription", "GET", "/v1/subscription");

log("");
log("== interpretation ==");
log("READ THIS BEFORE TRUSTING ANY 'BLOCKED' LABEL BELOW.");
log("HTTP 401 => our credential is wrong. That is a DEFECT to fix, NOT a product");
log("limitation. An earlier run misread exactly this as 'licensing blocked'.");
log("Only non-401 refusals (402, 403 CLOUD_NOT_SIGNED_IN) are real gates.");
log("");
log("With a valid token: GET/POST /v1/profiles => 200, POST /{id}/run => 200 with a");
log("real remote_debugging_port, and CDP /json/version answers. That is how the");
log("navigate/tabs/read/input/close/reconnect matrix is meant to be exercised.");
log("");
log("Also note: a profile is stopped with POST /v1/profiles/{id}/kill (NOT /stop),");
log("and DELETE /v1/profiles/{id} returns 409 PROFILE_RUNNING until it is killed.");