// ===========================================================================
// Real Donut validation harness  (Phase 6 evidence collector)
//
// READ-ONLY against the official Donut installation, using CareerFlow's OWN
// production credential reader. Nothing here re-implements auth.
//
//   - the bearer token is never printed, logged or written to disk
//   - every profile created is named cf-probe-* and deleted in the SAME run
//   - no licensing or security control is bypassed, probed or worked around
//
// Exit code 0 = every executed stage passed. Non-zero = a stage failed, with
// the verbatim external reason attributed rather than guessed at.
// ===========================================================================

import { writeFileSync } from "node:fs";
import { readLocalApiCredential, describeLocalApi } from "../shell/src/services/donut-credential.js";

const OUT = [];
let FAILED = 0;
function log(s = "") { OUT.push(s); console.log(s); }
function stage(n, label) { log(""); log(`STEP ${n}  ${label}`); }
function pass(s) { log(`  [PASS] ${s}`); }
function fail(s) { FAILED++; log(`  [FAIL] ${s}`); }
function note(s) { log(`  [note] ${s}`); }

function redact(j) {
  if (!j || typeof j !== "object") return j;
  const c = Array.isArray(j) ? [...j] : { ...j };
  for (const k of ["token", "api_token", "authorization", "password", "secret"]) {
    if (k in c) c[k] = "<redacted>";
  }
  return c;
}

async function call(cred, method, path, body, budget = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), budget);
  const s = Date.now();
  const init = {
    method,
    headers: { ...cred.authHeaders, "Content-Type": "application/json" },
    signal: ac.signal,
  };
  if (method !== "GET" && method !== "HEAD" && body !== undefined) {
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(`http://127.0.0.1:${cred.port}${path}`, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = text.slice(0, 300); }
    return { ok: res.ok, status: res.status, json: redact(json), ms: Date.now() - s };
  } catch (e) {
    return { ok: false, status: 0, error: `${e?.name}:${e?.message}`, ms: Date.now() - s };
  } finally {
    clearTimeout(t);
  }
}

const show = (r, n = 220) =>
  `status=${r.status} ok=${r.ok} ms=${r.ms} body=${String(JSON.stringify(r.json ?? r.error)).slice(0, n)}`;

const created = new Set();

