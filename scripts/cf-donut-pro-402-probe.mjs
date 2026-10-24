// Pro-gate probe: does /run still answer HTTP 402?
//
// Safe and read-only: it calls /run against a NON-EXISTENT profile id. If the
// Pro gate were still in force the server would refuse with 402 before it ever
// looked up the profile. If the gate is lifted, the request reaches the
// profile lookup and answers 404/400 instead. No profile is created, no
// browser is launched, nothing is modified.
import { readLocalApiCredential } from "../shell/src/services/donut-credential.js";
const cred = await readLocalApiCredential();
if (!cred.ok) { console.log("no credential:", cred.reason); process.exit(2); }
const probe = async (path, body) => {
  const r = await fetch(`http://127.0.0.1:${cred.port}${path}`, {
    method: "POST",
    headers: { ...cred.authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  return { status: r.status, body: t.slice(0, 300) };
};
console.log("POST /v1/profiles/does-not-exist-cf-probe/run ->", JSON.stringify(await probe(`/v1/profiles/does-not-exist-cf-probe/run`, { headless: false })));
console.log("POST /v1/profiles/does-not-exist-cf-probe/kill ->", JSON.stringify(await probe(`/v1/profiles/does-not-exist-cf-probe/kill`, {})));
