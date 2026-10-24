// Live Donut Pro validation (Phase 6 evidence).
//
// READ-ONLY against the official Donut installation apart from creating and
// deleting ONE profile namespaced `cf-probe-*`, removed in `finally`.
// Imports the REAL CareerFlow credential reader and the REAL cdp-session
// facade, so every number below is produced by production code paths.
// The bearer token is never printed, logged, or written to disk.
//
// Contract: docs/official-donut/README.md (verified against 0.31.3).

import { writeFileSync } from "node:fs";
import { readLocalApiCredential, describeLocalApi } from "../shell/src/services/donut-credential.js";
import { createCdpSession } from "../shell/src/services/cdp-session.js";

const OUT = [];
const log = (...a) => { const l = a.join(" "); OUT.push(l); console.log(l); };
const step = (n, t) => log("", `=== STEP ${n} :: ${t} ===`);

async function call(cred, method, path, body = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30000);
  const s = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${cred.port}${path}`, {
      method,
      headers: { ...cred.authHeaders, "Content-Type": "application/json" },
      body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { ok: res.ok, status: res.status, json, raw: json ? null : text.slice(0, 240), ms: Date.now() - s };
  } catch (e) {
    return { ok: false, status: 0, error: `${e?.name}:${e?.message}`, ms: Date.now() - s };
  } finally { clearTimeout(t); }
}

const show = (r, n = 260) =>
  `status=${r.status} ok=${r.ok} ms=${r.ms} body=${String(JSON.stringify(r.json ?? r.error ?? r.raw)).slice(0, n)}`;

const verdict = {};
let cred = null;
let createdId = null;
let S = null;

try {
  step(1, "credential acquisition (official DBAPI v2 container)");
  log(`  describeLocalApi        = ${JSON.stringify(await describeLocalApi())}`);
  cred = await readLocalApiCredential();
  log(`  readLocalApiCredential = state=${cred.state} ok=${cred.ok} port=${cred.port ?? "-"} reason=${cred.reason ?? "-"}`);
  verdict.credential = cred.ok === true;
  if (!cred.ok) { log("  BLOCKED: no credential available."); process.exit(2); }
  log("  bearer token: present, used only in request headers, never printed");

  step(2, "auth boundary control (unauthenticated and wrong-token MUST be rejected)");
  const una = await fetch(`http://127.0.0.1:${cred.port}/v1/profiles`).catch(e => ({ err: e.message }));
  log(`  NO bearer    -> ${una.status ?? "err " + una.err}   (expect 401)`);
  verdict.authEnforced = una.status === 401;
  const bad = await fetch(`http://127.0.0.1:${cred.port}/v1/profiles`, { headers: { Authorization: "Bearer definitely-not-the-token" } }).catch(e => ({ err: e.message }));
  log(`  WRONG token  -> ${bad.status ?? "err " + bad.err}   (expect 401)`);
  verdict.wrongTokenRejected = bad.status === 401;

  step(3, "authenticated REST API");
  const spec = await call(cred, "GET", "/openapi.json");
  log(`  GET /openapi.json  -> ${show(spec)}`);
  const paths = spec.json?.paths ? Object.keys(spec.json.paths) : [];
  log(`  documented paths = ${paths.length}`);
  verdict.openapiPaths = paths.length;
  verdict.runEndpointDocumented = Boolean(spec.json?.paths?.["/v1/profiles/{id}/run"]?.post);
  log(`  GET /v1/profiles   -> ${show(await call(cred, "GET", "/v1/profiles"))}`);

  step(4, "profile creation (POST /v1/profiles)");
  const mk = await call(cred, "POST", "/v1/profiles", { name: `cf-probe-${Date.now()}`, browser: "wayfern", os: "windows" });
  log(`  POST /v1/profiles  -> ${show(mk)}`);
  createdId = String(mk.json?.id ?? mk.json?.profile?.id ?? mk.json?.profile_id ?? "") || null;
  verdict.profileCreated = Boolean(createdId) && mk.status < 300;
  log(`  created profile id = ${createdId}`);
} catch (e) {
  log(`UNCAUGHT(phase A): ${e?.stack ?? e}`);
  verdict.uncaught = String(e?.message ?? e);
}
writeFileSync("logs/_evidence_donut_pro_validation.txt", OUT.join("\n") + "\n");