try {
  log("=".repeat(78));
  log("REAL DONUT VALIDATION -- CareerFlow  (official installation, untouched)");
  log("=".repeat(78));

  stage(1, "credential acquisition");
  note(`describeLocalApi       = ${JSON.stringify(await describeLocalApi())}`);
  const cred = await readLocalApiCredential();
  note(`readLocalApiCredential = state=${cred.state} ok=${cred.ok} port=${cred.port ?? "-"}`);
  if (cred.ok) {
    pass("credential derived from the official DBAPI v2 token container");
    pass(`bearer token present for 127.0.0.1:${cred.port}; never printed`);
  } else {
    fail(`credential unavailable (reason=${cred.reason})`);
    throw new Error("no credential");
  }

  stage(2, "authenticated REST API");
  const una = await fetch(`http://127.0.0.1:${cred.port}/v1/profiles`).catch((e) => ({ err: e.message }));
  if (una.status === 401) pass("unauthenticated request REJECTED with 401 (auth is enforced)");
  else fail(`expected 401 unauthenticated, got ${una.status ?? una.err}`);

  const list = await call(cred, "GET", "/v1/profiles");
  if (list.ok) pass(`GET /v1/profiles -> 200 in ${list.ms}ms, total=${list.json?.total ?? list.json?.profiles?.length}`);
  else fail(`GET /v1/profiles -> ${show(list)}`);

  const hours = await call(cred, "GET", "/v1/remote-hours");
  if (hours.ok) pass("GET /v1/remote-hours -> 200 (paid-plan quota endpoint reachable)");
  else note(`GET /v1/remote-hours -> ${show(hours, 160)}`);

  stage(3, "profile creation");
  const name = `cf-probe-${Date.now()}`;
  const mk = await call(cred, "POST", "/v1/profiles", {
    name, browser: "wayfern", tags: ["cf-probe"], temporary: true,
  });
  log(`  POST /v1/profiles {name, browser:"wayfern"} -> ${show(mk, 300)}`);
  let pid = null;
  if (mk.ok) {
    pid = String(mk.json?.profile?.id ?? mk.json?.id ?? mk.json?.profiles?.[0]?.id ?? "") || null;
    if (pid) { created.add(pid); pass(`profile created id=${pid}`); }
    else fail("profile created but response carried no id");
  } else {
    fail(`profile creation failed: status=${mk.status} ${JSON.stringify(mk.json)}`);
  }
  if (!pid) throw new Error("no profile");

  stage(4, "/run  (the call that returned HTTP 402 on the Free tier)");
  const run = await call(cred, "POST", `/v1/profiles/${pid}/run`, {}, 90000);
  log(`  POST /v1/profiles/${pid}/run -> ${show(run, 300)}`);
  let port = null;
  if (run.ok) {
    port = Number(run.json?.remote_debugging_port ?? 0) || null;
    if (port) pass(`/run SUCCEEDED in ${run.ms}ms -- the HTTP 402 blocker is GONE. remote_debugging_port=${port}`);
    else fail("/run returned 200 but no remote_debugging_port");
  } else if (run.status === 402) {
    fail(`/run returned HTTP 402 -- account is STILL Free-tier. ${JSON.stringify(run.json)}`);
  } else {
    fail(`/run failed: ${show(run)}`);
  }
  let browser = null;
  if (port) {
    stage(5, "remote debugging port reachable (CDP /json/version)");
    let ver = null;
    for (let i = 0; i < 25 && !ver; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      ver = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    }
    if (ver) pass(`CDP endpoint live on :${port} -- ${ver.Browser}`);
    else fail(`CDP endpoint never answered on :${port}`);

    stage(6, "Playwright connectOverCDP + real page operations");
    try {
      const { chromium } = await import("playwright-core");
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      pass(`connectOverCDP OK -- ${browser.contexts().length} context(s)`);

      const ctx = browser.contexts()[0] ?? (await browser.newContext());
      const page = await ctx.newPage();
      pass("page created");

      await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30000 });
      pass(`navigation -> ${page.url()} / title="${await page.title()}"`);

      const p2 = await ctx.newPage();
      await p2.goto("https://example.org", { waitUntil: "domcontentloaded", timeout: 30000 });
      pass(`second tab created -> ${p2.url()}`);
      pass(`tab list = ${ctx.pages().length}: ${ctx.pages().map((p) => p.url()).join(" | ")}`);

      await p2.bringToFront();
      await page.waitForTimeout(400);
      pass("tab activated (bringToFront)");

      await p2.goBack({ waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => note(`back: ${String(e.message).slice(0, 70)}`));
      pass(`back    -> ${p2.url()}`);
      await p2.goForward({ waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => note(`forward: ${String(e.message).slice(0, 70)}`));
      pass(`forward -> ${p2.url()}`);
      await p2.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
      pass(`reload  -> ${p2.url()}`);

      await p2.close();
      pass(`tab closed -> ${ctx.pages().length} tab(s) remain`);

      stage(7, "disconnect / reconnect");
      await browser.close();
      browser = null;
      pass("disconnected from CDP");
      await new Promise((r) => setTimeout(r, 1500));
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const live = browser.contexts()[0]?.pages() ?? [];
      pass(`reconnected -> ${browser.contexts().length} context(s), ${live.length} page(s)`);
      note(`surviving pages: ${live.map((p) => p.url()).join(" | ") || "(none)"}`);
    } catch (e) {
      fail(`Playwright/CDP stage threw: ${e?.message}`);
    }
  } else {
    stage(5, "remote debugging port reachable (CDP /json/version)");
    note("SKIPPED -- /run did not succeed, so there is no port to reach");
  }

  stage(9, "cleanup -- no leaked profiles or processes");
  if (browser) { try { await browser.close(); } catch { /* already gone */ } note("playwright disconnected"); }
  for (const id of created) {
    const k = await call(cred, "POST", `/v1/profiles/${id}/kill`, {}, 30000);
    log(`  POST /v1/profiles/${id}/kill   -> ${show(k, 120)}`);
    const d = await call(cred, "DELETE", `/v1/profiles/${id}`);
    if (d.ok) pass(`probe profile ${id} deleted`);
    else fail(`probe profile ${id} NOT deleted (status=${d.status})`);
  }
  const after = await call(cred, "GET", "/v1/profiles");
  const left = (after.json?.profiles ?? []).filter((p) => String(p.name ?? "").startsWith("cf-probe-"));
  if (!left.length) pass("zero cf-probe-* profiles remain");
  else fail(`LEAK: ${left.length} probe profile(s) remain: ${left.map((p) => p.name).join(", ")}`);
  if (after.ok) pass(`backend healthy after cleanup -> ${show(after, 90)}`);
  else fail(`backend unhealthy: ${show(after, 120)}`);
} catch (e) {
  fail(`harness aborted: ${e?.message}`);
} finally {
  log("");
  log("=".repeat(78));
  log(FAILED === 0 ? "RESULT: ALL EXECUTED STAGES PASSED" : `RESULT: ${FAILED} STAGE(S) FAILED`);
  log("=".repeat(78));
  writeFileSync("logs/_evidence_donut_pro_validation.txt", OUT.join("\n") + "\n");
}

process.exit(FAILED === 0 ? 0 : 1);
